import { describe, expect, it } from 'vitest';
import app from '../index';
import { countSlotBookings, insertBookingRequest, listSlotBookingCounts } from '../db/repo';
import { checkAvailability, estimateCost, rowsToCapacityEvents } from '../lib/availability';
import { SERVICE_TEMPLATES, type TemplateId } from '../lib/services';
import type { Tenant, TenantService, TenantServiceOption } from '../types';
import { createTestEnv, endUserToken, TENANT_A } from './helpers';

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
    AcceptedPetTypes: null,
    MaxConcurrentPets: null,
    CancellationTiers: null,
    HolidayRate: null,
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
    DisabledAt: null,
    ...over,
  };
}

describe('availability API — regression guards', () => {
  it('rejects a pet count over the service cap even on an empty calendar', async () => {
    const { env } = createTestEnv();
    // No existing rows in 2027; the range walk skips empty days, so the isolation check must catch it.
    // 5 pets is within the absolute cap (50) but over the boarding service's MaxConcurrentPets of 2 (seeded).
    const res = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2027-03-01&end=2027-03-04&pets=5',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(res.available).toBe(false);
  });

  it('rejects an impossible calendar date instead of computing negative nights', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/availability?type=boarding&start=2027-02-30&end=2027-03-01&pets=1',
      {},
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects an over-long range', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/availability?type=boarding&start=2027-01-01&end=2099-01-01&pets=1',
      {},
      env,
    );
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
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2027-03-11&end=2027-03-12&pets=2',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(res.available).toBe(false);
  });

  it('the same dates differ between tenants because capacity is per-tenant', async () => {
    const { env } = createTestEnv();
    // Seed: Jun 20-25 has 1 pet at Sunny Paws (max 2) and 2 pets at Happy Tails (max 4).
    // A 2-pet request fits Happy Tails (2+2=4) but not Sunny Paws (1+2>2).
    const query = 'type=boarding&start=2028-06-21&end=2028-06-24&pets=2';
    const a = (await (
      await app.request(`/api/sunny-paws/availability?${query}`, {}, env)
    ).json()) as { available: boolean };
    const b = (await (
      await app.request(`/api/happy-tails/availability?${query}`, {}, env)
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
      await app.request('/api/sunny-paws/availability?type=walk&start=2028-07-03', {}, env)
    ).json()) as { available: boolean };
    const onBusy = (await (
      await app.request('/api/sunny-paws/availability?type=walk&start=2028-06-21', {}, env)
    ).json()) as { available: boolean; estCost: number };
    expect(onBlocked.available).toBe(false);
    expect(onBusy.available).toBe(true);
    expect(onBusy.estCost).toBe(20); // first walk option (30 min) at $20/visit
  });

  it('validates inputs', async () => {
    const { env } = createTestEnv();
    const badType = await app.request(
      '/api/sunny-paws/availability?type=spa&start=2028-08-01',
      {},
      env,
    );
    const badDate = await app.request(
      '/api/sunny-paws/availability?type=walk&start=tomorrow',
      {},
      env,
    );
    const badRange = await app.request(
      '/api/sunny-paws/availability?type=boarding&start=2028-08-05&end=2028-08-05',
      {},
      env,
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
    const res = await app.request(
      '/api/sunny-paws/availability?type=boarding&start=2027-06-01&end=2027-06-08&pets=1',
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Stays are limited to 3 nights.');
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
      await app.request(
        '/api/sunny-paws/availability?type=walk&option=d60&start=2028-08-01',
        {},
        env,
      )
    ).json()) as { available: boolean; estCost: number };
    expect(r).toMatchObject({ available: true, estCost: 35 });
  });

  it('rejects an unknown option', async () => {
    const { env } = createTestEnv();
    const r = await app.request(
      '/api/sunny-paws/availability?type=walk&option=nope&start=2028-08-01',
      {},
      env,
    );
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

describe('checkAvailability', () => {
  it('single-visit cost is the picked option price (no nights math)', async () => {
    const { env } = createTestEnv();
    const t = tenant();
    const res = await checkAvailability(env, t, svc('walk'), opt({ Rate: 35 }), '2028-08-01', '');
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
    const res = await checkAvailability(env, t, svc('boarding'), o, '2028-08-10', '2028-08-13', 1);
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
      2,
    );
    expect(res).toMatchObject({ available: false });
    expect(SERVICE_TEMPLATES.housesitting.shape).toBe('range');
  });

  it('unlimited tenant (paws-and-relax) accepts overlapping boardings', async () => {
    const { env } = createTestEnv();
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
    const res = (await (
      await app.request(
        '/api/paws-and-relax/availability?type=boarding&start=2028-05-02&end=2028-05-06&pets=9',
        {},
        env,
      )
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

    const full = await checkAvailability(env, t, svc('walk'), slotOption, '2028-09-01', '');
    expect(full).toMatchObject({ available: false });

    const otherDate = await checkAvailability(env, t, svc('walk'), slotOption, '2028-09-02', '');
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
    const partial = await checkAvailability(env, t, svc('walk'), slotOption, '2028-09-01', '');
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
    const full = await checkAvailability(env, t, svc('walk'), slotOption, '2028-09-01', '');
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
    const blocked = await checkAvailability(env, t, service, o, '2028-08-11', '2028-08-13', 1);
    expect(blocked).toMatchObject({ available: false });

    // A 3-pet sit against a cap of 2 fails the fast path even on empty dates.
    const overCap = await checkAvailability(env, t, service, o, '2028-08-20', '2028-08-22', 3);
    expect(overCap).toMatchObject({ available: false });
    expect((overCap as { reason: string }).reason).toBe('That exceeds our house-sitting capacity.');
  });
});

describe('estimateCost — the billing unit is the service’s RateUnit, not a hardcoded constant', () => {
  // THE test that must never break: every service that exists today is night-billed, so this
  // change must not move a single price. Numbers are the seeded rates (sql/seed.sql).
  it('regression lock — night-unit range services bill exactly nights, at the seeded rates', () => {
    expect(estimateCost(svc('boarding'), opt({ Rate: 50 }), '2028-08-10', '2028-08-13')).toBe(150); // 3 nights
    expect(estimateCost(svc('boarding'), opt({ Rate: 40 }), '2028-06-21', '2028-06-24')).toBe(120); // Happy Tails
    expect(estimateCost(svc('housesitting'), opt({ Rate: 70 }), '2028-08-10', '2028-08-15')).toBe(
      350,
    ); // 5 nights
    expect(estimateCost(svc('boarding'), opt({ Rate: 50 }), '2028-08-10', '2028-08-11')).toBe(50); // 1 night
    // Degenerate 0-night range still bills the 1-night floor (billableUnits' Math.max(1, …)).
    expect(estimateCost(svc('boarding'), opt({ Rate: 50 }), '2028-08-10', '2028-08-10')).toBe(50);
    // Both built-in range templates are night-billed — the premise of the lock above.
    expect(SERVICE_TEMPLATES.boarding.rateUnit).toBe('night');
    expect(SERVICE_TEMPLATES.housesitting.rateUnit).toBe('night');
  });

  it('a day-unit range service bills nights + 1 (the departure day is chargeable)', () => {
    const dayBoarding = svc('boarding', { ServiceType: 'day-boarding', RateUnit: 'day' });
    // Apr 10 → Apr 13 is 3 nights = 4 chargeable DAYS at $30 → $120, not $90.
    expect(estimateCost(dayBoarding, opt({ Rate: 30 }), '2029-04-10', '2029-04-13')).toBe(120);
    // A same-day day-unit range is 1 day, never 2.
    expect(estimateCost(dayBoarding, opt({ Rate: 30 }), '2029-04-10', '2029-04-10')).toBe(30);
  });

  it('single-shape services return the flat option rate whatever their RateUnit', () => {
    expect(estimateCost(svc('walk'), opt({ Rate: 20 }), '2028-08-01', '')).toBe(20);
    expect(estimateCost(svc('checkin'), opt({ Rate: 12 }), '2028-08-01', '')).toBe(12);
    // daycare is the shape:'single' + rateUnit:'day' pairing — flat rate, no nights math.
    expect(estimateCost(svc('daycare'), opt({ Rate: 40 }), '2028-08-01', '')).toBe(40);
  });

  it('an unexpected RateUnit on a range service falls back to per-night (never inflates a bill)', () => {
    // 'visit' can only reach a range service through bad data; the mapping must be total.
    const odd = svc('boarding', { RateUnit: 'visit' });
    expect(estimateCost(odd, opt({ Rate: 50 }), '2028-08-10', '2028-08-13')).toBe(150); // 3 nights, not 4
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
      1,
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
      1,
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
        1,
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
    );
    expect(res).toMatchObject({ available: true, estCost: 20 });
    // Deliberately absent (like `nights`): there is no quantity to bill, so there is nothing
    // for the widget to label.
    const ok = res as { billedUnits?: number; unit?: string };
    expect(ok.billedUnits).toBeUndefined();
    expect(ok.unit).toBeUndefined();
  });
});

describe('no inferred pricing — pet count never moves the price', () => {
  it('the API quote is identical for 1 pet and 3 pets, yet 5 pets is refused', async () => {
    const { env } = createTestEnv();
    // Happy Tails boarding: MaxConcurrentPets = 4 (sql/seed.sql), so 1 and 3 pets are bookable and
    // 5 is over the cap; the dates are clear of the seeded Jun 20-25 booking / Jul 3-5 block. This
    // must go through the HTTP route because the ROUTE is what receives `pets` — a direct
    // estimateCost() call could not see a pet count to ignore.
    const dates = 'type=boarding&start=2029-05-10&end=2029-05-13';
    const quote = async (pets: number) =>
      (await (
        await app.request(`/api/happy-tails/availability?${dates}&pets=${pets}`, {}, env)
      ).json()) as Record<string, unknown>;
    const [one, three, five] = await Promise.all([quote(1), quote(3), quote(5)]);

    expect(one).toMatchObject({ available: true, estCost: 120 }); // $40/night × 3 nights
    expect(three.available).toBe(true);
    // The WHOLE payload must match — not just estCost — so no future per-pet quantity or
    // multiplier can sneak in through another field either.
    expect(three).toEqual(one);
    // …and `pets` is genuinely READ, not merely unused: 5 > the 4-pet cap is refused. Without this
    // leg the equality above would still pass if the route stopped looking at `pets` altogether.
    expect(five).toEqual({ available: false, reason: 'That exceeds our boarding capacity.' });
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

    const quote = (await (
      await app.request(
        '/api/sunny-paws/availability?type=day-boarding&start=2029-04-10&end=2029-04-13&pets=1',
        {},
        env,
      )
    ).json()) as {
      available: boolean;
      estCost: number;
      nights: number;
      billedUnits: number;
      unit: string;
    };
    expect(quote).toMatchObject({ available: true, nights: 3, billedUnits: 4, unit: 'day' });
    expect(quote.estCost).toBe(120); // 3 nights = 4 days × $30
    expect(quote.billedUnits * 30).toBe(quote.estCost); // the label and the price agree

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
    expect(booked.estCost).toBe(quote.estCost);

    const stored = raw
      .prepare('SELECT EstCost FROM BookingRequests WHERE Id = ?')
      .get(booked.id) as { EstCost: number } | undefined;
    expect(stored?.EstCost).toBe(quote.estCost);
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
