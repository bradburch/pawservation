import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, TENANT_A, endUserToken } from './helpers';
import { getTenantBySlug, insertBookingRequest, updateTenantSettings } from '../db/repo';
import { invalidateTenantCache } from '../lib/tenant-resolve';
import { addDays, addMonths, getPacificDateStr } from '../../src/shared/index.js';
import type { MonthAvailability, MonthDay } from '../lib/availability';

// Seeded in sql/seed.sql: Jess's fixed EndUserId for the Sunny Paws tenant.
const JESS_END_USER_ID = 'eu_sp_jess';

describe('GET /api/:slug/availability/month', () => {
  it('D1 boarding booking: blocks, partial, available, mine', async () => {
    const { env } = createTestEnv();
    // A blocked day (no calendar involved — a plain 'blocked' BookingRequests row).
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: '2026-10-10',
      endDate: '2026-10-11',
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    // Jess's own confirmed boarding booking, one night.
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: JESS_END_USER_ID,
      serviceType: 'boarding',
      startDate: '2026-10-20',
      endDate: '2026-10-21',
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=boarding&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: string; days: MonthDay[] };
    expect(body.days).toHaveLength(31);

    const d10 = body.days.find((d) => d.date === '2026-10-10')!;
    expect(d10.status).toBe('unavailable');

    const d20 = body.days.find((d) => d.date === '2026-10-20')!;
    expect(d20.status).toBe('partial');
    expect(d20.used).toBe(1);
    expect(d20.max).toBe(2); // Sunny Paws boarding seeded MaxConcurrentPets=2
    expect(d20.mine).toBe(true);

    const d15 = body.days.find((d) => d.date === '2026-10-15')!;
    expect(d15.status).toBe('available');
    expect(d15.mine).toBe(false);

    // today field must be a YYYY-MM-DD string
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('walk: blocks propagate, boarding capacity ignored, max=null', async () => {
    const { env } = createTestEnv();
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: '2026-10-10',
      endDate: '2026-10-11',
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: JESS_END_USER_ID,
      serviceType: 'boarding',
      startDate: '2026-10-20',
      endDate: '2026-10-21',
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=walk&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: string; days: MonthDay[] };

    const d10 = body.days.find((d) => d.date === '2026-10-10')!;
    expect(d10.status).toBe('unavailable');

    const d20 = body.days.find((d) => d.date === '2026-10-20')!;
    expect(d20.status).toBe('available'); // boarding events ignored for walks
    expect(d20.max).toBeNull();
    expect(d20.used).toBeNull();
  });

  it('no bookings at all: every day available', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=boarding&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: string; days: MonthDay[] };
    expect(body.days).toHaveLength(31);
    expect(body.days.every((d) => d.status === 'available')).toBe(true);
  });

  it('regression: a confirmed D1 boarding booking filling capacity marks the day unavailable, with no calendar connected', async () => {
    const { env } = createTestEnv();
    // Sunny Paws boarding MaxConcurrentPets=2 — a 2-pet booking fills the day on its own. No ProviderConnections
    // row is seeded for this tenant/capability, so there is no calendar connection whatsoever.
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2026-10-05',
      endDate: '2026-10-06',
      optionKey: null,
      petCount: 2,
      estCost: null,
      status: 'confirmed',
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=boarding&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: MonthDay[] };
    const d5 = body.days.find((d) => d.date === '2026-10-05')!;
    expect(d5.status).toBe('unavailable');
    expect(d5.used).toBe(2);
    expect(d5.max).toBe(2);
  });

  it('walk with a capacity-limited option: full day is unavailable, independent of calendar connection', async () => {
    const { env, raw } = createTestEnv();
    // No calendar connected — proves the slot-capacity path doesn't depend on Google Calendar.
    raw
      .prepare(
        `INSERT INTO TenantServiceOptions
           (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, StartTime, EndTime, Capacity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'opt_test_morning',
        'tnt_sunnypaws',
        'walk',
        'morning-walk',
        'Morning Walk',
        180,
        25,
        '11:00',
        '14:00',
        1,
      );
    await insertBookingRequest(env.PAWSERVATION_DB, 'tnt_sunnypaws', {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2026-10-05',
      endDate: null,
      optionKey: 'morning-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'confirmed',
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=walk&month=2026-10&option=morning-walk',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: MonthDay[] };
    const d5 = body.days.find((d) => d.date === '2026-10-05')!;
    expect(d5.status).toBe('unavailable');
    expect(d5.used).toBeNull(); // customers never see raw counts
    expect(d5.max).toBeNull();

    const d6 = body.days.find((d) => d.date === '2026-10-06')!;
    expect(d6.status).toBe('available');
  });

  it('rejects an unmatched ?option= instead of silently dropping the capacity filter', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=walk&month=2026-10&option=does-not-exist',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('marks a same-day windowed walk booking as "mine"', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `INSERT INTO TenantServiceOptions
           (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, StartTime, EndTime, Capacity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'opt_test_afternoon',
        'tnt_sunnypaws',
        'walk',
        'afternoon-walk',
        'Afternoon Walk',
        180,
        25,
        '11:00',
        '14:00',
        null,
      );
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: JESS_END_USER_ID,
      serviceType: 'walk',
      startDate: '2026-10-15',
      endDate: null,
      optionKey: 'afternoon-walk',
      petCount: 1,
      startTime: '11:00',
      estCost: null,
      status: 'confirmed',
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=walk&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: MonthDay[] };
    const d15 = body.days.find((d) => d.date === '2026-10-15')!;
    expect(d15.mine).toBe(true);
  });

  it('per-option slot: month grid marks the day full by pets, not bookings', async () => {
    const { env, raw } = createTestEnv();
    // Give the seeded 30-minute walk option a 4-pet capacity.
    raw
      .prepare(
        `UPDATE TenantServiceOptions SET Capacity = 4
         WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'walk' AND OptionKey = 'd30'`,
      )
      .run();
    // Two 2-pet walks fill the 4-pet slot on Nov 12.
    for (const _ of [0, 1]) {
      await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
        endUserId: null,
        serviceType: 'walk',
        startDate: '2026-11-12',
        endDate: null,
        optionKey: 'd30',
        petCount: 2,
        startTime: null,
        estCost: null,
        status: 'confirmed',
      });
    }
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=walk&option=d30&month=2026-11',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: MonthDay[] };
    const d12 = body.days.find((d) => d.date === '2026-11-12')!;
    expect(d12.status).toBe('unavailable'); // 4 pets ≥ capacity 4
    const d13 = body.days.find((d) => d.date === '2026-11-13')!;
    expect(d13.status).toBe('available');
  });

  it('per-option slot: a day with room left is unavailable to a set that does not fit', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        `UPDATE TenantServiceOptions SET Capacity = 2
         WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'walk' AND OptionKey = 'd30'`,
      )
      .run();
    // 1 of 2 pets used on Nov 12: the grid used to paint that `available` for everyone, so a
    // two-dog household saw a bookable day the quote then refused.
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2026-11-12',
      endDate: null,
      optionKey: 'd30',
      petCount: 1,
      startTime: null,
      estCost: null,
      status: 'confirmed',
    });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const daysFor = async (petIds?: string) => {
      const res = await app.request(
        '/api/sunny-paws/availability/month?type=walk&option=d30&month=2026-11' +
          (petIds === undefined ? '' : `&petIds=${petIds}`),
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { days: MonthDay[] }).days;
    };

    const two = await daysFor('pet_sp_bella,pet_sp_mochi');
    expect(two.find((d) => d.date === '2026-11-12')).toMatchObject({
      status: 'unavailable',
      reason: 'Not enough room for 2 pets',
    });
    // One pet still fits, and the reason stays null on an open day.
    const one = await daysFor('pet_sp_bella');
    expect(one.find((d) => d.date === '2026-11-12')).toMatchObject({
      status: 'available',
      reason: null,
    });
  });

  it('house-sit month grid denominates capacity in pets (MaxConcurrentPets)', async () => {
    const { env, raw } = createTestEnv();
    // Give Sunny Paws' seeded house-sit service a 2-pet cap.
    raw
      .prepare(
        `UPDATE TenantServices SET MaxConcurrentPets = 2
         WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'housesitting'`,
      )
      .run();
    // A 2-pet house-sit fills the day.
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'housesitting',
      startDate: '2026-11-05',
      endDate: '2026-11-06',
      optionKey: 'standard',
      petCount: 2,
      estCost: null,
      status: 'confirmed',
    });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=housesitting&month=2026-11',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: MonthDay[] };
    const d5 = body.days.find((d) => d.date === '2026-11-05')!;
    expect(d5.status).toBe('unavailable');
    expect(d5.used).toBe(2);
    expect(d5.max).toBe(2);
  });
});

/**
 * The booking window on the WIRE (task 6a). `monthAvailability` already resolves both ends of the
 * window; publishing them lets the widget disable month paging past the horizon without the
 * client ever touching the knobs (`MinLeadDays` / `MaxAdvanceMonths`) or doing date arithmetic —
 * the rule stays at its three server call sites, exactly as CLAUDE.md requires.
 */
describe('GET /api/:slug/availability/month — booking-window bounds', () => {
  const today = () => getPacificDateStr();
  const monthOf = (date: string) => date.slice(0, 7);

  async function monthBody(env: Env, month: string, type = 'boarding'): Promise<MonthAvailability> {
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability/month?type=${type}&month=${month}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as MonthAvailability;
  }

  it('publishes both bounds as resolved dates; an unlimited horizon publishes null', async () => {
    const { env } = createTestEnv(); // seeded tenant: no MinLeadDays, no MaxAdvanceMonths
    const body = await monthBody(env, monthOf(today()));
    expect(body.earliestBookable).toBe(today()); // no minimum notice → today is bookable
    expect(body.latestBookable).toBeNull(); // NULL horizon = unlimited
  });

  it('an unlimited horizon still answers months years out, so the widget can page forever', async () => {
    const { env } = createTestEnv();
    const far = addMonths(today(), 40);
    const body = await monthBody(env, monthOf(far));
    expect(body.latestBookable).toBeNull();
    // Not merely a 200 with everything struck out: with no horizon those days are real openings.
    expect(body.days.some((d) => d.status === 'available')).toBe(true);
  });

  it('reflects the per-service minimum notice and the profile horizon, day-clamped', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE TenantServices SET MinLeadDays = 3 WHERE TenantId = '${TENANT_A}' AND ServiceType = 'boarding';`,
    );
    raw.exec(`UPDATE Tenants SET MaxAdvanceMonths = 2 WHERE Id = '${TENANT_A}';`);
    const body = await monthBody(env, monthOf(today()));
    expect(body.earliestBookable).toBe(addDays(today(), 3));
    expect(body.latestBookable).toBe(addMonths(today(), 2));
  });

  it('the bounds are per SERVICE: a walk with no notice keeps today as its earliest', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE TenantServices SET MinLeadDays = 5 WHERE TenantId = '${TENANT_A}' AND ServiceType = 'boarding';`,
    );
    expect((await monthBody(env, monthOf(today()), 'boarding')).earliestBookable).toBe(
      addDays(today(), 5),
    );
    expect((await monthBody(env, monthOf(today()), 'walk')).earliestBookable).toBe(today());
  });
});

/**
 * `MonthDay.reason` (task 6b): the branch that made a day unavailable, in the customer's words.
 * The grid is the only place a customer can learn WHY a day is struck through.
 */
describe('MonthDay.reason', () => {
  const today = () => getPacificDateStr();
  // Two months out — safely inside no-horizon territory and stable against the real clock.
  const futureMonth = () => addMonths(today(), 2).slice(0, 7);

  async function daysOf(
    env: Env,
    month: string,
    type = 'boarding',
  ): Promise<Map<string, MonthDay>> {
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability/month?type=${type}&month=${month}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonthAvailability;
    return new Map(body.days.map((d) => [d.date, d]));
  }

  it('names the blocked / full branches and stays null for bookable days', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: `${m}-10`,
      endDate: `${m}-11`,
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    // Sunny Paws boarding is capped at 2 pets/day — one 2-pet stay fills the 20th outright.
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: `${m}-20`,
      endDate: `${m}-21`,
      optionKey: null,
      petCount: 2,
      estCost: null,
      status: 'confirmed',
    });
    // One pet on the 22nd: partial, still bookable, so no reason.
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: `${m}-22`,
      endDate: `${m}-23`,
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });

    const days = await daysOf(env, m);
    expect(days.get(`${m}-10`)).toMatchObject({
      status: 'unavailable',
      reason: 'Sitter unavailable',
    });
    expect(days.get(`${m}-20`)).toMatchObject({ status: 'unavailable', reason: 'Fully booked' });
    expect(days.get(`${m}-22`)).toMatchObject({ status: 'partial', reason: null });
    expect(days.get(`${m}-25`)).toMatchObject({ status: 'available', reason: null });
  });

  it('a single-day service reports the blocked and slot-full branches too', async () => {
    const { env, raw } = createTestEnv();
    const m = futureMonth();
    raw.exec(
      `UPDATE TenantServiceOptions SET Capacity = 1
       WHERE TenantId = '${TENANT_A}' AND ServiceType = 'walk' AND OptionKey = 'd30';`,
    );
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: `${m}-10`,
      endDate: `${m}-11`,
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: `${m}-12`,
      endDate: null,
      optionKey: 'd30',
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability/month?type=walk&option=d30&month=${m}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await res.json()) as MonthAvailability;
    const days = new Map(body.days.map((d) => [d.date, d]));
    expect(days.get(`${m}-10`)?.reason).toBe('Sitter unavailable');
    expect(days.get(`${m}-12`)?.reason).toBe('Fully booked');
    expect(days.get(`${m}-13`)?.reason).toBeNull();
  });

  it('the booking window overrides whatever capacity says: too soon / too far ahead', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE TenantServices SET MinLeadDays = 3 WHERE TenantId = '${TENANT_A}' AND ServiceType = 'boarding';`,
    );
    raw.exec(`UPDATE Tenants SET MaxAdvanceMonths = 1 WHERE Id = '${TENANT_A}';`);
    const t = getPacificDateStr();

    const thisMonth = await daysOf(env, t.slice(0, 7));
    expect(thisMonth.get(t)).toMatchObject({ status: 'unavailable', reason: 'Too soon to book' });

    const farDays = await daysOf(env, addMonths(t, 3).slice(0, 7));
    expect([...farDays.values()].every((d) => d.reason === 'Too far ahead to book')).toBe(true);
  });
});

/**
 * `?petIds=` (task 8b): the grid is painted for the pets the customer actually selected, not for
 * a hypothetical single pet. Without it a `1/2` cell reads bookable to a two-dog household and
 * the booking POST then refuses it — the grid and `checkRange` must give the same answer.
 */
describe('GET /api/:slug/availability/month — ?petIds=', () => {
  const today = () => getPacificDateStr();
  const futureMonth = () => addMonths(today(), 2).slice(0, 7);

  // Jess's two seeded Sunny Paws pets (sql/seed.sql).
  const BELLA = 'pet_sp_bella';
  const MOCHI = 'pet_sp_mochi';

  async function daysFor(env: Env, month: string, petIds?: string) {
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability/month?type=boarding&month=${month}` +
        (petIds === undefined ? '' : `&petIds=${petIds}`),
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    return { res, body: (await res.json()) as MonthAvailability };
  }

  /** One pet already boarding on the 12th; Sunny Paws' pool holds 2. */
  async function seedOneOfTwo(env: Env, month: string) {
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: `${month}-12`,
      endDate: `${month}-13`,
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
  }

  it('a 1-of-2 day is partial for one pet and unavailable for two', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await seedOneOfTwo(env, m);

    const one = await daysFor(env, m, BELLA);
    expect(one.body.days.find((d) => d.date === `${m}-12`)).toMatchObject({
      status: 'partial',
      used: 1,
      max: 2,
      reason: null,
    });

    const two = await daysFor(env, m, `${BELLA},${MOCHI}`);
    expect(two.body.days.find((d) => d.date === `${m}-12`)).toMatchObject({
      status: 'unavailable',
      // The counts stay in the cell — the customer still sees 1/2, now with the reason that
      // explains why 1/2 isn't enough for them.
      used: 1,
      max: 2,
      reason: 'Not enough room for 2 pets',
    });
    // An empty day still seats both, so the paint is set-aware, not a blanket refusal.
    expect(two.body.days.find((d) => d.date === `${m}-15`)?.status).toBe('available');
  });

  it('agrees with the quote: a day the grid strikes out mid-range, checkRange refuses', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await seedOneOfTwo(env, m);
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');

    const { body } = await daysFor(env, m, `${BELLA},${MOCHI}`);
    expect(body.days.find((d) => d.date === `${m}-12`)?.status).toBe('unavailable');

    // Spanned as a MIDDLE day, where no bookend rule can excuse it. (`rangeHasConflict` is
    // deliberately MORE permissive at the two endpoints — a stay may check in on the day another
    // checks out — so a per-day paint can only ever be the conservative half of the answer, which
    // is why the widget's client-side range verdict is an optimistic hint and the server stays
    // the authority. See CALENDAR_LOGIC.md §3.)
    const quote = await app.request(
      `/api/sunny-paws/availability?type=boarding&option=standard&start=${m}-11&end=${m}-14` +
        `&petIds=${BELLA},${MOCHI}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(((await quote.json()) as { available: boolean }).available).toBe(false);
  });

  it('a cap-filling set strikes out even an empty day, with the count named', async () => {
    const { env, raw } = createTestEnv();
    const m = futureMonth();
    raw.exec(
      `UPDATE TenantServices SET MaxConcurrentPets = 1
       WHERE TenantId = '${TENANT_A}' AND ServiceType = 'boarding';`,
    );
    const { body } = await daysFor(env, m, `${BELLA},${MOCHI}`);
    expect(body.days.find((d) => d.date === `${m}-15`)).toMatchObject({
      status: 'unavailable',
      reason: 'Not enough room for 2 pets',
    });
  });

  it('no petIds paints for one pet — byte-identical to the pre-change response', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await seedOneOfTwo(env, m);
    const absent = await daysFor(env, m);
    const explicit = await daysFor(env, m, BELLA);
    expect(absent.body).toEqual(explicit.body);
  });

  it('duplicate ids collapse — a set is distinct pets, never a count the client can inflate', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await seedOneOfTwo(env, m);
    const dupe = await daysFor(env, m, `${BELLA},${BELLA}`);
    expect(dupe.body.days.find((d) => d.date === `${m}-12`)?.status).toBe('partial');
  });

  it("refuses an id the caller doesn't own rather than painting for fewer pets", async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    // A real pet — belonging to the OTHER seeded tenant's customer.
    const other = await daysFor(env, m, 'pet_ht_otis');
    expect(other.res.status).toBe(400);
    const nonsense = await daysFor(env, m, 'pet_does_not_exist');
    expect(nonsense.res.status).toBe(400);
  });

  it('bounds the set with the same cap the quote and the POST use', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    const tooMany = await daysFor(
      env,
      m,
      Array.from({ length: 20 }, (_, i) => `pet_${i}`).join(','),
    );
    expect(tooMany.res.status).toBe(400);
  });
});

/**
 * The house-sit / boarding handover rule (migration 0006) in the PAINT.
 *
 * The rule is a property of a RANGE — really of a PAIR of ranges — so the grid can never paint it
 * exactly: the same day is a legal handover for one range and a refusal for another
 * (CALENDAR_LOGIC.md §9). But it must never claim `available` for a day where NO request of that
 * kind could start or continue, which is what it did before this block existed: `monthAvailability`
 * looked only at its own pool, so `month?type=boarding` returned `available` for a date the quote
 * refused with `overlap_not_allowed` and the POST 409'd — the widget rendering "These dates look
 * open" directly above "Your sitter is house-sitting on those dates".
 *
 * What IS soundly paintable, and all this pins:
 *  - allowance 0 — no opposite-kind day may ever be shared, so every one of them is unusable;
 *  - the DIRECTIONAL half of rule 2 — a day where the neighbours are neither all departing nor all
 *    arriving cannot be a handover for ANY range, since a request's only options are to arrive on
 *    it, depart on it, or span it;
 *  - a ONE-NIGHT neighbour — any handover doubles its only night, so neighbour rule 3 refuses every
 *    request that touches it, whatever the request's own shape.
 */
describe('the month grid and the cross-kind handover rule', () => {
  const today = () => getPacificDateStr();
  const futureMonth = () => addMonths(today(), 2).slice(0, 7);

  async function setAllowance(env: Env, days: number | null): Promise<void> {
    const t = (await getTenantBySlug(env.PAWSERVATION_DB, 'sunny-paws'))!;
    await updateTenantSettings(env.PAWSERVATION_DB, TENANT_A, {
      displayName: t.DisplayName,
      accentColor: t.AccentColor,
      timezone: t.Timezone,
      contactEmail: t.ContactEmail,
      contactPhone: t.ContactPhone,
      maxAdvanceMonths: t.MaxAdvanceMonths,
      housesitBoardingOverlapDays: days,
      // Carried through, not defaulted — see updateTenantSettings's own comment.
      calendarCostBasis: t.CalendarCostBasis,
    });
    await invalidateTenantCache('sunny-paws', env);
  }

  /** An existing confirmed house sit, `[start, endExclusive)`. */
  async function seedHouseSit(env: Env, start: string, endExclusive: string): Promise<void> {
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'housesitting',
      startDate: start,
      endDate: endExclusive,
      optionKey: 'standard',
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
  }

  async function paint(env: Env, month: string, type: string): Promise<Map<string, MonthDay>> {
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability/month?type=${type}&month=${month}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonthAvailability;
    return new Map(body.days.map((d) => [d.date, d]));
  }

  async function quoteBoarding(env: Env, start: string, end: string) {
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability?type=boarding&start=${start}&end=${end}&petIds=pet_sp_bella`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    return (await res.json()) as { available: boolean; code?: string };
  }

  it('strikes out the mid-stay days of a house sit for a BOARDING request, and agrees with the quote', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    // House sit occupies the 10th–18th; the 19th is checkout (no overnight).
    await seedHouseSit(env, `${m}-10`, `${m}-19`);

    const days = await paint(env, m, 'boarding');
    // A day strictly inside the sit is neither its arrival nor its departure — no boarding range
    // could arrive on it, depart on it, or span it.
    expect(days.get(`${m}-13`)).toMatchObject({
      status: 'unavailable',
      reason: 'Sitter is house-sitting',
    });
    // …and the quote for a stay over that day refuses, which is the disagreement this fixes.
    expect(await quoteBoarding(env, `${m}-12`, `${m}-15`)).toMatchObject({
      available: false,
      code: 'overlap_not_allowed',
    });

    // The two ends stay open: the sit ARRIVES on the 10th (a boarding may depart on it) and
    // DEPARTS on the 18th (a boarding may arrive on it). Both are real, bookable handovers.
    expect(days.get(`${m}-10`)?.status).toBe('available');
    expect(days.get(`${m}-18`)?.status).toBe('available');
    expect(await quoteBoarding(env, `${m}-18`, `${m}-21`).then((q) => q.available)).toBe(true);
    // Checkout day and an untouched day are plainly free.
    expect(days.get(`${m}-19`)?.status).toBe('available');
    expect(days.get(`${m}-25`)?.status).toBe('available');
  });

  it('is symmetric: a boarding stay strikes out the same days for a HOUSE-SIT request', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: `${m}-10`,
      endDate: `${m}-19`,
      optionKey: 'standard',
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });

    const days = await paint(env, m, 'housesitting');
    expect(days.get(`${m}-13`)).toMatchObject({
      status: 'unavailable',
      reason: 'Sitter has boarders',
    });
    expect(days.get(`${m}-10`)?.status).toBe('available');
    expect(days.get(`${m}-18`)?.status).toBe('available');
  });

  it('allowance 0: every day of the opposite-kind stay is struck out, ends included', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await setAllowance(env, 0);
    await seedHouseSit(env, `${m}-10`, `${m}-19`);

    const days = await paint(env, m, 'boarding');
    for (const d of [10, 13, 18])
      expect(days.get(`${m}-${d}`)).toMatchObject({
        status: 'unavailable',
        reason: 'Sitter is house-sitting',
      });
    expect(days.get(`${m}-19`)?.status).toBe('available');
  });

  it('allowance NULL: the rule does not run, so the paint says nothing about it', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await setAllowance(env, null);
    await seedHouseSit(env, `${m}-10`, `${m}-19`);

    const days = await paint(env, m, 'boarding');
    expect(days.get(`${m}-13`)?.status).toBe('available');
    expect(days.get(`${m}-13`)?.reason).toBeNull();
  });

  it('a ONE-NIGHT house sit strikes out its own night: any handover would double it', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await seedHouseSit(env, `${m}-14`, `${m}-15`);

    const days = await paint(env, m, 'boarding');
    // The night both arrives and departs, so the directional test alone would call it a handover —
    // but the neighbour keeps no night of its own, so the engine refuses every request touching it.
    expect(days.get(`${m}-14`)).toMatchObject({
      status: 'unavailable',
      reason: 'Sitter is house-sitting',
    });
    expect(await quoteBoarding(env, `${m}-14`, `${m}-17`)).toMatchObject({
      available: false,
      code: 'overlap_not_allowed',
    });
    expect(await quoteBoarding(env, `${m}-12`, `${m}-15`)).toMatchObject({
      available: false,
      code: 'overlap_not_allowed',
    });
  });

  it('a day two house sits share — one leaving, one mid-stay — is struck out', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await seedHouseSit(env, `${m}-08`, `${m}-13`); // departs on the 12th
    await seedHouseSit(env, `${m}-10`, `${m}-20`); // mid-stay on the 12th

    const days = await paint(env, m, 'boarding');
    // `every one of them` in rule 2: one sit is leaving, the other is still there.
    expect(days.get(`${m}-12`)?.status).toBe('unavailable');
    expect(await quoteBoarding(env, `${m}-12`, `${m}-15`)).toMatchObject({
      available: false,
      code: 'overlap_not_allowed',
    });
  });

  it('single-day services are untouched by the rule', async () => {
    const { env } = createTestEnv();
    const m = futureMonth();
    await seedHouseSit(env, `${m}-10`, `${m}-19`);
    // A walk draws no pool and is invisible to the handover rule — only a blocked day stops it.
    expect((await paint(env, m, 'walk')).get(`${m}-13`)?.status).toBe('available');
  });
});
