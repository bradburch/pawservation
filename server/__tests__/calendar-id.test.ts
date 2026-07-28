import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  insertBookingRequest,
  listProviderConnections,
  setBookingGCalEventId,
  setProviderCalendarId,
  setProviderTokens,
} from '../db/repo';
import { reconcileBookingsWithCalendar } from '../lib/calendar-sync';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminToken, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

const CAL_ID = 'sitting@group.calendar.google.com';

async function seedCalendar(env: Env) {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: 'enc-a',
    refresh: 'enc-r',
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

/**
 * Changing the target calendar now kicks off a re-backfill (see repointCalendarTarget). The seeded
 * tokens above are not real ciphertext, so the backfill fails fast inside its own catch and never
 * reaches the network — but stub fetch anyway so a route test can never make a real Google request.
 */
function stubGoogle() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ id: 'evt' }), { status: 200 }));
}

describe('setProviderCalendarId (repo)', () => {
  it('sets and clears CalendarId on the connected row', async () => {
    const { env } = createTestEnv();
    await seedCalendar(env);

    // Set a custom calendar id
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', CAL_ID);
    const connections = await listProviderConnections(env.PAWBOOK_DB, TENANT_A);
    const row = connections.find((c) => c.Capability === 'calendar');
    expect(row?.CalendarId).toBe(CAL_ID);

    // Set to null clears it
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', null);
    const connections2 = await listProviderConnections(env.PAWBOOK_DB, TENANT_A);
    const row2 = connections2.find((c) => c.Capability === 'calendar');
    expect(row2?.CalendarId).toBeNull();
  });
});

describe('POST /:slug/admin/providers/calendar/calendar-id (route)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sets the calendar id and persists it (204)', async () => {
    const { env } = createTestEnv();
    await seedCalendar(env);
    stubGoogle();
    const token = await adminToken(TENANT_A);

    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/calendar-id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ calendarId: 'x@group.calendar.google.com' }),
      },
      env,
    );
    expect(res.status).toBe(204);

    const connections = await listProviderConnections(env.PAWBOOK_DB, TENANT_A);
    const row = connections.find((c) => c.Capability === 'calendar');
    expect(row?.CalendarId).toBe('x@group.calendar.google.com');
  });

  it('blank calendarId clears to null', async () => {
    const { env } = createTestEnv();
    await seedCalendar(env);
    stubGoogle();
    const token = await adminToken(TENANT_A);

    // First set a non-primary id
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', CAL_ID);

    // Now clear with empty string
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/calendar-id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ calendarId: '' }),
      },
      env,
    );
    expect(res.status).toBe(204);

    const connections = await listProviderConnections(env.PAWBOOK_DB, TENANT_A);
    const row = connections.find((c) => c.Capability === 'calendar');
    expect(row?.CalendarId).toBeNull();
  });

  it('calendarId appears in the settings GET response', async () => {
    const { env } = createTestEnv();
    await seedCalendar(env);
    const token = await adminToken(TENANT_A);

    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', CAL_ID);

    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calendar: { calendarId: string | null } };
    expect(body.calendar.calendarId).toBe(CAL_ID);
  });
});

/**
 * Regression suite for the mass-cancel hazard that switching calendars used to open. A stored
 * GCalEventId names an event inside whatever calendar was configured when it was created, and
 * reconcileBookingsWithCalendar looks those ids up in the CURRENTLY configured calendar. Before
 * repointCalendarTarget, changing the target left every id in place, so the next reconcile found
 * none of them and cancelled every real booking.
 */
describe('switching the target calendar', () => {
  afterEach(() => vi.restoreAllMocks());

  const tenant = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant;
  // reconcileBookingsWithCalendar's window is [today-1, today+180) against the real clock.
  const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
  const IN_WINDOW_START = addDays(TODAY, 10);
  const IN_WINDOW_END = addDays(TODAY, 13);

  /** A connection with REAL ciphertext, so the backfill actually reaches (mocked) fetch. */
  async function connectCalendar(env: Env) {
    await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
      access: await encryptToken(TEST_SECRET, 'access-1'),
      refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
      expiresAt: '2030-01-01T00:00:00Z', // far future — no refresh round-trip
      calendarId: 'primary',
    });
  }

  async function seedSyncedBooking(env: Env): Promise<string> {
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: IN_WINDOW_START,
      endDate: IN_WINDOW_END,
      optionKey: 'standard',
      petCount: 1,
      estCost: 150,
      status: 'confirmed',
    });
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, id, 'evt_in_old_calendar', null);
    return id;
  }

  async function switchTo(env: Env, calendarId: string): Promise<Response> {
    return app.request(
      '/api/sunny-paws/admin/providers/calendar/calendar-id',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await adminToken(TENANT_A)}`,
        },
        body: JSON.stringify({ calendarId }),
      },
      env,
    );
  }

  async function bookingRow(env: Env, id: string) {
    return env.PAWBOOK_DB.prepare('SELECT Status, GCalEventId FROM BookingRequests WHERE Id = ?')
      .bind(id)
      .first<{ Status: string; GCalEventId: string | null }>();
  }

  it('does NOT cancel bookings when reconciliation runs against the new calendar', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);

    // Switch calendars with Google refusing every write, so the re-backfill creates nothing — the
    // worst case, and precisely the state the old code turned into a mass cancellation.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    expect((await switchTo(env, CAL_ID)).status).toBe(204);
    expect((await bookingRow(env, id))?.GCalEventId).toBeNull();

    // Now reconcile against the new (empty) calendar. The cleared id keeps the booking out of the
    // candidate set entirely, so it survives.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    await reconcileBookingsWithCalendar(env, tenant);
    expect((await bookingRow(env, id))?.Status).toBe('confirmed');
  });

  it('re-backfills the booking into the NEW calendar', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);

    const urls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: 'evt_in_new_calendar' }), { status: 200 });
    });
    expect((await switchTo(env, CAL_ID)).status).toBe(204);

    const row = await bookingRow(env, id);
    expect(row?.GCalEventId).toBe('evt_in_new_calendar');
    expect(row?.Status).toBe('confirmed');
    // Every write went to the new calendar; none to the old target.
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toContain(encodeURIComponent(CAL_ID));
      expect(u).not.toContain('/calendars/primary/');
    }
  });

  it('saving the SAME target is a no-op — event ids are kept and Google is not touched', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedSyncedBooking(env);

    const spy = stubGoogle();
    // The connection already points at 'primary'; blank means primary too, so neither is a switch.
    expect((await switchTo(env, 'primary')).status).toBe(204);
    expect((await switchTo(env, '')).status).toBe(204);

    expect((await bookingRow(env, id))?.GCalEventId).toBe('evt_in_old_calendar');
    expect(spy).not.toHaveBeenCalled();
  });
});
