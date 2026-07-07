import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl,
  buildEventResource,
  createEvent,
  exchangeCode,
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
});
