import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { insertBookingRequest, setBookingGCalEventId, setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { adminHeaders, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';

/** Connected Google Calendar with a far-future token expiry — no refresh round-trip. */
async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

async function seedBooking(
  env: Env,
  status: 'pending' | 'confirmed',
  gcalEventId: string | null,
): Promise<string> {
  const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: '2030-03-01',
    endDate: '2030-03-04',
    optionKey: null,
    petType: 'dog',
    petCount: 1,
    estCost: 150,
    status,
  });
  if (gcalEventId) await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, id, gcalEventId, null);
  return id;
}

async function postStatus(env: Env, id: string, status: string): Promise<Response> {
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

async function bookingRow(
  env: Env,
  id: string,
): Promise<{ Status: string; GCalEventId: string | null }> {
  const row = await env.PAWBOOK_DB.prepare(
    'SELECT Status, GCalEventId FROM BookingRequests WHERE Id = ?',
  )
    .bind(id)
    .first<{ Status: string; GCalEventId: string | null }>();
  return row!;
}

describe('POST /:slug/admin/bookings/:id/status — Google Calendar hooks (confirm PATCH, decline/cancel delete)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cancel deletes the synced event and keeps GCalEventId on the row', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env, 'confirmed', 'evt_1');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const res = await postStatus(env, id, 'cancelled');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled', notified: false });
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toContain('/calendars/primary/events/evt_1');
    // GCalEventId is retained as a historical record — reconciliation already
    // ignores cancelled bookings (listSyncedBookingIds excludes them).
    expect(await bookingRow(env, id)).toEqual({ Status: 'cancelled', GCalEventId: 'evt_1' });
  });

  it('decline (from pending) deletes the synced event', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env, 'pending', 'evt_2');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    const res = await postStatus(env, id, 'declined');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'declined', notified: false });
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toContain('/events/evt_2');
  });

  it('confirm PATCHes the existing event (drops the [REQUEST] marker)', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env, 'pending', 'evt_3');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_3' }), { status: 200 }));
    const res = await postStatus(env, id, 'confirmed');
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect(url).toContain('/calendars/primary/events/evt_3');
    const resource = JSON.parse(init.body as string) as { summary: string };
    expect(resource.summary).not.toContain('[REQUEST]');
  });

  it('no-ops when the booking has no GCalEventId', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env, 'confirmed', null);
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await postStatus(env, id, 'cancelled');
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('no-ops when no calendar is connected, even with a GCalEventId', async () => {
    const { env } = createTestEnv();
    // No connectCalendar: the seeded ProviderConnections row is 'disconnected'.
    const id = await seedBooking(env, 'confirmed', 'evt_4');
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await postStatus(env, id, 'cancelled');
    expect(res.status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a Google failure is swallowed — the status change stands', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env, 'confirmed', 'evt_5');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const res = await postStatus(env, id, 'cancelled');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'cancelled', notified: false });
    expect((await bookingRow(env, id)).Status).toBe('cancelled');
  });

  it('410 Gone (already deleted) is treated as success', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env, 'confirmed', 'evt_6');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 410 }));
    const res = await postStatus(env, id, 'cancelled');
    expect(res.status).toBe(200);
    expect((await bookingRow(env, id)).Status).toBe('cancelled');
  });
});
