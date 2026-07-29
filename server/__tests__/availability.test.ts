import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  countSlotBookings,
  insertBookingRequest,
  listSlotBookingCounts,
  setServiceAcceptedPetTypes,
} from '../db/repo';
import { checkAvailability, estimateCost, rowsToCapacityEvents } from '../lib/availability';
import { SERVICE_TEMPLATES, type TemplateId } from '../lib/services';
import type { Tenant, TenantService, TenantServiceOption } from '../types';
import { createTestEnv, endUserToken, seedPets, TENANT_A, TENANT_B } from './helpers';

/** Authenticated availability quote. Every caller supplies REAL pet ids: there is no pet-count
 *  param any more, by design (design spec §5). */
async function quote(
  env: Env,
  slug: string,
  query: string,
  petIds: string[],
  email = 'jess@example.com',
): Promise<Response> {
  const token = await endUserToken(env, slug, email);
  const sep = query.includes('?') ? '&' : '&';
  return app.request(
    `/api/${slug}/availability?${query}${sep}petIds=${petIds.join(',')}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

/** A TenantService row cloned from a built-in template, as the migration/seed produces. */
function svc(type: TemplateId, over: Partial<TenantService> = {}): TenantService {
  const tpl = SERVICE_TEMPLATES[type];
  return {
    TenantId: TENANT_A,
    ServiceType: type,
    Enabled: 1,
    Label: tpl.label,
    Icon: tpl.icon,
    Description: null,
    Shape: tpl.shape,
    RateUnit: tpl.rateUnit,
    HasDuration: tpl.hasDuration ? 1 : 0,
    CapacityKind: tpl.capacityKind,
    SortOrder: 0,
    Questions: [],
    MaxNights: null,
    MaxPetCount: null,
    MinLeadDays: null,
    AcceptedPetTypes: null,
    MaxConcurrentPets: null,
    CancellationTiers: null,
    HolidayRate: null,
    // 'exact' on purpose: this fixture is the DEFAULT service, and every pricing
    // assertion below is written against the refusing mode. A 'linear' service must be
    // asked for explicitly (`svc('boarding', { PetRateMode: 'linear' })`), so no existing
    // expectation can quietly change meaning when the multiplier lands.
    PetRateMode: 'exact',
    ...over,
  };
}

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    Id: TENANT_A,
    Slug: 'sunny-paws',
    DisplayName: 'Sunny Paws',
    AccentColor: '#000000',
    Timezone: null,
    ContactEmail: null,
    ContactPhone: null,
    MaxAdvanceMonths: null,
    DisabledAt: null,
    ...over,
  };
}

describe('availability API — regression guards', () => {
  it('rejects a pet count over the service cap even on an empty calendar', async () => {
    const { env, raw } = createTestEnv();
    // No existing rows in 2027; the range walk skips empty days, so the isolation check must catch it.
    // 5 pets is within the absolute cap (50) but over the boarding service's MaxConcurrentPets of 2 (seeded).
    const extra = seedPets(raw, TENANT_A, 'eu_sp_jess', [
      { id: 'pet_sp_t1_a', petType: 'dog' },
      { id: 'pet_sp_t1_b', petType: 'dog' },
      { id: 'pet_sp_t1_c', petType: 'dog' },
    ]);
    const res = (await (
      await quote(env, 'sunny-paws', 'type=boarding&start=2027-03-01&end=2027-03-04', [
        'pet_sp_bella',
        'pet_sp_mochi',
        ...extra,
      ])
    ).json()) as { available: boolean };
    expect(res.available).toBe(false);
  });

  it('rejects an impossible calendar date instead of computing negative nights', async () => {
    const { env } = createTestEnv();
    const res = await quote(env, 'sunny-paws', 'type=boarding&start=2027-02-30&end=2027-03-01', [
      'pet_sp_bella',
    ]);
    expect(res.status).toBe(400);
  });

  it('rejects an over-long range', async () => {
    const { env } = createTestEnv();
    const res = await quote(env, 'sunny-paws', 'type=boarding&start=2027-01-01&end=2099-01-01', [
      'pet_sp_bella',
    ]);
    expect(res.status).toBe(400);
  });

  it('sees a booking that starts exactly on the checkout day (fetch-window +1)', async () => {
    const { env } = createTestEnv();
    // Sunny Paws max 2. Existing: 1 pet Mar 8→12, and 2 pets starting EXACTLY on Mar 12 (→15).
    // A 2-pet request Mar 11→12: its last night (Mar 11) is full (1+2>2); the soft-bookend
    // look-ahead at Mar 12 must see the full next-day booking and keep the conflict — which
    // only works if the capacity fetch reaches one day past checkout.
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2027-03-08',
      endDate: '2027-03-12',
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2027-03-12',
      endDate: '2027-03-15',
      optionKey: null,
      petCount: 2,
      estCost: null,
      status: 'confirmed',
    });
    const res = (await (
      await quote(env, 'sunny-paws', 'type=boarding&start=2027-03-11&end=2027-03-12', [
        'pet_sp_bella',
        'pet_sp_mochi',
      ])
    ).json()) as { available: boolean };
    expect(res.available).toBe(false);
  });

  it('the same dates differ between tenants because capacity is per-tenant', async () => {
    const { env, raw } = createTestEnv();
    seedPets(raw, TENANT_B, 'eu_ht_jess', [{ id: 'pet_ht_pip', petType: 'dog' }]);
    // Happy Tails prices a pair of dogs at the same $40/night as one dog — an EXPLICIT sitter
    // choice, which is the only way a 2-pet set gets a price at all now.
    raw
      .prepare(
        `INSERT INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate)
         VALUES (?, 'boarding', 'standard', 'dog:2', 40)`,
      )
      .run(TENANT_B);
    // Seed: Jun 20-25 has 1 pet at Sunny Paws (max 2) and 2 pets at Happy Tails (max 4).
    // A 2-pet request fits Happy Tails (2+2=4) but not Sunny Paws (1+2>2).
    const query = 'type=boarding&start=2028-06-21&end=2028-06-24';
    const a = (await (
      await quote(env, 'sunny-paws', query, ['pet_sp_bella', 'pet_sp_mochi'])
    ).json()) as { available: boolean };
    const b = (await (
      await quote(env, 'happy-tails', query, ['pet_ht_otis', 'pet_ht_pip'])
    ).json()) as { available: boolean; estCost: number; nights: number };
    expect(a.available).toBe(false);
    expect(b.available).toBe(true);
    expect(b.nights).toBe(3);
    expect(b.estCost).toBe(120); // $40/night × 3 nights
  });

  it('walks are rejected only on blocked days', async () => {
    const { env } = createTestEnv();
    // Jul 3 is blocked in seed; Jun 21 has boarding but walks ignore boarding load.
    const onBlocked = (await (
      await quote(env, 'sunny-paws', 'type=walk&start=2028-07-03', ['pet_sp_bella'])
    ).json()) as { available: boolean };
    const onBusy = (await (
      await quote(env, 'sunny-paws', 'type=walk&start=2028-06-21', ['pet_sp_bella'])
    ).json()) as { available: boolean; estCost: number };
    expect(onBlocked.available).toBe(false);
    expect(onBusy.available).toBe(true);
    expect(onBusy.estCost).toBe(20); // first walk option (30 min) at $20/visit
  });

  it('validates inputs', async () => {
    const { env } = createTestEnv();
    const badType = await quote(env, 'sunny-paws', 'type=spa&start=2028-08-01', ['pet_sp_bella']);
    const badDate = await quote(env, 'sunny-paws', 'type=walk&start=tomorrow', ['pet_sp_bella']);
    const badRange = await quote(
      env,
      'sunny-paws',
      'type=boarding&start=2028-08-05&end=2028-08-05',
      ['pet_sp_bella'],
    );
    expect(badType.status).toBe(400);
    expect(badDate.status).toBe(400);
    expect(badRange.status).toBe(400);
  });

  it('the public quote enforces the service MaxNights (F3 fix — quote and booking now agree)', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `UPDATE TenantServices SET MaxNights = 3 WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'boarding'`,
      )
      .run();
    const res = await quote(env, 'sunny-paws', 'type=boarding&start=2027-06-01&end=2027-06-08', [
      'pet_sp_bella',
    ]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Stays are limited to 3 nights.');
  });

  it('the public quote enforces the service MaxPetCount — same rule, same refusal shape as the booking POST', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `UPDATE TenantServices SET MaxPetCount = 1 WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'boarding'`,
      )
      .run();
    const res = await quote(env, 'sunny-paws', 'type=boarding&start=2027-06-01&end=2027-06-03', [
      'pet_sp_bella',
      'pet_sp_mochi',
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('This service allows at most 1 pet.');
  });

  it('the public quote runs pet-type acceptance before pricing — a cat against a dogs-only service gets the acceptance message, not unpriced-pet-set', async () => {
    const { env } = createTestEnv();
    await setServiceAcceptedPetTypes(env.PAWBOOK_DB, TENANT_A, 'boarding', ['dog']);
    // Bella (dog) + Mochi (cat), no dog+cat mix rate seeded: absent the acceptance gate, this
    // 2-pet set would fall through to estimateCost and get refused as unpriced-pet-set instead.
    const res = await quote(env, 'sunny-paws', 'type=boarding&start=2027-06-01&end=2027-06-03', [
      'pet_sp_bella',
      'pet_sp_mochi',
    ]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Boarding doesn't accept cats — Mochi can't join this booking.");
  });
});

describe('rowsToCapacityEvents', () => {
  it('maps blocked rows to blocked events and keeps pet counts', () => {
    const events = rowsToCapacityEvents([
      {
        Id: '1',
        TenantId: 't',
        EndUserId: null,
        ServiceType: 'blocked',
        StartDate: '2028-08-01',
        EndDate: '2028-08-03',
        OptionKey: null,
        PetCount: 1,
        StartTime: null,
        GCalEventId: null,
        EstCost: null,
        CancellationFee: null,
        Status: 'confirmed',
        CreatedAt: '',
        CapacityKind: null,
      },
      {
        Id: '2',
        TenantId: 't',
        EndUserId: 'u',
        ServiceType: 'boarding',
        StartDate: '2028-08-04',
        EndDate: '2028-08-06',
        OptionKey: null,
        PetCount: 2,
        StartTime: null,
        GCalEventId: null,
        EstCost: 100,
        CancellationFee: null,
        Status: 'pending',
        CreatedAt: '',
        CapacityKind: 'boarding',
      },
    ]);
    expect(events[0]).toMatchObject({
      kind: 'blocked',
      start_date: '2028-08-01',
    });
    expect(events[1]).toMatchObject({ kind: 'boarding', serviceType: 'boarding', petCount: 2 });
  });
});

describe('config + availability — service options and pet types', () => {
  it('config exposes services with options and accepted pet types', async () => {
    const { env } = createTestEnv();
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      petTypes: { slug: string }[];
      services: {
        type: string;
        hasDuration: boolean;
        options: { optionKey: string; rate: number }[];
      }[];
    };
    expect(cfg.petTypes.map((p) => p.slug)).toEqual(expect.arrayContaining(['dog', 'cat']));
    const walk = cfg.services.find((s) => s.type === 'walk')!;
    expect(walk.hasDuration).toBe(true);
    expect(walk.options.map((o) => o.optionKey)).toEqual(['d30', 'd60', 'd90']);
  });

  it('availability picks the requested option price', async () => {
    const { env } = createTestEnv();
    const r = (await (
      await quote(env, 'sunny-paws', 'type=walk&option=d60&start=2028-08-01', ['pet_sp_bella'])
    ).json()) as { available: boolean; estCost: number };
    expect(r).toMatchObject({ available: true, estCost: 35 });
  });

  it('rejects an unknown option', async () => {
    const { env } = createTestEnv();
    const r = await quote(env, 'sunny-paws', 'type=walk&option=nope&start=2028-08-01', [
      'pet_sp_bella',
    ]);
    expect(r.status).toBe(400);
  });
});

/** An option row. `Rate` is what the sitter typed; there is no per-option billing unit to set —
 *  `TenantServiceOption` has no `RateUnit` (the retired column is not selected), so the BILLING
 *  unit can only be the service's, and cost tests vary the service and keep the option fixed. */
function opt(over: Partial<TenantServiceOption>): TenantServiceOption {
  return {
    Id: 'o',
    TenantId: TENANT_A,
    ServiceType: 'walk',
    OptionKey: 'd30',
    Label: '30 minutes',
    DurationMinutes: 30,
    Rate: 20,
    StartTime: null,
    EndTime: null,
    Capacity: null,
    WeekdaysOnly: 0,
    ...over,
  };
}

/** A single pet with no stored rate — the common case exercised through this file's direct
 *  `checkAvailability`/`estimateCost` calls, which still falls through to the option's flat rate
 *  (spec §2 step 3). Distinct fixture pets for the multi-pet capacity-only tests below, since
 *  those exercise the capacity fast path / conflict check, which returns before pricing runs. */
const onePet = [{ id: 'p_avail_1', petType: 'dog' }];
const twoPets = [
  { id: 'p_avail_1', petType: 'dog' },
  { id: 'p_avail_2', petType: 'dog' },
];
const threePets = [
  { id: 'p_avail_1', petType: 'dog' },
  { id: 'p_avail_2', petType: 'dog' },
  { id: 'p_avail_3', petType: 'dog' },
];
const noRates = { groupRates: [], mixRates: [] };

describe('checkAvailability', () => {
  it('single-visit cost is the picked option price (no nights math)', async () => {
    const { env } = createTestEnv();
    const t = tenant();
    const res = await checkAvailability(
      env,
      t,
      svc('walk'),
      opt({ Rate: 35 }),
      '2028-08-01',
      '',
      onePet,
      noRates,
    );
    expect(res).toMatchObject({ available: true, estCost: 35 });
  });

  it('range cost is option price times nights', async () => {
    const { env } = createTestEnv();
    const t = tenant();
    const o = opt({
      ServiceType: 'boarding',
      OptionKey: 'standard',
      DurationMinutes: null,
      Rate: 50,
    });
    const res = await checkAvailability(
      env,
      t,
      svc('boarding'),
      o,
      '2028-08-10',
      '2028-08-13',
      onePet,
      noRates,
    );
    expect(res).toMatchObject({ available: true, estCost: 150, nights: 3 });
  });

  it('house-sit conflicts when it overlaps existing boarding by more than a day', async () => {
    const { env } = createTestEnv();
    const t = tenant(); // housesit cap null = unlimited; conflict must come from overlap rule
    const o = opt({
      ServiceType: 'housesitting',
      OptionKey: 'standard',
      DurationMinutes: null,
      Rate: 70,
    });
    // Seed: 1 pet boarding Jun 20-25. A house-sit Jun 21-23 overlaps boarding on Jun 21 AND 22.
    const res = await checkAvailability(
      env,
      t,
      svc('housesitting'),
      o,
      '2028-06-21',
      '2028-06-23',
      twoPets,
      noRates,
    );
    expect(res).toMatchObject({ available: false });
    expect(SERVICE_TEMPLATES.housesitting.shape).toBe('range');
  });

  it('unlimited tenant (paws-and-relax) accepts overlapping boardings', async () => {
    const { env, raw } = createTestEnv();
    await insertBookingRequest(env.PAWBOOK_DB, 'tnt_pawsandrelax', {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2028-05-01',
      endDate: '2028-05-10',
      optionKey: 'standard',
      petCount: 8,
      estCost: null,
      status: 'confirmed',
    });
    // Seed already has one owned pet (pet_pr_luna) for eu_pr_jess; seed 8 more for a 9-pet quote.
    const extra = seedPets(
      raw,
      'tnt_pawsandrelax',
      'eu_pr_jess',
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => ({ id: `pet_pr_${s}`, petType: 'dog' })),
    );
    const res = (await (
      await quote(env, 'paws-and-relax', 'type=boarding&start=2028-05-02&end=2028-05-06', [
        'pet_pr_luna',
        ...extra,
      ])
    ).json()) as { available: boolean };
    expect(res.available).toBe(true);
  });

  it('rejects once a windowed option hits its capacity, ignoring cancelled bookings', async () => {
    const { env, raw } = createTestEnv();
    const t = tenant();
    const slotOption = opt({ OptionKey: 'morning-walk', Capacity: 2 });

    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-01',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'pending',
    });
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-01',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'confirmed',
    });
    const cancelledId = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-01',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'pending',
    });
    raw.prepare('UPDATE BookingRequests SET Status = ? WHERE Id = ?').run('cancelled', cancelledId);

    const full = await checkAvailability(
      env,
      t,
      svc('walk'),
      slotOption,
      '2028-09-01',
      '',
      onePet,
      noRates,
    );
    expect(full).toMatchObject({ available: false });

    const otherDate = await checkAvailability(
      env,
      t,
      svc('walk'),
      slotOption,
      '2028-09-02',
      '',
      onePet,
      noRates,
    );
    expect(otherDate).toMatchObject({ available: true });
  });

  it('slot capacity counts pets, not bookings (SUM(PetCount))', async () => {
    const { env } = createTestEnv();
    const t = tenant();
    const slotOption = opt({ OptionKey: 'morning-walk', Capacity: 4 });

    // One 2-pet booking: 2 of 4 pets used → still available.
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-01',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 2,
      startTime: '11:00',
      estCost: null,
      status: 'confirmed',
    });
    const partial = await checkAvailability(
      env,
      t,
      svc('walk'),
      slotOption,
      '2028-09-01',
      '',
      onePet,
      noRates,
    );
    expect(partial).toMatchObject({ available: true });

    // A second 2-pet booking fills the 4-pet slot → full.
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-01',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 2,
      startTime: '11:00',
      estCost: null,
      status: 'confirmed',
    });
    const full = await checkAvailability(
      env,
      t,
      svc('walk'),
      slotOption,
      '2028-09-01',
      '',
      onePet,
      noRates,
    );
    expect(full).toMatchObject({ available: false });
  });

  it('house-sit pool cap is read from MaxConcurrentPets, in pets', async () => {
    const { env } = createTestEnv();
    const t = tenant();
    const o = opt({
      ServiceType: 'housesitting',
      OptionKey: 'standard',
      DurationMinutes: null,
      Rate: 70,
    });
    // House-sit service with a 2-pet cap and one existing 2-pet sit (Aug, no boarding overlap).
    const service = svc('housesitting', { MaxConcurrentPets: 2 });
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'housesitting',
      startDate: '2028-08-10',
      endDate: '2028-08-14',
      optionKey: 'standard',
      petCount: 2,
      estCost: null,
      status: 'confirmed',
    });
    // A 1-pet sit overlapping mid-range: 2 + 1 > 2 → blocked.
    const blocked = await checkAvailability(
      env,
      t,
      service,
      o,
      '2028-08-11',
      '2028-08-13',
      onePet,
      noRates,
    );
    expect(blocked).toMatchObject({ available: false });

    // A 3-pet sit against a cap of 2 fails the fast path even on empty dates.
    const overCap = await checkAvailability(
      env,
      t,
      service,
      o,
      '2028-08-20',
      '2028-08-22',
      threePets,
      noRates,
    );
    expect(overCap).toMatchObject({ available: false });
    expect((overCap as { reason: string }).reason).toBe('That exceeds our house-sitting capacity.');
  });
});

describe('estimateCost — PriceResult, and the refusal arm', () => {
  const bella = { id: 'pet_sp_bella', petType: 'dog' };
  const mochi = { id: 'pet_sp_mochi', petType: 'cat' };
  const noRates = { groupRates: [], mixRates: [] };

  it('one pet with no stored rate falls back to the option rate — today unchanged', () => {
    const res = estimateCost(
      svc('boarding'),
      opt({ Rate: 50 }),
      '2028-08-10',
      '2028-08-13',
      [bella],
      noRates,
    );
    expect(res).toEqual({ priced: true, cost: 150, billedUnits: 3, unit: 'night' });
  });

  it('TWO pets with no stored rate REFUSE — no price, and never a coerced 0', () => {
    const res = estimateCost(
      svc('boarding'),
      opt({ Rate: 50 }),
      '2028-08-10',
      '2028-08-13',
      [bella, mochi],
      noRates,
    );
    expect(res.priced).toBe(false);
    expect(res).toMatchObject({
      reason: 'unpriced-pet-set',
      groupKey: 'pet_sp_bella,pet_sp_mochi',
      mixKey: 'cat:1|dog:1',
    });
    expect(res).not.toHaveProperty('cost');
  });

  it('a species-mix rate prices the exact set — and is NOT multiplied by anything', () => {
    const res = estimateCost(
      svc('boarding'),
      opt({ ServiceType: 'boarding', OptionKey: 'standard', Rate: 50 }),
      '2028-08-10',
      '2028-08-13',
      [bella, { id: 'p_rex', petType: 'dog' }],
      {
        groupRates: [],
        mixRates: [{ mixKey: 'dog:2', rate: 70, serviceType: 'boarding', optionKey: 'standard' }],
      },
    );
    // $70/night for the PAIR × 3 nights. Not 2 × $70, not $50 + $70, not $50 × 2.
    expect(res).toEqual({ priced: true, cost: 210, billedUnits: 3, unit: 'night' });
  });

  it('a pet-id group rate BEATS a species rate for the same set', () => {
    const res = estimateCost(
      svc('boarding'),
      opt({ ServiceType: 'boarding', OptionKey: 'standard', Rate: 50 }),
      '2028-08-10',
      '2028-08-11',
      [bella, mochi],
      {
        groupRates: [
          {
            groupKey: 'pet_sp_bella,pet_sp_mochi',
            rate: 65,
            serviceType: 'boarding',
            optionKey: 'standard',
          },
        ],
        mixRates: [
          { mixKey: 'cat:1|dog:1', rate: 80, serviceType: 'boarding', optionKey: 'standard' },
        ],
      },
    );
    expect(res).toEqual({ priced: true, cost: 65, billedUnits: 1, unit: 'night' });
  });

  it('a rate for ANOTHER option of the same service never leaks in', () => {
    const res = estimateCost(
      svc('walk'),
      opt({ OptionKey: 'd60', Rate: 35 }),
      '2028-08-01',
      '2028-08-01',
      [bella, { id: 'p_rex', petType: 'dog' }],
      {
        groupRates: [],
        mixRates: [{ mixKey: 'dog:2', rate: 55, serviceType: 'walk', optionKey: 'd30' }],
      },
    );
    expect(res.priced).toBe(false);
  });

  it('a single-day service carries a price but no quantity — the flat charge is unchanged', () => {
    const res = estimateCost(
      svc('walk'),
      opt({ Rate: 20 }),
      '2028-08-01',
      '2028-08-01',
      [bella],
      noRates,
    );
    expect(res).toEqual({ priced: true, cost: 20 });
  });

  it('an EMPTY pet set is refused, never priced at the option rate', () => {
    const res = estimateCost(
      svc('walk'),
      opt({ Rate: 20 }),
      '2028-08-01',
      '2028-08-01',
      [],
      noRates,
    );
    expect(res).toMatchObject({ priced: false, groupKey: '', mixKey: '' });
  });

  it('a repeated pet id is ONE pet, so it keeps the single-pet fallback', () => {
    const res = estimateCost(
      svc('walk'),
      opt({ Rate: 20 }),
      '2028-08-01',
      '2028-08-01',
      [bella, bella],
      noRates,
    );
    expect(res).toEqual({ priced: true, cost: 20 });
  });
});

/**
 * `PetRateMode` (0005) is the ONE sanctioned route by which a pet COUNT reaches the price path,
 * and it is reachable only because the sitter stored the choice. Every test here has a sibling in
 * the block above asserting the same input under `'exact'`: the pair is the lock. Deleting either
 * half leaves "refuses" or "multiplies" untested and the boundary between them unguarded.
 */
describe('estimateCost — PetRateMode: multiplication ONLY where the sitter opted in', () => {
  const bella = { id: 'pet_sp_bella', petType: 'dog' };
  const mochi = { id: 'pet_sp_mochi', petType: 'cat' };
  const rex = { id: 'p_rex', petType: 'dog' };
  const noRates = { groupRates: [], mixRates: [] };
  const linearBoarding = svc('boarding', { PetRateMode: 'linear' });

  it("the DEFAULT fixture is 'exact' — the multiplier is opt-in, never the ambient behaviour", () => {
    expect(svc('boarding').PetRateMode).toBe('exact');
    expect(
      estimateCost(
        svc('boarding'),
        opt({ Rate: 50 }),
        '2028-08-10',
        '2028-08-13',
        [bella, mochi],
        noRates,
      ),
    ).toMatchObject({ priced: false, reason: 'unpriced-pet-set' });
  });

  it("under 'linear', two pets with no stored rate cost exactly twice the one-pet price", () => {
    const one = estimateCost(
      linearBoarding,
      opt({ Rate: 50 }),
      '2028-08-10',
      '2028-08-13',
      [bella],
      noRates,
    );
    const two = estimateCost(
      linearBoarding,
      opt({ Rate: 50 }),
      '2028-08-10',
      '2028-08-13',
      [bella, mochi],
      noRates,
    );
    // 3 nights x $50 = $150 for one pet; x2 pets = $300. The quantity fields do NOT double:
    // three nights are three nights however many dogs sleep through them.
    expect(one).toEqual({ priced: true, cost: 150, billedUnits: 3, unit: 'night' });
    expect(two).toEqual({ priced: true, cost: 300, billedUnits: 3, unit: 'night' });
  });

  it("under 'linear', a STORED pet-set rate still wins — a typed rate is never multiplied", () => {
    // The sitter typed "$70/night for two dogs". Multiplying it would charge $140 for a pair she
    // deliberately priced at $70 — the exact "price they did not agree to" this feature guards.
    const res = estimateCost(
      svc('boarding', { PetRateMode: 'linear' }),
      opt({ ServiceType: 'boarding', OptionKey: 'standard', Rate: 50 }),
      '2028-08-10',
      '2028-08-13',
      [bella, rex],
      {
        groupRates: [],
        mixRates: [{ mixKey: 'dog:2', rate: 70, serviceType: 'boarding', optionKey: 'standard' }],
      },
    );
    expect(res).toEqual({ priced: true, cost: 210, billedUnits: 3, unit: 'night' }); // 70x3, not 140x3
  });

  it("under 'linear', a stored pet-ID group rate also wins over the multiplier", () => {
    const res = estimateCost(
      svc('boarding', { PetRateMode: 'linear' }),
      opt({ ServiceType: 'boarding', OptionKey: 'standard', Rate: 50 }),
      '2028-08-10',
      '2028-08-11',
      [bella, mochi],
      {
        groupRates: [
          {
            groupKey: 'pet_sp_bella,pet_sp_mochi',
            rate: 65,
            serviceType: 'boarding',
            optionKey: 'standard',
          },
        ],
        mixRates: [],
      },
    );
    expect(res).toEqual({ priced: true, cost: 65, billedUnits: 1, unit: 'night' }); // not 100
  });

  it("under 'linear', ONE pet is untouched — x1 is not a price change", () => {
    expect(
      estimateCost(linearBoarding, opt({ Rate: 50 }), '2028-08-10', '2028-08-13', [bella], noRates),
    ).toEqual(
      estimateCost(
        svc('boarding'),
        opt({ Rate: 50 }),
        '2028-08-10',
        '2028-08-13',
        [bella],
        noRates,
      ),
    );
  });

  it("under 'linear', a repeated pet id is still ONE pet — a duplicate cannot double a price", () => {
    const res = estimateCost(
      svc('walk', { PetRateMode: 'linear' }),
      opt({ Rate: 20 }),
      '2028-08-01',
      '2028-08-01',
      [bella, bella],
      noRates,
    );
    expect(res).toEqual({ priced: true, cost: 20 });
  });

  it("under 'linear', an EMPTY pet set is STILL refused — the multiplier never manufactures a $0", () => {
    const res = estimateCost(
      svc('walk', { PetRateMode: 'linear' }),
      opt({ Rate: 20 }),
      '2028-08-01',
      '2028-08-01',
      [],
      noRates,
    );
    expect(res).toMatchObject({ priced: false, reason: 'unpriced-pet-set' });
    expect(res).not.toHaveProperty('cost');
  });

  it('an UNRECOGNISED stored mode reads as refusing, not as multiplying', () => {
    // Bad data (a hand-edited row, a future value rolled back) must fail toward "no price", never
    // toward inventing one. The branch compares against 'linear' explicitly for this reason.
    const weird = svc('boarding', { PetRateMode: 'sliding' as unknown as 'exact' });
    expect(
      estimateCost(weird, opt({ Rate: 50 }), '2028-08-10', '2028-08-13', [bella, mochi], noRates),
    ).toMatchObject({ priced: false, reason: 'unpriced-pet-set' });
  });

  it('scales the WHOLE cost including the holiday leg — the pets are not free on Christmas', () => {
    // Dec 24 -> Dec 27 = 3 nights, 2 of them holiday-priced (Eve + Day, named by check-in date).
    // One dog: $40 + 2 x $90 = $220. Two dogs on a 'linear' service: $440.
    const holiday = { HolidayRate: 90 } as const;
    const one = estimateCost(
      svc('boarding', { ...holiday, PetRateMode: 'linear' }),
      opt({ Rate: 40 }),
      '2029-12-24',
      '2029-12-27',
      [bella],
      noRates,
    );
    const two = estimateCost(
      svc('boarding', { ...holiday, PetRateMode: 'linear' }),
      opt({ Rate: 40 }),
      '2029-12-24',
      '2029-12-27',
      [bella, mochi],
      noRates,
    );
    expect(one).toMatchObject({ priced: true, cost: 220, holidayUnits: 2, holidayRate: 90 });
    expect(two).toMatchObject({ priced: true, cost: 440, holidayUnits: 2, holidayRate: 90 });
    // The BREAKDOWN is unchanged by pet count: 2 holiday nights, one stored $90 rate. Only the
    // total scales — `holiday-cost.ts` still never sees a pet.
    expect((two as { holidayUnits: number }).holidayUnits).toBe(
      (one as { holidayUnits: number }).holidayUnits,
    );
    // And the same stay on the DEFAULT 'exact' service is refused outright, not holiday-tripled.
    expect(
      estimateCost(
        svc('boarding', holiday),
        opt({ Rate: 40 }),
        '2029-12-24',
        '2029-12-27',
        [bella, mochi],
        noRates,
      ),
    ).toMatchObject({ priced: false });
  });

  it('the multiplier is x N and nothing else — three pets is exactly 3x, never 2.5x or 3x+fee', () => {
    const base = estimateCost(
      linearBoarding,
      opt({ Rate: 50 }),
      '2028-08-10',
      '2028-08-13',
      [bella],
      noRates,
    ) as { cost: number };
    for (const n of [2, 3, 4, 5]) {
      const pets = Array.from({ length: n }, (_, i) => ({ id: `p_${i}`, petType: 'dog' }));
      const res = estimateCost(
        linearBoarding,
        opt({ Rate: 50 }),
        '2028-08-10',
        '2028-08-13',
        pets,
        noRates,
      ) as { cost: number };
      expect(res.cost).toBe(base.cost * n);
    }
  });
});

describe('estimateCost — the billing unit is the service’s RateUnit, not a hardcoded constant', () => {
  // THE test that must never break: every service that exists today is night-billed, so this
  // change must not move a single price. Numbers are the seeded rates (sql/seed.sql).
  it('regression lock — night-unit range services bill exactly nights, at the seeded rates', () => {
    expect(
      estimateCost(svc('boarding'), opt({ Rate: 50 }), '2028-08-10', '2028-08-13', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 150 }); // 3 nights
    expect(
      estimateCost(svc('boarding'), opt({ Rate: 40 }), '2028-06-21', '2028-06-24', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 120 }); // Happy Tails
    expect(
      estimateCost(
        svc('housesitting'),
        opt({ Rate: 70 }),
        '2028-08-10',
        '2028-08-15',
        onePet,
        noRates,
      ),
    ).toMatchObject({ priced: true, cost: 350 }); // 5 nights
    expect(
      estimateCost(svc('boarding'), opt({ Rate: 50 }), '2028-08-10', '2028-08-11', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 50 }); // 1 night
    // Degenerate 0-night range still bills the 1-night floor (billableUnits' Math.max(1, …)).
    expect(
      estimateCost(svc('boarding'), opt({ Rate: 50 }), '2028-08-10', '2028-08-10', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 50 });
    // Both built-in range templates are night-billed — the premise of the lock above.
    expect(SERVICE_TEMPLATES.boarding.rateUnit).toBe('night');
    expect(SERVICE_TEMPLATES.housesitting.rateUnit).toBe('night');
  });

  it('a day-unit range service bills nights + 1 (the departure day is chargeable)', () => {
    const dayBoarding = svc('boarding', { ServiceType: 'day-boarding', RateUnit: 'day' });
    // Apr 10 → Apr 13 is 3 nights = 4 chargeable DAYS at $30 → $120, not $90.
    expect(
      estimateCost(dayBoarding, opt({ Rate: 30 }), '2029-04-10', '2029-04-13', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 120 });
    // A same-day day-unit range is 1 day, never 2.
    expect(
      estimateCost(dayBoarding, opt({ Rate: 30 }), '2029-04-10', '2029-04-10', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 30 });
  });

  it('single-shape services return the flat option rate whatever their RateUnit', () => {
    expect(
      estimateCost(svc('walk'), opt({ Rate: 20 }), '2028-08-01', '', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 20 });
    expect(
      estimateCost(svc('checkin'), opt({ Rate: 12 }), '2028-08-01', '', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 12 });
    // daycare is the shape:'single' + rateUnit:'day' pairing — flat rate, no nights math.
    expect(
      estimateCost(svc('daycare'), opt({ Rate: 40 }), '2028-08-01', '', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 40 });
  });

  it('an unexpected RateUnit on a range service falls back to per-night (never inflates a bill)', () => {
    // 'visit' can only reach a range service through bad data; the mapping must be total.
    const odd = svc('boarding', { RateUnit: 'visit' });
    expect(
      estimateCost(odd, opt({ Rate: 50 }), '2028-08-10', '2028-08-13', onePet, noRates),
    ).toMatchObject({ priced: true, cost: 150 }); // 3 nights, not 4
  });
});

describe('the quote’s quantity is unit-aware (billedUnits + unit)', () => {
  const RANGE_OPT = {
    ServiceType: 'boarding',
    OptionKey: 'standard',
    DurationMinutes: null,
  } as const;

  it('regression lock — a night-billed range service still bills nights, and says so', async () => {
    const { env } = createTestEnv();
    const res = await checkAvailability(
      env,
      tenant(),
      svc('boarding'), // template rateUnit: 'night'
      opt({ ...RANGE_OPT, Rate: 50 }),
      '2028-08-10',
      '2028-08-13',
      onePet,
      noRates,
    );
    // `nights` is untouched, and the new quantity equals it — today's behavior, restated.
    expect(res).toMatchObject({ available: true, estCost: 150, nights: 3, billedUnits: 3 });
    expect(res).toMatchObject({ unit: 'night' });
  });

  it('a day-billed range service reports nights + 1 days, not nights', async () => {
    const { env } = createTestEnv();
    const res = await checkAvailability(
      env,
      tenant(),
      svc('boarding', { ServiceType: 'day-boarding', RateUnit: 'day' }),
      opt({ ...RANGE_OPT, ServiceType: 'day-boarding', Rate: 30 }),
      '2029-04-10',
      '2029-04-13',
      onePet,
      noRates,
    );
    // 3 nights = 4 chargeable days. `nights` keeps its own meaning (3) for wire compatibility.
    expect(res).toMatchObject({ available: true, estCost: 120, nights: 3, billedUnits: 4 });
    expect(res).toMatchObject({ unit: 'day' });
  });

  it('estCost is always rate × billedUnits, so the number and the price cannot drift', async () => {
    const { env } = createTestEnv();
    const cases = [
      {
        service: svc('boarding'),
        rate: 50,
        unit: 'night' as const,
        start: '2028-08-10',
        end: '2028-08-13',
      },
      {
        service: svc('housesitting'),
        rate: 70,
        unit: 'night' as const,
        start: '2028-08-10',
        end: '2028-08-15',
      },
      {
        service: svc('boarding', { ServiceType: 'day-boarding', RateUnit: 'day' }),
        rate: 30,
        unit: 'day' as const,
        start: '2029-04-10',
        end: '2029-04-13',
      },
      {
        service: svc('boarding', { ServiceType: 'day-boarding-1', RateUnit: 'day' }),
        rate: 30,
        unit: 'day' as const,
        start: '2029-04-10',
        end: '2029-04-10', // degenerate same-day range: 1 day, never 2
      },
    ];
    for (const c of cases) {
      const res = await checkAvailability(
        env,
        tenant(),
        c.service,
        opt({ ...RANGE_OPT, ServiceType: c.service.ServiceType, Rate: c.rate }),
        c.start,
        c.end,
        onePet,
        noRates,
      );
      expect(res.available).toBe(true);
      const ok = res as { estCost: number; billedUnits?: number; unit?: string };
      expect(ok.unit).toBe(c.unit);
      expect(c.rate * ok.billedUnits!).toBe(ok.estCost);
    }
  });

  it('single-day services carry no quantity at all — a flat per-booking charge', async () => {
    const { env } = createTestEnv();
    const res = await checkAvailability(
      env,
      tenant(),
      svc('walk'),
      opt({ Rate: 20 }),
      '2028-08-01',
      '',
      onePet,
      noRates,
    );
    expect(res).toMatchObject({ available: true, estCost: 20 });
    // Deliberately absent (like `nights`): there is no quantity to bill, so there is nothing
    // for the widget to label.
    const ok = res as { billedUnits?: number; unit?: string };
    expect(ok.billedUnits).toBeUndefined();
    expect(ok.unit).toBeUndefined();
  });
});

describe('no inferred pricing — an unpriced multi-pet set is REFUSED, never inferred', () => {
  /**
   * >>> DELIBERATE INVERSION of the pre-PR-3 lock, 'the API quote is identical for 1 pet and 3
   * pets, yet 5 pets is refused'. That test asserted the quote payload was IDENTICAL for 1 and 3
   * pets, which was the correct guarantee while pets could not reach the price path at all. They
   * can now: a pet set selects a STORED rate. The invariant did not weaken — it got sharper. What
   * used to be "pet count is ignored" is now "pet count is never ARITHMETIC": three dogs are
   * either priced by a rate the sitter typed for three dogs, or they are not priced at all. The
   * one thing that must never happen — the single-dog rate multiplied up — is what this block
   * now pins, from both directions.
   */
  const dates = 'type=boarding&start=2029-05-10&end=2029-05-13'; // 3 nights, clear of seeded rows

  /** Flip ONE tenant's ONE service into the opted-in multiplier, the way the admin PUT does. */
  function setLinear(
    raw: ReturnType<typeof createTestEnv>['raw'],
    tenantId: string,
    serviceType: string,
  ): void {
    raw
      .prepare(`UPDATE TenantServices SET PetRateMode='linear' WHERE TenantId=? AND ServiceType=?`)
      .run(tenantId, serviceType);
  }

  it("a three-dog quote with no three-dog rate is refused, not tripled (mode 'exact')", async () => {
    const { env, raw } = createTestEnv();
    const ids = seedPets(raw, TENANT_B, 'eu_ht_jess', [
      { id: 'pet_ht_pip', petType: 'dog' },
      { id: 'pet_ht_sam', petType: 'dog' },
    ]);
    const one = (await (await quote(env, 'happy-tails', dates, ['pet_ht_otis'])).json()) as Record<
      string,
      unknown
    >;
    const three = (await (
      await quote(env, 'happy-tails', dates, ['pet_ht_otis', ...ids])
    ).json()) as Record<string, unknown>;

    // One dog still falls back to the option rate: $40/night × 3 nights. Unchanged behaviour.
    expect(one).toMatchObject({ available: true, priced: true, estCost: 120 });
    // Three dogs: the dates are just as free, and there is NO price.
    expect(three).toMatchObject({ available: true, priced: false, reason: 'unpriced-pet-set' });
    expect(three).not.toHaveProperty('estCost');
    // The defect this whole feature exists to prevent, stated as a number:
    expect(three.estCost).not.toBe(360);
    // …and it is the DEFAULT: nobody had to configure this tenant to get the refusal.
    const stored = raw
      .prepare(`SELECT PetRateMode FROM TenantServices WHERE TenantId=? AND ServiceType='boarding'`)
      .get(TENANT_B) as { PetRateMode: string };
    expect(stored.PetRateMode).toBe('exact');
  });

  it("…and with the sitter's stored 'linear' mode, that SAME quote is exactly tripled", async () => {
    // The sibling of the test above, on the same tenant, service, dates and pets. The ONLY
    // difference is one stored column the sitter chose — which is the whole design: the number
    // 360 is legitimate here and a defect one test up, and the two must stay side by side.
    const { env, raw } = createTestEnv();
    setLinear(raw, TENANT_B, 'boarding');
    const ids = seedPets(raw, TENANT_B, 'eu_ht_jess', [
      { id: 'pet_ht_pip', petType: 'dog' },
      { id: 'pet_ht_sam', petType: 'dog' },
    ]);
    const one = (await (await quote(env, 'happy-tails', dates, ['pet_ht_otis'])).json()) as Record<
      string,
      unknown
    >;
    const three = (await (
      await quote(env, 'happy-tails', dates, ['pet_ht_otis', ...ids])
    ).json()) as Record<string, unknown>;
    expect(one).toMatchObject({ available: true, priced: true, estCost: 120 });
    expect(three).toMatchObject({ available: true, priced: true, estCost: 360 });
    // The nights did not triple with the price — only the money scales.
    expect(three.billedUnits).toBe(3);
    expect(three.unit).toBe('night');
  });

  it("a stored three-dog rate beats 'linear' at the API too — the sitter's number, not 3x", async () => {
    const { env, raw } = createTestEnv();
    setLinear(raw, TENANT_B, 'boarding');
    const ids = seedPets(raw, TENANT_B, 'eu_ht_jess', [
      { id: 'pet_ht_pip', petType: 'dog' },
      { id: 'pet_ht_sam', petType: 'dog' },
    ]);
    raw
      .prepare(
        `INSERT INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate)
         VALUES (?, 'boarding', 'standard', 'dog:3', 55)`,
      )
      .run(TENANT_B);
    const three = (await (
      await quote(env, 'happy-tails', dates, ['pet_ht_otis', ...ids])
    ).json()) as Record<string, unknown>;
    // $55/night x 3 nights = $165 — the typed trio rate, NOT $360 and not $165 x 3.
    expect(three).toMatchObject({ available: true, priced: true, estCost: 165 });
  });

  it("one tenant's 'linear' mode never leaks into another tenant's identical service", async () => {
    const { env, raw } = createTestEnv();
    // Sunny Paws opts in; Happy Tails does not. Same service slug, same option key.
    setLinear(raw, TENANT_A, 'boarding');
    const htIds = seedPets(raw, TENANT_B, 'eu_ht_jess', [{ id: 'pet_ht_pip', petType: 'dog' }]);
    const spIds = seedPets(raw, TENANT_A, 'eu_sp_jess', [{ id: 'pet_sp_pip', petType: 'dog' }]);
    const sunny = (await (
      await quote(env, 'sunny-paws', 'type=boarding&start=2029-05-10&end=2029-05-13', [
        'pet_sp_bella',
        ...spIds,
      ])
    ).json()) as Record<string, unknown>;
    const happy = (await (
      await quote(env, 'happy-tails', dates, ['pet_ht_otis', ...htIds])
    ).json()) as Record<string, unknown>;
    expect(sunny).toMatchObject({ available: true, priced: true, estCost: 300 }); // $50 x 3 x 2
    expect(happy).toMatchObject({ available: true, priced: false, reason: 'unpriced-pet-set' });
  });

  it('with an explicit three-dog rate, the price is THAT rate — not three times the single rate', async () => {
    const { env, raw } = createTestEnv();
    const ids = seedPets(raw, TENANT_B, 'eu_ht_jess', [
      { id: 'pet_ht_pip', petType: 'dog' },
      { id: 'pet_ht_sam', petType: 'dog' },
    ]);
    raw
      .prepare(
        `INSERT INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate)
         VALUES (?, 'boarding', 'standard', 'dog:3', 55)`,
      )
      .run(TENANT_B);
    const three = (await (
      await quote(env, 'happy-tails', dates, ['pet_ht_otis', ...ids])
    ).json()) as Record<string, unknown>;
    // $55/night for the trio × 3 nights = $165. NOT $120 × 3 = $360, and not $40 + $55.
    expect(three).toMatchObject({ available: true, priced: true, estCost: 165 });
  });

  it('…and pets are still genuinely READ: 5 pets is over the 4-pet cap and refused on capacity', async () => {
    const { env, raw } = createTestEnv();
    const ids = seedPets(
      raw,
      TENANT_B,
      'eu_ht_jess',
      ['a', 'b', 'c', 'd'].map((s) => ({ id: `pet_ht_${s}`, petType: 'dog' })),
    );
    const five = (await (
      await quote(env, 'happy-tails', dates, ['pet_ht_otis', ...ids])
    ).json()) as Record<string, unknown>;
    expect(five).toEqual({ available: false, reason: 'That exceeds our boarding capacity.' });
  });

  it("a HOLIDAY rate is also immune to pet count (mode 'exact')", async () => {
    const { env, raw } = createTestEnv();
    // Happy Tails boarding with an explicit holiday rate. The whole point: a holiday rate is a
    // stored rate x units of TIME. If any future change made the holiday leg pet-aware — a
    // per-pet holiday surcharge, a "×petCount" on the holiday units — this equality breaks.
    raw
      .prepare(`UPDATE TenantServices SET HolidayRate = 90 WHERE TenantId = ? AND ServiceType = ?`)
      .run(TENANT_B, 'boarding');
    // An explicit 3-dog rate EQUAL to the single-pet option rate ($40, sql/seed.sql) — real pets,
    // real petIds (design spec §5: there is no anonymous pet-COUNT any more). Resolving the same
    // base rate through two different paths (single-pet fallback vs. an explicit stored mix rate)
    // and getting an IDENTICAL holiday-priced payload is what proves the holiday leg only sees
    // units of time, never how many pets or which resolution path produced the base rate.
    const ids = seedPets(raw, TENANT_B, 'eu_ht_jess', [
      { id: 'pet_ht_pip', petType: 'dog' },
      { id: 'pet_ht_sam', petType: 'dog' },
    ]);
    raw
      .prepare(
        `INSERT INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate)
         VALUES (?, 'boarding', 'standard', 'dog:3', 40)`,
      )
      .run(TENANT_B);
    const dates = 'type=boarding&start=2029-12-24&end=2029-12-27';
    // Sequential, not Promise.all: both calls mint a session token via the same in-memory sqlite
    // handle (see helpers.ts's `batch`), which cannot run two transactions concurrently.
    const one = (await (await quote(env, 'happy-tails', dates, ['pet_ht_otis'])).json()) as Record<
      string,
      unknown
    >;
    const three = (await (
      await quote(env, 'happy-tails', dates, ['pet_ht_otis', ...ids])
    ).json()) as Record<string, unknown>;
    // Dec 24 -> Dec 27 bills nights starting Dec 24, 25, 26; Dec 24 (Eve) and Dec 25 (Day) are
    // the listed holidays, Dec 26 is not, so 2 of the 3 nights are holiday-priced.
    expect(one).toMatchObject({ available: true, priced: true, holidayUnits: 2 });
    // The WHOLE payload — including estCost, holidayUnits and holidayRate — must be identical.
    expect(three).toEqual(one);
  });

  it("…and under 'linear' the holiday leg scales too — but the BREAKDOWN never does", async () => {
    // The deliberate holiday call (documented in server/lib/holiday-cost.ts): the multiplier is
    // applied to the composed total, so a sitter who opted into "N pets cost N times as much"
    // gets that on holidays as well. What must NOT change is the breakdown — the number of
    // holiday units and the stored holiday rate are facts about the CALENDAR, not the pets.
    const { env, raw } = createTestEnv();
    setLinear(raw, TENANT_B, 'boarding');
    raw
      .prepare(`UPDATE TenantServices SET HolidayRate = 90 WHERE TenantId = ? AND ServiceType = ?`)
      .run(TENANT_B, 'boarding');
    const ids = seedPets(raw, TENANT_B, 'eu_ht_jess', [
      { id: 'pet_ht_pip', petType: 'dog' },
      { id: 'pet_ht_sam', petType: 'dog' },
    ]);
    const holidayDates = 'type=boarding&start=2029-12-24&end=2029-12-27';
    const one = (await (
      await quote(env, 'happy-tails', holidayDates, ['pet_ht_otis'])
    ).json()) as Record<string, unknown>;
    const three = (await (
      await quote(env, 'happy-tails', holidayDates, ['pet_ht_otis', ...ids])
    ).json()) as Record<string, unknown>;
    // 1 normal night at $40 + 2 holiday nights at $90 = $220 for one dog; x3 dogs = $660.
    expect(one).toMatchObject({ estCost: 220, holidayUnits: 2, holidayRate: 90 });
    expect(three).toMatchObject({ estCost: 660, holidayUnits: 2, holidayRate: 90 });
    // Still 3 billed nights, still 2 of them holidays, still ONE stored $90 rate.
    expect(three.billedUnits).toBe(one.billedUnits);
  });
});

describe('quote/stamp parity for a day-unit range service', () => {
  /** Seeds an enabled range service billed per DAY at Sunny Paws, the way a sitter would get one
   *  from a template clone (admin PUT writes the same columns). */
  function seedDayBoarding(raw: ReturnType<typeof createTestEnv>['raw']): void {
    raw
      .prepare(
        `INSERT INTO TenantServices
           (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind, SortOrder)
         VALUES (?, ?, 1, ?, 'bed', 'range', 'day', 0, 'boarding', 9)`,
      )
      .run(TENANT_A, 'day-boarding', 'Day boarding');
    raw
      .prepare(
        `INSERT INTO TenantServiceOptions
           (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate)
         VALUES (?, ?, ?, 'standard', 'Standard', NULL, 30)`,
      )
      .run('opt_sp_dayboard', TENANT_A, 'day-boarding');
  }

  it('the availability quote, the POST response, and the stored EstCost all agree', async () => {
    const { env, raw } = createTestEnv();
    seedDayBoarding(raw);

    const quoteBody = (await (
      await quote(env, 'sunny-paws', 'type=day-boarding&start=2029-04-10&end=2029-04-13', [
        'pet_sp_bella',
      ])
    ).json()) as {
      available: boolean;
      estCost: number;
      nights: number;
      billedUnits: number;
      unit: string;
    };
    expect(quoteBody).toMatchObject({ available: true, nights: 3, billedUnits: 4, unit: 'day' });
    expect(quoteBody.estCost).toBe(120); // 3 nights = 4 days × $30
    expect(quoteBody.billedUnits * 30).toBe(quoteBody.estCost); // the label and the price agree

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'day-boarding',
          startDate: '2029-04-10',
          endDate: '2029-04-13',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const booked = (await res.json()) as { id: string; estCost: number };
    expect(booked.estCost).toBe(quoteBody.estCost);

    const stored = raw
      .prepare('SELECT EstCost FROM BookingRequests WHERE Id = ?')
      .get(booked.id) as { EstCost: number } | undefined;
    expect(stored?.EstCost).toBe(quoteBody.estCost);
  });
});

describe('countSlotBookings / listSlotBookingCounts', () => {
  it('counts only pending/confirmed bookings for the given option and date', async () => {
    const { env, raw } = createTestEnv();
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-01',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'pending',
    });
    const cancelledId = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-01',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'pending',
    });
    raw.prepare('UPDATE BookingRequests SET Status = ? WHERE Id = ?').run('cancelled', cancelledId);
    // A different option, same date — must not count toward morning-walk.
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-01',
      endDate: null,
      optionKey: 'd30',
      petCount: 1,
      startTime: null,
      estCost: null,
      status: 'confirmed',
    });
    // Same option, but on toDateExclusive itself — must NOT be included in the [from, to) range
    // below. This is what actually exercises the exclusive upper bound (a `StartDate <=
    // toDateExclusive` bug would wrongly pull this one in).
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-02',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'confirmed',
    });

    const count = await countSlotBookings(
      env.PAWBOOK_DB,
      TENANT_A,
      'walk',
      'morning-walk',
      '2028-09-01',
    );
    expect(count).toBe(1);

    const counts = await listSlotBookingCounts(
      env.PAWBOOK_DB,
      TENANT_A,
      'walk',
      'morning-walk',
      '2028-09-01',
      '2028-09-02',
    );
    expect(counts.get('2028-09-01')).toBe(1);
    expect(counts.has('2028-09-02')).toBe(false);
  });

  it('countSlotBookings excludes the given booking id (self-exclusion for race checks)', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-05',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'pending',
    });
    const including = await countSlotBookings(
      env.PAWBOOK_DB,
      TENANT_A,
      'walk',
      'morning-walk',
      '2028-09-05',
    );
    const excluding = await countSlotBookings(
      env.PAWBOOK_DB,
      TENANT_A,
      'walk',
      'morning-walk',
      '2028-09-05',
      id,
    );
    expect(including).toBe(1);
    expect(excluding).toBe(0);
  });

  it('sums PetCount across bookings for the slot', async () => {
    const { env } = createTestEnv();
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-10',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 2,
      startTime: '11:00',
      estCost: null,
      status: 'confirmed',
    });
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2028-09-10',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 3,
      startTime: '11:00',
      estCost: null,
      status: 'confirmed',
    });
    const count = await countSlotBookings(
      env.PAWBOOK_DB,
      TENANT_A,
      'walk',
      'morning-walk',
      '2028-09-10',
    );
    expect(count).toBe(5); // 2 + 3 pets, not 2 bookings

    const counts = await listSlotBookingCounts(
      env.PAWBOOK_DB,
      TENANT_A,
      'walk',
      'morning-walk',
      '2028-09-10',
      '2028-09-11',
    );
    expect(counts.get('2028-09-10')).toBe(5);
  });
});

describe('the availability quote is authenticated and pet-identified', () => {
  it('401s without a token — the quote is no longer anonymous', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/availability?type=walk&start=2028-08-01&petIds=pet_sp_bella',
      {},
      env,
    );
    expect(res.status).toBe(401);
  });

  it('403s a token minted for a DIFFERENT tenant', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability?type=walk&start=2028-08-01&petIds=pet_sp_bella',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('rejects a pet the caller does not own', async () => {
    const { env, raw } = createTestEnv();
    // A second customer at the SAME tenant, with a pet of their own. Same-tenant isolation is the
    // property the ownership gate actually defends; cross-tenant is already covered by the 403.
    raw
      .prepare(
        `INSERT INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES ('eu_sp_other', ?, 'other@example.com', 'Other', 'active')`,
      )
      .run(TENANT_A);
    seedPets(raw, TENANT_A, 'eu_sp_other', [{ id: 'pet_sp_foreign', petType: 'dog' }]);
    const res = await quote(env, 'sunny-paws', 'type=walk&start=2028-08-01', ['pet_sp_foreign']);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Unknown pet.');
  });

  it('lets a CO-OWNER quote a pet they co-own (PetOwners is the authority)', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `INSERT INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES ('eu_sp_rob', ?, 'rob@example.com', 'Rob', 'active')`,
      )
      .run(TENANT_A);
    // Rob owns no pet of his own; he is a second owner of Jess's Bella.
    raw
      .prepare(
        `INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, 'pet_sp_bella', 'eu_sp_rob')`,
      )
      .run(TENANT_A);
    const res = await quote(
      env,
      'sunny-paws',
      'type=walk&start=2028-08-01',
      ['pet_sp_bella'],
      'rob@example.com',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: true, priced: true, estCost: 20 });
  });

  it('rejects an empty petIds list', async () => {
    const { env } = createTestEnv();
    const res = await quote(env, 'sunny-paws', 'type=walk&start=2028-08-01', []);
    expect(res.status).toBe(400);
  });

  it('an unpriced 2-pet set quotes as AVAILABLE but UNPRICED — dates and money are separate answers', async () => {
    const { env } = createTestEnv();
    const res = await quote(env, 'sunny-paws', 'type=walk&start=2028-08-01', [
      'pet_sp_bella',
      'pet_sp_mochi',
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      available: true,
      priced: false,
      reason: 'unpriced-pet-set',
      groupKey: 'pet_sp_bella,pet_sp_mochi',
      mixKey: 'cat:1|dog:1',
    });
    // The refusal carries no money at all — not 0, not null, not undefined-but-present.
    expect(body).not.toHaveProperty('estCost');
  });
});
