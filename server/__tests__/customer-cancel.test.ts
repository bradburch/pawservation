import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  cancelBookingForUser,
  getAnalytics,
  insertBookingCharge,
  insertBookingRequest,
  listCapacityRows,
  setProviderTokens,
  updateBookingStatus,
} from '../db/repo';
import { redriveCalendarOutbox, reconcileBookingsWithCalendar } from '../lib/calendar-sync';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A, TEST_SECRET } from './helpers';
import type { DatabaseSync } from 'node:sqlite';
import type { Tenant } from '../types';

const SLUG = 'sunny-paws';
const JESS = 'eu_sp_jess';
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
const tenant = { Id: TENANT_A, Slug: SLUG, Timezone: null } as Tenant;

/** 100% within 2 days of the start, 50% within 7 — the fixture the ledger tests already use. */
function seedBoardingTiers(raw: DatabaseSync): void {
  raw.exec(
    `UPDATE TenantServices SET CancellationTiers =
       '[{"withinDays":2,"percent":100},{"withinDays":7,"percent":50}]'
     WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'boarding'`,
  );
}

async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

/** A boarding booking owned by Jess, `startsInDays` out, optionally already synced to Google. */
async function seedBooking(
  env: Env,
  over: {
    status?: 'pending' | 'confirmed';
    startsInDays?: number;
    nights?: number;
    estCost?: number | null;
    endUserId?: string | null;
    gcalEventId?: string;
    serviceType?: string;
  } = {},
): Promise<string> {
  const start = addDays(TODAY, over.startsInDays ?? 20);
  const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
    endUserId: over.endUserId === undefined ? JESS : over.endUserId,
    serviceType: over.serviceType ?? 'boarding',
    startDate: start,
    endDate: addDays(start, over.nights ?? 2),
    optionKey: 'standard',
    petCount: 1,
    estCost: over.estCost === undefined ? 200 : over.estCost,
    status: over.status ?? 'confirmed',
  });
  if (over.gcalEventId) {
    await env.PAWSERVATION_DB.prepare('UPDATE BookingRequests SET GCalEventId = ? WHERE Id = ?')
      .bind(over.gcalEventId, id)
      .run();
  }
  return id;
}

async function row(env: Env, id: string) {
  return (await env.PAWSERVATION_DB.prepare(
    'SELECT Status, CancellationFee, GCalEventId, SyncPending FROM BookingRequests WHERE Id = ?',
  )
    .bind(id)
    .first<{
      Status: string;
      CancellationFee: number | null;
      GCalEventId: string | null;
      SyncPending: number;
    }>())!;
}

const cancel = async (env: Env, token: string, id: string) =>
  app.request(
    `/api/${SLUG}/bookings/${id}/cancel`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    env,
  );

const jessToken = (env: Env) => endUserToken(env, SLUG, 'jess@example.com');

/** Record a hand-entered payment as the sitter — 201 when insertPayment's guard allows it, 404
 *  when it refuses (the route's existing idiom). */
const pay = async (env: Env, id: string, amount = 10) =>
  app.request(
    `/api/${SLUG}/admin/bookings/${id}/payments`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, method: 'cash', paidDate: TODAY }),
    },
    env,
  );

/** Every Google call the mock saw, as `METHOD url`. Structurally typed so it takes the fetch spy
 *  without importing vitest's mock-instance generics. */
function calls(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args) => {
    const [url, init] = args as [unknown, RequestInit | undefined];
    return `${init?.method ?? 'GET'} ${String(url)}`;
  });
}

describe('POST /:slug/bookings/:id/cancel — fee-free path', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cancels a confirmed booking outside every tier: row cancelled, fee stored as 0, Google event DELETED', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    // 40 days out — past the 7-day tier, so nothing is owed.
    const id = await seedBooking(env, { startsInDays: 40, gcalEventId: 'evt_free' });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const res = await cancel(env, await jessToken(env), id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled', cancellationFee: 0 });

    // A REAL 0, not NULL: "cancelled and nothing owed" is a recorded fact.
    expect(await row(env, id)).toMatchObject({
      Status: 'cancelled',
      CancellationFee: 0,
      SyncPending: 0,
    });
    expect(calls(spy)).toEqual([
      'DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_free',
    ]);
  });

  it('cancels a PENDING request free of charge and deletes its [REQUEST] event, even inside the tightest tier', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    // Tomorrow — squarely inside the 100% tier. A CONFIRMED booking here would owe the full
    // $200; a pending REQUEST owes nothing, because the sitter never accepted it.
    const id = await seedBooking(env, {
      status: 'pending',
      startsInDays: 1,
      gcalEventId: 'evt_req',
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    const res = await cancel(env, await jessToken(env), id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled', cancellationFee: 0 });
    expect(await row(env, id)).toMatchObject({ Status: 'cancelled', CancellationFee: 0 });
    // Deleted, not retitled: there is no receivable to keep a calendar record of.
    expect(calls(spy)).toEqual([
      'DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_req',
    ]);
  });

  it('a booking that never synced cancels cleanly with no Google call at all', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const id = await seedBooking(env, { startsInDays: 40 }); // no GCalEventId
    const spy = vi.spyOn(globalThis, 'fetch');
    expect((await cancel(env, await jessToken(env), id)).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(await row(env, id)).toMatchObject({ Status: 'cancelled', CancellationFee: 0 });
  });
});

describe('POST /:slug/bookings/:id/cancel — fee path', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stores the server-computed fee and RETITLES the Google event [CANCELLED]', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    // 5 days out → the 50% tier → $100 of a $200 stay.
    const id = await seedBooking(env, { startsInDays: 5, gcalEventId: 'evt_fee' });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await cancel(env, await jessToken(env), id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled', cancellationFee: 100 });
    expect(await row(env, id)).toMatchObject({
      Status: 'cancelled',
      CancellationFee: 100,
      GCalEventId: 'evt_fee',
      SyncPending: 0,
    });

    expect(calls(spy)).toEqual([
      'PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_fee',
    ]);
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string) as {
      summary: string;
      extendedProperties: { private: Record<string, string> };
    };
    expect(body.summary).toContain('[CANCELLED]');
    // The bookingId survives the retitle — that is what keeps reconcile from reading this as a
    // foreign event and materializing it as capacity-blocking external row (see below).
    expect(body.extendedProperties.private.bookingId).toBe(id);
  });

  it('the client cannot name its own price — the request body is not read at all', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const id = await seedBooking(env, { startsInDays: 5 });
    const res = await app.request(
      `/api/${SLUG}/bookings/${id}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await jessToken(env)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cancellationFee: 0, chargeFee: false }),
      },
      env,
    );
    expect(await res.json()).toEqual({ status: 'cancelled', cancellationFee: 100 });
    expect((await row(env, id)).CancellationFee).toBe(100);
  });

  it('a service with no cancellation policy never charges', async () => {
    const { env } = createTestEnv(); // tiers NOT seeded
    const id = await seedBooking(env, { startsInDays: 1 });
    const res = await cancel(env, await jessToken(env), id);
    expect(await res.json()).toEqual({ status: 'cancelled', cancellationFee: 0 });
  });
});

describe('the outbox must not undo a retitle (the 15-minute bug)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a sweep after a fee-bearing cancel LEAVES the event alive and still titled [CANCELLED]', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const id = await seedBooking(env, { startsInDays: 5, gcalEventId: 'evt_keep' });

    // The cancel's own push FAILS, so the row stays SyncPending=1 and the sweep has to re-drive
    // it — precisely the state in which the old "terminal status + event id → delete" rule would
    // have deleted the event this feature exists to keep.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    expect((await cancel(env, await jessToken(env), id)).status).toBe(200);
    expect(await row(env, id)).toMatchObject({ CancellationFee: 100, SyncPending: 1 });

    vi.restoreAllMocks();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await redriveCalendarOutbox(env, tenant);

    const seen = calls(spy);
    expect(seen).toEqual([
      'PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_keep',
    ]);
    expect(seen.some((c) => c.startsWith('DELETE'))).toBe(false);
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string) as {
      summary: string;
    };
    expect(body.summary).toContain('[CANCELLED]');
    expect(await row(env, id)).toMatchObject({ GCalEventId: 'evt_keep', SyncPending: 0 });
  });

  it('a fee-FREE cancel is still deleted by the sweep, and a decline still is too', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const free = await seedBooking(env, { startsInDays: 40, gcalEventId: 'evt_a' });
    const declined = await seedBooking(env, {
      status: 'pending',
      startsInDays: 41,
      gcalEventId: 'evt_b',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await cancel(env, await jessToken(env), free);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, declined, 'declined');

    vi.restoreAllMocks();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await redriveCalendarOutbox(env, tenant);
    expect(calls(spy).filter((c) => c.startsWith('DELETE')).length).toBe(2);
    expect((await row(env, free)).SyncPending).toBe(0);
    expect((await row(env, declined)).SyncPending).toBe(0);
  });

  /**
   * The outbox's window used to be `StartDate >= today-1`, but `isCustomerCancellable` lets a
   * customer cancel a stay that has ALREADY STARTED. A cancel whose inline Google push failed
   * therefore left SyncPending=1 on a row no sweep could ever see again: the event stayed on the
   * sitter's calendar forever, and the fee-bearing retitle never landed. The bound is now
   * `COALESCE(EndDate, StartDate) >= today-1`, the same shape listSyncedBookingIds uses.
   */
  it('a sweep re-drives a cancelled IN-PROGRESS stay whose push failed (it is not stuck forever)', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    // Started 5 days ago, runs 5 more — in progress today, and inside the 100% tier.
    const id = await seedBooking(env, {
      startsInDays: -5,
      nights: 10,
      gcalEventId: 'evt_inflight',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    expect((await cancel(env, await jessToken(env), id)).status).toBe(200);
    expect(await row(env, id)).toMatchObject({ CancellationFee: 200, SyncPending: 1 });

    vi.restoreAllMocks();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await redriveCalendarOutbox(env, tenant);

    expect(calls(spy)).toEqual([
      'PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_inflight',
    ]);
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string) as {
      summary: string;
    };
    expect(body.summary).toContain('[CANCELLED]');
    expect(await row(env, id)).toMatchObject({ SyncPending: 0 });
  });

  it('a fee-bearing cancel that never synced is retired from the outbox, not pushed into Google', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const id = await seedBooking(env, { startsInDays: 5 }); // no GCalEventId

    expect((await cancel(env, await jessToken(env), id)).status).toBe(200);
    expect(await row(env, id)).toMatchObject({ CancellationFee: 100, SyncPending: 1 });

    const spy = vi.spyOn(globalThis, 'fetch');
    await redriveCalendarOutbox(env, tenant);
    // A create here would put a [CANCELLED] event on a calendar that never carried the booking.
    expect(spy).not.toHaveBeenCalled();
    expect(await row(env, id)).toMatchObject({ GCalEventId: null, SyncPending: 0 });
  });
});

/**
 * The SITTER's cancel path has to reach the same conclusion as the customer's, from the same
 * predicate. If it doesn't, one DB state (cancelled + fee) resolves two ways depending only on
 * whether the inline Google call happened to succeed: the route deletes, but a failed delete
 * leaves SyncPending set and the next sweep retitles instead.
 */
describe('the admin status route shares the delete-vs-retitle rule', () => {
  afterEach(() => vi.restoreAllMocks());

  const postStatus = async (env: Env, id: string, body: Record<string, unknown>) =>
    app.request(
      `/api/${SLUG}/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    );

  it('cancel WITH a fee PATCHes the event to [CANCELLED] rather than deleting it', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const id = await seedBooking(env, { startsInDays: 5, gcalEventId: 'evt_admin' });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    const res = await postStatus(env, id, { status: 'cancelled', chargeFee: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'cancelled', cancellationFee: 100 });

    expect(calls(spy)).toEqual([
      'PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_admin',
    ]);
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string) as {
      summary: string;
    };
    expect(body.summary).toContain('[CANCELLED]');
    expect(await row(env, id)).toMatchObject({
      Status: 'cancelled',
      CancellationFee: 100,
      GCalEventId: 'evt_admin',
      SyncPending: 0,
    });
  });

  it('cancel with a fee on a booking that never synced makes NO Google call — no catch-up create', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const id = await seedBooking(env, { startsInDays: 5 }); // no GCalEventId
    const spy = vi.spyOn(globalThis, 'fetch');

    const res = await postStatus(env, id, { status: 'cancelled', chargeFee: true });
    expect(res.status).toBe(200);
    // The confirm branch this now shares would otherwise CREATE the event as a catch-up, putting
    // a [CANCELLED] entry on a calendar that never carried the booking.
    expect(spy).not.toHaveBeenCalled();
    expect(await row(env, id)).toMatchObject({ CancellationFee: 100, GCalEventId: null });
  });

  it('cancel WITHOUT a fee still deletes, and a decline still deletes', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const cancelled = await seedBooking(env, { startsInDays: 5, gcalEventId: 'evt_nofee' });
    const declined = await seedBooking(env, {
      status: 'pending',
      startsInDays: 6,
      gcalEventId: 'evt_dec',
    });
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    // chargeFee omitted entirely — the sitter waived it.
    await postStatus(env, cancelled, { status: 'cancelled' });
    await postStatus(env, declined, { status: 'declined' });
    expect(calls(spy)).toEqual([
      'DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_nofee',
      'DELETE https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_dec',
    ]);
  });
});

describe('a retitle never resurrects a hand-deleted event', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a fee-bearing cancel against an already-deleted event does not create a [CANCELLED] one', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const id = await seedBooking(env, { startsInDays: 5, gcalEventId: 'evt_gone' });
    // Google reports the event gone (the sitter deleted it by hand). updateBookingCalendarEvent's
    // recreate branch exists to re-assert a LIVE booking; re-asserting a dead one would put back
    // the very event a fee-free cancel deletes on purpose.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 410 }));

    expect((await cancel(env, await jessToken(env), id)).status).toBe(200);
    expect(calls(spy)).toEqual([
      'PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_gone',
    ]);
    expect(calls(spy).some((c) => c.startsWith('POST'))).toBe(false);
    // Flag cleared: there is nothing left to push, so this must not wedge the outbox either.
    expect(await row(env, id)).toMatchObject({ CancellationFee: 100, SyncPending: 0 });
  });
});

describe('a [CANCELLED] event must not block capacity', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the cancelled row leaves the capacity map', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const start = addDays(TODAY, 5);
    const id = await seedBooking(env, { startsInDays: 5, gcalEventId: 'evt_cap' });
    expect(
      (await listCapacityRows(env.PAWSERVATION_DB, TENANT_A, start, addDays(start, 3))).map(
        (r) => r.Id,
      ),
    ).toContain(id);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await cancel(env, await jessToken(env), id);

    // listCapacityRows selects Status IN ('pending','confirmed') — a cancelled row is simply gone.
    expect(
      (await listCapacityRows(env.PAWSERVATION_DB, TENANT_A, start, addDays(start, 3))).map(
        (r) => r.Id,
      ),
    ).not.toContain(id);
  });

  it('reconcile does not re-materialize the retitled event as a capacity-blocking external row', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    await connectCalendar(env);
    const start = addDays(TODAY, 5);
    const id = await seedBooking(env, { startsInDays: 5, gcalEventId: 'evt_cap2' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await cancel(env, await jessToken(env), id);
    vi.restoreAllMocks();

    // Google now reports the retitled event — still carrying private.bookingId, which is exactly
    // what excludes it from reconcile's foreign-event set.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              id: 'evt_cap2',
              summary: '[CANCELLED] Bella — Boarding',
              status: 'confirmed',
              updated: '2030-01-01T00:00:00Z',
              start: { date: start },
              end: { date: addDays(start, 3) },
              extendedProperties: { private: { pawservation: 'true', bookingId: id } },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await reconcileBookingsWithCalendar(env, tenant);

    const externals = await env.PAWSERVATION_DB.prepare(
      "SELECT Id FROM BookingRequests WHERE TenantId = ? AND ServiceType = 'external'",
    )
      .bind(TENANT_A)
      .all<{ Id: string }>();
    expect(externals.results).toEqual([]);
    expect(
      (await listCapacityRows(env.PAWSERVATION_DB, TENANT_A, start, addDays(start, 3))).length,
    ).toBe(0);
  });
});

describe('Earnings after a customer cancellation', () => {
  it('a fee-free cancel contributes nothing to outstanding', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const id = await seedBooking(env, { startsInDays: 40 });
    await cancel(env, await jessToken(env), id);

    const analytics = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(analytics.outstanding.find((o) => o.BookingId === id)).toBeUndefined();
  });

  it('a fee-bearing cancel stays outstanding for exactly the fee', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const id = await seedBooking(env, { startsInDays: 5 });
    await cancel(env, await jessToken(env), id);

    const analytics = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    const owed = analytics.outstanding.find((o) => o.BookingId === id);
    // EstCost on the outstanding row carries the BASE amount, which for a cancelled booking is
    // the assessed fee — $100 of the $200 stay, never the stay price.
    expect(owed).toMatchObject({ EstCost: 100, ChargesTotal: 0, PaidTotal: 0 });
  });

  it('a fee-free cancel with an extra charge on it still owes that charge, and nothing else', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const id = await seedBooking(env, { startsInDays: 40 });
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: id,
      label: 'Vet visit',
      amount: 45,
    });
    await cancel(env, await jessToken(env), id);

    const analytics = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    const owed = analytics.outstanding.find((o) => o.BookingId === id);
    // The STAY nets to zero — the base amount is the $0 fee, not the $200 EstCost. The separately
    // logged charge is a receivable in its own right and survives the cancellation, which is the
    // long-standing rule OUTSTANDING_WHERE_SQL encodes ("a charge is owed on a stay that happened
    // whether or not it was later cancelled"). If a customer cancellation should ALSO void
    // outstanding charges, that is a deliberate change to the shared earnings predicate — and to
    // the Venmo importer's candidate set, which reads the same SQL.
    expect(owed).toMatchObject({ EstCost: 0, ChargesTotal: 45 });
  });

  it('a fee-free cancellation refuses payments — a stored 0 is not a receivable', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const id = await seedBooking(env, { startsInDays: 40 });
    await cancel(env, await jessToken(env), id);
    expect((await pay(env, id)).status).toBe(404);
  });

  /**
   * The other direction of the same guard. OUTSTANDING_WHERE_SQL surfaces a fee-free cancellation
   * that still carries extra charges (charges survive a cancellation by design), so the Earnings
   * page actively tells the sitter she is owed $45 — and *Record payment* used to 404 on exactly
   * that row, because insertPayment's guard tested the fee alone.
   */
  it('a fee-free cancellation carrying extra charges IS payable', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const id = await seedBooking(env, { startsInDays: 40 });
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: id,
      label: 'Vet visit',
      amount: 45,
    });
    await cancel(env, await jessToken(env), id);

    // Same booking the Earnings page lists as owing $45…
    const analytics = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(analytics.outstanding.find((o) => o.BookingId === id)).toMatchObject({
      EstCost: 0,
      ChargesTotal: 45,
    });
    // …and the sitter can now actually record the payment against it.
    const res = await pay(env, id, 45);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ paidTotal: 45 });
  });

  it('a DECLINED booking is never payable, charges or not — declines are never billed', async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, { status: 'pending', startsInDays: 20 });
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: id,
      label: 'Vet visit',
      amount: 45,
    });
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'declined');
    // Not outstanding either — the guard and the earnings predicate agree in both directions.
    const analytics = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(analytics.outstanding.some((o) => o.BookingId === id)).toBe(false);
    expect((await pay(env, id)).status).toBe(404);
  });

  it('the outstanding row for a fee-free cancel with extras is NOT labelled a cancellation fee', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const free = await seedBooking(env, { startsInDays: 40 });
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: free,
      label: 'Vet visit',
      amount: 45,
    });
    await cancel(env, await jessToken(env), free);
    const withFee = await seedBooking(env, { startsInDays: 5 });
    await cancel(env, await jessToken(env), withFee);

    const res = await app.request(
      `/api/${SLUG}/admin/analytics`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const body = (await res.json()) as {
      outstanding: { bookingId: string; isCancellationFee: boolean }[];
    };
    const byId = (id: string) => body.outstanding.find((o) => o.bookingId === id)!;
    // $45 of extras on a waived cancellation is not "a $45 cancellation fee".
    expect(byId(free).isCancellationFee).toBe(false);
    expect(byId(withFee).isCancellationFee).toBe(true);
  });
});

describe('POST /:slug/bookings/:id/cancel — refusals', () => {
  it("404s on another customer's booking, and never touches it", async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    raw.exec(
      `INSERT INTO EndUsers (Id, TenantId, Email, Name, Status)
       VALUES ('eu_sp_other', 'tnt_sunnypaws', 'other@example.com', 'Other Person', 'active')`,
    );
    const theirs = await seedBooking(env, { startsInDays: 5, endUserId: 'eu_sp_other' });

    const res = await cancel(env, await jessToken(env), theirs);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found.', code: 'unknown_booking' });
    expect(await row(env, theirs)).toMatchObject({ Status: 'confirmed', CancellationFee: null });
  });

  it('404s on a blocked-day row and on a materialized external row — no existence oracle', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, Status, SyncPending)
       VALUES ('br_blocked', 'tnt_sunnypaws', 'eu_sp_jess', 'blocked', '2030-01-10', '2030-01-13', 1, 'confirmed', 0),
              ('br_external', 'tnt_sunnypaws', 'eu_sp_jess', 'external', '2030-01-10', '2030-01-13', 1, 'confirmed', 0)`,
    );
    const token = await jessToken(env);
    for (const id of ['br_blocked', 'br_external', 'br_nonexistent']) {
      const res = await cancel(env, token, id);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found.', code: 'unknown_booking' });
    }
  });

  it('409s on an already-cancelled booking and on a stay that has already finished', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const token = await jessToken(env);

    const already = await seedBooking(env, { startsInDays: 40 });
    await cancel(env, token, already);
    const second = await cancel(env, token, already);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('not_cancellable');

    const past = await seedBooking(env, { startsInDays: -30 });
    expect((await cancel(env, token, past)).status).toBe(409);
    expect((await row(env, past)).Status).toBe('confirmed');
  });

  it('a raced double-cancel charges the fee exactly once', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const id = await seedBooking(env, { startsInDays: 5 });
    const token = await jessToken(env);

    // Fired together: the Status guard lives inside the UPDATE, so one wins and one 409s. The
    // losing request must not restamp the fee (which would be harmless here but is a
    // double-charge on any future non-idempotent fee side effect).
    const [a, b] = await Promise.all([cancel(env, token, id), cancel(env, token, id)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await row(env, id)).toMatchObject({ Status: 'cancelled', CancellationFee: 100 });
  });

  it('a sitter confirming between the pricing and the write makes the cancel LOSE, not land free', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    // Priced as a pending request (free), but confirmed before the write lands — the guard
    // matches the status the fee came from, so the free cancellation cannot stick to a booking
    // that would now owe $200.
    const id = await seedBooking(env, { status: 'pending', startsInDays: 1 });
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'confirmed');
    expect(await cancelBookingForUser(env.PAWSERVATION_DB, TENANT_A, JESS, id, 0, 'pending')).toBe(
      false,
    );
    expect(await row(env, id)).toMatchObject({ Status: 'confirmed', CancellationFee: null });
  });

  it('requires authentication', async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, { startsInDays: 5 });
    expect(
      (await app.request(`/api/${SLUG}/bookings/${id}/cancel`, { method: 'POST' }, env)).status,
    ).toBe(401);
  });

  it("cannot reach across tenants: Jess's happy-tails session cannot cancel her sunny-paws booking", async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, { startsInDays: 5 });
    const otherTenantToken = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const res = await app.request(
      `/api/${SLUG}/bookings/${id}/cancel`,
      { method: 'POST', headers: { Authorization: `Bearer ${otherTenantToken}` } },
      env,
    );
    expect(res.status).toBe(403);
    expect((await row(env, id)).Status).toBe('confirmed');
  });
});

describe('GET /:slug/bookings/mine — the fee preview the confirm step renders', () => {
  it('carries a server-computed cancellable flag and prospective fee', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const soon = await seedBooking(env, { startsInDays: 5 }); // 50% tier → $100
    const far = await seedBooking(env, { startsInDays: 40 }); // outside every tier → $0
    const pending = await seedBooking(env, { status: 'pending', startsInDays: 1 }); // free
    const past = await seedBooking(env, { startsInDays: -30 });

    const res = await app.request(
      `/api/${SLUG}/bookings/mine`,
      { headers: { Authorization: `Bearer ${await jessToken(env)}` } },
      env,
    );
    const { bookings } = (await res.json()) as {
      bookings: { id: string; cancellable: boolean; feeIfCancelledToday: number | null }[];
    };
    const by = (id: string) => bookings.find((b) => b.id === id)!;
    expect(by(soon)).toMatchObject({ cancellable: true, feeIfCancelledToday: 100 });
    expect(by(far)).toMatchObject({ cancellable: true, feeIfCancelledToday: 0 });
    expect(by(pending)).toMatchObject({ cancellable: true, feeIfCancelledToday: 0 });
    expect(by(past)).toMatchObject({ cancellable: false, feeIfCancelledToday: null });
  });

  it('the preview and the amount actually stamped are the same number', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const id = await seedBooking(env, { startsInDays: 5 });
    const token = await jessToken(env);
    const list = (await (
      await app.request(
        `/api/${SLUG}/bookings/mine`,
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).json()) as { bookings: { id: string; feeIfCancelledToday: number | null }[] };
    const previewed = list.bookings.find((b) => b.id === id)!.feeIfCancelledToday;
    const stamped = ((await (await cancel(env, token, id)).json()) as { cancellationFee: number })
      .cancellationFee;
    expect(stamped).toBe(previewed);
  });
});
