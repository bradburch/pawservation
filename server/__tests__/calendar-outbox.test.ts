import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  deleteBookingCalendarEvent,
  redriveCalendarOutbox,
  syncBookingToCalendar,
  updateBookingCalendarEvent,
} from '../lib/calendar-sync';
import {
  cancelBlockedRange,
  insertBackfilledBooking,
  insertBookingRequest,
  listBlockedRowsWithEventsInWindow,
  listSyncedBookingIds,
  listSyncPendingBookings,
  listUnsyncedFutureBookings,
  markSyncPending,
  setProviderTokens,
  updateBookingStatus,
} from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import {
  adminHeaders,
  createTestEnv,
  endUserToken,
  TENANT_A,
  TENANT_B,
  TEST_SECRET,
} from './helpers';
import type { Tenant } from '../types';

const tenant = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant;
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

async function syncState(env: Env, id: string) {
  return (await env.PAWSERVATION_DB.prepare(
    'SELECT SyncPending, GCalEventId, Status FROM BookingRequests WHERE Id = ?',
  )
    .bind(id)
    .first<{ SyncPending: number; GCalEventId: string | null; Status: string }>())!;
}

function seedBooking(env: Env, status: 'pending' | 'confirmed' = 'confirmed') {
  return insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: addDays(TODAY, 10),
    endDate: addDays(TODAY, 13),
    optionKey: 'standard',
    petCount: 1,
    estCost: 150,
    status,
  });
}

const syncInputFor = (id: string) => ({
  bookingId: id,
  endUserId: null,
  serviceType: 'boarding',
  serviceLabel: 'Boarding',
  startDate: addDays(TODAY, 10),
  endDate: addDays(TODAY, 13),
  startTime: null,
  departureTime: null,
  durationMinutes: null,
  petCount: 1,
  petNames: ['Bella'],
  estCost: 150,
  status: 'confirmed' as const,
});

describe('calendar outbox — write side', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a customer booking POST leaves SyncPending=1 when the Google push fails, 0 when it lands', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'boarding',
          startDate: addDays(TODAY, 30),
          endDate: addDays(TODAY, 32),
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(res.status).toBe(201); // Google failure NEVER blocks the booking
    const { id } = (await res.json()) as { id: string };
    expect((await syncState(env, id)).SyncPending).toBe(1);

    // Now the push succeeds (event create returns an id) — flag clears via the CAS write.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_ok' }), { status: 200 }),
    );
    await syncBookingToCalendar(env, tenant, { ...syncInputFor(id), status: 'pending' });
    const after = await syncState(env, id);
    expect(after).toMatchObject({ SyncPending: 0, GCalEventId: 'evt_ok' });
    void raw;
  });

  it('a blocked-day row is born sync-pending, same as a real booking, and is returned by the outbox query', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: addDays(TODAY, 5),
      endDate: addDays(TODAY, 7),
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    expect((await syncState(env, id)).SyncPending).toBe(1);
    // Assert the query itself returns the row — that is the predicate that changed, not merely
    // the SyncPending flag on a row fetched some other way.
    const rows = await listSyncPendingBookings(
      env.PAWSERVATION_DB,
      TENANT_A,
      addDays(TODAY, -1),
      200,
    );
    expect(rows.map((r) => r.Id)).toContain(id);
  });

  it('listUnsyncedFutureBookings widened bound: an in-progress blocked row (StartDate past, EndDate future) is still a backfill candidate', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: addDays(TODAY, -3),
      endDate: addDays(TODAY, 4),
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    const rows = await listUnsyncedFutureBookings(env.PAWSERVATION_DB, TENANT_A, TODAY, 200);
    expect(rows.map((r) => r.Id)).toContain(id);
  });

  it('listUnsyncedFutureBookings widened bound: an in-progress real booking (StartDate past, EndDate future) is still a backfill candidate', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: addDays(TODAY, -3),
      endDate: addDays(TODAY, 4),
      optionKey: 'standard',
      petCount: 1,
      estCost: 150,
      status: 'confirmed',
    });
    const rows = await listUnsyncedFutureBookings(env.PAWSERVATION_DB, TENANT_A, TODAY, 200);
    expect(rows.map((r) => r.Id)).toContain(id);
  });

  it('every status transition re-marks the row pending', async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, 'pending');
    await clearFlag(env, id);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'confirmed');
    expect((await syncState(env, id)).SyncPending).toBe(1);
    await clearFlag(env, id);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'cancelled');
    expect((await syncState(env, id)).SyncPending).toBe(1);
  });

  it('declining marks pending too (post-baseline Status=declined)', async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, 'pending');
    await clearFlag(env, id);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'declined');
    const s = await syncState(env, id);
    expect(s).toMatchObject({ Status: 'declined', SyncPending: 1 });
  });

  // The assessed-cancellation branch (cancellationFee != null) is a separate SQL statement from
  // the plain cancel above — it must carry the same SyncPending=1 write, or a fee-cancelled
  // booking's calendar event would silently never get deleted.
  it('cancelling WITH an assessed cancellation fee also marks the row pending', async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, 'confirmed');
    await clearFlag(env, id);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'cancelled', 25);
    const s = await syncState(env, id);
    expect(s).toMatchObject({ Status: 'cancelled', SyncPending: 1 });
  });

  it('a successful update-push and delete-push clear the flag; failures leave it set', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env);
    await env.PAWSERVATION_DB.prepare(
      "UPDATE BookingRequests SET GCalEventId = 'evt_1', SyncPending = 1 WHERE Id = ?",
    )
      .bind(id)
      .run();

    // update-push failure → still pending
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(
      updateBookingCalendarEvent(env, tenant, 'evt_1', syncInputFor(id)),
    ).rejects.toThrow();
    expect((await syncState(env, id)).SyncPending).toBe(1);

    // update-push success → cleared
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await updateBookingCalendarEvent(env, tenant, 'evt_1', syncInputFor(id));
    expect((await syncState(env, id)).SyncPending).toBe(0);

    // delete-push success → cleared (cancel first to make it a real delete case)
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'cancelled');
    expect((await syncState(env, id)).SyncPending).toBe(1);
    await deleteBookingCalendarEvent(env, tenant, 'evt_1', id);
    expect((await syncState(env, id)).SyncPending).toBe(0);
  });
});

async function clearFlag(env: Env, id: string) {
  await env.PAWSERVATION_DB.prepare('UPDATE BookingRequests SET SyncPending = 0 WHERE Id = ?')
    .bind(id)
    .run();
}

describe('redriveCalendarOutbox', () => {
  afterEach(() => vi.restoreAllMocks());

  it('re-drives a failed create: event created, id stored, flag cleared', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env, 'pending'); // born SyncPending=1, GCalEventId NULL
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_redriven' }), { status: 200 }));
    await redriveCalendarOutbox(env, tenant);
    expect(spy).toHaveBeenCalled();
    expect(await syncState(env, id)).toMatchObject({
      SyncPending: 0,
      GCalEventId: 'evt_redriven',
    });
  });

  it('re-drives a failed delete for a cancelled booking, and clears without a call when there is no event', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const withEvent = await seedBooking(env);
    await env.PAWSERVATION_DB.prepare(
      "UPDATE BookingRequests SET GCalEventId = 'evt_x' WHERE Id = ?",
    )
      .bind(withEvent)
      .run();
    const withoutEvent = await seedBooking(env, 'pending');
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, withEvent, 'cancelled');
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, withoutEvent, 'declined');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await redriveCalendarOutbox(env, tenant);
    expect((await syncState(env, withEvent)).SyncPending).toBe(0);
    expect((await syncState(env, withoutEvent)).SyncPending).toBe(0);
    // Only ONE Google call: the DELETE for withEvent. withoutEvent had nothing to delete.
    expect(spy.mock.calls.filter(([u]) => String(u).includes('/events/')).length).toBe(1);
  });

  it('a failing row stays pending and does not stop the rest of the batch', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const first = await seedBooking(env, 'pending');
    const second = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: addDays(TODAY, 20),
      endDate: addDays(TODAY, 22),
      optionKey: 'standard',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    let call = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      ++call === 1
        ? new Response('', { status: 500 })
        : new Response(JSON.stringify({ id: `evt_${call}` }), { status: 200 }),
    );
    await redriveCalendarOutbox(env, tenant);
    expect((await syncState(env, first)).SyncPending).toBe(1); // earliest StartDate goes first, fails
    expect((await syncState(env, second)).SyncPending).toBe(0);
  });

  it('no connection → no Google calls, rows stay pending for a future connect', async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, 'pending');
    const spy = vi.spyOn(globalThis, 'fetch');
    await redriveCalendarOutbox(env, tenant);
    expect(spy).not.toHaveBeenCalled();
    expect((await syncState(env, id)).SyncPending).toBe(1);
  });

  it('a status change landing mid-create is not masked: the flag stays set and the next sweep cleans up correctly', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env, 'pending'); // SyncPending=1, GCalEventId NULL

    // Simulate an admin cancelling the booking WHILE the create's Google round-trip is in flight:
    // the mock performs the status change itself before resolving the create response.
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'cancelled');
      return new Response(JSON.stringify({ id: 'evt_raced' }), { status: 200 });
    });
    await redriveCalendarOutbox(env, tenant);

    // The create's CAS-guarded clear must NOT have masked the cancel's own pending flag — the id
    // is still recorded (so the event isn't orphaned), but SyncPending stays set for a redrive.
    expect(await syncState(env, id)).toMatchObject({
      SyncPending: 1,
      GCalEventId: 'evt_raced',
      Status: 'cancelled',
    });

    // Next sweep sees fresh state (cancelled + a known event id) and deletes it, clearing cleanly.
    vi.restoreAllMocks();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await redriveCalendarOutbox(env, tenant);
    expect(spy.mock.calls[0]?.[0]).toContain('evt_raced');
    expect((await syncState(env, id)).SyncPending).toBe(0);
  });
});

/** Seed a confirmed blocked (time-off) row, optionally with a stamped GCalEventId — mirrors how a
 * real block looks once the outbox has already pushed it to Google. */
async function seedBlocked(
  env: Env,
  opts?: { startDate?: string; endDate?: string; gcalEventId?: string | null; tenantId?: string },
) {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, opts?.tenantId ?? TENANT_A, {
    endUserId: null,
    serviceType: 'blocked',
    startDate: opts?.startDate ?? addDays(TODAY, 5),
    endDate: opts?.endDate ?? addDays(TODAY, 7),
    optionKey: null,
    petCount: 1,
    estCost: null,
    status: 'confirmed',
  });
  if (opts?.gcalEventId !== undefined) {
    await env.PAWSERVATION_DB.prepare('UPDATE BookingRequests SET GCalEventId = ? WHERE Id = ?')
      .bind(opts.gcalEventId, id)
      .run();
  }
  return id;
}

describe('cancelBlockedRange — soft delete', () => {
  it('cancels a confirmed blocked row and returns its GCalEventId, unconditionally re-arming SyncPending', async () => {
    const { env } = createTestEnv();
    const id = await seedBlocked(env, { gcalEventId: 'evt_block_1' });
    // Clear the flag first (it is born pending) so the assertion proves THIS call re-arms it,
    // not merely that it was never cleared.
    await clearFlag(env, id);

    const result = await cancelBlockedRange(env.PAWSERVATION_DB, TENANT_A, id);
    expect(result).toBe('evt_block_1');
    expect(await syncState(env, id)).toMatchObject({
      Status: 'cancelled',
      SyncPending: 1,
      GCalEventId: 'evt_block_1',
    });
  });

  it('a confirmed blocked row with no GCalEventId yet cancels and returns null, not undefined', async () => {
    const { env } = createTestEnv();
    const id = await seedBlocked(env); // simulates the outbox not having pushed it yet — GCalEventId stays NULL
    const result = await cancelBlockedRange(env.PAWSERVATION_DB, TENANT_A, id);
    expect(result).toBeNull();
    expect((await syncState(env, id)).Status).toBe('cancelled');
  });

  it('a repeated call against an already-cancelled row returns undefined (no second UPDATE succeeds)', async () => {
    const { env } = createTestEnv();
    const id = await seedBlocked(env, { gcalEventId: 'evt_block_2' });
    expect(await cancelBlockedRange(env.PAWSERVATION_DB, TENANT_A, id)).toBe('evt_block_2');
    expect(await cancelBlockedRange(env.PAWSERVATION_DB, TENANT_A, id)).toBeUndefined();
    // The row was not further mutated by the second, refused call.
    expect(await syncState(env, id)).toMatchObject({
      Status: 'cancelled',
      GCalEventId: 'evt_block_2',
    });
  });

  it("another tenant's row id is refused — tenant scoping", async () => {
    const { env } = createTestEnv();
    const id = await seedBlocked(env, { tenantId: TENANT_B, gcalEventId: 'evt_block_3' });
    expect(await cancelBlockedRange(env.PAWSERVATION_DB, TENANT_A, id)).toBeUndefined();
    // Untouched — still confirmed under its own tenant.
    const row = await env.PAWSERVATION_DB.prepare('SELECT Status FROM BookingRequests WHERE Id = ?')
      .bind(id)
      .first<{ Status: string }>();
    expect(row?.Status).toBe('confirmed');
  });

  it('an unknown id is refused', async () => {
    const { env } = createTestEnv();
    expect(await cancelBlockedRange(env.PAWSERVATION_DB, TENANT_A, 'no-such-id')).toBeUndefined();
  });
});

describe('updateBookingStatus — a blocked row can never take a CancellationFee', () => {
  it("the assessed-cancellation branch's SQL excludes ServiceType 'blocked': the call is refused and CancellationFee stays NULL", async () => {
    const { env } = createTestEnv();
    const id = await seedBlocked(env, { gcalEventId: 'evt_block_fee' });
    // This is the only branch of updateBookingStatus that ever writes CancellationFee — proving it
    // is refused here is what guarantees a removed blocked row can never carry an assessed fee,
    // which in turn is what keeps keepsCalendarEventOnCancel false and the delete-not-retitle
    // branch the only one that ever fires for time off (see cancelBlockedRange above, which never
    // even offers a fee parameter).
    expect(await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'cancelled', 25)).toBe(
      false,
    );
    const row = await env.PAWSERVATION_DB.prepare(
      'SELECT Status, CancellationFee FROM BookingRequests WHERE Id = ?',
    )
      .bind(id)
      .first<{ Status: string; CancellationFee: number | null }>();
    expect(row).toMatchObject({ Status: 'confirmed', CancellationFee: null });
  });
});

describe("listSyncedBookingIds excludes 'blocked' rows", () => {
  it('a blocked row with a live GCalEventId never enters the delete-detection candidate set', async () => {
    const { env } = createTestEnv();
    await seedBlocked(env, { gcalEventId: 'evt_block_4' });
    const ids = await listSyncedBookingIds(
      env.PAWSERVATION_DB,
      TENANT_A,
      addDays(TODAY, -1),
      addDays(TODAY, 180),
    );
    expect(ids).toEqual([]);
  });
});

describe('listBlockedRowsWithEventsInWindow', () => {
  it('returns a blocked row with an event inside the window, and excludes one outside it or with no event id', async () => {
    const { env } = createTestEnv();
    const inWindow = await seedBlocked(env, {
      startDate: addDays(TODAY, 5),
      endDate: addDays(TODAY, 7),
      gcalEventId: 'evt_in',
    });
    const outsideWindow = await seedBlocked(env, {
      startDate: addDays(TODAY, 400),
      endDate: addDays(TODAY, 402),
      gcalEventId: 'evt_far',
    });
    const noEventId = await seedBlocked(env, {
      startDate: addDays(TODAY, 6),
      endDate: addDays(TODAY, 8),
      gcalEventId: null,
    });

    const ids = await listBlockedRowsWithEventsInWindow(
      env.PAWSERVATION_DB,
      TENANT_A,
      addDays(TODAY, -1),
      addDays(TODAY, 180),
    );
    expect(ids).toContain(inWindow);
    expect(ids).not.toContain(outsideWindow);
    expect(ids).not.toContain(noEventId);
  });

  it('is tenant-scoped', async () => {
    const { env } = createTestEnv();
    const otherTenantId = await seedBlocked(env, { tenantId: TENANT_B, gcalEventId: 'evt_b' });
    const ids = await listBlockedRowsWithEventsInWindow(
      env.PAWSERVATION_DB,
      TENANT_A,
      addDays(TODAY, -1),
      addDays(TODAY, 180),
    );
    expect(ids).not.toContain(otherTenantId);
  });
});

describe('markSyncPending', () => {
  it('sets the flag on exactly the ids given, scoped to the tenant', async () => {
    const { env } = createTestEnv();
    const a = await seedBlocked(env, { startDate: addDays(TODAY, 5), endDate: addDays(TODAY, 7) });
    const b = await seedBlocked(env, {
      startDate: addDays(TODAY, 10),
      endDate: addDays(TODAY, 12),
    });
    const untouched = await seedBlocked(env, {
      startDate: addDays(TODAY, 20),
      endDate: addDays(TODAY, 22),
    });
    const otherTenantRow = await seedBlocked(env, {
      tenantId: TENANT_B,
      startDate: addDays(TODAY, 5),
      endDate: addDays(TODAY, 7),
    });
    // Start every row clean so the assertion proves markSyncPending's own effect.
    await clearFlag(env, a);
    await clearFlag(env, b);
    await clearFlag(env, untouched);
    await clearFlag(env, otherTenantRow);

    await markSyncPending(env.PAWSERVATION_DB, TENANT_A, [a, b]);

    expect((await syncState(env, a)).SyncPending).toBe(1);
    expect((await syncState(env, b)).SyncPending).toBe(1);
    expect((await syncState(env, untouched)).SyncPending).toBe(0);
    // Even though otherTenantRow's id was not in the list at all, this also proves the WHERE
    // clause is tenant-scoped rather than relying solely on the ids not colliding.
    expect((await syncState(env, otherTenantRow)).SyncPending).toBe(0);
  });

  it('chunks beyond DELETE_CHUNK_SIZE without exceeding D1s bound-parameter cap', async () => {
    const { env } = createTestEnv();
    const ids: string[] = [];
    for (let i = 0; i < 95; i++) {
      ids.push(
        await seedBlocked(env, {
          startDate: addDays(TODAY, 100 + i),
          endDate: addDays(TODAY, 101 + i),
        }),
      );
    }
    for (const id of ids) await clearFlag(env, id);

    await markSyncPending(env.PAWSERVATION_DB, TENANT_A, ids);

    for (const id of ids) {
      expect((await syncState(env, id)).SyncPending).toBe(1);
    }
  });

  it('is scoped to ServiceType = blocked — a real booking id is not re-armed', async () => {
    // Structural guard, not incidental: today's only real caller already sources ids from
    // listBlockedRowsWithEventsInWindow (itself scoped to 'blocked'), so this proves the WHERE
    // clause itself refuses a non-blocked row rather than relying on callers to filter first —
    // a future caller aiming this at an 'external' (Google-owned) row's id must not be able to
    // put it in the outbox, where it would be pushed back to Google as a booking-shaped event.
    const { env } = createTestEnv();
    const bookingId = await seedBooking(env, 'confirmed');
    await clearFlag(env, bookingId);

    await markSyncPending(env.PAWSERVATION_DB, TENANT_A, [bookingId]);

    expect((await syncState(env, bookingId)).SyncPending).toBe(0);
  });
});

/**
 * The backfill's central guarantee: adoption is READ-ONLY against Google. An adopted row is born
 * `SyncPending = 0`, but every ordinary lifecycle write re-arms that flag unconditionally
 * (updateBookingStatus, updateBookingRequest) — so "born dormant" is not the guarantee, it is only
 * its first moment. The outbox is where the guarantee has to actually live, because the very
 * action the backfill's own docblock tells the sitter to take (listSyncedBookingIds' comment:
 * "The sitter cancels it from the dashboard instead") is exactly what arms the row.
 *
 * Driven through the real admin route rather than by inserting an already-cancelled row: the
 * arming is the whole point, and a direct insert skips it.
 */
describe('a booking adopted from the calendar is never written back to Google', () => {
  afterEach(() => vi.restoreAllMocks());

  const adopt = (env: Env, status: 'confirmed' | 'cancelled' = 'confirmed') =>
    insertBackfilledBooking(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: 'eu_sp_jess', // seeded owner (sql/seed.sql) — BookingRequests.EndUserId is FK-enforced
      serviceType: 'boarding',
      startDate: addDays(TODAY, 10),
      endDate: addDays(TODAY, 13),
      optionKey: 'standard',
      petCount: 1,
      estCost: 150,
      status,
      gcalEventId: 'evt_the_sitters_own',
    });

  const cancelViaAdmin = async (env: Env, id: string) =>
    app.request(
      `/api/sunny-paws/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      },
      env,
    );

  const eventCalls = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([u]) => String(u).includes('/events'));

  it('cancelling an adopted booking from the dashboard deletes nothing in Google', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await adopt(env);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    expect((await cancelViaAdmin(env, id)).status).toBe(200);
    await redriveCalendarOutbox(env, tenant);

    // A fee-free cancel takes the outbox's DELETE branch (Status terminal + GCalEventId present),
    // which would destroy the sitter's own pre-existing event.
    expect(eventCalls(spy)).toEqual([]);
    // The row must never even be a candidate — the exclusion belongs in the query, not in a
    // per-branch check a future op could miss.
    expect(
      (await listSyncPendingBookings(env.PAWSERVATION_DB, TENANT_A, addDays(TODAY, -1), 100)).map(
        (r) => r.Id,
      ),
    ).not.toContain(id);
  });

  it('cancelling an adopted booking WITH a fee does not overwrite the sitter’s event either', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await adopt(env);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'evt_the_sitters_own' }), { status: 200 }),
      );

    // A fee-bearing cancel takes the outbox's UPDATE branch instead, which would rewrite the
    // sitter's own title and description with pawservation's rendering. Armed through
    // updateBookingStatus's assessed-cancellation branch directly (repo.ts) rather than the admin
    // route, only because no seeded service carries CancellationTiers for the route to compute a
    // fee from — the arming SQL under test is the same statement the route calls.
    expect(await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'cancelled', 25)).toBe(
      true,
    );
    await redriveCalendarOutbox(env, tenant);

    expect(eventCalls(spy)).toEqual([]);
  });

  it('an ORDINARY booking still syncs — the exclusion must not disable the outbox', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const ordinary = await seedBooking(env, 'pending'); // Source NULL, born SyncPending = 1
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_ordinary' }), { status: 200 }));

    expect(
      (await listSyncPendingBookings(env.PAWSERVATION_DB, TENANT_A, addDays(TODAY, -1), 100)).map(
        (r) => r.Id,
      ),
    ).toContain(ordinary);

    await redriveCalendarOutbox(env, tenant);
    expect(eventCalls(spy).length).toBeGreaterThan(0);
    expect(await syncState(env, ordinary)).toMatchObject({
      SyncPending: 0,
      GCalEventId: 'evt_ordinary',
    });
  });
});
