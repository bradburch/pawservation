import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertBookingRequest } from '../db/repo';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

/**
 * A walk that belongs to a series is still an ordinary booking row; the only new thing it carries
 * is the id of the series it came from. Every reader that hands a booking row onward must carry
 * that id (null for a single booking) — a reader that silently drops it would render a series walk
 * as a one-off with nothing to show it is not.
 */

const JESS = 'eu_sp_jess';

const seedSeries = (raw: DatabaseSync, id: string, endUserId: string) =>
  raw
    .prepare(
      `INSERT INTO BookingSeries (Id, TenantId, EndUserId, ServiceType, Weekdays, StartDate, Status, CreatedBy, CreatedAt, UpdatedAt)
       VALUES (?, ?, ?, 'walk', 2, '2030-01-01', 'active', 'client', 'x', 'x')`,
    )
    .run(id, TENANT_A, endUserId);

/** One single booking and one series walk for Jess under sunny-paws; returns their ids. */
async function seedSingleAndWalk(env: Env, raw: DatabaseSync) {
  seedSeries(raw, 's1', JESS);
  const single = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
    endUserId: JESS,
    serviceType: 'walk',
    startDate: '2030-01-01',
    endDate: null,
    optionKey: null,
    petCount: 1,
    estCost: 2500,
    status: 'pending',
  });
  const walk = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
    endUserId: JESS,
    serviceType: 'walk',
    startDate: '2030-01-08',
    endDate: null,
    optionKey: null,
    petCount: 1,
    estCost: 2500,
    status: 'confirmed',
    seriesId: 's1',
  });
  return { single, walk };
}

type Row = { id: string; seriesId?: string | null } & Record<string, unknown>;

describe('SeriesId plumbing', () => {
  it('insertBookingRequest stores seriesId with SyncPending 0 (a walk never syncs as its own event), and a single booking with SyncPending 1', async () => {
    const { env, raw } = createTestEnv();
    const { single, walk } = await seedSingleAndWalk(env, raw);
    const row = (id: string) => ({
      ...(raw
        .prepare('SELECT SeriesId, SyncPending FROM BookingRequests WHERE Id = ?')
        .get(id) as object),
    });
    expect(row(single)).toEqual({ SeriesId: null, SyncPending: 1 });
    expect(row(walk)).toEqual({ SeriesId: 's1', SyncPending: 0 });
  });

  it('/bookings/mine and /admin/bookings carry seriesId on every row (null for a single booking)', async () => {
    const { env, raw } = createTestEnv();
    const { single, walk } = await seedSingleAndWalk(env, raw);

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const mineRes = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(mineRes.status).toBe(200);
    const mine = ((await mineRes.json()) as { bookings: Row[] }).bookings;

    const adminRes = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(adminRes.status).toBe(200);
    const admin = ((await adminRes.json()) as { bookings: Row[] }).bookings;

    for (const list of [mine, admin]) {
      expect(list.length).toBeGreaterThan(2);
      for (const b of list) expect(b).toHaveProperty('seriesId');
      const byId = new Map(list.map((b) => [b.id, b]));
      expect(byId.get(single)!.seriesId).toBeNull();
      expect(byId.get(walk)!.seriesId).toBe('s1');
      // The seeded rows predate series entirely: every one of them is a single booking.
      for (const b of list.filter((r) => r.id.startsWith('seed_'))) expect(b.seriesId).toBeNull();
    }
  });

  it('a plain booking list gains seriesId and no projected or skipped key', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const { bookings } = (await res.json()) as { bookings: Row[] };
    expect(bookings.length).toBeGreaterThan(0);
    for (const b of bookings) {
      expect(b.seriesId).toBeNull();
      expect(Object.keys(b)).not.toContain('projected');
      expect(Object.keys(b)).not.toContain('skipped');
    }
  });
});
