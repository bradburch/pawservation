import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  clearProviderConnection,
  getProviderConnection,
  insertBookingRequest,
  setBookingGCalEventId,
  setProviderCalendarId,
  setProviderTokens,
} from '../db/repo';
import { getCalendarAccessToken } from '../lib/calendar-sync';
import { decryptToken, encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminHeaders, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

/**
 * POST /:slug/admin/providers/calendar/create-calendar — Pawservation creates a dedicated secondary
 * calendar ("Pawservation — Pet bookings") inside the sitter's own Google account and points booking
 * sync at it, so pet work never lands in her personal calendar.
 */

const NEW_CAL_ID = 'pawservation123@group.calendar.google.com';
const tenant = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant;

/** createTestEnv leaves the Google OAuth vars unset; the route 503s without them. */
function withGoogleConfigured(env: Env): Env {
  Object.assign(env, {
    GOOGLE_CLIENT_ID: 'cid',
    GOOGLE_CLIENT_SECRET: 'csecret',
    GOOGLE_OAUTH_REDIRECT_URI: 'https://w/oauth/google/callback',
  });
  return env;
}

async function connectCalendar(env: Env, expiresAt = '2030-01-01T00:00:00Z') {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt,
    calendarId: 'primary',
  });
}

function createCalendarRequest(env: Env): Promise<Response> {
  return adminHeaders(TENANT_A).then((headers) =>
    app.request(
      '/api/sunny-paws/admin/providers/calendar/create-calendar',
      { method: 'POST', headers },
      env,
    ),
  );
}

/** Google stub: the /calendars POST returns the new calendar, event POSTs return an event id. */
function stubGoogle(calendarStatus = 200): { urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url);
    urls.push(u);
    bodies.push(String((init as RequestInit | undefined)?.body ?? ''));
    if (u === 'https://www.googleapis.com/calendar/v3/calendars') {
      return calendarStatus === 200
        ? new Response(JSON.stringify({ id: NEW_CAL_ID }), { status: 200 })
        : new Response(JSON.stringify({ error: { message: 'Insufficient Permission' } }), {
            status: calendarStatus,
          });
    }
    return new Response(JSON.stringify({ id: 'evt_new' }), { status: 200 });
  });
  return { urls, bodies };
}

async function calendarIdOf(env: Env): Promise<string | null> {
  const conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
  return conn?.CalendarId ?? null;
}

describe('POST create-calendar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates the calendar in Google and stores the returned id as the sync target', async () => {
    const { env } = createTestEnv();
    withGoogleConfigured(env);
    await connectCalendar(env);
    const { urls, bodies } = stubGoogle();

    const res = await createCalendarRequest(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      calendarId: NEW_CAL_ID,
      summary: 'Pawservation — Pet bookings',
    });

    const i = urls.indexOf('https://www.googleapis.com/calendar/v3/calendars');
    expect(i).toBe(0); // the calendar is created before anything else happens
    expect(JSON.parse(bodies[i])).toEqual({
      summary: 'Pawservation — Pet bookings',
      timeZone: DEFAULT_TIMEZONE, // tenant Timezone is NULL → instance default, not a hardcode
    });
    expect(await calendarIdOf(env)).toBe(NEW_CAL_ID);
  });

  it("uses the tenant's own timezone when it has one", async () => {
    const { env, raw } = createTestEnv();
    withGoogleConfigured(env);
    raw.exec(`UPDATE Tenants SET Timezone = 'America/New_York' WHERE Id = '${TENANT_A}'`);
    await connectCalendar(env);
    const { urls, bodies } = stubGoogle();

    expect((await createCalendarRequest(env)).status).toBe(200);
    const i = urls.indexOf('https://www.googleapis.com/calendar/v3/calendars');
    expect(JSON.parse(bodies[i]).timeZone).toBe('America/New_York');
  });

  it('re-backfills existing future bookings into the NEW calendar, and cancels nothing', async () => {
    const { env } = createTestEnv();
    withGoogleConfigured(env);
    await connectCalendar(env);
    const today = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: addDays(today, 10),
      endDate: addDays(today, 13),
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 150,
      status: 'confirmed',
    });
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, id, 'evt_in_old_calendar', null);
    const { urls } = stubGoogle();

    expect((await createCalendarRequest(env)).status).toBe(200);

    const row = await env.PAWBOOK_DB.prepare(
      'SELECT Status, GCalEventId FROM BookingRequests WHERE Id = ?',
    )
      .bind(id)
      .first<{ Status: string; GCalEventId: string | null }>();
    expect(row?.Status).toBe('confirmed'); // never cancelled by the switch
    expect(row?.GCalEventId).toBe('evt_new'); // re-created, not the stale old-calendar id

    const eventWrites = urls.filter((u) => u.includes('/events'));
    expect(eventWrites.length).toBeGreaterThan(0);
    for (const u of eventWrites) expect(u).toContain(encodeURIComponent(NEW_CAL_ID));
  });

  it('tells the sitter to reconnect when Google refuses for lack of scope (400, not 500)', async () => {
    const { env } = createTestEnv();
    withGoogleConfigured(env);
    await connectCalendar(env);
    stubGoogle(403);

    const res = await createCalendarRequest(env);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/reconnect|connect it again/i);
    // Nothing was repointed, so sync keeps working against the current calendar.
    expect(await calendarIdOf(env)).toBe('primary');
  });

  it('refuses to create a second calendar when one is already targeted (409)', async () => {
    const { env } = createTestEnv();
    withGoogleConfigured(env);
    await connectCalendar(env);
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', NEW_CAL_ID);
    const { urls } = stubGoogle();

    const res = await createCalendarRequest(env);
    expect(res.status).toBe(409);
    expect((await res.json<{ calendarId: string }>()).calendarId).toBe(NEW_CAL_ID);
    expect(urls).toEqual([]); // no Google traffic at all
  });

  it('409s when Google Calendar is not connected', async () => {
    const { env } = createTestEnv();
    withGoogleConfigured(env);
    const { urls } = stubGoogle();
    const res = await createCalendarRequest(env);
    expect(res.status).toBe(409);
    expect(urls).toEqual([]);
  });

  it('503s when the server has no Google OAuth configuration', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    expect((await createCalendarRequest(env)).status).toBe(503);
  });

  it('403s for a disabled tenant', async () => {
    const { env, raw } = createTestEnv();
    withGoogleConfigured(env);
    raw.exec(`UPDATE Tenants SET DisabledAt = '2026-01-01T00:00:00Z' WHERE Id = '${TENANT_A}'`);
    await connectCalendar(env);
    const res = await createCalendarRequest(env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_disabled' });
  });

  it('requires an admin session', async () => {
    const { env } = createTestEnv();
    withGoogleConfigured(env);
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/create-calendar',
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(401);
  });
});

/**
 * A calendar id is an identifier, not a credential. Disconnect drops the tokens and keeps the
 * choice, so reconnecting doesn't make the sitter re-pick her pet calendar — and so the
 * create-calendar guard above still sees that a dedicated calendar exists.
 */
describe('calendar id survives the connection lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('disconnect clears the tokens but preserves CalendarId', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', NEW_CAL_ID);

    await clearProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');

    const conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(conn?.Status).toBe('disconnected');
    expect(conn?.AccessToken).toBeNull();
    expect(conn?.RefreshToken).toBeNull();
    expect(conn?.TokenExpiresAt).toBeNull();
    expect(conn?.ConnectedAt).toBeNull();
    expect(conn?.CalendarId).toBe(NEW_CAL_ID);
  });

  it('reconnecting keeps the existing calendar id rather than resetting it to primary', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', NEW_CAL_ID);
    await clearProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');

    await connectCalendar(env); // the OAuth callback's write, which passes calendarId: 'primary'

    const conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(conn?.Status).toBe('connected');
    expect(conn?.CalendarId).toBe(NEW_CAL_ID);
  });

  it('a token refresh does not rewrite the calendar id (NULL stays NULL)', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env, '2020-01-01T00:00:00Z'); // expired → forces a refresh
    // NULL means "use the account's primary calendar"; a refresh used to collapse it to 'primary'.
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', null);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), { status: 200 }),
    );

    const before = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(await getCalendarAccessToken(env, tenant, before!)).toBe('access-2');

    const after = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(after?.CalendarId).toBeNull();
    // The refreshed access token was persisted, and the refresh token was left untouched.
    expect(await decryptToken(TEST_SECRET, after!.AccessToken!)).toBe('access-2');
    expect(after?.RefreshToken).toBe(before?.RefreshToken);
    expect(after?.Status).toBe('connected');
  });

  it('a token refresh preserves a chosen calendar id', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env, '2020-01-01T00:00:00Z');
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', NEW_CAL_ID);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), { status: 200 }),
    );

    const conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    await getCalendarAccessToken(env, tenant, conn!);

    expect(await calendarIdOf(env)).toBe(NEW_CAL_ID);
  });
});
