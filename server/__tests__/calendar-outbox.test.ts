import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  deleteBookingCalendarEvent,
  syncBookingToCalendar,
  updateBookingCalendarEvent,
} from '../lib/calendar-sync';
import { insertBookingRequest, setProviderTokens, updateBookingStatus } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { createTestEnv, endUserToken, TENANT_A, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

const tenant = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant;
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

async function syncState(env: Env, id: string) {
  return (await env.PAWBOOK_DB.prepare(
    'SELECT SyncPending, GCalEventId, Status FROM BookingRequests WHERE Id = ?',
  )
    .bind(id)
    .first<{ SyncPending: number; GCalEventId: string | null; Status: string }>())!;
}

function seedBooking(env: Env, status: 'pending' | 'confirmed' = 'confirmed') {
  return insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: addDays(TODAY, 10),
    endDate: addDays(TODAY, 13),
    optionKey: 'standard',
    petCount: 1,
    estCost: 150,
    status,
  });
}

const syncInputFor = (id: string) => ({
  bookingId: id,
  endUserId: null,
  serviceType: 'boarding',
  serviceLabel: 'Boarding',
  startDate: addDays(TODAY, 10),
  endDate: addDays(TODAY, 13),
  startTime: null,
  durationMinutes: null,
  petCount: 1,
  petNames: ['Bella'],
  estCost: 150,
  status: 'confirmed' as const,
});

describe('calendar outbox — write side', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a customer booking POST leaves SyncPending=1 when the Google push fails, 0 when it lands', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'boarding',
          startDate: addDays(TODAY, 30),
          endDate: addDays(TODAY, 32),
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(res.status).toBe(201); // Google failure NEVER blocks the booking
    const { id } = (await res.json()) as { id: string };
    expect((await syncState(env, id)).SyncPending).toBe(1);

    // Now the push succeeds (event create returns an id) — flag clears via the CAS write.
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_ok' }), { status: 200 }),
    );
    await syncBookingToCalendar(env, tenant, { ...syncInputFor(id), status: 'pending' });
    const after = await syncState(env, id);
    expect(after).toMatchObject({ SyncPending: 0, GCalEventId: 'evt_ok' });
    void raw;
  });

  it('a blocked-day row never enters the outbox', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: addDays(TODAY, 5),
      endDate: addDays(TODAY, 7),
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    expect((await syncState(env, id)).SyncPending).toBe(0);
  });

  it('every status transition re-marks the row pending', async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, 'pending');
    await clearFlag(env, id);
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'confirmed');
    expect((await syncState(env, id)).SyncPending).toBe(1);
    await clearFlag(env, id);
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'cancelled');
    expect((await syncState(env, id)).SyncPending).toBe(1);
  });

  it('declining marks pending too (post-baseline Status=declined)', async () => {
    const { env } = createTestEnv();
    const id = await seedBooking(env, 'pending');
    await clearFlag(env, id);
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'declined');
    const s = await syncState(env, id);
    expect(s).toMatchObject({ Status: 'declined', SyncPending: 1 });
  });

  it('a successful update-push and delete-push clear the flag; failures leave it set', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const id = await seedBooking(env);
    await env.PAWBOOK_DB.prepare(
      "UPDATE BookingRequests SET GCalEventId = 'evt_1', SyncPending = 1 WHERE Id = ?",
    )
      .bind(id)
      .run();

    // update-push failure → still pending
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    await expect(
      updateBookingCalendarEvent(env, tenant, 'evt_1', syncInputFor(id)),
    ).rejects.toThrow();
    expect((await syncState(env, id)).SyncPending).toBe(1);

    // update-push success → cleared
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await updateBookingCalendarEvent(env, tenant, 'evt_1', syncInputFor(id));
    expect((await syncState(env, id)).SyncPending).toBe(0);

    // delete-push success → cleared (cancel first to make it a real delete case)
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'cancelled');
    expect((await syncState(env, id)).SyncPending).toBe(1);
    await deleteBookingCalendarEvent(env, tenant, 'evt_1', id);
    expect((await syncState(env, id)).SyncPending).toBe(0);
  });
});

async function clearFlag(env: Env, id: string) {
  await env.PAWBOOK_DB.prepare('UPDATE BookingRequests SET SyncPending = 0 WHERE Id = ?')
    .bind(id)
    .run();
}
