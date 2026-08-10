import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { getHouseholdBalances, insertBackfilledBooking, insertBookingRequest } from '../db/repo';
import { MAX_BACKFILL_EST_COST } from '../routes/admin';
import { adminHeaders, createTestEnv, TENANT_A, TENANT_B } from './helpers';

// A fresh owner + pet, isolated from the seed's own eu_sp_jess bookings, so the balance
// assertions below need no arithmetic against unrelated seeded rows — this household has
// exactly the one booking the test creates.
function seedOwner(raw: DatabaseSync, tenantId: string, suffix: string): string {
  const endUserId = `eu_${suffix}`;
  const petId = `pet_${suffix}`;
  raw
    .prepare(`INSERT INTO EndUsers (Id, TenantId, Email) VALUES (?, ?, ?)`)
    .run(endUserId, tenantId, `${suffix}@example.com`);
  raw
    .prepare(
      `INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType) VALUES (?, ?, ?, 'Fido', 'dog')`,
    )
    .run(petId, tenantId, endUserId);
  raw
    .prepare(`INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)`)
    .run(tenantId, petId, endUserId);
  return endUserId;
}

// A row adopted from the calendar (Source = 'calendar-backfill') — the only kind this route may
// touch. `owners.some(...)` in the balance test finds this household by the endUserId returned by
// seedOwner, since a booking attaches to a household by its owner first (see
// buildHouseholdBalances), not by BookingRequestPets, which nothing here inserts.
async function makeBackfilledBooking(
  env: Env,
  raw: DatabaseSync,
  tenantId: string,
  suffix: string,
  estCost = 25,
): Promise<string> {
  const endUserId = seedOwner(raw, tenantId, suffix);
  return insertBackfilledBooking(env.PAWSERVATION_DB, tenantId, {
    endUserId,
    serviceType: 'walk',
    startDate: '2023-05-01',
    endDate: null,
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status: 'confirmed',
    gcalEventId: `evt_${suffix}`,
  });
}

// Admin session is always TENANT_A's, against TENANT_A's own slug — matching the pattern the
// booking-charges tests use for the "foreign booking" case: the id in the path belongs to some
// tenant, the session belongs to sunny-paws, and only the SQL's TenantId match decides.
async function patchCost(env: Env, bookingId: string, body: unknown) {
  return app.request(
    `/api/sunny-paws/admin/bookings/${bookingId}/cost`,
    {
      method: 'PATCH',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

function readEstCost(raw: DatabaseSync, bookingId: string): number | null {
  const row = raw.prepare('SELECT EstCost FROM BookingRequests WHERE Id = ?').get(bookingId) as
    { EstCost: number | null } | undefined;
  return row?.EstCost ?? null;
}

describe('PATCH /:slug/admin/bookings/:id/cost', () => {
  it('updates a backfilled booking and moves the household balance with it', async () => {
    const { env, raw } = createTestEnv();
    const endUserId = seedOwner(raw, TENANT_A, 'bf_balance');
    const bookingId = await insertBackfilledBooking(env.PAWSERVATION_DB, TENANT_A, {
      endUserId,
      serviceType: 'walk',
      startDate: '2023-05-01',
      endDate: null,
      optionKey: 'standard',
      petCount: 1,
      estCost: 25,
      status: 'confirmed',
      gcalEventId: 'evt_bf_balance',
    });

    const res = await patchCost(env, bookingId, { estCost: 40 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ estCost: 40 });
    expect(readEstCost(raw, bookingId)).toBe(40);

    // The point of the feature: correcting the row must move the household statement with it,
    // not just the raw column.
    const balances = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A);
    const household = balances.find((h) => h.owners.some((o) => o.endUserId === endUserId));
    expect(household?.expectedTotal).toBe(40);
    expect(household?.balance).toBe(40);
  });

  it('refuses a booking that came through pawservation, with 404', async () => {
    const { env, raw } = createTestEnv();
    const bookingId = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2030-01-01',
      endDate: '2030-01-03',
      optionKey: 'standard',
      petCount: 1,
      estCost: 100,
      status: 'confirmed',
    });

    const res = await patchCost(env, bookingId, { estCost: 40 });
    expect(res.status).toBe(404);
    expect(readEstCost(raw, bookingId)).toBe(100);
  });

  it('refuses a blocked sentinel with the same 404', async () => {
    const { env, raw } = createTestEnv();
    const blockedId = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: '2030-02-01',
      endDate: '2030-02-03',
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });

    const res = await patchCost(env, blockedId, { estCost: 40 });
    expect(res.status).toBe(404);
    expect(readEstCost(raw, blockedId)).toBe(null);
  });

  it('refuses a fractional amount', async () => {
    const { env, raw } = createTestEnv();
    const bookingId = await makeBackfilledBooking(env, raw, TENANT_A, 'frac');

    const res = await patchCost(env, bookingId, { estCost: 40.5 });
    expect(res.status).toBe(400);
    expect(readEstCost(raw, bookingId)).toBe(25);
  });

  it('refuses zero and negative amounts', async () => {
    const { env, raw } = createTestEnv();
    const bookingId = await makeBackfilledBooking(env, raw, TENANT_A, 'zeroneg');

    expect((await patchCost(env, bookingId, { estCost: 0 })).status).toBe(400);
    expect((await patchCost(env, bookingId, { estCost: -5 })).status).toBe(400);
    expect(readEstCost(raw, bookingId)).toBe(25);
  });

  it('refuses an amount over the ceiling', async () => {
    const { env, raw } = createTestEnv();
    const bookingId = await makeBackfilledBooking(env, raw, TENANT_A, 'ceiling');

    const res = await patchCost(env, bookingId, { estCost: MAX_BACKFILL_EST_COST + 1 });
    expect(res.status).toBe(400);
    expect(readEstCost(raw, bookingId)).toBe(25);
  });

  it("refuses another tenant's booking id", async () => {
    const { env, raw } = createTestEnv();
    // Backfilled under TENANT_B; the PATCH above always authenticates as TENANT_A against
    // TENANT_A's own slug, so this exercises the SQL's TenantId match, not a routing accident.
    const bookingId = await makeBackfilledBooking(env, raw, TENANT_B, 'foreign');

    const res = await patchCost(env, bookingId, { estCost: 40 });
    expect(res.status).toBe(404);
    expect(readEstCost(raw, bookingId)).toBe(25);
  });
});
