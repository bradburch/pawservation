import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl,
  buildEventResource,
  buildUnavailableEventResource,
  CalendarAuthError,
  createCalendar,
  createEvent,
  PET_CALENDAR_SUMMARY,
  exchangeCode,
  listCalendarEvents,
  refreshAccessToken,
  UNAVAILABLE_EVENT_SUMMARY,
  updateEvent,
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
    // Both scopes, space-separated: calendar.events keeps writing to primary / a hand-made calendar
    // working, calendar.app.created is what lets us create the dedicated pet calendar.
    expect(p.get('scope')?.split(' ')).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.app.created',
    ]);
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

  it('refreshAccessToken throws a clear error on a malformed 200 response, same as exchangeCode', async () => {
    // A shape-check regression here reintroduces expiresAtFrom(undefined) computing NaN, whose
    // new Date(NaN).toISOString() throws an unhelpful bare RangeError instead of this named one.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }),
    );
    await expect(refreshAccessToken(env, 'rt')).rejects.toThrow(
      /incomplete token set.*access_token/,
    );
  });

  it('createCalendar POSTs summary + timeZone to /calendars and returns the new calendar id', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'abc123@group.calendar.google.com' }), { status: 200 }),
      );
    const { id } = await createCalendar('AT', PET_CALENDAR_SUMMARY, 'America/Denver');
    expect(id).toBe('abc123@group.calendar.google.com');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer AT' });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      summary: 'Pawservation — Pet bookings',
      timeZone: 'America/Denver',
    });
  });

  // 403 insufficientPermissions is what a token issued before calendar.app.created was requested
  // gets back; 401 is a token Google won't accept at all. Both mean "reconnect", not "server bug".
  it.each([401, 403])('createCalendar throws CalendarAuthError on %i', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Insufficient Permission' } }), { status }),
    );
    await expect(createCalendar('AT', 'X', 'UTC')).rejects.toBeInstanceOf(CalendarAuthError);
  });

  it('createCalendar throws a plain error on other failures', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const err = await createCalendar('AT', 'X', 'UTC').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CalendarAuthError);
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

  it('updateEvent PATCHes the specific event and carries the bearer token', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_1' }), { status: 200 }));
    await updateEvent('AT', 'primary', 'evt_1', { summary: 'Boarding — Rex' });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events/evt_1');
    expect((init as RequestInit).method).toBe('PATCH');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer AT' });
  });

  it('updateEvent returns { gone: false } on a 2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_1' }), { status: 200 }),
    );
    expect(await updateEvent('AT', 'primary', 'evt_1', {})).toEqual({ gone: false });
  });

  it('updateEvent reports gone (not an error) when the event was hand-deleted (404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not found', { status: 404 }));
    expect(await updateEvent('AT', 'primary', 'evt_1', {})).toEqual({ gone: true });
  });

  it('updateEvent reports gone on 410 Gone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('gone', { status: 410 }));
    expect(await updateEvent('AT', 'primary', 'evt_1', {})).toEqual({ gone: true });
  });

  it('updateEvent throws on a non-2xx response that is not 404/410', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }));
    await expect(updateEvent('AT', 'primary', 'evt_1', {})).rejects.toThrow(
      'Google updateEvent failed (500)',
    );
  });

  it('buildEventResource: all-day range uses date start/end (exclusive)', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk-allday',
      startDate: '2030-01-10',
      endDate: '2030-01-13',
      startTime: null,
      departureTime: null,
      durationMinutes: null,
      petCount: 2,
      petNames: ['Rex', 'Fido'],
      estCost: 150,
      customerEmail: 'a@b.c',
      status: 'confirmed',
      timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ date: '2030-01-10' });
    expect(r.end).toEqual({ date: '2030-01-13' });
    // Pet NAMES lead the summary (not a bare count), and the customer moved to the description.
    expect(r.summary).toBe('Rex, Fido — Boarding');
    expect(r.description).toContain('Customer: a@b.c');
  });

  it('buildEventResource: all-day single day uses next-day exclusive end', () => {
    const r = buildEventResource({
      serviceLabel: 'Daycare',
      category: 'day-care',
      bookingId: 'bk-single',
      startDate: '2030-01-10',
      endDate: null,
      startTime: null,
      departureTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: ['Rex'],
      estCost: 40,
      customerEmail: null,
      status: 'confirmed',
      timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ date: '2030-01-10' });
    expect(r.end).toEqual({ date: '2030-01-11' });
  });

  it('buildEventResource: timed booking uses dateTime + timeZone, end = start + duration', () => {
    const r = buildEventResource({
      serviceLabel: 'Walk',
      category: 'walks',
      bookingId: 'bk-timed',
      startDate: '2030-01-10',
      endDate: null,
      startTime: '09:30',
      departureTime: null,
      durationMinutes: 60,
      petCount: 1,
      petNames: ['Rex'],
      estCost: 35,
      customerEmail: 'a@b.c',
      status: 'confirmed',
      timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ dateTime: '2030-01-10T09:30:00', timeZone: 'America/Los_Angeles' });
    expect(r.end).toEqual({ dateTime: '2030-01-10T10:30:00', timeZone: 'America/Los_Angeles' });
  });

  it('buildEventResource: pending event gets a [REQUEST] prefix + a full description', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk-pending',
      startDate: '2030-01-10',
      endDate: '2030-01-13',
      startTime: null,
      departureTime: null,
      durationMinutes: null,
      petCount: 2,
      petNames: ['Bella', 'Mochi'],
      estCost: 150,
      customerEmail: 'jess@example.com',
      status: 'pending',
      timezone: 'America/Los_Angeles',
    });
    expect(r.summary).toBe('[REQUEST] Bella, Mochi — Boarding');
    expect(r.description).toBe(
      'Service: Boarding\nPets: Bella, Mochi\nCustomer: jess@example.com\nEstimated cost: $150\n' +
        'Requested via Pawservation — confirm or decline in your dashboard.',
    );
  });

  it('buildEventResource: confirmed event drops the prefix and the "requested via" line', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk-confirmed',
      startDate: '2030-01-10',
      endDate: '2030-01-13',
      startTime: null,
      departureTime: null,
      durationMinutes: null,
      petCount: 2,
      petNames: ['Bella', 'Mochi'],
      estCost: 150,
      customerEmail: 'jess@example.com',
      status: 'confirmed',
      timezone: 'America/Los_Angeles',
    });
    expect(r.summary).toBe('Bella, Mochi — Boarding');
    expect(r.description).toBe(
      'Service: Boarding\nPets: Bella, Mochi\nCustomer: jess@example.com\nEstimated cost: $150',
    );
    expect(r.description).not.toContain('Requested via');
  });

  it('buildEventResource: falls back to a pet count when no names are given', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk-count',
      startDate: '2030-01-10',
      endDate: '2030-01-13',
      startTime: null,
      departureTime: null,
      durationMinutes: null,
      petCount: 3,
      petNames: [],
      estCost: null,
      customerEmail: null,
      status: 'pending',
      timezone: 'America/Los_Angeles',
    });
    expect(r.summary).toBe('[REQUEST] 3 pets — Boarding');
    // No customer + no cost lines when both are absent, but the pending line still appears.
    expect(r.description).toBe(
      'Service: Boarding\nPets: 3 pets\nRequested via Pawservation — confirm or decline in your dashboard.',
    );
  });

  it('buildEventResource: sets extendedProperties.private with booking metadata + status', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk1',
      startDate: '2030-01-10',
      endDate: '2030-01-13',
      startTime: null,
      departureTime: null,
      durationMinutes: null,
      petCount: 2,
      petNames: ['Bella', 'Mochi'],
      estCost: 150,
      customerEmail: 'jess@example.com',
      status: 'pending',
      timezone: 'America/Los_Angeles',
    });
    expect(r.extendedProperties?.private).toEqual({
      pawservation: 'true',
      category: 'boarding',
      petCount: '2',
      customerEmail: 'jess@example.com',
      bookingId: 'bk1',
      status: 'pending',
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
      departureTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: null,
      customerEmail: null,
      status: 'confirmed',
      timezone: 'America/Los_Angeles',
    });
    expect(r.extendedProperties?.private.customerEmail).toBe('');
    expect(r.extendedProperties?.private.pawservation).toBe('true');
    expect(r.extendedProperties?.private.status).toBe('confirmed');
  });

  it('keeps a range booking all-day and notes the arrival time in the description', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding',
      category: 'boarding',
      bookingId: 'bk1',
      startDate: '2028-06-20',
      endDate: '2028-06-25',
      startTime: '14:30',
      departureTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: ['Bella'],
      estCost: 250,
      customerEmail: 'jess@example.com',
      status: 'confirmed',
      timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ date: '2028-06-20' });
    expect(r.end).toEqual({ date: '2028-06-25' });
    expect(r.description).toContain('Arrival: 14:30');
  });

  describe('buildUnavailableEventResource', () => {
    it('summary is exactly UNAVAILABLE, verbatim, no marker, no interpolation', () => {
      const r = buildUnavailableEventResource({
        bookingId: 'blk-1',
        startDate: '2026-08-10',
        endDate: '2026-08-18',
      });
      expect(r.summary).toBe('UNAVAILABLE');
      expect(r.summary).toBe(UNAVAILABLE_EVENT_SUMMARY);
    });

    it('description is exactly the two documented lines', () => {
      const r = buildUnavailableEventResource({
        bookingId: 'blk-1',
        startDate: '2026-08-10',
        endDate: '2026-08-18',
      });
      expect(r.description).toBe(
        'Time off booked in Pawservation.\n' +
          'Deleting this event does not free the day — remove it under Time off in your dashboard.',
      );
    });

    it('the date-convention lock: an already-exclusive endDate passes through verbatim, no +/-1', () => {
      const r = buildUnavailableEventResource({
        bookingId: 'blk-1',
        startDate: '2026-08-10',
        endDate: '2026-08-18',
      });
      expect(r.start).toEqual({ date: '2026-08-10' });
      expect(r.end).toEqual({ date: '2026-08-18' });
    });

    it('a null endDate falls back to the day after startDate', () => {
      const r = buildUnavailableEventResource({
        bookingId: 'blk-1',
        startDate: '2026-08-10',
        endDate: null,
      });
      expect(r.start).toEqual({ date: '2026-08-10' });
      expect(r.end).toEqual({ date: '2026-08-11' });
    });

    it('start/end are always the {date} shape, never {dateTime}', () => {
      const r = buildUnavailableEventResource({
        bookingId: 'blk-1',
        startDate: '2026-08-10',
        endDate: '2026-08-18',
      });
      expect(r.start).not.toHaveProperty('dateTime');
      expect(r.end).not.toHaveProperty('dateTime');
      expect(Object.keys(r.start)).toEqual(['date']);
      expect(Object.keys(r.end)).toEqual(['date']);
    });

    it('private.bookingId is present and equals the id passed in, alongside category/status', () => {
      const r = buildUnavailableEventResource({
        bookingId: 'blk-42',
        startDate: '2026-08-10',
        endDate: '2026-08-18',
      });
      expect(r.extendedProperties?.private).toEqual({
        pawservation: 'true',
        category: 'blocked',
        bookingId: 'blk-42',
        status: 'confirmed',
      });
    });

    it('never carries a marker regardless of the summary being a constant', () => {
      // Structural check that nothing derives the summary from any state: two different
      // bookingId/date inputs must produce the byte-identical summary.
      const a = buildUnavailableEventResource({
        bookingId: 'blk-a',
        startDate: '2026-01-01',
        endDate: '2026-01-02',
      });
      const b = buildUnavailableEventResource({
        bookingId: 'blk-b',
        startDate: '2027-12-25',
        endDate: null,
      });
      expect(a.summary).toBe('UNAVAILABLE');
      expect(b.summary).toBe('UNAVAILABLE');
    });
  });

  describe('listCalendarEvents', () => {
    it('normalizes an all-day event and a timed event', async () => {
      const fakeBody = {
        items: [
          {
            id: 'evt_a',
            summary: 'Dog boarding',
            status: 'confirmed',
            updated: '2030-05-01T00:00:00Z',
            start: { date: '2030-06-01' },
            end: { date: '2030-06-04' },
            extendedProperties: {
              private: { pawservation: 'true', category: 'boarding', bookingId: 'bk-a' },
            },
          },
          {
            id: 'evt_b',
            summary: 'Walk',
            status: 'confirmed',
            updated: '2030-05-01T00:00:00Z',
            start: { dateTime: '2030-06-05T09:30:00-07:00' },
            end: { dateTime: '2030-06-05T10:30:00-07:00' },
            extendedProperties: {
              private: { pawservation: 'true', category: 'walks', bookingId: 'bk-b' },
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
        id: 'evt_a',
        summary: 'Dog boarding',
        start: '2030-06-01',
        end: '2030-06-04',
        allDay: true,
        status: 'confirmed',
        updated: '2030-05-01T00:00:00Z',
        private: { pawservation: 'true', category: 'boarding', bookingId: 'bk-a' },
      });
      // timed event — dateTime sliced to date part
      expect(events[1]).toEqual({
        id: 'evt_b',
        summary: 'Walk',
        start: '2030-06-05',
        end: '2030-06-05',
        allDay: false,
        status: 'confirmed',
        updated: '2030-05-01T00:00:00Z',
        private: { pawservation: 'true', category: 'walks', bookingId: 'bk-b' },
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
      // A fresh Response per call — a real fetch would never hand back the same (already-read)
      // Response object across pages the way a shared mockResolvedValue instance would.
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response(JSON.stringify({ items: [], nextPageToken: 'abc' }), { status: 200 }),
      );
      await expect(
        listCalendarEvents('AT', 'primary', '2030-06-01Z', '2030-07-01Z'),
      ).rejects.toThrow('result truncated');
    });
  });

  describe('listCalendarEvents — widened projection + pagination', () => {
    afterEach(() => vi.restoreAllMocks());

    it('surfaces id, status, updated, allDay for both event shapes', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'evt_allday',
                summary: 'Boarding — Rex',
                status: 'confirmed',
                updated: '2026-07-27T10:00:00Z',
                start: { date: '2026-08-01' },
                end: { date: '2026-08-04' },
              },
              {
                id: 'evt_timed',
                summary: 'Vet visit',
                status: 'tentative',
                updated: '2026-07-27T11:00:00Z',
                start: { dateTime: '2026-08-02T14:00:00-07:00' },
                end: { dateTime: '2026-08-02T15:00:00-07:00' },
              },
            ],
          }),
          { status: 200 },
        ),
      );
      const events = await listCalendarEvents('tok', 'primary', 'a', 'b');
      expect(events[0]).toMatchObject({
        id: 'evt_allday',
        allDay: true,
        status: 'confirmed',
        start: '2026-08-01',
        end: '2026-08-04',
      });
      expect(events[1]).toMatchObject({ id: 'evt_timed', allDay: false, end: '2026-08-02' });
    });

    it('follows nextPageToken and concatenates pages', async () => {
      const pages = [
        {
          items: [{ id: 'e1', start: { date: '2026-08-01' }, end: { date: '2026-08-02' } }],
          nextPageToken: 'p2',
        },
        { items: [{ id: 'e2', start: { date: '2026-08-03' }, end: { date: '2026-08-04' } }] },
      ];
      let call = 0;
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(
          async () => new Response(JSON.stringify(pages[call++]), { status: 200 }),
        );
      const events = await listCalendarEvents('tok', 'primary', 'a', 'b');
      expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
      expect(String(spy.mock.calls[1]![0])).toContain('pageToken=p2');
    });

    it('still fails loudly past the page cap — absence must never be inferred from truncation', async () => {
      // Fresh Response per call, same reasoning as above.
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response(JSON.stringify({ items: [], nextPageToken: 'again' }), { status: 200 }),
      );
      await expect(listCalendarEvents('tok', 'primary', 'a', 'b')).rejects.toThrow(
        'result truncated',
      );
    });
  });
});
