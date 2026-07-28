import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  chunkArray,
  deleteExternalEventsMissing,
  insertPayment,
  listSyncedBookingIds,
  listUnsyncedFutureBookings,
  updateBookingStatus,
} from '../db/repo';
import { rowsToCapacityEvents } from '../lib/availability';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
const EXT_START = addDays(TODAY, 40);
const EXT_END = addDays(TODAY, 43); // exclusive

/** Seed a materialized external row the way the reconciler will write it. */
async function seedExternal(
  env: Env,
  opts?: { start?: string; end?: string; status?: string; gcalEventId?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.PAWBOOK_DB.prepare(
    `INSERT INTO BookingRequests
       (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount,
        EstCost, GCalEventId, ExternalSummary, Status, SyncPending)
     VALUES (?, ?, NULL, 'external', ?, ?, NULL, 1, NULL, ?, 'Neighbor stay — Rex', ?, 0)`,
  )
    .bind(
      id,
      TENANT_A,
      opts?.start ?? EXT_START,
      opts?.end ?? EXT_END,
      opts?.gcalEventId === undefined ? `gev_${id.slice(0, 8)}` : opts.gcalEventId,
      opts?.status ?? 'confirmed',
    )
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

  it('cannot be declined — the ServiceType guard alone blocks it, isolated from the Status=pending precondition', async () => {
    const { env } = createTestEnv();
    // 'declined' is only ever valid from Status='pending' — seed pending explicitly so a false
    // pass can't be explained by the Status guard instead of the ServiceType one under test.
    const id = await seedExternal(env, { status: 'pending' });
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'declined')).toBe(false);
  });

  it('is excluded from calendar backfill candidates by ServiceType, not incidentally by GCalEventId', async () => {
    const { env } = createTestEnv();
    // A real materialized row always carries a GCalEventId, which alone would already exclude it
    // from listUnsyncedFutureBookings (GCalEventId IS NULL). Seed one WITHOUT a GCalEventId to
    // prove the ServiceType exclusion added alongside 'blocked' is what actually guards backfill.
    const id = await seedExternal(env, { gcalEventId: null });
    const rows = await listUnsyncedFutureBookings(env.PAWBOOK_DB, TENANT_A, TODAY, 200);
    expect(rows.find((r) => r.Id === id)).toBeUndefined();
  });
});

/** Spies on every `db.prepare(...)` call matching the chunked-DELETE SQL and records how many
 * params each `.bind(...)` call receives. The D1-param-cap regression this section guards
 * against would show up as a single bind count exceeding ~91 (90 ids + 1 tenantId). */
function spyOnDeleteBindCounts(env: Env): number[] {
  const bindCounts: number[] = [];
  const original = env.PAWBOOK_DB.prepare.bind(env.PAWBOOK_DB);
  vi.spyOn(env.PAWBOOK_DB, 'prepare').mockImplementation((sql: string) => {
    const stmt = original(sql);
    if (!sql.includes('DELETE FROM BookingRequests WHERE TenantId = ? AND Id IN')) return stmt;
    const rawBind = stmt.bind.bind(stmt);
    return {
      ...stmt,
      bind: (...args: unknown[]) => {
        bindCounts.push(args.length);
        return rawBind(...args);
      },
    } as unknown as D1PreparedStatement;
  });
  return bindCounts;
}

describe('deleteExternalEventsMissing — D1 100-bound-parameter cap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('chunkArray never produces a group larger than `size`', () => {
    const items = Array.from({ length: 205 }, (_, i) => `id_${i}`);
    const chunks = chunkArray(items, 90);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.length)).toEqual([90, 90, 25]);
    expect(chunks.flat()).toEqual(items); // no items dropped or reordered
  });

  it('chunkArray of an empty array yields no chunks', () => {
    expect(chunkArray([], 90)).toEqual([]);
  });

  it('deletes the correct stale rows when the live set is far larger than the old ~97-id cap', async () => {
    const { env } = createTestEnv();
    // 150 "live" ids (well past the old NOT-IN-bound-parameter breaking point) plus 50 stale rows
    // that must be deleted. Every prepared DELETE this call issues is spied on below to prove no
    // single statement's bind count can approach D1's 100-param cap.
    const liveIds = Array.from({ length: 150 }, (_, i) => `gev_live_${i}`);
    for (const gcalEventId of liveIds) {
      await seedExternal(env, { gcalEventId });
    }
    const staleIds = Array.from({ length: 50 }, (_, i) => `gev_stale_${i}`);
    for (const gcalEventId of staleIds) {
      await seedExternal(env, { gcalEventId });
    }

    const bindCounts = spyOnDeleteBindCounts(env);
    const deleted = await deleteExternalEventsMissing(
      env.PAWBOOK_DB,
      TENANT_A,
      addDays(TODAY, -1),
      addDays(TODAY, 180),
      liveIds,
    );

    expect(deleted).toBe(50);
    // At least one DELETE ran (the 50 stale ids fit one 90-sized chunk), and no statement bound
    // more than DELETE_CHUNK_SIZE (90) ids + 1 tenantId — safely under D1's 100-param cap.
    expect(bindCounts.length).toBeGreaterThan(0);
    for (const count of bindCounts) expect(count).toBeLessThanOrEqual(91);

    const remaining = await env.PAWBOOK_DB.prepare(
      "SELECT GCalEventId FROM BookingRequests WHERE TenantId = ? AND ServiceType = 'external' ORDER BY GCalEventId",
    )
      .bind(TENANT_A)
      .all<{ GCalEventId: string }>();
    expect(remaining.results.map((r) => r.GCalEventId).sort()).toEqual([...liveIds].sort());
  });

  it('chunks a DELETE across multiple statements when stale rows exceed one chunk', async () => {
    const { env } = createTestEnv();
    // 200 stale external rows spread across the window, none reported live — forces 3 DELETE
    // statements at DELETE_CHUNK_SIZE=90 (90 + 90 + 20).
    for (let i = 0; i < 200; i++) {
      await seedExternal(env, {
        gcalEventId: `gev_stale_${i}`,
        start: addDays(TODAY, 40 + (i % 100)),
        end: addDays(TODAY, 41 + (i % 100)),
      });
    }

    const bindCounts = spyOnDeleteBindCounts(env);
    const deleted = await deleteExternalEventsMissing(
      env.PAWBOOK_DB,
      TENANT_A,
      addDays(TODAY, -1),
      addDays(TODAY, 180),
      [],
    );

    expect(deleted).toBe(200);
    expect(bindCounts).toHaveLength(3);
    for (const count of bindCounts) expect(count).toBeLessThanOrEqual(91);
    expect(bindCounts.reduce((a, b) => a + b - 1, 0)).toBe(200); // -1 per chunk for the tenantId param
  });
});
