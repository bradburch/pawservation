import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backfillCalendarEvents,
  syncBookingToCalendar,
  updateBookingCalendarEvent,
} from '../lib/calendar-sync';
import { addDays, getPacificDateStr, DEFAULT_TIMEZONE } from '../../src/shared/index.js';
import { setBookingGCalEventId, setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

const tenant = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant;

async function connectCalendar(env: Env, expiresAt: string) {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt,
    calendarId: 'primary',
  });
}
function seedBooking(raw: { exec: (s: string) => void }, id: string) {
  raw.exec(`INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, EstCost, Status)
            VALUES ('${id}', '${TENANT_A}', 'boarding', '2030-03-01', '2030-03-04', 1, 150, 'pending')`);
}

describe('syncBookingToCalendar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an event and persists the event id when connected', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z'); // not expired
    seedBooking(raw, 'b1');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_b1' }), { status: 200 }));
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b1',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: 150,
      status: 'pending',
    });
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='b1'`).get() as {
      GCalEventId: string;
    };
    expect(row.GCalEventId).toBe('evt_b1');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('no-ops when the calendar is not connected', async () => {
    const { env, raw } = createTestEnv();
    seedBooking(raw, 'b2');
    const spy = vi.spyOn(globalThis, 'fetch');
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b2',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: 150,
      status: 'pending',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token before creating the event', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2000-01-01T00:00:00Z'); // expired
    seedBooking(raw, 'b3');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'evt_b3' }), { status: 200 }));
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b3',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: 150,
      status: 'pending',
    });
    expect(spy).toHaveBeenCalledTimes(2);
    const eventCall = spy.mock.calls[1];
    expect((eventCall[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer access-2',
    });
  });

  it('deletes its just-created event and leaves the stored id when the CAS loses the race', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z');
    seedBooking(raw, 'brace');
    // Simulate a concurrent writer that already claimed the slot: GCalEventId is non-NULL, so the
    // NULL-expected compare-and-swap in this call must NOT stick.
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, 'brace', 'evt_winner', null);

    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const method = (init as RequestInit).method;
      if (method === 'POST')
        return new Response(JSON.stringify({ id: 'evt_dup' }), { status: 200 });
      return new Response(null, { status: 204 }); // DELETE
    });

    await syncBookingToCalendar(env, tenant, {
      bookingId: 'brace',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: 150,
      status: 'pending',
    });

    // The duplicate event this call created was deleted, not orphaned...
    const deleteCall = spy.mock.calls.find(
      ([, init]) => (init as RequestInit).method === 'DELETE',
    ) as [string, RequestInit] | undefined;
    expect(deleteCall).toBeTruthy();
    expect(deleteCall![0]).toContain('/events/evt_dup');
    // ...and the stored id is the winner's, untouched.
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='brace'`).get() as {
      GCalEventId: string;
    };
    expect(row.GCalEventId).toBe('evt_winner');
  });
});

describe('updateBookingCalendarEvent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('PATCHes the given event id with the confirmed (prefix-free) resource', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z');
    seedBooking(raw, 'bu1');
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, 'bu1', 'evt_bu1', null);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_bu1' }), { status: 200 }));

    await updateBookingCalendarEvent(env, tenant, 'evt_bu1', {
      bookingId: 'bu1',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: 150,
      status: 'confirmed',
    });

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/calendars/primary/events/evt_bu1');
    expect(init.method).toBe('PATCH');
    const resource = JSON.parse(init.body as string) as { summary: string };
    expect(resource.summary).not.toContain('[REQUEST]');
    expect(resource.summary).toBe('Boarding — 1 pet');
  });

  it('recreates a hand-deleted event (PATCH 404 → create) and replaces the stored id', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z');
    seedBooking(raw, 'bu_gone');
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, 'bu_gone', 'evt_stale', null);

    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const method = (init as RequestInit).method;
      if (method === 'PATCH') return new Response('not found', { status: 404 }); // hand-deleted
      return new Response(JSON.stringify({ id: 'evt_new' }), { status: 200 }); // POST create
    });

    // The confirm path must not be affected by the recreate — this resolves normally.
    await expect(
      updateBookingCalendarEvent(env, tenant, 'evt_stale', {
        bookingId: 'bu_gone',
        endUserId: null,
        serviceType: 'boarding',
        serviceLabel: 'Boarding',
        startDate: '2030-03-01',
        endDate: '2030-03-04',
        startTime: null,
        durationMinutes: null,
        petCount: 1,
        petNames: [],
        estCost: 150,
        status: 'confirmed',
      }),
    ).resolves.toBeUndefined();

    // PATCH first, then a POST create — no DELETE (the CAS stuck).
    expect(spy.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual([
      'PATCH',
      'POST',
    ]);
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='bu_gone'`).get() as {
      GCalEventId: string;
    };
    expect(row.GCalEventId).toBe('evt_new'); // stale id replaced with the recreated event's id
  });

  it('deletes the recreated event and leaves the stored id when the recreate CAS loses the race', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z');
    seedBooking(raw, 'bu_race');
    // The stored id no longer equals the stale id the confirm path is recreating against (another
    // writer moved it), so the stale-expected compare-and-swap must NOT stick.
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, 'bu_race', 'evt_moved', null);

    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const method = (init as RequestInit).method;
      if (method === 'PATCH') return new Response('gone', { status: 410 });
      if (method === 'POST')
        return new Response(JSON.stringify({ id: 'evt_replacement' }), { status: 200 });
      return new Response(null, { status: 204 }); // DELETE
    });

    await updateBookingCalendarEvent(env, tenant, 'evt_stale', {
      bookingId: 'bu_race',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: 150,
      status: 'confirmed',
    });

    const deleteCall = spy.mock.calls.find(
      ([, init]) => (init as RequestInit).method === 'DELETE',
    ) as [string, RequestInit] | undefined;
    expect(deleteCall).toBeTruthy();
    expect(deleteCall![0]).toContain('/events/evt_replacement');
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='bu_race'`).get() as {
      GCalEventId: string;
    };
    expect(row.GCalEventId).toBe('evt_moved'); // untouched
  });

  it('no-ops when the calendar is not connected', async () => {
    const { env, raw } = createTestEnv();
    seedBooking(raw, 'bu2');
    const spy = vi.spyOn(globalThis, 'fetch');
    await updateBookingCalendarEvent(env, tenant, 'evt_bu2', {
      bookingId: 'bu2',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: 150,
      status: 'confirmed',
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('backfillCalendarEvents', () => {
  afterEach(() => vi.restoreAllMocks());

  const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

  function insertBooking(
    raw: { exec: (s: string) => void },
    id: string,
    opts: { startDate: string; status: string; gcal?: string },
  ) {
    const gcal = opts.gcal ? `'${opts.gcal}'` : 'NULL';
    raw.exec(
      `INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, EstCost, GCalEventId, Status)
       VALUES ('${id}', '${TENANT_A}', 'boarding', '${opts.startDate}', NULL, 1, 150, ${gcal}, '${opts.status}')`,
    );
  }

  it('creates events for future unsynced pending + confirmed bookings, leaving cancelled/past/synced alone', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z');

    insertBooking(raw, 'bf_pending', { startDate: addDays(TODAY, 5), status: 'pending' });
    insertBooking(raw, 'bf_confirmed', { startDate: addDays(TODAY, 6), status: 'confirmed' });
    insertBooking(raw, 'bf_cancelled', { startDate: addDays(TODAY, 7), status: 'cancelled' });
    insertBooking(raw, 'bf_past', { startDate: addDays(TODAY, -5), status: 'pending' });
    insertBooking(raw, 'bf_synced', {
      startDate: addDays(TODAY, 8),
      status: 'pending',
      gcal: 'evt_already',
    });

    const bodies: Record<string, string> = {};
    let n = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const id = `evt_bf_${++n}`;
      const body = JSON.parse((init as RequestInit).body as string) as {
        extendedProperties?: { private?: { bookingId?: string } };
        summary: string;
      };
      bodies[body.extendedProperties!.private!.bookingId!] = body.summary;
      return new Response(JSON.stringify({ id }), { status: 200 });
    });

    await backfillCalendarEvents(env, tenant);

    // Both future, unsynced bookings got an event, each with the status-correct summary. (The
    // shared test DB seeds other future TENANT_A bookings too; we assert about ours specifically.)
    expect(bodies['bf_pending']).toBe('[REQUEST] Boarding — 1 pet');
    expect(bodies['bf_confirmed']).toBe('Boarding — 1 pet');
    // The cancelled and past bookings were never sent to Google.
    expect(bodies).not.toHaveProperty('bf_cancelled');
    expect(bodies).not.toHaveProperty('bf_past');

    const idOf = (id: string) =>
      (
        raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='${id}'`).get() as {
          GCalEventId: string | null;
        }
      ).GCalEventId;
    expect(idOf('bf_pending')).toMatch(/^evt_bf_/);
    expect(idOf('bf_confirmed')).toMatch(/^evt_bf_/);
    expect(idOf('bf_cancelled')).toBeNull();
    expect(idOf('bf_past')).toBeNull();
    expect(idOf('bf_synced')).toBe('evt_already'); // untouched
  });

  it('one booking failing does not stop the rest', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z');
    insertBooking(raw, 'bf_a', { startDate: addDays(TODAY, 5), status: 'pending' });
    insertBooking(raw, 'bf_b', { startDate: addDays(TODAY, 6), status: 'pending' });

    // Fail only bf_a's create (matched by booking id in the payload, so ordering is irrelevant);
    // every other booking — bf_b and any seeded ones — still succeeds.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        extendedProperties?: { private?: { bookingId?: string } };
      };
      if (body.extendedProperties?.private?.bookingId === 'bf_a')
        throw new TypeError('transient google outage');
      return new Response(JSON.stringify({ id: 'evt_ok' }), { status: 200 });
    });

    await backfillCalendarEvents(env, tenant); // must not throw

    const idA = (
      raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='bf_a'`).get() as {
        GCalEventId: string | null;
      }
    ).GCalEventId;
    const idB = (
      raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='bf_b'`).get() as {
        GCalEventId: string | null;
      }
    ).GCalEventId;
    // The earlier one failed (still null); the later one still synced.
    expect(idA).toBeNull();
    expect(idB).toBe('evt_ok');
  });
});
