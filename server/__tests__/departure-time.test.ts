/**
 * `BookingRequests.DepartureTime` — the owner's estimated DEPARTURE (pick-up) time, and both times
 * on a service whose clock nobody else owns (boarding, house sitting, daycare).
 *
 * Written BEFORE the implementation (TDD). The two rules easiest to get wrong are pinned first:
 *
 *  1. **Ordering is a SINGLE-DAY rule only.** On a range stay the departure falls on a LATER date,
 *     so `departureTime <= startTime` is perfectly legal — an ordering check there would refuse
 *     "drop off Friday 17:00, collect Monday 08:00", which is the most ordinary boarding there is.
 *  2. **The option still owns the clock where the option HAS one.** Walks and check-ins are
 *     duration-priced (`HasDuration = 1`): their slot time is the option's, so a client-supplied
 *     arrival or departure there is a bug, not a preference. `arrival-time.test.ts` pins that for
 *     the arrival; this file pins it for the departure and for the services that now DO accept both.
 */
import { describe, expect, it } from 'vitest';
import app from '../index';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { buildEventResource, type CalendarBooking } from '../lib/google-calendar';
import { adminHeaders, createTestEnv, endUserToken, futureWeekday, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';
const BELLA = 'pet_sp_bella';
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
/** A future Monday — the walk option under test is duration-priced, and the original fixture
 *  pinned a Monday, so that property is preserved rather than assumed irrelevant. */
const MONDAY = futureWeekday(1);

async function post(env: Env, body: Record<string, unknown>): Promise<Response> {
  const token = await endUserToken(env, SLUG, 'jess@example.com');
  return app.request(
    `/api/${SLUG}/bookings`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function times(
  env: Env,
  id: string,
): Promise<{ StartTime: string | null; DepartureTime: string | null }> {
  return (await env.PAWSERVATION_DB.prepare(
    'SELECT StartTime, DepartureTime FROM BookingRequests WHERE Id = ?',
  )
    .bind(id)
    .first<{ StartTime: string | null; DepartureTime: string | null }>())!;
}

describe('owner-set departure time', () => {
  it('stores both times on a range stay and publishes them to the sitter and the customer', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 40),
      endDate: addDays(TODAY, 43),
      petIds: [BELLA],
      startTime: '17:00',
      departureTime: '08:00',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await times(env, id)).toEqual({ StartTime: '17:00', DepartureTime: '08:00' });

    const adminList = (await (
      await app.request(
        `/api/${SLUG}/admin/bookings`,
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as {
      bookings: { id: string; startTime: string | null; departureTime: string | null }[];
    };
    expect(adminList.bookings.find((b) => b.id === id)).toMatchObject({
      startTime: '17:00',
      departureTime: '08:00',
    });

    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const mine = (await (
      await app.request(
        `/api/${SLUG}/bookings/mine`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).json()) as { bookings: { id: string; departureTime: string | null }[] };
    expect(mine.bookings.find((b) => b.id === id)?.departureTime).toBe('08:00');
  });

  it('accepts a departure EARLIER in the day than the arrival on a range stay (different dates)', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 50),
      endDate: addDays(TODAY, 53),
      petIds: [BELLA],
      startTime: '17:00',
      departureTime: '08:00',
    });
    expect(res.status).toBe(201);
  });

  it('leaves DepartureTime NULL when none is sent', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 60),
      endDate: addDays(TODAY, 62),
      petIds: [BELLA],
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await times(env, id)).toEqual({ StartTime: null, DepartureTime: null });
  });

  it('rejects a malformed departure time with a stable code', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 70),
      endDate: addDays(TODAY, 72),
      petIds: [BELLA],
      departureTime: '24:00',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'invalid_departure_time',
    });
  });
});

describe('daycare owns no clock, so the owner sets both times', () => {
  it('stores an arrival and a departure on a daycare booking', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'daycare',
      startDate: addDays(TODAY, 40),
      petIds: [BELLA],
      startTime: '08:00',
      departureTime: '16:30',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await times(env, id)).toEqual({ StartTime: '08:00', DepartureTime: '16:30' });
  });

  it('refuses a departure at or before the arrival ON ONE DAY', async () => {
    const { env } = createTestEnv();
    for (const departureTime of ['08:00', '07:30']) {
      const res = await post(env, {
        type: 'daycare',
        startDate: addDays(TODAY, 41),
        petIds: [BELLA],
        startTime: '08:00',
        departureTime,
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { code: string }).toMatchObject({
        code: 'invalid_departure_time',
      });
    }
  });
});

describe('a duration-priced option still owns the clock', () => {
  it('refuses an owner arrival time on a walk (the option is the appointment)', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'walk',
      startDate: MONDAY,
      optionKey: 'd30',
      petIds: [BELLA],
      startTime: '09:00',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: 'invalid_start_time' });
  });

  it('refuses an owner departure time on a walk too', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'walk',
      startDate: MONDAY,
      optionKey: 'd30',
      petIds: [BELLA],
      departureTime: '09:30',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({
      code: 'invalid_departure_time',
    });
  });
});

describe('the Google event', () => {
  const base: CalendarBooking = {
    serviceLabel: 'Boarding',
    category: 'boarding',
    bookingId: 'b1',
    startDate: '2028-09-01',
    endDate: '2028-09-04',
    startTime: null,
    departureTime: null,
    durationMinutes: null,
    petCount: 1,
    petNames: ['Bella'],
    estCost: 150,
    customerEmail: 'jess@example.com',
    status: 'confirmed',
    timezone: 'America/Los_Angeles',
  };

  it('keeps a RANGE stay all-day with both times, and states them in the description', () => {
    const ev = buildEventResource({ ...base, startTime: '17:00', departureTime: '08:00' });
    // Not negotiable: a timed dateTime event is single-day-only and would collapse the stay.
    expect(ev.start).toEqual({ date: '2028-09-01' });
    expect(ev.end).toEqual({ date: '2028-09-04' });
    expect(ev.description).toContain('Arrival: 17:00');
    expect(ev.description).toContain('Departure: 08:00');
  });

  it('gives a SINGLE-DAY booking with both times a real duration', () => {
    const ev = buildEventResource({
      ...base,
      serviceLabel: 'Daycare',
      category: 'daycare',
      endDate: null,
      startTime: '08:00',
      departureTime: '16:30',
    });
    expect(ev.start).toEqual({
      dateTime: '2028-09-01T08:00:00',
      timeZone: 'America/Los_Angeles',
    });
    expect(ev.end).toEqual({
      dateTime: '2028-09-01T16:30:00',
      timeZone: 'America/Los_Angeles',
    });
  });

  it('falls back to the option duration when a single-day booking has no departure time', () => {
    const ev = buildEventResource({
      ...base,
      endDate: null,
      startTime: '09:00',
      durationMinutes: 30,
    });
    expect(ev.end).toEqual({
      dateTime: '2028-09-01T09:30:00',
      timeZone: 'America/Los_Angeles',
    });
  });
});

describe('an edit changes the times', () => {
  it('moves the departure time and leaves the estimate alone (a time is not price-relevant)', async () => {
    const { env } = createTestEnv();
    const created = await post(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 80),
      endDate: addDays(TODAY, 83),
      petIds: [BELLA],
      startTime: '17:00',
      departureTime: '08:00',
    });
    const { id, estCost } = (await created.json()) as { id: string; estCost: number };

    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const res = await app.request(
      `/api/${SLUG}/bookings/${id}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: addDays(TODAY, 80),
          endDate: addDays(TODAY, 83),
          petIds: [BELLA],
          answers: {},
          startTime: '18:00',
          departureTime: '11:00',
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { estCost: number }).toMatchObject({ estCost });
    expect(await times(env, id)).toEqual({ StartTime: '18:00', DepartureTime: '11:00' });
  });

  it('clears the departure time when the edit omits it', async () => {
    const { env } = createTestEnv();
    const created = await post(env, {
      type: 'boarding',
      startDate: addDays(TODAY, 90),
      endDate: addDays(TODAY, 92),
      petIds: [BELLA],
      departureTime: '08:00',
    });
    const { id } = (await created.json()) as { id: string };
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const res = await app.request(
      `/api/${SLUG}/bookings/${id}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startDate: addDays(TODAY, 90),
          endDate: addDays(TODAY, 92),
          petIds: [BELLA],
          answers: {},
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await times(env, id)).toEqual({ StartTime: null, DepartureTime: null });
  });
});
