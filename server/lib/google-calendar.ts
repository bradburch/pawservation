/**
 * Google OAuth2 + Calendar v3 REST client. All network calls go through fetch (mockable in tests).
 * `buildEventResource` is pure so event shaping is unit-tested without touching the network.
 */
import { addDays } from '../../src/shared/index.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export type TokenSet = { accessToken: string; refreshToken: string; expiresAt: string };

export function buildAuthUrl(env: Env, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
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
  estCost: number | null;
  customerEmail: string | null;
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
  summary: string;
  start: string; // 'YYYY-MM-DD' (all-day) or the date part of a dateTime
  end: string; // exclusive end date, same normalization
  private: Record<string, string>; // extendedProperties.private, or {}
};

function addMinutesToLocal(date: string, time: string, minutes: number): string {
  // Treat the wall-clock value as UTC purely for arithmetic; the timeZone field carries the real
  // zone, so adding minutes here yields the correct local end time (even across an hour/day roll).
  const d = new Date(`${date}T${time}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
}

export function buildEventResource(b: CalendarBooking): EventResource {
  const who = b.customerEmail ?? 'booking';
  const summary = `${b.serviceLabel} — ${who} (${b.petCount} pet${b.petCount === 1 ? '' : 's'})`;
  const description =
    `Service: ${b.serviceLabel}` + (b.estCost != null ? `\nEstimated cost: $${b.estCost}` : '');
  const extendedProperties = {
    private: {
      pawbook: 'true',
      category: b.category,
      petCount: String(b.petCount),
      customerEmail: b.customerEmail ?? '',
      bookingId: b.bookingId,
    },
  };

  if (b.startTime) {
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

export const BLOCK_EVENT_SUMMARY = 'unavailable';

export function categorizeCalendarEvent(
  event: CalendarEvent,
):
  | { kind: 'booking'; category: string; petCount: number; email: string }
  | { kind: 'block' }
  | { kind: 'ignore' } {
  if (event.private.pawbook === 'true') {
    return {
      kind: 'booking',
      category: event.private.category,
      petCount: Number(event.private.petCount) || 1,
      email: event.private.customerEmail ?? '',
    };
  }
  if (event.summary.trim().toLowerCase() === BLOCK_EVENT_SUMMARY) {
    return { kind: 'block' };
  }
  return { kind: 'ignore' };
}

export async function listCalendarEvents(
  accessToken: string,
  calendarId: string,
  timeMinISO: string,
  timeMaxISO: string,
): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    singleEvents: 'true',
    maxResults: '2500',
    orderBy: 'startTime',
  });
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) throw new Error(`Google listCalendarEvents failed (${res.status})`);
  const j = (await res.json()) as {
    items: Array<{
      summary?: string;
      start: { date?: string; dateTime?: string };
      end: { date?: string; dateTime?: string };
      extendedProperties?: { private?: Record<string, string> };
    }>;
  };
  return (j.items ?? []).map((item) => ({
    summary: item.summary ?? '',
    start: item.start.date ?? item.start.dateTime?.slice(0, 10) ?? '',
    end: item.end.date ?? item.end.dateTime?.slice(0, 10) ?? '',
    private: item.extendedProperties?.private ?? {},
  }));
}
