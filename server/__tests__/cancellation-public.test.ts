import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';
import { addDays, getPacificDateStr } from '../../src/shared/index.js';

type ConfigService = { type: string; cancellationTiers: unknown };
type ConfigResponse = { services: ConfigService[] };
type MineBooking = { id: string; cancellationFeeCents: number | null };
type MineResponse = { bookings: MineBooking[] };

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

async function postStatus(env: Env, id: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/api/sunny-paws/admin/bookings/${id}/status`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function mine(env: Env): Promise<MineResponse> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  const res = await app.request(
    '/api/sunny-paws/bookings/mine',
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
  return (await res.json()) as MineResponse;
}

describe('GET /config exposes cancellationTiers per service', () => {
  it('returns the seeded tiers for boarding', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);

    const res = await app.request('/api/sunny-paws/config', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigResponse;
    const boarding = body.services.find((s) => s.type === 'boarding')!;
    expect(boarding.cancellationTiers).toEqual([
      { withinDays: 2, percent: 100 },
      { withinDays: 7, percent: 50 },
    ]);
  });

  it('returns null for a service with no cancellation policy', async () => {
    const { env } = createTestEnv();

    const res = await app.request('/api/sunny-paws/config', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigResponse;
    const boarding = body.services.find((s) => s.type === 'boarding')!;
    expect(boarding.cancellationTiers).toBeNull();
  });
});

describe('GET /bookings/mine exposes cancellationFeeCents', () => {
  it('returns the assessed fee on a fee-charged cancelled booking', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as {
      id: string;
      estCostCents: number;
    };
    await confirm(env, created.id);

    const cancel = await postStatus(env, created.id, { status: 'cancelled', chargeFee: true });
    expect(cancel.status).toBe(200);

    const { bookings } = await mine(env);
    const row = bookings.find((b) => b.id === created.id)!;
    expect(row.cancellationFeeCents).toBe(created.estCostCents);
  });

  it('returns null cancellationFeeCents on a booking cancelled without a fee', async () => {
    const { env, raw } = createTestEnv();
    seedTiers(raw);
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as { id: string };
    await confirm(env, created.id);

    const cancel = await postStatus(env, created.id, { status: 'cancelled' });
    expect(cancel.status).toBe(200);

    const { bookings } = await mine(env);
    const row = bookings.find((b) => b.id === created.id)!;
    expect(row.cancellationFeeCents).toBeNull();
  });

  it('returns null cancellationFeeCents on a pending (uncancelled) booking', async () => {
    const { env } = createTestEnv();
    const start = addDays(getPacificDateStr(), 1);
    const end = addDays(getPacificDateStr(), 3);
    const created = (await (await bookBoarding(env, start, end)).json()) as { id: string };

    const { bookings } = await mine(env);
    const row = bookings.find((b) => b.id === created.id)!;
    expect(row.cancellationFeeCents).toBeNull();
  });
});
