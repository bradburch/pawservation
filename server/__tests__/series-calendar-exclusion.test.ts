import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  insertBookingRequest,
  listSyncedBookingIds,
  listSyncPendingBookings,
  listUnsyncedFutureBookings,
  setProviderTokens,
  updateBookingForEdit,
  updateBookingStatus,
  cancelBookingForUser,
} from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A, TEST_SECRET } from './helpers';
import type { DatabaseSync } from 'node:sqlite';

const SLUG = 'sunny-paws';
const JESS = 'eu_sp_jess';
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

function seed(raw: DatabaseSync) {
  raw.prepare(`INSERT INTO BookingSeries (Id, TenantId, EndUserId, ServiceType, Weekdays, StartDate, Status, CreatedBy, CreatedAt, UpdatedAt)
    VALUES ('s1', ?, ?, 'walk', 2, '2030-01-01', 'active', 'client', 'x', 'x')`).run(TENANT_A, JESS);
  // A walk that LOOKS unsynced, sync-pending AND synced at once, so every lister would pick it up
  // were it a single booking:
  raw.prepare(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status, SeriesId, SyncPending, GCalEventId, CreatedAt)
    VALUES ('w1', ?, ?, 'walk', '2030-01-08', 1, 'confirmed', 's1', 1, NULL, 'x'),
           ('w2', ?, ?, 'walk', '2030-01-15', 1, 'confirmed', 's1', 1, 'evt-w2', 'x')`).run(
    TENANT_A, JESS, TENANT_A, JESS,
  );
}

const seriesPending = (raw: DatabaseSync) =>
  (raw.prepare(`SELECT SyncPending AS p FROM BookingSeries WHERE Id = 's1'`).get() as { p: number }).p;
const walkPending = (raw: DatabaseSync, id: string) =>
  (raw.prepare(`SELECT SyncPending AS p FROM BookingRequests WHERE Id = ?`).get(id) as { p: number }).p;

async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

const googleCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((a) => String(a[0])).filter((u) => u.includes('googleapis.com'));

describe('a series row is invisible to the per-booking calendar outbox, backfill and reconcile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('listUnsyncedFutureBookings skips it', async () => {
    const { env, raw } = createTestEnv();
    seed(raw);
    const ids = (await listUnsyncedFutureBookings(env.PAWSERVATION_DB, TENANT_A, '2026-01-01', 500)).map((r) => r.Id);
    expect(ids).not.toContain('w1');
  });
  it('listSyncPendingBookings skips it', async () => {
    const { env, raw } = createTestEnv();
    seed(raw);
    const ids = (await listSyncPendingBookings(env.PAWSERVATION_DB, TENANT_A, '2026-01-01', 500)).map((r) => r.Id);
    expect(ids).not.toContain('w1');
    expect(ids).not.toContain('w2');
  });
  it('listSyncedBookingIds skips it', async () => {
    const { env, raw } = createTestEnv();
    seed(raw);
    expect(await listSyncedBookingIds(env.PAWSERVATION_DB, TENANT_A, '2026-01-01', '2031-01-01')).not.toContain('w2');
  });
  it('a single booking is unchanged: still listed and still armed', async () => {
    const { env, raw } = createTestEnv();
    seed(raw);
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: JESS, serviceType: 'boarding', startDate: '2030-02-01', endDate: '2030-02-03',
      optionKey: 'standard', petCount: 1, estCost: 15000, status: 'pending',
    });
    expect(walkPending(raw, id)).toBe(1);
    const pending = (await listSyncPendingBookings(env.PAWSERVATION_DB, TENANT_A, '2026-01-01', 500)).map((r) => r.Id);
    expect(pending).toContain(id);
    const unsynced = (await listUnsyncedFutureBookings(env.PAWSERVATION_DB, TENANT_A, '2026-01-01', 500)).map((r) => r.Id);
    expect(unsynced).toContain(id);
    // and a status change still arms it
    raw.exec(`UPDATE BookingRequests SET SyncPending = 0 WHERE Id = '${id}'`);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'confirmed');
    expect(walkPending(raw, id)).toBe(1);
  });

  it('every status writer leaves a walk unarmed (cancel with fee, decline, generic, customer cancel, edit)', async () => {
    const { env, raw } = createTestEnv();
    seed(raw);
    const reset = (id: string, status: string) =>
      raw.exec(`UPDATE BookingRequests SET SyncPending = 0, Status = '${status}' WHERE Id = '${id}'`);

    reset('w1', 'confirmed');
    expect(await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, 'w1', 'cancelled', 500)).toBe(true);
    expect(walkPending(raw, 'w1')).toBe(0);

    reset('w1', 'pending');
    expect(await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, 'w1', 'declined')).toBe(true);
    expect(walkPending(raw, 'w1')).toBe(0);

    reset('w1', 'pending');
    expect(await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, 'w1', 'cancelled')).toBe(true);
    expect(walkPending(raw, 'w1')).toBe(0);

    reset('w1', 'confirmed');
    expect(await cancelBookingForUser(env.PAWSERVATION_DB, TENANT_A, JESS, 'w1', 0, 'confirmed')).toBe(true);
    expect(walkPending(raw, 'w1')).toBe(0);

    reset('w1', 'confirmed');
    expect(
      await updateBookingForEdit(env.PAWSERVATION_DB, TENANT_A, JESS, 'w1', {
        startDate: '2030-01-09', endDate: null, startTime: null, departureTime: null,
        petCount: 1, estCost: 100, answers: {}, expectedStatus: 'confirmed',
      }),
    ).toBe(true);
    expect(walkPending(raw, 'w1')).toBe(0);
  });

  it('the admin status route on a walk re-arms its series and pushes no event of its own', async () => {
    const { env, raw } = createTestEnv();
    seed(raw);
    await connectCalendar(env);
    raw.exec(`UPDATE BookingRequests SET SyncPending = 0 WHERE Id IN ('w1','w2')`);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    expect(seriesPending(raw)).toBe(0);
    for (const [id, status] of [['w1', 'cancelled'], ['w2', 'confirmed']] as const) {
      raw.exec(`UPDATE BookingSeries SET SyncPending = 0`);
      const res = await app.request(
        `/api/${SLUG}/admin/bookings/${id}/status`,
        {
          method: 'POST',
          headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        },
        env,
      );
      expect(res.status).toBe(200);
      expect(seriesPending(raw)).toBe(1);
      expect(walkPending(raw, id)).toBe(0);
    }
    expect(googleCalls(spy)).toEqual([]);
  });

  it("the customer cancel route on a walk re-arms its series and deletes no event (even one with an id)", async () => {
    const { env, raw } = createTestEnv();
    seed(raw);
    await connectCalendar(env);
    raw.exec(`UPDATE BookingRequests SET SyncPending = 0, StartDate = '${addDays(TODAY, 40)}' WHERE Id = 'w2'`);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const res = await app.request(
      `/api/${SLUG}/bookings/w2/cancel`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(seriesPending(raw)).toBe(1);
    expect(walkPending(raw, 'w2')).toBe(0);
    expect(googleCalls(spy)).toEqual([]);
  });

  it('the customer edit route on a walk re-arms its series and pushes no event', async () => {
    const { env, raw } = createTestEnv();
    seed(raw);
    await connectCalendar(env);
    const start = addDays(TODAY, 40);
    raw.exec(`UPDATE BookingRequests SET SyncPending = 0, ServiceType = 'boarding', OptionKey = 'standard',
      StartDate = '${start}', EndDate = '${addDays(start, 3)}', Status = 'pending' WHERE Id = 'w1'`);
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const token = await endUserToken(env, SLUG, 'jess@example.com');
    const res = await app.request(
      `/api/${SLUG}/bookings/w1`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: start, endDate: addDays(start, 2), petIds: ['pet_sp_bella'] }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(seriesPending(raw)).toBe(1);
    expect(walkPending(raw, 'w1')).toBe(0);
    expect(googleCalls(spy)).toEqual([]);
  });
});
