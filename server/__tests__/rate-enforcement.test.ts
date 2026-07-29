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

/** Flip ONE tenant's ONE service into the sitter-opted-in multiplier, as the admin PUT does. */
function setLinear(
  raw: ReturnType<typeof createTestEnv>['raw'],
  tenantId: string,
  serviceType: string,
): void {
  raw
    .prepare(`UPDATE TenantServices SET PetRateMode='linear' WHERE TenantId=? AND ServiceType=?`)
    .run(tenantId, serviceType);
}

describe("booking POST refuses an unpriced pet set (mode 'exact')", () => {
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

/**
 * The sibling block. Same route, same payloads, one stored column different — and the assertions
 * invert. Keeping both means neither "it refuses" nor "it multiplies" can be deleted as redundant,
 * and the boundary between them is what a future change has to break to slip through.
 */
describe("booking POST prices a multi-pet set when the sitter stored 'linear'", () => {
  it('201s at the multiplied price, and STAMPS that same number', async () => {
    const { env, raw } = createTestEnv();
    setLinear(raw, TENANT_A, 'walk');
    const res = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-11',
      optionKey: 'd30',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(res.status).toBe(201);
    const booked = (await res.json()) as { id: string; estCost: number };
    expect(booked.estCost).toBe(40); // the $20 d30 walk x 2 pets
    const stored = raw.prepare(`SELECT EstCost FROM BookingRequests WHERE Id=?`).get(booked.id) as {
      EstCost: number;
    };
    expect(stored.EstCost).toBe(40);
  });

  it('the quote and the POST AGREE for the same set — parity holds in the new mode too', async () => {
    const { env, raw } = createTestEnv();
    setLinear(raw, TENANT_A, 'walk');
    const q = (await (
      await quote(env, 'sunny-paws', 'type=walk&start=2028-08-12&option=d30', [
        'pet_sp_bella',
        'pet_sp_mochi',
      ])
    ).json()) as { priced: boolean; estCost: number };
    const p = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-12',
      optionKey: 'd30',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(q).toMatchObject({ priced: true, estCost: 40 });
    expect(p.status).toBe(201);
    expect(((await p.json()) as { estCost: number }).estCost).toBe(q.estCost);
  });

  it('a stored rate for that exact set still wins over the multiplier at the POST', async () => {
    const { env, raw } = createTestEnv();
    setLinear(raw, TENANT_A, 'walk');
    raw
      .prepare(
        `INSERT INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate)
         VALUES (?, 'walk', 'd30', 'cat:1|dog:1', 33)`,
      )
      .run(TENANT_A);
    const res = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-13',
      optionKey: 'd30',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(res.status).toBe(201);
    // $33 — the rate the sitter typed for a dog + a cat. Not $40 (2 x $20), not $66 (2 x $33).
    expect(((await res.json()) as { estCost: number }).estCost).toBe(33);
  });

  it('a single pet is unchanged by the mode — x1 never moves a price', async () => {
    const { env, raw } = createTestEnv();
    setLinear(raw, TENANT_A, 'walk');
    const res = await book(env, 'sunny-paws', {
      type: 'walk',
      startDate: '2028-08-14',
      optionKey: 'd30',
      petIds: ['pet_sp_bella'],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ estCost: 20 });
  });

  it('the mode is per SERVICE — opting walks in does not opt boarding in', async () => {
    const { env, raw } = createTestEnv();
    setLinear(raw, TENANT_A, 'walk');
    const res = await book(env, 'sunny-paws', {
      type: 'boarding',
      startDate: '2028-08-15',
      endDate: '2028-08-17',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'unpriced_pet_set' });
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

  it("tenant A's 'linear' MODE never prices tenant B's booking either", async () => {
    const { env, raw } = createTestEnv();
    seedPets(raw, TENANT_B, 'eu_ht_jess', [{ id: 'pet_ht_pip', petType: 'dog' }]);
    // The mode is a column on tenant A's own row, so isolation here is structural — but a future
    // "look up the mode once per service slug" cache is exactly how it would stop being.
    setLinear(raw, TENANT_A, 'walk');
    const res = await book(env, 'happy-tails', {
      type: 'walk',
      startDate: '2028-08-16',
      optionKey: 'd30',
      petIds: ['pet_ht_otis', 'pet_ht_pip'],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'unpriced_pet_set' });
  });
});
