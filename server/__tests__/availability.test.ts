import { describe, expect, it } from 'vitest';
import app from '../index';
import { countSlotBookings, insertBookingRequest, listSlotBookingCounts } from '../db/repo';
import { checkAvailability, rowsToCapacityEvents } from '../lib/availability';
import { SERVICE_CATALOG } from '../lib/services';
import type { Tenant, TenantServiceOption } from '../types';
import { createTestEnv, TENANT_A } from './helpers';

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    Id: TENANT_A,
    Slug: 'sunny-paws',
    DisplayName: 'Sunny Paws',
    AccentColor: '#000000',
    MaxBoardingPets: 2,
    MaxHouseSitsPerDay: null,
    MaxStayNights: null,
    Timezone: null,
    ContactEmail: null,
    ContactPhone: null,
    ...over,
  };
}

describe('availability API — regression guards', () => {
  it('rejects a pet count over the tenant cap even on an empty calendar', async () => {
    const { env } = createTestEnv();
    // No existing rows in 2027; the range walk skips empty days, so the isolation check must catch it.
    // 5 pets is within the absolute cap (50) but over Sunny Paws' per-tenant max of 2.
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
      petType: null,
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
      petType: null,
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
        PetType: null,
        PetCount: 1,
        StartTime: null,
        GCalEventId: null,
        EstCost: null,
        Status: 'confirmed',
        CreatedAt: '',
      },
      {
        Id: '2',
        TenantId: 't',
        EndUserId: 'u',
        ServiceType: 'boarding',
        StartDate: '2028-08-04',
        EndDate: '2028-08-06',
        OptionKey: null,
        PetType: null,
        PetCount: 2,
        StartTime: null,
        GCalEventId: null,
        EstCost: 100,
        Status: 'pending',
        CreatedAt: '',
      },
    ]);
    expect(events[0]).toMatchObject({
      type: 'blocked',
      start_date: '2028-08-01',
    });
    expect(events[1]).toMatchObject({ type: 'boarding', petCount: 2 });
  });
});

describe('config + availability — service options and pet types', () => {
  it('config exposes services with options and accepted pet types', async () => {
    const { env } = createTestEnv();
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      petTypes: string[];
      services: {
        type: string;
        hasDuration: boolean;
        options: { optionKey: string; rate: number }[];
      }[];
    };
    expect(cfg.petTypes).toEqual(expect.arrayContaining(['dog', 'cat']));
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

describe('checkAvailability', () => {
  function opt(over: Partial<TenantServiceOption>): TenantServiceOption {
    return {
      Id: 'o',
      TenantId: TENANT_A,
      ServiceType: 'walk',
      OptionKey: 'd30',
      Label: '30 minutes',
      DurationMinutes: 30,
      Rate: 20,
      RateUnit: 'visit',
      StartTime: null,
      EndTime: null,
      Capacity: null,
      ...over,
    };
  }

  it('single-visit cost is the picked option price (no nights math)', async () => {
    const { env } = createTestEnv();
    const t = tenant();
    const res = await checkAvailability(env, t, 'walk', opt({ Rate: 35 }), '2028-08-01', '');
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
      RateUnit: 'night',
    });
    const res = await checkAvailability(env, t, 'boarding', o, '2028-08-10', '2028-08-13', 1);
    expect(res).toMatchObject({ available: true, estCost: 150, nights: 3 });
  });

  it('house-sit conflicts when it overlaps existing boarding by more than a day', async () => {
    const { env } = createTestEnv();
    const t = tenant(); // MaxHouseSitsPerDay null = unlimited; conflict must come from overlap rule
    const o = opt({
      ServiceType: 'housesitting',
      OptionKey: 'standard',
      DurationMinutes: null,
      Rate: 70,
      RateUnit: 'night',
    });
    // Seed: 1 pet boarding Jun 20-25. A house-sit Jun 21-23 overlaps boarding on Jun 21 AND 22.
    const res = await checkAvailability(env, t, 'housesitting', o, '2028-06-21', '2028-06-23', 2);
    expect(res).toMatchObject({ available: false });
    expect(SERVICE_CATALOG.housesitting.shape).toBe('range');
  });

  it('unlimited tenant (paws-and-relax) accepts overlapping boardings', async () => {
    const { env } = createTestEnv();
    await insertBookingRequest(env.PAWBOOK_DB, 'tnt_pawsandrelax', {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2028-05-01',
      endDate: '2028-05-10',
      optionKey: 'standard',
      petType: null,
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
      petType: null,
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
      petType: null,
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
      petType: null,
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'pending',
    });
    raw.prepare('UPDATE BookingRequests SET Status = ? WHERE Id = ?').run('cancelled', cancelledId);

    const full = await checkAvailability(env, t, 'walk', slotOption, '2028-09-01', '');
    expect(full).toMatchObject({ available: false });

    const otherDate = await checkAvailability(env, t, 'walk', slotOption, '2028-09-02', '');
    expect(otherDate).toMatchObject({ available: true });
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
      petType: null,
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
      petType: null,
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
      petType: null,
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
      petType: null,
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
      petType: null,
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
});
