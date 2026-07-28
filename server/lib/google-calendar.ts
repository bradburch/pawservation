/**
 * Google OAuth2 + Calendar v3 REST client. All network calls go through fetch (mockable in tests).
 * `buildEventResource` is pure so event shaping is unit-tested without touching the network.
 */
import { addDays } from '../../src/shared/index.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
/**
 * Two scopes, space-separated as Google's `scope` param requires:
 * - `calendar.events` — read/write events on calendars the sitter already has. Keeps today's
 *   behavior working for a connection that targets `primary` or a hand-made calendar.
 * - `calendar.app.created` — create secondary calendars and manage events on calendars THIS app
 *   created, and nothing else. The narrowest scope that can create the dedicated pet calendar; it
 *   grants no access to the sitter's existing calendars.
 */
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.app.created',
].join(' ');

/** Summary (display name) of the dedicated calendar Pawservation creates inside the sitter's account. */
export const PET_CALENDAR_SUMMARY = 'Pawservation — Pet bookings';

/**
 * Google rejected the call for lack of authorization rather than for anything about the request.
 * The remedy is always the same — reconnect Google so a fresh grant carries the current scope set —
 * so callers can turn this into one actionable message instead of a generic 500.
 */
export class CalendarAuthError extends Error {
  constructor(readonly status: number) {
    super(`Google rejected the request as unauthorized (${status})`);
    this.name = 'CalendarAuthError';
  }
}

export type TokenSet = { accessToken: string; refreshToken: string; expiresAt: string };

export function buildAuthUrl(env: Env, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: CALENDAR_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

function expiresAtFrom(expiresInSeconds: number): string {
  // 60s safety margin so a near-expiry token is treated as expired before a call fails.
  return new Date(Date.now() + (expiresInSeconds - 60) * 1000).toISOString();
}

export async function exchangeCode(env: Env, code: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const j = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: expiresAtFrom(j.expires_in),
  };
}

export async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: string }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: j.access_token, expiresAt: expiresAtFrom(j.expires_in) };
}

/**
 * Create a secondary calendar in the authenticated sitter's own Google account and return its id —
 * a `…@group.calendar.google.com` value, which every call site here already encodeURIComponent's, so
 * it drops into the existing event paths unchanged.
 *
 * Requires the `calendar.app.created` scope. A connection authorized before that scope was requested
 * will be refused (Google answers 403 `insufficientPermissions`, 401 for a token it won't accept at
 * all) — surfaced as CalendarAuthError, because the fix in both cases is to reconnect Google.
 */
export async function createCalendar(
  accessToken: string,
  summary: string,
  timeZone: string,
): Promise<{ id: string }> {
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary, timeZone }),
  });
  if (res.status === 401 || res.status === 403) throw new CalendarAuthError(res.status);
  if (!res.ok) throw new Error(`Google createCalendar failed (${res.status})`);
  const j = (await res.json()) as { id: string };
  return { id: j.id };
}

export async function createEvent(
  accessToken: string,
  calendarId: string,
  event: object,
): Promise<{ id: string }> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    },
  );
  if (!res.ok) throw new Error(`Google createEvent failed (${res.status})`);
  const j = (await res.json()) as { id: string };
  return { id: j.id };
}

/**
 * PATCH an existing event. If the event no longer exists on Google — 404 Not Found or 410 Gone,
 * i.e. it was hand-deleted in Calendar — this is not an error: return `{ gone: true }` so the
 * caller can recreate it (mirrors deleteEvent treating 410 as success). Any other non-2xx throws.
 */
export async function updateEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  resource: object,
): Promise<{ gone: boolean }> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(resource),
    },
  );
  if (res.status === 404 || res.status === 410) return { gone: true };
  if (!res.ok) throw new Error(`Google updateEvent failed (${res.status})`);
  return { gone: false };
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  );
  // 410 Gone = already deleted; treat as success.
  if (!res.ok && res.status !== 410) throw new Error(`Google deleteEvent failed (${res.status})`);
}

export async function revokeToken(token: string): Promise<void> {
  const res = await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Google revokeToken failed (${res.status})`);
}

export type CalendarBooking = {
  serviceLabel: string;
  category: string;
  bookingId: string;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  petCount: number;
  petNames: string[];
  estCost: number | null;
  customerEmail: string | null;
  status: 'pending' | 'confirmed';
  timezone: string;
};

type EventResource = {
  summary: string;
  description: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  extendedProperties?: { private: Record<string, string> };
};

export type CalendarEvent = {
  id: string; // Google event id — the external-row upsert key
  summary: string;
  start: string; // 'YYYY-MM-DD' (all-day) or the date part of a dateTime
  end: string; // all-day: Google's EXCLUSIVE end date; timed: the date part of the end dateTime
  allDay: boolean; // start.date present (vs dateTime) — drives end-exclusivity normalization
  status: string; // 'confirmed' | 'tentative' | 'cancelled' (cancelled filtered by callers)
  updated: string; // RFC3339 — informational; materialization compares content, not clocks
  private: Record<string, string>;
};

function addMinutesToLocal(date: string, time: string, minutes: number): string {
  // Treat the wall-clock value as UTC purely for arithmetic; the timeZone field carries the real
  // zone, so adding minutes here yields the correct local end time (even across an hour/day roll).
  const d = new Date(`${date}T${time}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
}

export function buildEventResource(b: CalendarBooking): EventResource {
  const petsText =
    b.petNames.length > 0
      ? b.petNames.join(', ')
      : `${b.petCount} pet${b.petCount === 1 ? '' : 's'}`;
  const summary = `${b.status === 'pending' ? '[REQUEST] ' : ''}${b.serviceLabel} — ${petsText}`;
  const lines = [`Service: ${b.serviceLabel}`, `Pets: ${petsText}`];
  if (b.customerEmail) lines.push(`Customer: ${b.customerEmail}`);
  if (b.startTime && b.endDate) lines.push(`Arrival: ${b.startTime}`);
  if (b.estCost != null) lines.push(`Estimated cost: $${b.estCost}`);
  if (b.status === 'pending')
    lines.push('Requested via Pawservation — confirm or decline in your dashboard.');
  const description = lines.join('\n');
  const extendedProperties = {
    private: {
      pawbook: 'true',
      category: b.category,
      petCount: String(b.petCount),
      customerEmail: b.customerEmail ?? '',
      bookingId: b.bookingId,
      status: b.status,
    },
  };

  // Timed branch is for single-day services only: a RANGE booking with an arrival time must stay
  // an all-day multi-day event (the timed branch would collapse it to a 60-minute block).
  if (b.startTime && !b.endDate) {
    const startDateTime = `${b.startDate}T${b.startTime}:00`;
    const endDateTime = addMinutesToLocal(b.startDate, b.startTime, b.durationMinutes ?? 60);
    return {
      summary,
      description,
      start: { dateTime: startDateTime, timeZone: b.timezone },
      end: { dateTime: endDateTime, timeZone: b.timezone },
      extendedProperties,
    };
  }
  const endDate = b.endDate ?? addDays(b.startDate, 1);
  return {
    summary,
    description,
    start: { date: b.startDate },
    end: { date: endDate },
    extendedProperties,
  };
}
/** Hard cap on pages one pull will follow (~25 000 events). Past it we still THROW rather than
 * return a partial list: callers infer deletion from absence, and a truncated list would read as
 * a mass deletion (see the reconcile mass-cancel hazard). */
const LIST_MAX_PAGES = 10;

export async function listCalendarEvents(
  accessToken: string,
  calendarId: string,
  timeMinISO: string,
  timeMaxISO: string,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      singleEvents: 'true',
      maxResults: '2500',
      orderBy: 'startTime',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`Google listCalendarEvents failed (${res.status})`);
    const j = (await res.json()) as {
      items: Array<{
        id?: string;
        summary?: string;
        status?: string;
        updated?: string;
        start: { date?: string; dateTime?: string };
        end: { date?: string; dateTime?: string };
        extendedProperties?: { private?: Record<string, string> };
      }>;
      nextPageToken?: string;
    };
    for (const item of j.items ?? []) {
      events.push({
        id: item.id ?? '',
        summary: item.summary ?? '',
        start: item.start.date ?? item.start.dateTime?.slice(0, 10) ?? '',
        end: item.end.date ?? item.end.dateTime?.slice(0, 10) ?? '',
        allDay: Boolean(item.start.date),
        status: item.status ?? 'confirmed',
        updated: item.updated ?? '',
        private: item.extendedProperties?.private ?? {},
      });
    }
    pageToken = j.nextPageToken;
    if (!pageToken) return events;
  }
  // We follow pages up to LIST_MAX_PAGES, but past it we still THROW rather than return a
  // partial list — a truncated result must never be treated as "these events don't exist,"
  // since callers use absence to infer deletion. Fail loudly so callers' existing best-effort
  // error handling skips the operation.
  throw new Error(
    `Google listCalendarEvents: result truncated (more than ${LIST_MAX_PAGES} pages in range)`,
  );
}
