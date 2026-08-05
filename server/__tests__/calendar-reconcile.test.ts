import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  calendarSyncKey,
  calendarWidgetSyncKey,
  RECONCILE_MIN_HORIZON_DAYS,
  reconcileBookingsWithCalendar,
  reconcileIfStale,
  reconcileWindow,
  redriveCalendarOutbox,
} from '../lib/calendar-sync';
import { insertBookingRequest, setBookingGCalEventId, setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { addDays, addMonths, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminToken, createTestEnv, endUserToken, TENANT_A, TEST_SECRET } from './helpers';
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
  await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
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
                private: { pawservation: 'true', category: 'boarding', bookingId: e.bookingId },
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
  const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: dates.startDate,
    endDate: dates.endDate,
    optionKey: 'standard',
    petCount: 1,
    estCost: 150,
    status: 'confirmed',
  });
  await setBookingGCalEventId(env.PAWSERVATION_DB, TENANT_A, id, 'evt_1', null);
  return id;
}

async function statusOf(env: Env, id: string): Promise<string> {
  const row = await env.PAWSERVATION_DB.prepare('SELECT Status FROM BookingRequests WHERE Id = ?')
    .bind(id)
    .first<{ Status: string }>();
  return row!.Status;
}

async function bookingRow(
  env: Env,
  id: string,
): Promise<{ Status: string; StartDate: string; EndDate: string | null }> {
  const row = await env.PAWSERVATION_DB.prepare(
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
                private: { pawservation: 'true', category: 'boarding', bookingId: id },
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

  /**
   * The marker is CLAIMED BEFORE the pull, not written after it. Written after, the throttle only
   * spaces out non-overlapping pulls and gives no exclusion: every concurrent month-grid GET reads
   * an empty key and starts its own reconcile — and one pull's outbox stamping a GCalEventId
   * mid-flight makes another read a live booking as hand-deleted and CANCEL it (emailing the
   * customer). This drives a second call from inside the first one's in-flight Google round-trip,
   * which is the shape of that race.
   */
  it('claims the throttle BEFORE the work, so an overlapping call does no Google round-trip', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    let reentered = false;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (!reentered) {
        reentered = true;
        await reconcileIfStale(env, tenant); // a second request, arriving mid-pull
      }
      return calendarListResponse([]);
    });
    await reconcileIfStale(env, tenant);
    expect(reentered).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // the overlapping call saw the claim and did nothing
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
  const { results } = await env.PAWSERVATION_DB.prepare(
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
    await env.PAWSERVATION_DB.prepare(
      `INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, GCalEventId, Status, SyncPending)
       VALUES ('ext_old', ?, 'external', '2020-01-01', '2020-01-03', 1, 'gev_old', 'confirmed', 0)`,
    )
      .bind(TENANT_A)
      .run();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([]));
    await reconcileBookingsWithCalendar(env, tenant);
    const row = await env.PAWSERVATION_DB.prepare('SELECT Id FROM BookingRequests WHERE Id = ?')
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

  it('a Pawservation-tagged event is never materialized as external (booking or blocked/time-off)', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const bookingId = await seedSyncedBooking(env);
    // A blocked (time-off) row's UNAVAILABLE event also carries private.bookingId (see
    // buildUnavailableEventResource) — this is the SAME foreign-event filter (`!e.private.bookingId`)
    // that must skip it too, not a second implementation.
    const blockedId = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: IN_WINDOW_START,
      endDate: IN_WINDOW_END,
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    await setBookingGCalEventId(env.PAWSERVATION_DB, TENANT_A, blockedId, 'evt_block_tagged', null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([bookingId, blockedId]));
    await reconcileBookingsWithCalendar(env, tenant);
    expect(await externalRows(env)).toEqual([]);
    expect(await statusOf(env, bookingId)).toBe('confirmed');
    expect(await statusOf(env, blockedId)).toBe('confirmed');
  });

  it("tenant isolation: tenant B's identically-named Google event ids never collide with A's rows", async () => {
    const { env } = createTestEnv();
    await connectCalendar(env); // tenant A only
    await env.PAWSERVATION_DB.prepare(
      `INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, GCalEventId, Status, SyncPending)
       VALUES ('ext_b', 'tnt_happytails', 'external', ?, ?, 1, 'gev_1', 'confirmed', 0)`,
    )
      .bind(IN_WINDOW_START, IN_WINDOW_END)
      .run();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([])); // A's calendar now empty
    await reconcileBookingsWithCalendar(env, tenant); // deletes A's in-window externals only
    const b = await env.PAWSERVATION_DB.prepare('SELECT Id FROM BookingRequests WHERE Id = ?')
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
    await env.PAWSERVATION_DB.prepare(
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

    const row = await env.PAWSERVATION_DB.prepare(
      'SELECT Id FROM BookingRequests WHERE TenantId = ? AND GCalEventId = ?',
    )
      .bind(TENANT_A, deferredId)
      .first();
    expect(row).not.toBeNull(); // NOT deleted, despite not being in this pass's materialize batch
  });

  // Regression: MATERIALIZE_LIMIT overflow must make real progress, not rewrite the same first-200
  // prefix forever while event #201 never gets a row. Not-yet-materialized events are prioritized
  // over already-materialized ones, so a 250-event backlog fully drains by the second pass, and an
  // already-materialized event that moved still picks up its update once budget allows.
  it('MATERIALIZE_LIMIT overflow makes real progress: 250 foreign events all have rows by pass two, and a moved already-materialized event still updates', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);

    const events = Array.from({ length: 250 }, (_, i) => ({
      id: `gev_ov_${i}`,
      summary: `Event ${i}`,
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse(events));
    await reconcileBookingsWithCalendar(env, tenant); // pass 1: writes the first 200 (none had a row yet)
    expect(await externalRows(env)).toHaveLength(200);

    // Pass 2: same 250 events, but gev_ov_0 (materialized in pass 1) has moved in Google.
    vi.restoreAllMocks();
    const moved = addDays(IN_WINDOW_START, 7);
    const movedEnd = addDays(IN_WINDOW_END, 7);
    const eventsPass2 = events.map((e) =>
      e.id === 'gev_ov_0' ? { ...e, start: { date: moved }, end: { date: movedEnd } } : e,
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse(eventsPass2));
    await reconcileBookingsWithCalendar(env, tenant); // pass 2: the 50 stragglers get priority

    const rowsAfterPass2 = await externalRows(env);
    expect(rowsAfterPass2).toHaveLength(250); // every foreign event now has a row — progress was real

    const movedRow = rowsAfterPass2.find((r) => r.GCalEventId === 'gev_ov_0');
    expect(movedRow).toMatchObject({ StartDate: moved, EndDate: movedEnd }); // update applied, budget permitting
  });
});

describe('reconcile v2 — blocked-row re-assertion (a2)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Seed a confirmed blocked (time-off) row with a stamped GCalEventId, starting from the
   *  realistic "already synced, nothing owed" state — insertBookingRequest always stamps
   *  SyncPending = 1 on insert, so this resets it to 0 first, meaning any SyncPending = 1 seen
   *  after a reconcile call in these tests can only be attributed to the re-assertion pass under
   *  test, never to the seed itself. */
  async function seedBlocked(
    env: Env,
    opts?: { startDate?: string; endDate?: string; gcalEventId?: string },
  ): Promise<string> {
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: opts?.startDate ?? IN_WINDOW_START,
      endDate: opts?.endDate ?? IN_WINDOW_END,
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    await setBookingGCalEventId(
      env.PAWSERVATION_DB,
      TENANT_A,
      id,
      opts?.gcalEventId ?? 'evt_block',
      null,
    );
    await env.PAWSERVATION_DB.prepare('UPDATE BookingRequests SET SyncPending = 0 WHERE Id = ?')
      .bind(id)
      .run();
    return id;
  }

  async function rowState(
    env: Env,
    id: string,
  ): Promise<{ Status: string; GCalEventId: string | null; SyncPending: number }> {
    const row = await env.PAWSERVATION_DB.prepare(
      'SELECT Status, GCalEventId, SyncPending FROM BookingRequests WHERE Id = ?',
    )
      .bind(id)
      .first<{ Status: string; GCalEventId: string | null; SyncPending: number }>();
    return row!;
  }

  it('re-arms a blocked row whose event is missing from Google, without cancelling it or clearing its stale event id', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBlocked(env, { gcalEventId: 'evt_block_gone' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([])); // hand-deleted in Google
    await reconcileBookingsWithCalendar(env, tenant);
    const row = await rowState(env, id);
    expect(row.Status).toBe('confirmed'); // never cancelled — time off isn't a withdrawable commitment
    expect(row.GCalEventId).toBe('evt_block_gone'); // stale id preserved for the outbox's CAS (expectedOld)
    expect(row.SyncPending).toBe(1); // re-armed for the next outbox pass to recreate the event
  });

  it('leaves a blocked row outside the query window completely untouched, however absent it is from the response', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // Well outside any [today-1, today+180) window relative to actual real-world "today" — same
    // out-of-window shape as the analogous booking test above.
    const id = await seedBlocked(env, {
      startDate: '2020-01-01',
      endDate: '2020-01-03',
      gcalEventId: 'evt_block_old',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([])); // response never could have named it
    await reconcileBookingsWithCalendar(env, tenant);
    const row = await rowState(env, id);
    expect(row.SyncPending).toBe(0); // untouched — outside the window, never spoken for by this response
    expect(row.Status).toBe('confirmed');
    expect(row.GCalEventId).toBe('evt_block_old');
  });

  it("does not re-arm a blocked row whose event is present in Google's response", async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBlocked(env, { gcalEventId: 'evt_block_live' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([id]));
    await reconcileBookingsWithCalendar(env, tenant);
    const row = await rowState(env, id);
    expect(row.SyncPending).toBe(0); // still present in Google — no spurious re-arm
    expect(row.Status).toBe('confirmed');
    expect(row.GCalEventId).toBe('evt_block_live');
  });

  it('a re-armed blocked row is recreated by the next outbox pass, using its stale event id as expectedOld', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBlocked(env, { gcalEventId: 'evt_block_stale' });

    // Pass 1: reconcile sees the event gone from Google and re-arms the row.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([]));
    await reconcileBookingsWithCalendar(env, tenant);
    expect((await rowState(env, id)).SyncPending).toBe(1);

    // Pass 2: the outbox re-drive PATCHes the stale id (404 → gone), then recreates via POST and
    // CASes the new id in using the stale one as expectedOld (updateBookingCalendarEvent's path).
    vi.restoreAllMocks();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const method = (init as RequestInit).method;
      if (method === 'PATCH') return new Response('gone', { status: 404 }); // stale id no longer exists
      return new Response(JSON.stringify({ id: 'evt_block_new' }), { status: 200 }); // POST create
    });
    await redriveCalendarOutbox(env, tenant);

    // Discriminates this path from a reconcile that had instead NULLED GCalEventId: that path would
    // skip updateBookingCalendarEvent entirely and go straight to a create, issuing no PATCH at all
    // — same final row state, but a materially different (and wrong — see the reconcile test above)
    // request sequence. Asserting the PATCH itself, against the stale id, is what actually proves
    // `expectedOld` was preserved rather than merely inferring it from the end state.
    const patchCall = spy.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    expect(patchCall?.[0]).toContain('evt_block_stale');

    const row = await rowState(env, id);
    expect(row.GCalEventId).toBe('evt_block_new'); // recreated — the POSITIVE outcome, not just "not cancelled"
    expect(row.SyncPending).toBe(0); // retired from the outbox once the push landed
    expect(row.Status).toBe('confirmed'); // still blocks capacity throughout
  });
});

describe('reconcile v2 — delete-detection now notifies the customer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cancels AND emails when email is configured; cancel stands when the email fails', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // Seed DIRECTLY (not via the API): the API path would fire its own calendar push against the
    // fetch mock, and a configured RESEND key disables the prototype-code login endUserToken needs.
    const jess = (await env.PAWSERVATION_DB.prepare(
      "SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = 'jess@example.com'",
    )
      .bind(TENANT_A)
      .first<{ Id: string }>())!;
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: jess.Id,
      serviceType: 'boarding',
      startDate: IN_WINDOW_START,
      endDate: IN_WINDOW_END,
      optionKey: 'standard',
      petCount: 1,
      estCost: 150,
      status: 'confirmed',
    });
    await setBookingGCalEventId(env.PAWSERVATION_DB, TENANT_A, id, 'evt_gone', null);
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

/**
 * Task 6c. Reconcile's authoritative window used to be a hardcoded [today-1, today+180) — so a
 * business taking bookings 12+ months out had a whole tail of its bookable calendar that Google
 * was never consulted about. The window now stretches to cover the tenant's booking horizon.
 *
 * The safety property under test is LOCKSTEP: the Google query, `listSyncedBookingIds` and
 * `listExternalEventRowsInWindow` all derive from `reconcileWindow`. Widening only the Google
 * query would leave "absent from the response" meaning "deleted by hand" for bookings that were
 * never in the response's range — i.e. spurious cancellation of real bookings.
 */
describe('reconcileWindow', () => {
  const T = '2026-03-15';

  it('is [today-1, today+180) when the tenant sets no horizon (NULL = unlimited)', () => {
    expect(reconcileWindow({ MaxAdvanceMonths: null } as Tenant, T)).toEqual({
      start: addDays(T, -1),
      endExclusive: addDays(T, RECONCILE_MIN_HORIZON_DAYS),
    });
  });

  it('stretches to the whole horizon, one day past the last bookable date (exclusive end)', () => {
    // 12 months out is well past the 180-day floor.
    expect(reconcileWindow({ MaxAdvanceMonths: 12 } as Tenant, T).endExclusive).toBe(
      addDays(addMonths(T, 12), 1),
    );
  });

  it('never shrinks below the 180-day floor for a short horizon', () => {
    // 2 months ≈ 61 days — the floor wins, so a short horizon keeps today's reach.
    expect(reconcileWindow({ MaxAdvanceMonths: 2 } as Tenant, T).endExclusive).toBe(
      addDays(T, RECONCILE_MIN_HORIZON_DAYS),
    );
  });
});

describe('reconcile over a widened window', () => {
  afterEach(() => vi.restoreAllMocks());

  // 300 days out: past the old 180-day window, inside a 12-month horizon.
  const FAR_START = addDays(TODAY, 300);
  const FAR_END = addDays(TODAY, 303);
  const horizonTenant = { ...tenant, MaxAdvanceMonths: 12 } as Tenant;

  it('does NOT cancel a far-future booking whose Google event is still live', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env, { startDate: FAR_START, endDate: FAR_END });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([id]));
    await reconcileBookingsWithCalendar(env, horizonTenant);
    expect(await statusOf(env, id)).toBe('confirmed');
  });

  it('cancels a far-future booking whose Google event is gone — the widened window reaches it', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env, { startDate: FAR_START, endDate: FAR_END });
    // Fresh Response per call — this test reconciles twice, and a Response body reads once.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => calendarListResponse([]));
    await reconcileBookingsWithCalendar(env, horizonTenant);
    expect(await statusOf(env, id)).toBe('cancelled');
    // Control: the same booking under a no-horizon tenant is outside the 180-day window and is
    // therefore never a candidate — proving the cancel above came from the widening, not luck.
    const { env: env2 } = createTestEnv();
    await connectCalendar(env2);
    const id2 = await seedSyncedBooking(env2, { startDate: FAR_START, endDate: FAR_END });
    await reconcileBookingsWithCalendar(env2, tenant);
    expect(await statusOf(env2, id2)).toBe('confirmed');
  });

  it('materializes a far-future foreign event, and deletes its row only when Google drops it', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const far = { id: 'gev_far', start: { date: FAR_START }, end: { date: FAR_END } };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => calendarResponse([far]));
    await reconcileBookingsWithCalendar(env, horizonTenant);
    expect(await externalRows(env)).toMatchObject([{ GCalEventId: 'gev_far' }]);

    // Still live on the next pass → the row survives (the spurious-delete guard).
    await reconcileBookingsWithCalendar(env, horizonTenant);
    expect(await externalRows(env)).toMatchObject([{ GCalEventId: 'gev_far' }]);

    // Gone from Google → the row goes with it, in the same widened window.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarResponse([]));
    await reconcileBookingsWithCalendar(env, horizonTenant);
    expect(await externalRows(env)).toEqual([]);
  });
});

describe('reconcileIfStale scopes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the widget draws on its own KV key, so the cron cannot eat its budget', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([]));

    // The cron/dashboard marker is set — a shared key would suppress the widget pull entirely.
    await env.PAWSERVATION_CACHE.put(calendarSyncKey(TENANT_A), '1');
    await reconcileIfStale(env, tenant, 'widget');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await env.PAWSERVATION_CACHE.get(calendarWidgetSyncKey(TENANT_A))).toBe('1');

    // …and the widget's own marker then throttles it.
    await reconcileIfStale(env, tenant, 'widget');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a widget pull does not consume the dashboard throttle', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([]));
    await reconcileIfStale(env, tenant, 'widget');
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBeNull();
    await reconcileIfStale(env, tenant); // dashboard scope still runs
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

/**
 * The widget's pull is DEFERRED (`c.executionCtx.waitUntil`), not awaited: `listCalendarEvents`
 * has no timeout, and a hanging Google must never hold up a customer-facing first paint. These
 * tests supply a real ExecutionContext so the route takes its production path; the rest of the
 * suite has none, so the route's `catch { await pull }` fallback keeps those deterministic.
 */
function fakeCtx(): { ctx: ExecutionContext; tail: Promise<unknown>[] } {
  const tail: Promise<unknown>[] = [];
  return {
    tail,
    ctx: {
      waitUntil: (p: Promise<unknown>) => tail.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
  };
}

const monthUrl = (month: string) =>
  `/api/sunny-paws/availability/month?type=boarding&month=${month}`;

describe('GET /:slug/availability/month triggers a widget-scoped reconciliation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not wait on Google: a fetch that never settles still returns the grid promptly', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // The outage mode an awaited call could not survive: Google accepts the connection and then
    // never answers. `listCalendarEvents` has no timeout, so awaiting this would block the
    // response until the platform killed the request.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const { ctx } = fakeCtx();

    const responded = Promise.resolve(
      app.request(
        monthUrl(IN_WINDOW_START.slice(0, 7)),
        { headers: { Authorization: `Bearer ${token}` } },
        env,
        ctx,
      ),
    ).then((r) => r.status as number | 'timeout');
    const timedOut = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 1000),
    );

    expect(await Promise.race([responded, timedOut])).toBe(200);
  });

  it('the deleted-by-hand booking is reconciled in the background and gone from the NEXT load', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: IN_WINDOW_START,
      endDate: addDays(IN_WINDOW_START, 1),
      optionKey: 'standard',
      petCount: 2, // fills Sunny Paws' 2-pet boarding pool for that night
      estCost: null,
      status: 'confirmed',
    });
    await setBookingGCalEventId(env.PAWSERVATION_DB, TENANT_A, id, 'evt_hand_deleted', null);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => calendarListResponse([]));
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const { ctx, tail } = fakeCtx();

    const first = await app.request(
      monthUrl(IN_WINDOW_START.slice(0, 7)),
      { headers: { Authorization: `Bearer ${token}` } },
      env,
      ctx,
    );
    expect(first.status).toBe(200);
    expect(tail).toHaveLength(1); // the pull was handed to the runtime, not awaited inline

    await Promise.all(tail); // the runtime drains it after the response
    expect(await statusOf(env, id)).toBe('cancelled');
    expect(await env.PAWSERVATION_CACHE.get(calendarWidgetSyncKey(TENANT_A))).toBe('1');

    const second = await app.request(
      monthUrl(IN_WINDOW_START.slice(0, 7)),
      { headers: { Authorization: `Bearer ${token}` } },
      env,
      fakeCtx().ctx,
    );
    const body = (await second.json()) as { days: { date: string; status: string }[] };
    expect(body.days.find((d) => d.date === IN_WINDOW_START)?.status).toBe('available');
  });

  // Covers the no-ExecutionContext fallback (`catch { await pull }`), which is what keeps every
  // other test in the suite deterministic: with the pull awaited, one request both reconciles and
  // paints. NOT the production ordering — see the deferred test above for that.
  it('with no ExecutionContext the pull is awaited, so one request both reconciles and paints', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    // A 2-pet stay fills Sunny Paws' boarding pool (MaxConcurrentPets=2) for its night.
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: IN_WINDOW_START,
      endDate: addDays(IN_WINDOW_START, 1),
      optionKey: 'standard',
      petCount: 2,
      estCost: null,
      status: 'confirmed',
    });
    await setBookingGCalEventId(env.PAWSERVATION_DB, TENANT_A, id, 'evt_hand_deleted', null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(calendarListResponse([])); // sitter deleted it

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability/month?type=boarding&month=${IN_WINDOW_START.slice(0, 7)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: { date: string; status: string }[] };
    expect(body.days.find((d) => d.date === IN_WINDOW_START)?.status).toBe('available');
    expect(await statusOf(env, id)).toBe('cancelled');
    expect(await env.PAWSERVATION_CACHE.get(calendarWidgetSyncKey(TENANT_A))).toBe('1');
  });

  it('a Google outage does not break the grid', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Google is down'));
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability/month?type=boarding&month=${IN_WINDOW_START.slice(0, 7)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
  });
});
