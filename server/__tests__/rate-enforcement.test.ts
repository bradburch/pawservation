import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, endUserToken, seedPets, TENANT_A, TENANT_B } from './helpers';

async function book(env: Env, slug: string, body: unknown, email = 'jess@example.com') {
  const token = await endUserToken(env, slug, email);
  return app.request(
    `/api/${slug}/bookings`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function quote(
  env: Env,
  slug: string,
  query: string,
  petIds: string[],
  email = 'jess@example.com',
) {
  const token = await endUserToken(env, slug, email);
  return app.request(
    `/api/${slug}/availability?${query}&petIds=${petIds.join(',')}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

describe('booking POST refuses an unpriced pet set', () => {
  it('400s with the stable code, and stores NOTHING', async () => {
    const { env, raw } = createTestEnv();
    const res = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-01',
      optionKey: 'd30',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'unpriced_pet_set' });
    // The refusal happens BEFORE the optimistic insert — no orphan row, no $0 booking. Scoped to
    // this test's own date (seed.sql seeds unrelated walk bookings on other dates/tenants).
    const rows = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM BookingRequests WHERE ServiceType='walk' AND StartDate='2028-08-01'`,
      )
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('a single pet is completely unaffected — the compatibility lock', async () => {
    const { env } = createTestEnv();
    const res = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-02',
      optionKey: 'd30',
      petIds: ['pet_sp_bella'],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ estCost: 20 });
  });

  it('the quote and the POST refuse TOGETHER for the same set', async () => {
    const { env } = createTestEnv();
    const q = (await (
      await quote(env, 'sunny-paws', 'type=walk&start=2028-08-03&option=d30', [
        'pet_sp_bella',
        'pet_sp_mochi',
      ])
    ).json()) as { priced: boolean };
    const p = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-03',
      optionKey: 'd30',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(q.priced).toBe(false);
    expect(p.status).toBe(400);
  });
});

describe('quote/stamp parity', () => {
  it('a PRICED multi-pet set: quote estCost === POST estCost === stored EstCost', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `INSERT INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate)
         VALUES (?, 'walk', 'd30', 'cat:1|dog:1', 33)`,
      )
      .run(TENANT_A);
    const q = (await (
      await quote(env, 'sunny-paws', 'type=walk&start=2028-08-04&option=d30', [
        'pet_sp_bella',
        'pet_sp_mochi',
      ])
    ).json()) as { priced: boolean; estCost: number };
    expect(q).toMatchObject({ priced: true, estCost: 33 });

    const res = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-04',
      optionKey: 'd30',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(res.status).toBe(201);
    const booked = (await res.json()) as { id: string; estCost: number };
    expect(booked.estCost).toBe(q.estCost);
    const stored = raw.prepare(`SELECT EstCost FROM BookingRequests WHERE Id=?`).get(booked.id) as {
      EstCost: number;
    };
    expect(stored.EstCost).toBe(q.estCost);
  });

  it('a pet-ID group rate beats the species rate at BOTH the quote and the stamp', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `INSERT INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate)
         VALUES (?, 'walk', 'd30', 'cat:1|dog:1', 33)`,
      )
      .run(TENANT_A);
    raw
      .prepare(
        `INSERT INTO PetGroupPricing (Id, TenantId, ServiceType, OptionKey, GroupKey, Rate)
         VALUES ('pgp_1', ?, 'walk', 'd30', 'pet_sp_bella,pet_sp_mochi', 21)`,
      )
      .run(TENANT_A);
    const q = (await (
      await quote(env, 'sunny-paws', 'type=walk&start=2028-08-05&option=d30', [
        'pet_sp_mochi',
        'pet_sp_bella',
      ])
    ).json()) as { estCost: number };
    expect(q.estCost).toBe(21); // group beats mix; selection ORDER does not change the key
    const res = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-05',
      optionKey: 'd30',
      petIds: ['pet_sp_mochi', 'pet_sp_bella'],
    });
    expect(((await res.json()) as { estCost: number }).estCost).toBe(21);
  });
});

describe('rates are tenant-scoped', () => {
  it("tenant A's species rate never prices tenant B's booking", async () => {
    const { env, raw } = createTestEnv();
    seedPets(raw, TENANT_B, 'eu_ht_jess', [{ id: 'pet_ht_pip', petType: 'dog' }]);
    // The rate belongs to Sunny Paws, for the SAME service type and option key.
    raw
      .prepare(
        `INSERT INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate)
         VALUES (?, 'walk', 'd30', 'dog:2', 99)`,
      )
      .run(TENANT_A);
    const q = (await (
      await quote(env, 'happy-tails', 'type=walk&start=2028-08-06&option=d30', [
        'pet_ht_otis',
        'pet_ht_pip',
      ])
    ).json()) as Record<string, unknown>;
    expect(q).toMatchObject({ priced: false, reason: 'unpriced-pet-set' });
    expect(q.estCost).not.toBe(99);
  });

  it("tenant A's pet-GROUP rate never prices tenant B's booking", async () => {
    const { env, raw } = createTestEnv();
    seedPets(raw, TENANT_B, 'eu_ht_jess', [{ id: 'pet_ht_pip', petType: 'dog' }]);
    raw
      .prepare(
        `INSERT INTO PetGroupPricing (Id, TenantId, ServiceType, OptionKey, GroupKey, Rate)
         VALUES ('pgp_x', ?, 'walk', 'd30', 'pet_ht_otis,pet_ht_pip', 7)`,
      )
      .run(TENANT_A);
    const q = (await (
      await quote(env, 'happy-tails', 'type=walk&start=2028-08-07&option=d30', [
        'pet_ht_otis',
        'pet_ht_pip',
      ])
    ).json()) as Record<string, unknown>;
    expect(q).toMatchObject({ priced: false });
  });
});
