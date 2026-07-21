import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A, TEST_SECRET } from './helpers';

/**
 * Persona scenario tests: Marisol runs Sunny Paws (tnt_sunnypaws / slug sunny-paws), a
 * boarding-heavy business with Google Calendar CONNECTED — she lives in her calendar and
 * expects every booking to show up there.
 *
 * These exercise the real HTTP routes (customer booking + admin status changes) end to end,
 * spying on globalThis.fetch to capture what Pawbook actually sends to the Google Calendar API,
 * following the patterns in calendar-sync.test.ts / calendar-delete-sync.test.ts.
 */

const CALENDAR_ID = 'primary';

async function connectCalendar(env: Env): Promise<void> {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-marisol'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-marisol'),
    expiresAt: '2031-01-01T00:00:00Z', // far future — no refresh round-trip to account for
    calendarId: CALENDAR_ID,
  });
}

async function bookBoarding(
  env: Env,
  token: string,
  startDate: string,
  endDate: string,
): Promise<Response> {
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        startDate,
        endDate,
        petIds: ['pet_sp_bella', 'pet_sp_mochi'], // Jess's two pets: a dog and a cat
      }),
    },
    env,
  );
}

async function setStatus(env: Env, id: string, status: string): Promise<Response> {
  return app.request(
    `/api/sunny-paws/admin/bookings/${id}/status`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
    env,
  );
}

type EventResource = {
  summary: string;
  description: string;
  extendedProperties?: { private: Record<string, string> };
};

describe('Persona: Marisol (Sunny Paws) — booking → Google Calendar → dashboard', () => {
  afterEach(() => vi.restoreAllMocks());

  it('1. a customer booking creates a Google Calendar event and persists the event id', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);

    let capturedUrl = '';
    let capturedInit: RequestInit = {};
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init as RequestInit;
      return new Response(JSON.stringify({ id: 'evt_marisol_1' }), { status: 200 });
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await bookBoarding(env, token, '2029-04-01', '2029-04-04'); // 3 nights, $50/night
    expect(res.status).toBe(201);
    const booked = (await res.json()) as { id: string; estCost: number; status: string };
    expect(booked.status).toBe('pending');
    expect(booked.estCost).toBe(150);

    // A POST hit the Google Calendar events endpoint for the tenant's connected calendar.
    expect(spy).toHaveBeenCalledOnce();
    expect(capturedInit.method).toBe('POST');
    expect(capturedUrl).toContain(`/calendars/${CALENDAR_ID}/events`);
    expect(capturedUrl).toContain('googleapis.com');

    const resource = JSON.parse(capturedInit.body as string) as EventResource;
    // A pending request is marked [REQUEST], names the pets, and carries full booking metadata.
    expect(resource.summary).toBe('[REQUEST] Boarding — Bella, Mochi');
    expect(resource.description).toBe(
      'Service: Boarding\nPets: Bella, Mochi\nCustomer: jess@example.com\nEstimated cost: $150\n' +
        'Requested via Pawservation — confirm or decline in your dashboard.',
    );
    expect(resource.extendedProperties?.private).toEqual({
      pawbook: 'true',
      category: 'boarding',
      petCount: '2',
      customerEmail: 'jess@example.com',
      bookingId: booked.id,
      status: 'pending',
    });

    // The event id Google returned is persisted on the booking row.
    const row = raw
      .prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id = ?`)
      .get(booked.id) as { GCalEventId: string };
    expect(row.GCalEventId).toBe('evt_marisol_1');
  });

  it('2. confirming the booking PATCHes its event to drop the [REQUEST] marker', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_marisol_2' }), { status: 200 }),
    );

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const bookRes = await bookBoarding(env, token, '2029-04-10', '2029-04-13');
    const { id } = (await bookRes.json()) as { id: string };

    const rowBefore = raw
      .prepare(`SELECT Status, GCalEventId FROM BookingRequests WHERE Id = ?`)
      .get(id) as { Status: string; GCalEventId: string };
    expect(rowBefore.Status).toBe('pending');
    expect(rowBefore.GCalEventId).toBe('evt_marisol_2');

    // Reset the spy's call count so we isolate calls made by the confirm step itself.
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockClear();

    const confirmRes = await setStatus(env, id, 'confirmed');
    expect(confirmRes.status).toBe(200);

    // Confirm now updates the existing event in place: a single PATCH to that event id, whose
    // patched summary is the confirmed (prefix-free) form — no new event is created.
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(url).toContain(`/calendars/${CALENDAR_ID}/events/evt_marisol_2`);
    const patched = JSON.parse(init.body as string) as EventResource;
    expect(patched.summary).toBe('Boarding — Bella, Mochi');
    expect(patched.summary).not.toContain('[REQUEST]');

    const rowAfter = raw.prepare(`SELECT Status FROM BookingRequests WHERE Id = ?`).get(id) as {
      Status: string;
    };
    expect(rowAfter.Status).toBe('confirmed');
  });

  it('5. a request lost to a Google outage is created as a catch-up when confirmed', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);

    // Outage at request time: the create-sync throws, so the booking has NO GCalEventId.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('googleapis.com')) throw new TypeError('outage');
      throw new Error(`unexpected fetch to ${String(url)}`);
    });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const bookRes = await bookBoarding(env, token, '2029-07-01', '2029-07-04');
    const { id } = (await bookRes.json()) as { id: string };
    expect(
      (
        raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id = ?`).get(id) as {
          GCalEventId: string | null;
        }
      ).GCalEventId,
    ).toBeNull();

    // Google is healthy again; confirming creates the missing event, already confirmed.
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_marisol_5' }), { status: 200 }));
    spy.mockClear();

    const confirmRes = await setStatus(env, id, 'confirmed');
    expect(confirmRes.status).toBe(200);

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST'); // a create (catch-up), not a PATCH
    expect(url).toContain(`/calendars/${CALENDAR_ID}/events`);
    const created = JSON.parse(init.body as string) as EventResource;
    expect(created.summary).toBe('Boarding — Bella, Mochi'); // confirmed, no [REQUEST]

    const row = raw
      .prepare(`SELECT Status, GCalEventId FROM BookingRequests WHERE Id = ?`)
      .get(id) as { Status: string; GCalEventId: string | null };
    expect(row.Status).toBe('confirmed');
    expect(row.GCalEventId).toBe('evt_marisol_5'); // now persisted
  });

  it('6. an updateEvent failure on confirm never breaks the confirm response', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_marisol_6' }), { status: 200 }),
    );

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const bookRes = await bookBoarding(env, token, '2029-08-01', '2029-08-04');
    const { id } = (await bookRes.json()) as { id: string };

    // The PATCH on confirm fails (Google 500), but the booking is already confirmed in the DB and
    // the response must still be 200 — calendar sync is strictly best-effort.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));

    const confirmRes = await setStatus(env, id, 'confirmed');
    expect(confirmRes.status).toBe(200);
    const rowAfter = raw.prepare(`SELECT Status FROM BookingRequests WHERE Id = ?`).get(id) as {
      Status: string;
    };
    expect(rowAfter.Status).toBe('confirmed');
  });

  it('3. declining a pending booking deletes its calendar event, on the tenant calendar id', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_marisol_3' }), { status: 200 }),
    );

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const bookRes = await bookBoarding(env, token, '2029-05-01', '2029-05-04');
    const { id } = (await bookRes.json()) as { id: string };
    const rowBefore = raw
      .prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id = ?`)
      .get(id) as { GCalEventId: string };
    expect(rowBefore.GCalEventId).toBe('evt_marisol_3');

    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    spy.mockClear(); // isolate calls made by the decline step from the earlier booking-create call

    const declineRes = await setStatus(env, id, 'declined');
    expect(declineRes.status).toBe(200);
    expect(await declineRes.json()).toEqual({ status: 'declined', notified: false });

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toContain(`/calendars/${CALENDAR_ID}/events/evt_marisol_3`);

    // Under the hood a decline is stored as Status='cancelled' + Declined=1 (updateBookingStatus
    // in server/db/repo.ts) — the API/dashboard-facing 'declined' status is derived from that
    // combination (see admin.ts's `r.Declined ? 'declined' : r.Status`).
    const rowAfter = raw
      .prepare(`SELECT Status, Declined, GCalEventId FROM BookingRequests WHERE Id = ?`)
      .get(id) as { Status: string; Declined: number; GCalEventId: string };
    expect(rowAfter.Status).toBe('cancelled');
    expect(rowAfter.Declined).toBe(1);
    // GCalEventId is retained as a historical record even though the live event is gone.
    expect(rowAfter.GCalEventId).toBe('evt_marisol_3');
  });

  it('4. a Google Calendar outage never blocks the booking — request still succeeds', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);

    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('googleapis.com')) {
        throw new TypeError('network outage reaching googleapis.com');
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    });

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await bookBoarding(env, token, '2029-06-01', '2029-06-04');

    expect(res.status).toBe(201);
    const booked = (await res.json()) as { id: string; status: string };
    expect(booked.status).toBe('pending');
    expect(spy).toHaveBeenCalled(); // the sync attempt did happen — and was swallowed

    const row = raw
      .prepare(`SELECT Status, GCalEventId FROM BookingRequests WHERE Id = ?`)
      .get(booked.id) as { Status: string; GCalEventId: string | null };
    expect(row.Status).toBe('pending');
    // The event was never created, so no id to persist — but the booking itself is intact.
    expect(row.GCalEventId).toBeNull();

    const mineRes = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const mine = (await mineRes.json()) as { bookings: { id: string; status: string }[] };
    const mineRow = mine.bookings.find((b) => b.id === booked.id);
    expect(mineRow?.status).toBe('pending');
  });
});
