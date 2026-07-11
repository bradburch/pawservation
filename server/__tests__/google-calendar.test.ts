import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl,
  buildEventResource,
  createEvent,
  exchangeCode,
  listCalendarEvents,
  refreshAccessToken,
} from '../lib/google-calendar';

const env = {
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://w/oauth/google/callback',
} as unknown as Env;

describe('google-calendar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('buildAuthUrl carries scope, offline access, consent prompt, redirect + state', () => {
    const url = new URL(buildAuthUrl(env, 'STATE123'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('redirect_uri')).toBe('https://w/oauth/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('state')).toBe('STATE123');
  });

  it('exchangeCode posts the code and maps the token response', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
          { status: 200 },
        ),
      );
    const set = await exchangeCode(env, 'auth-code');
    expect(set.accessToken).toBe('at');
    expect(set.refreshToken).toBe('rt');
    expect(new Date(set.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(spy).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', expect.anything());
  });

  it('refreshAccessToken returns a new access token + expiry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at2', expires_in: 3600 }), { status: 200 }),
    );
    const r = await refreshAccessToken(env, 'rt');
    expect(r.accessToken).toBe('at2');
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('createEvent POSTs to the calendar and returns the new id', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_1' }), { status: 200 }));
    const { id } = await createEvent('AT', 'primary', { summary: 'x' });
    expect(id).toBe('evt_1');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer AT' });
  });

  it('createEvent throws on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }));
    await expect(createEvent('AT', 'primary', {})).rejects.toThrow();
  });

  it('buildEventResource: all-day range uses date start/end (exclusive)', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk-allday',
      startDate: '2030-01-10',
      endDate: '2030-01-13',
      startTime: null,
      durationMinutes: null,
      petCount: 2,
      estCost: 150,
      customerEmail: 'a@b.c',
      timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ date: '2030-01-10' });
    expect(r.end).toEqual({ date: '2030-01-13' });
    expect(r.summary).toContain('Boarding');
    expect(r.summary).toContain('a@b.c');
  });

  it('buildEventResource: all-day single day uses next-day exclusive end', () => {
    const r = buildEventResource({
      serviceLabel: 'Day care',
      category: 'day-care',
      bookingId: 'bk-single',
      startDate: '2030-01-10',
      endDate: null,
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      estCost: 40,
      customerEmail: null,
      timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ date: '2030-01-10' });
    expect(r.end).toEqual({ date: '2030-01-11' });
  });

  it('buildEventResource: timed booking uses dateTime + timeZone, end = start + duration', () => {
    const r = buildEventResource({
      serviceLabel: 'Walks',
      category: 'walks',
      bookingId: 'bk-timed',
      startDate: '2030-01-10',
      endDate: null,
      startTime: '09:30',
      durationMinutes: 60,
      petCount: 1,
      estCost: 35,
      customerEmail: 'a@b.c',
      timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ dateTime: '2030-01-10T09:30:00', timeZone: 'America/Los_Angeles' });
    expect(r.end).toEqual({ dateTime: '2030-01-10T10:30:00', timeZone: 'America/Los_Angeles' });
  });

  it('buildEventResource: sets extendedProperties.private with booking metadata', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk1',
      startDate: '2030-01-10',
      endDate: '2030-01-13',
      startTime: null,
      durationMinutes: null,
      petCount: 2,
      estCost: 150,
      customerEmail: 'jess@example.com',
      timezone: 'America/Los_Angeles',
    });
    expect(r.extendedProperties?.private).toEqual({
      pawbook: 'true',
      category: 'boarding',
      petCount: '2',
      customerEmail: 'jess@example.com',
      bookingId: 'bk1',
    });
  });

  it('buildEventResource: extendedProperties.private uses empty string for null customerEmail', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk2',
      startDate: '2030-01-10',
      endDate: '2030-01-13',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      estCost: null,
      customerEmail: null,
      timezone: 'America/Los_Angeles',
    });
    expect(r.extendedProperties?.private.customerEmail).toBe('');
    expect(r.extendedProperties?.private.pawbook).toBe('true');
  });

  describe('listCalendarEvents', () => {
    it('normalizes an all-day event and a timed event', async () => {
      const fakeBody = {
        items: [
          {
            summary: 'Dog boarding',
            start: { date: '2030-06-01' },
            end: { date: '2030-06-04' },
            extendedProperties: {
              private: { pawbook: 'true', category: 'boarding', bookingId: 'bk-a' },
            },
          },
          {
            summary: 'Walk',
            start: { dateTime: '2030-06-05T09:30:00-07:00' },
            end: { dateTime: '2030-06-05T10:30:00-07:00' },
            extendedProperties: {
              private: { pawbook: 'true', category: 'walks', bookingId: 'bk-b' },
            },
          },
        ],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(fakeBody), { status: 200 }),
      );

      const events = await listCalendarEvents(
        'AT',
        'primary',
        '2030-06-01T00:00:00Z',
        '2030-07-01T00:00:00Z',
      );

      expect(events).toHaveLength(2);
      // all-day event
      expect(events[0]).toEqual({
        summary: 'Dog boarding',
        start: '2030-06-01',
        end: '2030-06-04',
        private: { pawbook: 'true', category: 'boarding', bookingId: 'bk-a' },
      });
      // timed event — dateTime sliced to date part
      expect(events[1]).toEqual({
        summary: 'Walk',
        start: '2030-06-05',
        end: '2030-06-05',
        private: { pawbook: 'true', category: 'walks', bookingId: 'bk-b' },
      });
    });

    it('defaults to empty private map and empty summary when fields are absent', async () => {
      const fakeBody = {
        items: [{ start: { date: '2030-06-01' }, end: { date: '2030-06-02' } }],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(fakeBody), { status: 200 }),
      );

      const events = await listCalendarEvents('AT', 'primary', '2030-06-01Z', '2030-07-01Z');
      expect(events[0].summary).toBe('');
      expect(events[0].private).toEqual({});
    });

    it('sends the correct query parameters and Authorization header', async () => {
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }));

      await listCalendarEvents('MY_TOKEN', 'cal@group.calendar.google.com', 'tMin', 'tMax');

      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(encodeURIComponent('cal@group.calendar.google.com'));
      const parsed = new URL(url);
      expect(parsed.searchParams.get('timeMin')).toBe('tMin');
      expect(parsed.searchParams.get('timeMax')).toBe('tMax');
      expect(parsed.searchParams.get('singleEvents')).toBe('true');
      expect(parsed.searchParams.get('maxResults')).toBe('2500');
      expect(parsed.searchParams.get('orderBy')).toBe('startTime');
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer MY_TOKEN');
    });

    it('throws on a non-2xx response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 403 }));
      await expect(
        listCalendarEvents('AT', 'primary', '2030-06-01Z', '2030-07-01Z'),
      ).rejects.toThrow('Google listCalendarEvents failed (403)');
    });

    it('throws when the response is truncated (nextPageToken present)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ items: [], nextPageToken: 'abc' }), { status: 200 }),
      );
      await expect(
        listCalendarEvents('AT', 'primary', '2030-06-01Z', '2030-07-01Z'),
      ).rejects.toThrow('result truncated');
    });
  });
});
