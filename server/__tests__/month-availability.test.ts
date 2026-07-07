import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, TENANT_A, endUserToken } from './helpers';
import { insertBookingRequest } from '../db/repo';
import type { MonthDay } from '../lib/availability';

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
      petType: null,
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
      petType: 'dog',
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
    expect(d20.max).toBe(2); // Sunny Paws seeded MaxBoardingPets=2
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
      petType: null,
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
      petType: 'dog',
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
    // Sunny Paws MaxBoardingPets=2 — a 2-pet booking fills the day on its own. No ProviderConnections
    // row is seeded for this tenant/capability, so there is no calendar connection whatsoever.
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2026-10-05',
      endDate: '2026-10-06',
      optionKey: null,
      petType: 'dog',
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
           (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'opt_test_morning',
        'tnt_sunnypaws',
        'walk',
        'morning-walk',
        'Morning Walk',
        180,
        25,
        'visit',
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
      petType: null,
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
           (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'opt_test_afternoon',
        'tnt_sunnypaws',
        'walk',
        'afternoon-walk',
        'Afternoon Walk',
        180,
        25,
        'visit',
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
      petType: 'dog',
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
});
