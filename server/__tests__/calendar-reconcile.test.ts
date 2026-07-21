import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { reconcileBookingsWithCalendar, reconcileIfStale } from '../lib/calendar-sync';
import { insertBookingRequest, setBookingGCalEventId, setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminToken, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

const tenant = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant;

// reconcileBookingsWithCalendar's query window is [today-1, today+180) relative to the *real*
// clock (no fake timers here), so "in window" fixtures must be computed relative to actual today
// rather than hardcoded — a hardcoded future date eventually ages out of the window.
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
const IN_WINDOW_START = addDays(TODAY, 10);
const IN_WINDOW_END = addDays(TODAY, 13);

async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z', // far future — no refresh-token fetch needed
    calendarId: 'primary',
  });
}

function calendarListResponse(bookingIds: string[]) {
  return new Response(
    JSON.stringify({
      items: bookingIds.map((id) => ({
        summary: 'Boarding',
        start: { date: IN_WINDOW_START },
        end: { date: IN_WINDOW_END },
        extendedProperties: { private: { pawbook: 'true', category: 'boarding', bookingId: id } },
      })),
    }),
    { status: 200 },
  );
}

async function seedSyncedBooking(
  env: Env,
  dates: { startDate: string; endDate: string } = {
    startDate: IN_WINDOW_START,
    endDate: IN_WINDOW_END,
  },
): Promise<string> {
  const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: dates.startDate,
    endDate: dates.endDate,
    optionKey: 'standard',
    petType: 'dog',
    petCount: 1,
    estCost: 150,
    status: 'confirmed',
  });
  await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, id, 'evt_1', null);
  return id;
}

async function statusOf(env: Env, id: string): Promise<string> {
  const row = await env.PAWBOOK_DB.prepare('SELECT Status FROM BookingRequests WHERE Id = ?')
    .bind(id)
    .first<{ Status: string }>();
  return row!.Status;
}

async function bookingRow(
  env: Env,
  id: string,
): Promise<{ Status: string; StartDate: string; EndDate: string | null }> {
  const row = await env.PAWBOOK_DB.prepare(
    'SELECT Status, StartDate, EndDate FROM BookingRequests WHERE Id = ?',
  )
    .bind(id)
    .first<{ Status: string; StartDate: string; EndDate: string | null }>();
  return row!;
}

describe('reconcileBookingsWithCalendar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cancels a synced booking whose event is missing from Calendar', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([])); // event deleted
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await statusOf(env, id)).toBe('cancelled');
  });

  it('leaves a booking untouched when its event is still present', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([id]));
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await statusOf(env, id)).toBe('confirmed');
  });

  it('no-ops when no calendar is connected', async () => {
    const { env } = createTestEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    await reconcileBookingsWithCalendar(env, tenant);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws instead of silently reconciling when the Calendar response is truncated, leaving the booking untouched', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);
    // Simulates a calendar with >2500 events in range: the booking's event would be missing from
    // this (first) page, but listCalendarEvents throws instead of returning an incomplete list —
    // so reconcileBookingsWithCalendar never reaches the "cancel missing bookings" loop.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextPageToken: 'abc' }), { status: 200 }),
    );
    await expect(reconcileBookingsWithCalendar(env, tenant)).rejects.toThrow('result truncated');
    expect(await statusOf(env, id)).toBe('confirmed');
  });

  it('leaves a booking outside the Calendar query window untouched, even though its event is absent from the response', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // Well outside any [today-1, today+180) window relative to actual real-world "today".
    const id = await seedSyncedBooking(env, { startDate: '2020-01-01', endDate: '2020-01-04' });
    // Simulates the booking being outside the query window: the response simply never contains it.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([]));
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await statusOf(env, id)).toBe('confirmed');
  });

  it('ignores a time change on an otherwise-present event — only presence of the bookingId is checked', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env); // default in-window dates
    const before = await bookingRow(env, id);
    // Event exists (same bookingId) but with different start/end dates than the DB row — still
    // well within the query window, just not matching the DB row's own dates.
    const shiftedStart = addDays(IN_WINDOW_START, 45);
    const shiftedEnd = addDays(IN_WINDOW_END, 45);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              summary: 'Boarding',
              start: { date: shiftedStart },
              end: { date: shiftedEnd },
              extendedProperties: {
                private: { pawbook: 'true', category: 'boarding', bookingId: id },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await bookingRow(env, id)).toEqual(before);
  });
});

describe('reconcileIfStale', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reconciles once, then skips within the TTL window', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([]));
    await reconcileIfStale(env, tenant);
    expect(spy).toHaveBeenCalledTimes(1);
    await reconcileIfStale(env, tenant);
    expect(spy).toHaveBeenCalledTimes(1); // second call within the TTL skips Calendar entirely
  });

  it('writes the TTL marker even when reconciliation fails, throttling retries during an outage', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 })); // Calendar API failure
    await reconcileIfStale(env, tenant);
    expect(spy).toHaveBeenCalledTimes(1);
    await reconcileIfStale(env, tenant);
    expect(spy).toHaveBeenCalledTimes(1); // marker was written despite the first call's failure
  });

  it('does not cancel a booking when the Calendar response is truncated (nextPageToken present)', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);
    // >2500 events in range: the booking's event would be missing from this (first) page, but
    // listCalendarEvents throws on truncation instead of returning an incomplete list, so the
    // best-effort wrapper here swallows the error and leaves the booking's status alone.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [], nextPageToken: 'abc' }), { status: 200 }),
    );
    await expect(reconcileIfStale(env, tenant)).resolves.not.toThrow();
    expect(await statusOf(env, id)).toBe('confirmed');
  });
});

describe('GET /:slug/admin/bookings triggers reconciliation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cancels a booking whose calendar event is gone before returning the list', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([]));
    const token = await adminToken(TENANT_A);
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await res.json()) as { bookings: { id: string; status: string }[] };
    expect(body.bookings.find((b) => b.id === id)?.status).toBe('cancelled');
  });
});
