import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import app from '../index';
import { createTestEnv, endUserToken, TENANT_A } from './helpers';
import { addDays, buildCapacity, rangeHasConflict } from '../../src/shared/index.js';
import type { CapacityRequest } from '../../src/shared/index.js';
import { listCapacityRows } from '../db/repo';
import { rowsToCapacityEvents, type MonthDay } from '../lib/availability';

/**
 * sql/seed-demo.sql — the lived-in demo seed. Its whole point is that the demo tenants show a
 * calendar a working sitter would recognise: bookings against every enabled service, and days the
 * widget paints `partial`/`unavailable` rather than an unbroken wall of green.
 *
 * A conflict the capacity engine does not actually see is worse than no conflict at all, so these
 * assertions go through the SAME paths the widget and the sitter do — the real
 * `/availability/month` route, and the real capacity engine over `listCapacityRows` — never a
 * re-derivation of the rules inside the test.
 *
 * Every date is read back OUT of the row that carries it (the seed writes them with
 * `date('now', '+N days')`), so the test asserts on the dates the seed actually produced and
 * cannot drift from them, whatever day it runs.
 */

type Row = { StartDate: string; EndDate: string | null };

const bookingDates = (raw: DatabaseSync, id: string): Row =>
  raw.prepare(`SELECT StartDate, EndDate FROM BookingRequests WHERE Id = ?`).get(id) as Row;

/** The widget's own month-grid call, for the month containing `date`. */
async function dayStatus(
  env: Env,
  token: string,
  slug: string,
  serviceType: string,
  date: string,
  optionKey?: string,
): Promise<MonthDay> {
  const query = new URLSearchParams({ type: serviceType, month: date.slice(0, 7) });
  if (optionKey) query.set('option', optionKey);
  const res = await app.request(
    `/api/${slug}/availability/month?${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { days: MonthDay[] };
  return body.days.find((d) => d.date === date)!;
}

/** Every date in [start, endExclusive). */
const daysIn = (start: string, endExclusive: string): string[] => {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
};

describe('sql/seed-demo.sql — shape', () => {
  it('gives every enabled service of every tenant at least one booking', () => {
    const { raw } = createTestEnv({ demoActivity: true });
    const idle = raw
      .prepare(
        `SELECT s.TenantId, s.ServiceType FROM TenantServices s
          WHERE s.Enabled = 1
            AND NOT EXISTS (SELECT 1 FROM BookingRequests b
                             WHERE b.TenantId = s.TenantId AND b.ServiceType = s.ServiceType)`,
      )
      .all();
    expect(idle).toEqual([]);
  });

  it('mixes pending and confirmed work into every tenant', () => {
    const { raw } = createTestEnv({ demoActivity: true });
    for (const tenantId of ['tnt_sunnypaws', 'tnt_happytails', 'tnt_pawsandrelax']) {
      const counts = raw
        .prepare(
          `SELECT Status, COUNT(*) AS n FROM BookingRequests
            WHERE TenantId = ? AND ServiceType NOT IN ('blocked', 'external') GROUP BY Status`,
        )
        .all(tenantId) as { Status: string; n: number }[];
      const byStatus = new Map(counts.map((c) => [c.Status, c.n]));
      expect(byStatus.get('pending') ?? 0).toBeGreaterThan(0);
      expect(byStatus.get('confirmed') ?? 0).toBeGreaterThan(0);
    }
  });

  it('books ONE pet at a time, and every booking names the pet its owner owns', () => {
    // The demo-only rows are the difference between the two fixtures, so this stays true as the
    // seed grows without anyone having to re-list ids here.
    const ids = (raw: DatabaseSync) =>
      (raw.prepare(`SELECT Id FROM BookingRequests`).all() as { Id: string }[]).map((r) => r.Id);
    const base = new Set(ids(createTestEnv().raw));
    const { raw } = createTestEnv({ demoActivity: true });
    const demoOnly = ids(raw).filter((id) => !base.has(id));
    expect(demoOnly.length).toBeGreaterThan(20);

    for (const id of demoOnly) {
      const row = raw
        .prepare(`SELECT ServiceType, EndUserId, PetCount FROM BookingRequests WHERE Id = ?`)
        .get(id) as { ServiceType: string; EndUserId: string | null; PetCount: number };
      // A set of 2+ pets with no stored pet-set rate is REFUSED at pricing (`unpriced_pet_set`),
      // and a demo that shows an unpriceable booking is a bad demo.
      expect({ id, petCount: row.PetCount }).toEqual({ id, petCount: 1 });
      if (row.ServiceType === 'blocked') {
        expect({ id, endUserId: row.EndUserId }).toEqual({ id, endUserId: null });
        continue;
      }
      // Pet references flow through BookingRequestPets -> EndUserPets, and PetOwners is the
      // authority on who may see/book that pet.
      const owned = raw
        .prepare(
          `SELECT COUNT(*) AS n FROM BookingRequestPets brp
             JOIN PetOwners po ON po.PetId = brp.PetId
            WHERE brp.BookingRequestId = ? AND po.EndUserId = ?`,
        )
        .get(id, row.EndUserId) as { n: number };
      expect({ id, ownedPets: owned.n }).toEqual({ id, ownedPets: 1 });
    }
  });

  it('respects the weekday-only custom service (`weekday N` modifier, not a fixed date)', () => {
    const { raw } = createTestEnv({ demoActivity: true });
    // opt_sp_mw30 is WeekdaysOnly=1: the server rejects a weekend morning walk, so seeded ones
    // that landed on a Saturday would be data the app itself would refuse to create.
    const weekendMorningWalks = raw
      .prepare(
        `SELECT Id, StartDate FROM BookingRequests
          WHERE ServiceType = 'morning-walk' AND strftime('%w', StartDate) IN ('0', '6')`,
      )
      .all();
    expect(weekendMorningWalks).toEqual([]);
    expect(
      raw
        .prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE ServiceType = 'morning-walk'`)
        .get(),
    ).toEqual({ n: 2 });
  });

  it('is idempotent — applying it twice leaves the same rows', () => {
    const { raw } = createTestEnv({ demoActivity: true });
    const snapshot = () =>
      JSON.stringify([
        raw.prepare(`SELECT * FROM BookingRequests ORDER BY Id`).all(),
        raw.prepare(`SELECT * FROM BookingRequestPets ORDER BY BookingRequestId, PetId`).all(),
        raw.prepare(`SELECT Id, TenantId, Email, Name, Status FROM EndUsers ORDER BY Id`).all(),
        raw
          .prepare(`SELECT Id, TenantId, EndUserId, Name, PetType FROM EndUserPets ORDER BY Id`)
          .all(),
        raw.prepare(`SELECT * FROM PetOwners ORDER BY PetId, EndUserId`).all(),
      ]);
    const before = snapshot();
    raw.exec(readFileSync(join(import.meta.dirname, '..', '..', 'sql', 'seed-demo.sql'), 'utf8'));
    expect(snapshot()).toBe(before);
  });
});

describe('sql/seed-demo.sql — the conflicts are real', () => {
  it('Sunny Paws: the over-booked boarding week paints unavailable, its shoulders partial', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const a = bookingDates(raw, 'seed_sp_board_a'); // now+5 .. now+12, confirmed
    const b = bookingDates(raw, 'seed_sp_board_b'); // now+7 .. now+11, confirmed

    // Two 1-pet stays overlap: MaxConcurrentPets=2 is reached (and the pending third pushes the
    // middle two days past it), so every night b occupies is closed.
    for (const date of daysIn(b.StartDate, b.EndDate!)) {
      const day = await dayStatus(env, token, 'sunny-paws', 'boarding', date);
      expect({ date, status: day.status, max: day.max }).toEqual({
        date,
        status: 'unavailable',
        max: 2,
      });
      expect(day.used).toBeGreaterThanOrEqual(2);
    }

    // Shoulders: one pet in a two-pet pool.
    for (const date of [...daysIn(a.StartDate, b.StartDate), b.EndDate!]) {
      const day = await dayStatus(env, token, 'sunny-paws', 'boarding', date);
      expect({ date, status: day.status, used: day.used }).toEqual({
        date,
        status: 'partial',
        used: 1,
      });
    }

    // Checkout day is free — EndDate is exclusive, there is no overnight on it.
    const after = await dayStatus(env, token, 'sunny-paws', 'boarding', a.EndDate!);
    expect(after.status).toBe('available');
  });

  it('Sunny Paws: the pending request over those dates really is in conflict', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const c = bookingDates(raw, 'seed_sp_board_c');
    const status = raw
      .prepare(`SELECT Status FROM BookingRequests WHERE Id = 'seed_sp_board_c'`)
      .get() as { Status: string };
    expect(status.Status).toBe('pending');

    const request: CapacityRequest = {
      serviceType: 'boarding',
      kind: 'boarding',
      cap: 2, // Sunny Paws boarding MaxConcurrentPets
      petCount: 1,
    };
    // Exactly what the sitter's confirm path asks: is there room for this booking, ignoring the
    // booking itself? Bookend sharing does not rescue it — its endpoints are interior days of two
    // already-confirmed stays, and the day after is full too.
    const rows = await listCapacityRows(
      env.PAWBOOK_DB,
      TENANT_A,
      c.StartDate,
      addDays(c.EndDate!, 1),
      'seed_sp_board_c',
    );
    const capacity = buildCapacity(rowsToCapacityEvents(rows));
    expect(rangeHasConflict(c.StartDate, c.EndDate!, request, capacity)).toBe(true);

    // Control: the same request four weeks later is fine, so the `true` above comes from the
    // seeded rows and not from a mis-built request.
    const clearStart = addDays(c.StartDate, 60);
    const clearEnd = addDays(c.EndDate!, 60);
    const clearRows = await listCapacityRows(
      env.PAWBOOK_DB,
      TENANT_A,
      clearStart,
      addDays(clearEnd, 1),
    );
    expect(
      rangeHasConflict(
        clearStart,
        clearEnd,
        request,
        buildCapacity(rowsToCapacityEvents(clearRows)),
      ),
    ).toBe(false);
  });

  it('Happy Tails: four nested stays plus a pending one fill the 4-pet pool', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const a = bookingDates(raw, 'seed_ht_board_a'); // now+14 .. now+21
    const b = bookingDates(raw, 'seed_ht_board_b'); // now+15 .. now+20
    const c = bookingDates(raw, 'seed_ht_board_c'); // now+16 .. now+19

    for (const date of daysIn(c.StartDate, c.EndDate!)) {
      const day = await dayStatus(env, token, 'happy-tails', 'boarding', date);
      expect({ date, status: day.status, max: day.max }).toEqual({
        date,
        status: 'unavailable',
        max: 4,
      });
      expect(day.used).toBeGreaterThanOrEqual(4);
    }
    for (const date of [...daysIn(a.StartDate, c.StartDate), c.EndDate!, b.EndDate!]) {
      const day = await dayStatus(env, token, 'happy-tails', 'boarding', date);
      expect({ date, status: day.status }).toEqual({ date, status: 'partial' });
    }
  });

  it('a blocked stretch closes every service, and reopens on its exclusive end date', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const block = bookingDates(raw, 'seed_sp_block2');

    for (const date of daysIn(block.StartDate, block.EndDate!)) {
      // Boarding draws on a pool; walks are block-only. A blocked day stops both.
      for (const serviceType of ['boarding', 'walk']) {
        const day = await dayStatus(env, token, 'sunny-paws', serviceType, date);
        expect({ serviceType, date, status: day.status }).toEqual({
          serviceType,
          date,
          status: 'unavailable',
        });
      }
    }
    const reopens = await dayStatus(env, token, 'sunny-paws', 'walk', block.EndDate!);
    expect(reopens.status).toBe('available');
  });

  it('Happy Tails: the 3-dog group walk sells out for that option only', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const { StartDate } = bookingDates(raw, 'seed_ht_grp_a');

    const full = await dayStatus(env, token, 'happy-tails', 'walk', StartDate, 'group-8-9');
    expect(full.status).toBe('unavailable');
    // The slot is full, not the day: a different walk option on the same date is still open.
    const open = await dayStatus(env, token, 'happy-tails', 'walk', StartDate, 'd30');
    expect(open.status).toBe('available');
  });
});
