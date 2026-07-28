import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { reconcileBookingsWithCalendar, reconcileIfStale } from '../lib/calendar-sync';
import { insertBookingRequest, setBookingGCalEventId, setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminToken, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

const tenant = {
  Id: TENANT_A,
  Slug: 'sunny-paws',
  DisplayName: 'Sunny Paws',
  Timezone: null,
} as Tenant;

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

type FakeEvent = {
  id?: string;
  summary?: string;
  status?: string;
  bookingId?: string; // present → a Pawservation event
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

function calendarResponse(events: FakeEvent[]) {
  return new Response(
    JSON.stringify({
      items: events.map((e) => ({
        id: e.id ?? 'evt_anon',
        summary: e.summary ?? 'Boarding',
        status: e.status ?? 'confirmed',
        updated: '2026-07-27T00:00:00Z',
        start: e.start ?? { date: IN_WINDOW_START },
        end: e.end ?? { date: IN_WINDOW_END },
        ...(e.bookingId
          ? {
              extendedProperties: {
                private: { pawbook: 'true', category: 'boarding', bookingId: e.bookingId },
              },
            }
          : {}),
      })),
    }),
    { status: 200 },
  );
}
const calendarListResponse = (bookingIds: string[]) =>
  calendarResponse(bookingIds.map((id) => ({ bookingId: id })));

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
    // so reconcileBookingsWithCalendar never reaches the "cancel missing bookings" loop. Fresh
    // Response per call — listCalendarEvents now paginates, so a shared mockResolvedValue
    // instance would fail on its second read rather than exercising the truncation path.
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
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
    // best-effort wrapper here swallows the error and leaves the booking's status alone. Fresh
    // Response per call (see the analogous fix in the truncation test above).
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
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

async function externalRows(env: Env) {
  const { results } = await env.PAWBOOK_DB.prepare(
    `SELECT GCalEventId, StartDate, EndDate, ExternalSummary FROM BookingRequests
     WHERE TenantId = ? AND ServiceType = 'external' ORDER BY StartDate`,
  )
    .bind(TENANT_A)
    .all<{ GCalEventId: string; StartDate: string; EndDate: string; ExternalSummary: string }>();
  return results;
}

describe('reconcile v2 — external materialization lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates, moves, and deletes an external row as Google changes', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // 1: appears
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([{ id: 'gev_1', summary: 'Neighbor stay — Rex' }]),
    );
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await externalRows(env)).toEqual([
      {
        GCalEventId: 'gev_1',
        StartDate: IN_WINDOW_START,
        EndDate: IN_WINDOW_END,
        ExternalSummary: 'Neighbor stay — Rex',
      },
    ]);
    // 2: moved + retitled in Google → same row updated, not duplicated
    vi.restoreAllMocks();
    const moved = addDays(IN_WINDOW_START, 5);
    const movedEnd = addDays(IN_WINDOW_END, 5);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([
        { id: 'gev_1', summary: 'Rex — moved', start: { date: moved }, end: { date: movedEnd } },
      ]),
    );
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await externalRows(env)).toEqual([
      { GCalEventId: 'gev_1', StartDate: moved, EndDate: movedEnd, ExternalSummary: 'Rex — moved' },
    ]);
    // 3: deleted in Google → row gone
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([]));
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await externalRows(env)).toEqual([]);
  });

  it('a timed external event blocks exactly the day it touches', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([
        {
          id: 'gev_t',
          summary: 'Vet',
          start: { dateTime: `${IN_WINDOW_START}T14:00:00-07:00` },
          end: { dateTime: `${IN_WINDOW_START}T15:00:00-07:00` },
        },
      ]),
    );
    await reconcileBookingsWithCalendar(env, tenant);
    const [row] = await externalRows(env);
    expect(row).toMatchObject({ StartDate: IN_WINDOW_START, EndDate: addDays(IN_WINDOW_START, 1) });
  });

  it('never touches an external row outside the queried window', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // A stale row far in the past (outside [today-1, today+180)) — absent from every response.
    await env.PAWBOOK_DB.prepare(
      `INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, GCalEventId, Status, SyncPending)
       VALUES ('ext_old', ?, 'external', '2020-01-01', '2020-01-03', 1, 'gev_old', 'confirmed', 0)`,
    )
      .bind(TENANT_A)
      .run();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([]));
    await reconcileBookingsWithCalendar(env, tenant);
    const row = await env.PAWBOOK_DB.prepare('SELECT Id FROM BookingRequests WHERE Id = ?')
      .bind('ext_old')
      .first();
    expect(row).not.toBeNull();
  });

  it('skips cancelled-status events and events with no id', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([
        { id: 'gev_c', summary: 'Ghost', status: 'cancelled' },
        { id: '', summary: 'No id' },
      ]),
    );
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await externalRows(env)).toEqual([]);
  });

  it('a Pawservation-tagged event is never materialized as external', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([id]));
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await externalRows(env)).toEqual([]);
    expect(await statusOf(env, id)).toBe('confirmed');
  });

  it("tenant isolation: tenant B's identically-named Google event ids never collide with A's rows", async () => {
    const { env } = createTestEnv();
    await connectCalendar(env); // tenant A only
    await env.PAWBOOK_DB.prepare(
      `INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, GCalEventId, Status, SyncPending)
       VALUES ('ext_b', 'tnt_happytails', 'external', ?, ?, 1, 'gev_1', 'confirmed', 0)`,
    )
      .bind(IN_WINDOW_START, IN_WINDOW_END)
      .run();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([])); // A's calendar now empty
    await reconcileBookingsWithCalendar(env, tenant); // deletes A's in-window externals only
    const b = await env.PAWBOOK_DB.prepare('SELECT Id FROM BookingRequests WHERE Id = ?')
      .bind('ext_b')
      .first();
    expect(b).not.toBeNull();
  });

  // Regression for the `liveIds` comment in reconcileBookingsWithCalendar: MATERIALIZE_LIMIT (200)
  // caps how many foreign events get a row WRITTEN this pass, but delete-detection must still be
  // told about every foreign event Google reports — a deferred-but-still-live event's already
  // materialized row must survive, not be deleted just because this pass didn't (re)write it.
  it('a deferred-but-live event beyond MATERIALIZE_LIMIT keeps its already-materialized row', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // Pre-seed a row as if an EARLIER reconcile pass had already materialized this event.
    const deferredId = 'gev_deferred';
    await env.PAWBOOK_DB.prepare(
      `INSERT INTO BookingRequests
         (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, GCalEventId, ExternalSummary, Status, SyncPending)
       VALUES ('ext_deferred', ?, 'external', ?, ?, 1, ?, 'Deferred stay', 'confirmed', 0)`,
    )
      .bind(TENANT_A, IN_WINDOW_START, IN_WINDOW_END, deferredId)
      .run();

    // Google reports 201 foreign events this pass: 200 filler events that exactly fill
    // MATERIALIZE_LIMIT's write batch, plus the already-materialized one appended LAST so it
    // falls outside toMaterialize's first-200 slice but is still present in the full liveIds list.
    const filler = Array.from({ length: 200 }, (_, i) => ({
      id: `gev_fill_${i}`,
      summary: `Filler ${i}`,
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse([...filler, { id: deferredId, summary: 'Deferred stay' }]),
    );

    await reconcileBookingsWithCalendar(env, tenant);

    const row = await env.PAWBOOK_DB.prepare(
      'SELECT Id FROM BookingRequests WHERE TenantId = ? AND GCalEventId = ?',
    )
      .bind(TENANT_A, deferredId)
      .first();
    expect(row).not.toBeNull(); // NOT deleted, despite not being in this pass's materialize batch
  });
});

describe('reconcile v2 — delete-detection now notifies the customer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cancels AND emails when email is configured; cancel stands when the email fails', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // Seed DIRECTLY (not via the API): the API path would fire its own calendar push against the
    // fetch mock, and a configured RESEND key disables the prototype-code login endUserToken needs.
    const jess = (await env.PAWBOOK_DB.prepare(
      "SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = 'jess@example.com'",
    )
      .bind(TENANT_A)
      .first<{ Id: string }>())!;
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: jess.Id,
      serviceType: 'boarding',
      startDate: IN_WINDOW_START,
      endDate: IN_WINDOW_END,
      optionKey: 'standard',
      petCount: 1,
      estCost: 150,
      status: 'confirmed',
    });
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, id, 'evt_gone', null);
    // Configure email ONLY now, for the reconcile under test.
    (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 're_test';
    (env as { RESEND_FROM_BOOKING?: string }).RESEND_FROM_BOOKING = 'book@pawservation.test';
    (env as { RESEND_FROM_NOREPLY?: string }).RESEND_FROM_NOREPLY = 'noreply@pawservation.test';

    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes('resend.com')) return new Response('{}', { status: 200 });
      return calendarListResponse([]); // the event is gone from Google
    });
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await statusOf(env, id)).toBe('cancelled');
    expect(calls.some((u) => u.includes('resend.com'))).toBe(true);
  });

  it('without email configured, the cancel still happens silently', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([]));
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await statusOf(env, id)).toBe('cancelled');
  });
});
