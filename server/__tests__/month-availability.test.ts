import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, TENANT_A, endUserToken } from './helpers';
import { insertBookingRequest } from '../db/repo';
import { addDays, addMonths, getPacificDateStr } from '../../src/shared/index.js';
import type { MonthAvailability, MonthDay } from '../lib/availability';

// Seeded in sql/seed.sql: Jess's fixed EndUserId for the Sunny Paws tenant.
const JESS_END_USER_ID = 'eu_sp_jess';

describe('GET /api/:slug/availability/month', () => {
  it('D1 boarding booking: blocks, partial, available, mine', async () => {
    const { env } = createTestEnv();
    // A blocked day (no calendar involved — a plain 'blocked' BookingRequests row).
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: '2026-10-10',
      endDate: '2026-10-11',
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, 'tnt_sunnypaws', {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
      await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: `${m}-10`,
      endDate: `${m}-11`,
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
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
