import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertPayment, listSyncedBookingIds, updateBookingStatus } from '../db/repo';
import { rowsToCapacityEvents } from '../lib/availability';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
const EXT_START = addDays(TODAY, 40);
const EXT_END = addDays(TODAY, 43); // exclusive

/** Seed a materialized external row the way the reconciler will write it. */
async function seedExternal(env: Env, opts?: { start?: string; end?: string }): Promise<string> {
  const id = crypto.randomUUID();
  await env.PAWBOOK_DB.prepare(
    `INSERT INTO BookingRequests
       (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount,
        EstCost, GCalEventId, ExternalSummary, Status, SyncPending)
     VALUES (?, ?, NULL, 'external', ?, ?, NULL, 1, NULL, ?, 'Neighbor stay — Rex', 'confirmed', 0)`,
  )
    .bind(id, TENANT_A, opts?.start ?? EXT_START, opts?.end ?? EXT_END, `gev_${id.slice(0, 8)}`)
    .run();
  return id;
}

describe("ServiceType 'external' — blocked-like, read-only, unpriced", () => {
  it('maps to a blocked capacity event (no bookend sharing, blocks every service)', () => {
    const events = rowsToCapacityEvents([
      { ServiceType: 'external', StartDate: EXT_START, EndDate: EXT_END, PetCount: 1 } as never,
    ]);
    expect(events[0]).toMatchObject({ kind: 'blocked', start_date: EXT_START });
  });

  it('blocks a real boarding request over its dates, end-to-end through the quote', async () => {
    const { env } = createTestEnv();
    await seedExternal(env);
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      `/api/sunny-paws/availability?type=boarding&start=${addDays(EXT_START, 1)}&end=${EXT_END}`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });

  it('cannot be confirmed, cancelled, declined, or paid', async () => {
    const { env } = createTestEnv();
    const id = await seedExternal(env);
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'cancelled')).toBe(false);
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'confirmed')).toBe(false);
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/${id}/status`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      },
      env,
    );
    expect(res.status).toBe(404);
    await expect(
      insertPayment(env.PAWBOOK_DB, TENANT_A, {
        bookingRequestId: id,
        amount: 10,
        method: 'cash',
        paidDate: TODAY,
        note: null,
      }),
    ).resolves.toBeNull(); // match insertPayment's actual "not payable" contract at HEAD
  });

  it('is invisible to delete-detection candidates despite having a GCalEventId', async () => {
    const { env } = createTestEnv();
    await seedExternal(env);
    const ids = await listSyncedBookingIds(
      env.PAWBOOK_DB,
      TENANT_A,
      addDays(TODAY, -1),
      addDays(TODAY, 180),
    );
    expect(ids).toEqual([]);
  });

  it('is purged when the calendar connection is disconnected', async () => {
    const { env } = createTestEnv();
    await seedExternal(env);
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/disconnect',
      { method: 'POST', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(200);
    const { results } = await env.PAWBOOK_DB.prepare(
      "SELECT Id FROM BookingRequests WHERE TenantId = ? AND ServiceType = 'external'",
    )
      .bind(TENANT_A)
      .all();
    expect(results).toEqual([]);
  });
});
