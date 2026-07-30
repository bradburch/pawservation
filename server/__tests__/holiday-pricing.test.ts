import { describe, expect, it } from 'vitest';
import app from '../index';
import { checkAvailability, estimateCost, unitSplitFor } from '../lib/availability';
import type { PriceResult } from '../lib/availability';
import { SERVICE_TEMPLATES, type TemplateId } from '../lib/services';
import type { Tenant, TenantService, TenantServiceOption } from '../types';
import { createTestEnv, endUserToken, TENANT_A } from './helpers';

/** Every quote here is single-pet and rate-less by design: the single-pet fallback
 *  (`distinct.length === 1` in `estimateCost`) resolves to `option.Rate` with no stored pet-set
 *  rate needed, so these numbers are identical to what they were before pet-set rates existed. */
const onePet = [{ id: 'p_holiday_1', petType: 'dog' }];
const noRates = { groupRates: [], mixRates: [] };

/** Unwraps a `priced: true` result's cost, failing loudly if a test accidentally hits the
 *  refusal arm — every case in this file is a single pet, which is never refused. */
function costOf(result: PriceResult): number {
  if (!result.priced) throw new Error(`expected a priced result, got a refusal: ${result.reason}`);
  return result.cost;
}

/** Same factories as availability.test.ts — copy that file's `svc`, `tenant`, and `opt` helpers
 *  verbatim so the two money suites describe the same rows. */
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
function opt(over: Partial<TenantServiceOption> = {}): TenantServiceOption {
  return {
    Id: 'opt_test',
    TenantId: TENANT_A,
    ServiceType: 'boarding',
    OptionKey: 'standard',
    Label: 'Standard',
    DurationMinutes: null,
    Rate: 40,
    StartTime: null,
    EndTime: null,
    Capacity: null,
    WeekdaysOnly: 0,
    ...over,
  };
}

describe('estimateCost — holiday units priced at the stored HolidayRate', () => {
  it('is UNCHANGED when HolidayRate is NULL (the compatibility lock)', () => {
    // Dec 23 -> Dec 27 spans Christmas Eve AND Christmas Day, and still costs 4 x $40.
    expect(
      costOf(
        estimateCost(
          svc('boarding'),
          opt({ Rate: 40 }),
          '2026-12-23',
          '2026-12-27',
          onePet,
          noRates,
        ),
      ),
    ).toBe(160);
  });

  it('prices only the holiday nights at the holiday rate', () => {
    const s = svc('boarding', { HolidayRate: 75 });
    // Nights begin Dec 23, 24, 25, 26 -> two holidays: 2 x $40 + 2 x $75 = $230.
    expect(
      costOf(estimateCost(s, opt({ Rate: 40 }), '2026-12-23', '2026-12-27', onePet, noRates)),
    ).toBe(230);
  });

  it('names a night by its CHECK-IN date, so Dec 24 -> Dec 25 is ONE holiday night', () => {
    const s = svc('boarding', { HolidayRate: 75 });
    expect(
      costOf(estimateCost(s, opt({ Rate: 40 }), '2026-12-24', '2026-12-25', onePet, noRates)),
    ).toBe(75);
    // The mirror: checking in ON Christmas Day and out on the 26th is also one holiday night.
    expect(
      costOf(estimateCost(s, opt({ Rate: 40 }), '2026-12-25', '2026-12-26', onePet, noRates)),
    ).toBe(75);
    // …and checking out ON a holiday does NOT make the last night a holiday night.
    expect(
      costOf(estimateCost(s, opt({ Rate: 40 }), '2026-12-23', '2026-12-24', onePet, noRates)),
    ).toBe(40);
  });

  it('prices a single-day service by the date itself', () => {
    const s = svc('walk', { HolidayRate: 40 });
    expect(
      costOf(estimateCost(s, opt({ Rate: 20 }), '2026-07-04', '2026-07-04', onePet, noRates)),
    ).toBe(40);
    expect(
      costOf(estimateCost(s, opt({ Rate: 20 }), '2026-07-05', '2026-07-05', onePet, noRates)),
    ).toBe(20);
  });

  it('includes the departure day for a DAY-billed range service', () => {
    // billableUnits = nights + 1, so Jul 3 -> Jul 4 is 2 days: Jul 3 (normal) + Jul 4 (holiday).
    const s = svc('boarding', { RateUnit: 'day', HolidayRate: 60 });
    expect(unitSplitFor(s, '2026-07-03', '2026-07-04')).toEqual({ units: 2, holidayUnits: 1 });
    expect(
      costOf(estimateCost(s, opt({ Rate: 30 }), '2026-07-03', '2026-07-04', onePet, noRates)),
    ).toBe(90);
  });

  it('accepts a holiday rate BELOW the base rate', () => {
    const s = svc('boarding', { HolidayRate: 25 });
    // 40 + 25
    expect(
      costOf(estimateCost(s, opt({ Rate: 40 }), '2026-07-03', '2026-07-05', onePet, noRates)),
    ).toBe(65);
  });
});

describe('the quote reports the holiday breakdown it priced with', () => {
  it('returns holidayUnits and holidayRate alongside billedUnits', async () => {
    const { env } = createTestEnv();
    const res = await checkAvailability(
      env,
      { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as unknown as Tenant,
      svc('boarding', { HolidayRate: 75 }),
      opt({ Rate: 40 }),
      '2026-12-23',
      '2026-12-27',
      onePet,
      noRates,
    );
    expect(res).toMatchObject({
      available: true,
      priced: true,
      estCost: 230,
      billedUnits: 4,
      unit: 'night',
      holidayUnits: 2,
      holidayRate: 75,
    });
  });

  it('omits both fields when no unit is holiday-priced', async () => {
    const { env } = createTestEnv();
    const res = (await checkAvailability(
      env,
      { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as unknown as Tenant,
      svc('boarding', { HolidayRate: 75 }),
      opt({ Rate: 40 }),
      '2026-03-02',
      '2026-03-05',
      onePet,
      noRates,
    )) as Record<string, unknown>;
    expect(res.estCost).toBe(120);
    expect(res.holidayUnits).toBeUndefined();
    expect(res.holidayRate).toBeUndefined();
  });
});

describe('quote/stamp parity across a holiday', () => {
  it('the booking stamps exactly what the quote said, holidays included', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(`UPDATE TenantServices SET HolidayRate = 75 WHERE TenantId = ? AND ServiceType = ?`)
      .run(TENANT_A, 'boarding');

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const quote = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2026-12-23&end=2026-12-27&petIds=pet_sp_bella',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).json()) as { estCost: number; holidayUnits: number };

    const created = (await (
      await app.request(
        '/api/sunny-paws/bookings',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'boarding',
            startDate: '2026-12-23',
            endDate: '2026-12-27',
            petIds: ['pet_sp_bella'],
          }),
        },
        env,
      )
    ).json()) as { estCost: number };

    expect(quote.holidayUnits).toBe(2);
    expect(created.estCost).toBe(quote.estCost);
  });

  it('the booking stamps exactly what the quote said for a SINGLE-DAY service on a holiday', async () => {
    const { env, raw } = createTestEnv();
    // Sunny Paws check-in (single-day, 'visit'-billed): d15 option is $12/visit normally.
    raw
      .prepare(`UPDATE TenantServices SET HolidayRate = 25 WHERE TenantId = ? AND ServiceType = ?`)
      .run(TENANT_A, 'checkin');

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const quote = (await (
      await app.request(
        '/api/sunny-paws/availability?type=checkin&option=d15&start=2026-12-25&petIds=pet_sp_bella',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).json()) as { estCost: number; holidayUnits: number };

    const created = (await (
      await app.request(
        '/api/sunny-paws/bookings',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'checkin',
            startDate: '2026-12-25',
            optionKey: 'd15',
            petIds: ['pet_sp_bella'],
          }),
        },
        env,
      )
    ).json()) as { estCost: number };

    expect(quote.estCost).toBe(25); // holiday rate replaces the $12 base for Christmas Day
    expect(quote.holidayUnits).toBe(1);
    expect(created.estCost).toBe(quote.estCost);
  });
});
