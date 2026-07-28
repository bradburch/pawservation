import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A, TENANT_B } from './helpers';
import { addDays, getPacificDateStr } from '../../src/shared/index.js';

/** Books one dog (Bella, sunny-paws) for a boarding stay via the real customer flow. */
async function bookBoarding(env: Env, startDate: string, endDate: string): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'boarding', startDate, endDate, petIds: ['pet_sp_bella'] }),
    },
    env,
  );
}

/** Seeds a two-tier cancellation policy on sunny-paws' boarding service. */
function seedTiers(raw: import('node:sqlite').DatabaseSync): void {
  raw.exec(
    `UPDATE TenantServices SET CancellationTiers =
       '[{"withinDays":2,"percent":100},{"withinDays":7,"percent":50}]'
     WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'boarding'`,
  );
}

function feeRow(raw: import('node:sqlite').DatabaseSync, id: string): number | null {
  const row = raw.prepare('SELECT CancellationFee FROM BookingRequests WHERE Id = ?').get(id) as {
    CancellationFee: number | null;
  };
  return row.CancellationFee;
}

function statusRow(raw: import('node:sqlite').DatabaseSync, id: string): string {
  const row = raw.prepare('SELECT Status FROM BookingRequests WHERE Id = ?').get(id) as {
    Status: string;
  };
  return row.Status;
}

async function confirm(env: Env, id: string): Promise<void> {
  await app.request(
    `/api/sunny-paws/admin/bookings/${id}/status`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'confirmed' }),
    },
    env,
  );
}

async function postStatus(
  env: Env,
  tenantId: string,
  id: string,
  body: Record<string, unknown>,
  slug = 'sunny-paws',
): Promise<Response> {
  return app.request(
    `/api/${slug}/admin/bookings/${id}/status`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(tenantId)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('cancellation fee assessment at cancel time', () => {
  it('charges 100% when cancelling inside the tightest window', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as {
      id: string;
      estCost: number;
    };
    await confirm(env, created.id);

    const res = await postStatus(env, TENANT_A, created.id, {
      status: 'cancelled',
      chargeFee: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'cancelled',
      notified: false,
      cancellationFee: created.estCost,
    });
    expect(feeRow(raw, created.id)).toBe(created.estCost);
    expect(statusRow(raw, created.id)).toBe('cancelled');
  });

  it('charges nothing when cancelling outside every window ($0 → NULL)', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    // Far-future dates: always outside the 7-day window regardless of "today".
    const created = (await (await bookBoarding(env, '2028-10-05', '2028-10-07')).json()) as {
      id: string;
    };
    await confirm(env, created.id);

    const res = await postStatus(env, TENANT_A, created.id, {
      status: 'cancelled',
      chargeFee: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'cancelled',
      notified: false,
      cancellationFee: null,
    });
    expect(feeRow(raw, created.id)).toBeNull();
    expect(statusRow(raw, created.id)).toBe('cancelled');
  });

  it('waives the fee when chargeFee is omitted', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as { id: string };
    await confirm(env, created.id);

    const res = await postStatus(env, TENANT_A, created.id, { status: 'cancelled' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'cancelled',
      notified: false,
      cancellationFee: null,
    });
    expect(feeRow(raw, created.id)).toBeNull();
    expect(statusRow(raw, created.id)).toBe('cancelled');
  });

  it('rejects chargeFee on a decline (400, booking untouched)', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as { id: string };
    // Do NOT confirm — decline is only valid from pending.

    const res = await postStatus(env, TENANT_A, created.id, {
      status: 'declined',
      chargeFee: true,
    });
    expect(res.status).toBe(400);
    expect(feeRow(raw, created.id)).toBeNull();
    expect(statusRow(raw, created.id)).toBe('pending');
  });

  it('rejects chargeFee on a non-confirmed booking (400, booking untouched)', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as { id: string };
    // Still pending — cancelling with a fee is not allowed.

    const res = await postStatus(env, TENANT_A, created.id, {
      status: 'cancelled',
      chargeFee: true,
    });
    expect(res.status).toBe(400);
    expect(feeRow(raw, created.id)).toBeNull();
    expect(statusRow(raw, created.id)).toBe('pending');
  });

  it('rejects chargeFee when the service has no cancellation policy (400)', async () => {
    const { env, raw } = createTestEnv();
    // No seedTiers — boarding has CancellationTiers NULL.
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as { id: string };
    await confirm(env, created.id);

    const res = await postStatus(env, TENANT_A, created.id, {
      status: 'cancelled',
      chargeFee: true,
    });
    expect(res.status).toBe(400);
    expect(feeRow(raw, created.id)).toBeNull();
    expect(statusRow(raw, created.id)).toBe('confirmed');
  });

  it('does not leak across tenants: TENANT_B token against a TENANT_A booking 404s', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as { id: string };
    await confirm(env, created.id);

    // TENANT_B admin acts within their OWN tenant (happy-tails); the TENANT_A booking id is
    // invisible to the tenant-scoped SQL, so the not-found path is unchanged and the row is
    // never touched.
    const res = await postStatus(env, TENANT_B, created.id, { status: 'cancelled' }, 'happy-tails');
    expect(res.status).toBe(404);
    expect(feeRow(raw, created.id)).toBeNull();
    expect(statusRow(raw, created.id)).toBe('confirmed');
  });

  it('404s (not 400) when chargeFee targets a booking id that does not exist', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);

    const res = await postStatus(env, TENANT_A, 'br_does_not_exist', {
      status: 'cancelled',
      chargeFee: true,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found.' });
  });

  it('404s (not 400) when chargeFee targets a materialized external row — no existence oracle', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    raw.exec(
      `INSERT INTO BookingRequests
         (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, GCalEventId, Status, SyncPending)
       VALUES ('ext_row_1', 'tnt_sunnypaws', 'external', '2029-01-10', '2029-01-13', 1, 'gev_1', 'confirmed', 0)`,
    );

    const res = await postStatus(env, TENANT_A, 'ext_row_1', {
      status: 'cancelled',
      chargeFee: true,
    });
    // Before the fix this was a 400 ("needs a confirmed booking with an estimated cost"), which
    // distinguishes "exists but isn't billable" from "doesn't exist at all" — an existence oracle
    // for read-only rows the sitter never created and has no UI to act on.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found.' });
  });
});
