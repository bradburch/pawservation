import { buildCapacity, rangeHasConflict, type CapacityEvent } from '@brad-paws/shared';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertBookingRequest } from '../db/repo';
import {
  checkAvailability,
  rowsToCapacityEvents,
  tenantRangeHasConflict,
} from '../lib/availability';
import { SERVICE_CATALOG } from '../lib/services';
import type { TenantServiceOption } from '../types';
import { createTestEnv, TENANT_A } from './helpers';

const boarding = (start: string, end: string, petCount = 1): CapacityEvent => ({
  start_date: start,
  end_date: end,
  type: 'boarding',
  petCount,
});
const blocked = (start: string, end: string): CapacityEvent => ({
  start_date: start,
  end_date: end,
  type: 'blocked',
});

describe('tenantRangeHasConflict', () => {
  it('matches shared rangeHasConflict exactly at max = 2 (parity pin for the D-E deviation)', () => {
    const scenarios: CapacityEvent[][] = [
      [],
      [boarding('2026-08-01', '2026-08-05', 1)],
      [boarding('2026-08-01', '2026-08-05', 2)],
      [boarding('2026-08-01', '2026-08-03', 1), boarding('2026-08-03', '2026-08-06', 1)],
      [blocked('2026-08-02', '2026-08-04')],
      [boarding('2026-08-04', '2026-08-08', 2)],
    ];
    const requests: [string, string, number][] = [
      ['2026-08-01', '2026-08-05', 1],
      ['2026-08-01', '2026-08-05', 2],
      ['2026-08-03', '2026-08-06', 1],
      ['2026-08-05', '2026-08-07', 2],
      ['2026-07-30', '2026-08-02', 1],
    ];
    for (const events of scenarios) {
      const capacity = buildCapacity(events);
      for (const [start, end, pets] of requests) {
        expect(
          tenantRangeHasConflict(start, end, capacity, pets, 2),
          `events=${JSON.stringify(events)} request=${start}→${end}×${pets}`,
        ).toBe(rangeHasConflict(start, end, 'boarding', capacity, pets));
      }
    }
  });

  it('honors a per-tenant max above the shared hardcoded 2', () => {
    const capacity = buildCapacity([boarding('2026-08-01', '2026-08-05', 2)]);
    // 2 pets already boarding mid-range: a 1-pet request conflicts at max 2 but fits at max 4.
    expect(tenantRangeHasConflict('2026-08-02', '2026-08-04', capacity, 1, 2)).toBe(true);
    expect(tenantRangeHasConflict('2026-08-02', '2026-08-04', capacity, 1, 4)).toBe(false);
    // …and at max 4, a 3-pet request still conflicts (2 + 3 > 4).
    expect(tenantRangeHasConflict('2026-08-02', '2026-08-04', capacity, 3, 4)).toBe(true);
  });

  it('blocked days conflict regardless of capacity', () => {
    const capacity = buildCapacity([blocked('2026-08-02', '2026-08-03')]);
    expect(tenantRangeHasConflict('2026-08-01', '2026-08-04', capacity, 1, 99)).toBe(true);
  });

  it('allows sharing a boundary day (soft bookend)', () => {
    // Existing booking checks out Aug 3 (exclusive end) with max pets — new booking may check in Aug 3.
    const capacity = buildCapacity([boarding('2026-08-01', '2026-08-03', 2)]);
    expect(tenantRangeHasConflict('2026-08-03', '2026-08-05', capacity, 2, 2)).toBe(false);
  });
});

describe('availability API — regression guards', () => {
  it('rejects a pet count over the tenant cap even on an empty calendar', async () => {
    const { env } = createTestEnv();
    // No existing rows in 2027; the range walk skips empty days, so the isolation check must catch it.
    // 5 pets is within the absolute cap (50) but over Brad Paws' per-tenant max of 2.
    const res = (await (
      await app.request(
        '/api/brad-paws/availability?type=boarding&start=2027-03-01&end=2027-03-04&pets=5',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(res.available).toBe(false);
  });

  it('rejects an impossible calendar date instead of computing negative nights', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/brad-paws/availability?type=boarding&start=2027-02-30&end=2027-03-01&pets=1',
      {},
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects an over-long range', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/brad-paws/availability?type=boarding&start=2027-01-01&end=2099-01-01&pets=1',
      {},
      env,
    );
    expect(res.status).toBe(400);
  });

  it('sees a booking that starts exactly on the checkout day (fetch-window +1)', async () => {
    const { env } = createTestEnv();
    // Brad Paws max 2. Existing: 1 pet Mar 8→12, and 2 pets starting EXACTLY on Mar 12 (→15).
    // A 2-pet request Mar 11→12: its last night (Mar 11) is full (1+2>2); the soft-bookend
    // look-ahead at Mar 12 must see the full next-day booking and keep the conflict — which
    // only works if the capacity fetch reaches one day past checkout.
    await insertBookingRequest(env.EMBED_PROTO_DB, TENANT_A, {
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
    await insertBookingRequest(env.EMBED_PROTO_DB, TENANT_A, {
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
        '/api/brad-paws/availability?type=boarding&start=2027-03-11&end=2027-03-12&pets=2',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(res.available).toBe(false);
  });

  it('the same dates differ between tenants because capacity is per-tenant', async () => {
    const { env } = createTestEnv();
    // Seed: Jun 20-25 has 1 pet at Brad Paws (max 2) and 2 pets at Happy Tails (max 4).
    // A 2-pet request fits Happy Tails (2+2=4) but not Brad Paws (1+2>2).
    const query = 'type=boarding&start=2026-06-21&end=2026-06-24&pets=2';
    const a = (await (
      await app.request(`/api/brad-paws/availability?${query}`, {}, env)
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
      await app.request('/api/brad-paws/availability?type=walk&start=2026-07-03', {}, env)
    ).json()) as { available: boolean };
    const onBusy = (await (
      await app.request('/api/brad-paws/availability?type=walk&start=2026-06-21', {}, env)
    ).json()) as { available: boolean; estCost: number };
    expect(onBlocked.available).toBe(false);
    expect(onBusy.available).toBe(true);
    expect(onBusy.estCost).toBe(20); // first walk option (30 min) at $20/visit
  });

  it('validates inputs', async () => {
    const { env } = createTestEnv();
    const badType = await app.request(
      '/api/brad-paws/availability?type=spa&start=2026-08-01',
      {},
      env,
    );
    const badDate = await app.request(
      '/api/brad-paws/availability?type=walk&start=tomorrow',
      {},
      env,
    );
    const badRange = await app.request(
      '/api/brad-paws/availability?type=boarding&start=2026-08-05&end=2026-08-05',
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
        StartDate: '2026-08-01',
        EndDate: '2026-08-03',
        OptionKey: null,
        PetType: null,
        PetCount: 1,
        EstCost: null,
        Status: 'confirmed',
        CreatedAt: '',
      },
      {
        Id: '2',
        TenantId: 't',
        EndUserId: 'u',
        ServiceType: 'boarding',
        StartDate: '2026-08-04',
        EndDate: '2026-08-06',
        OptionKey: null,
        PetType: null,
        PetCount: 2,
        EstCost: 100,
        Status: 'pending',
        CreatedAt: '',
      },
    ]);
    expect(events[0]).toMatchObject({ type: 'blocked', start_date: '2026-08-01' });
    expect(events[1]).toMatchObject({ type: 'boarding', petCount: 2 });
  });
});

describe('config + availability — service options and pet types', () => {
  it('config exposes services with options and accepted pet types', async () => {
    const { env } = createTestEnv();
    const cfg = (await (await app.request('/api/brad-paws/config', {}, env)).json()) as {
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
        '/api/brad-paws/availability?type=walk&option=d60&start=2026-08-01',
        {},
        env,
      )
    ).json()) as { available: boolean; estCost: number };
    expect(r).toMatchObject({ available: true, estCost: 35 });
  });

  it('rejects an unknown option', async () => {
    const { env } = createTestEnv();
    const r = await app.request(
      '/api/brad-paws/availability?type=walk&option=nope&start=2026-08-01',
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
      ...over,
    };
  }

  it('single-visit cost is the picked option price (no nights math)', async () => {
    const { env } = createTestEnv();
    const tenant = {
      Id: TENANT_A,
      Slug: 'brad-paws',
      DisplayName: 'Brad Paws',
      AccentColor: '#000000',
      MaxBoardingPets: 2,
    };
    const res = await checkAvailability(env, tenant, 'walk', opt({ Rate: 35 }), '2026-08-01', '');
    expect(res).toMatchObject({ available: true, estCost: 35 });
  });

  it('range cost is option price times nights', async () => {
    const { env } = createTestEnv();
    const tenant = {
      Id: TENANT_A,
      Slug: 'brad-paws',
      DisplayName: 'Brad Paws',
      AccentColor: '#000000',
      MaxBoardingPets: 2,
    };
    const o = opt({
      ServiceType: 'boarding',
      OptionKey: 'standard',
      DurationMinutes: null,
      Rate: 50,
      RateUnit: 'night',
    });
    const res = await checkAvailability(env, tenant, 'boarding', o, '2026-08-10', '2026-08-13', 1);
    expect(res).toMatchObject({ available: true, estCost: 150, nights: 3 });
  });

  it('house-sitting consumes a boarding slot (blocks a full boarding day)', async () => {
    const { env } = createTestEnv();
    const tenant = {
      Id: TENANT_A,
      Slug: 'brad-paws',
      DisplayName: 'Brad Paws',
      AccentColor: '#000000',
      MaxBoardingPets: 2,
    };
    const o = opt({
      ServiceType: 'housesitting',
      OptionKey: 'standard',
      DurationMinutes: null,
      Rate: 70,
      RateUnit: 'night',
    });
    // Seed has 1 boarding pet Jun 20-25 at max 2 -> a 2-pet house-sit overlapping conflicts.
    const res = await checkAvailability(
      env,
      tenant,
      'housesitting',
      o,
      '2026-06-21',
      '2026-06-23',
      2,
    );
    expect(res).toMatchObject({ available: false });
    expect(SERVICE_CATALOG.housesitting.shape).toBe('range');
  });
});
