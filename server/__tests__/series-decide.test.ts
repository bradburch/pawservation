import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import app from '../index';
import {
  armSeriesSync,
  confirmSeriesRowsStatement,
  declineSeriesRowsStatement,
  setSeriesStatusStatement,
} from '../db/repo';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import {
  adminHeaders,
  clearSeededBookings,
  createTestEnv,
  endUserToken,
  futureWeekday,
  TENANT_A,
  TENANT_B,
} from './helpers';

/**
 * One decision for the whole series: `POST /api/:slug/admin/series/:id/status` confirms or
 * declines every pending walk of a client's repeating request at once, guarded by `ifVersion`; and
 * a walk of a series still pending refuses its own answer (`decide_series`).
 *
 * Dates are relative to the real clock (the routes read `tenantToday`). Sunny Paws' `walk` / `d30`
 * is 2000 cents a walk with no slot cap seeded; Jess (eu_sp_jess) has Bella and Mochi. Happy Tails
 * is TENANT_B, whose admin must never reach Sunny Paws' series.
 */

const TODAY = () => getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

type Wire = {
  id: string;
  status: string;
  version: number;
  endUserId: string;
  customerName: string | null;
  pattern: string;
  walks: { id: string; date: string; status: string; projected: boolean }[];
  notified: boolean;
  overbookedDates: string[];
};

const RESEND = {
  RESEND_API_KEY: 'k',
  RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
  RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
};

async function world() {
  const { env, raw } = createTestEnv();
  await clearSeededBookings(env);
  await clearSeededBookings(env, TENANT_B);
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return { env, raw, token };
}

const json = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

/** A Tuesday-and-Thursday series for Bella, requested by Jess — pending, with rows to the window. */
async function seedSeries(env: Env, token: string): Promise<string> {
  const res = await app.request(
    '/api/sunny-paws/series',
    {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({
        type: 'walk',
        optionKey: 'd30',
        petIds: ['pet_sp_bella'],
        weekdays: ['tuesday', 'thursday'],
        startDate: futureWeekday(1, 14),
        endDate: null,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function decide(
  env: Env,
  id: string,
  body: unknown,
  tenantId = TENANT_A,
  slug = 'sunny-paws',
) {
  return app.request(
    `/api/${slug}/admin/series/${id}/status`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(tenantId)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function answerRow(env: Env, rowId: string, body: unknown) {
  return app.request(
    `/api/sunny-paws/admin/bookings/${rowId}/status`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

const seriesOf = (raw: DatabaseSync, id: string) =>
  raw.prepare(`SELECT Status, Version, SyncPending FROM BookingSeries WHERE Id = ?`).get(id) as {
    Status: string;
    Version: number;
    SyncPending: number;
  };

const rowsOf = (raw: DatabaseSync, id: string) =>
  raw
    .prepare(
      `SELECT Id, StartDate, Status, SyncPending FROM BookingRequests WHERE SeriesId = ? ORDER BY StartDate`,
    )
    .all(id) as { Id: string; StartDate: string; Status: string; SyncPending: number }[];

const statusCounts = (raw: DatabaseSync, id: string) => {
  const out: Record<string, number> = {};
  for (const r of rowsOf(raw, id)) out[r.Status] = (out[r.Status] ?? 0) + 1;
  return out;
};

describe('POST /api/:slug/admin/series/:id/status — one decision for the whole series', () => {
  it('confirm flips the series active and every pending row confirmed in one batch, and bumps Version', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    const rows = rowsOf(raw, id);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.every((r) => r.Status === 'pending')).toBe(true);
    const batches: number[] = [];
    const db = env.PAWSERVATION_DB;
    const spying = {
      ...env,
      PAWSERVATION_DB: {
        prepare: (sql: string) => db.prepare(sql),
        batch: (statements: D1PreparedStatement[]) => {
          batches.push(statements.length);
          return db.batch(statements);
        },
      },
    } as unknown as Env;

    const res = await decide(spying, id, { status: 'confirmed', ifVersion: 1 });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as Wire;
    expect(wire).toMatchObject({
      id,
      status: 'active',
      version: 2,
      endUserId: 'eu_sp_jess',
      customerName: 'Jess Demo',
      notified: false,
      overbookedDates: [],
    });
    expect(wire.walks.filter((w) => !w.projected).every((w) => w.status === 'confirmed')).toBe(
      true,
    );
    expect(batches).toEqual([2]);
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'active', Version: 2 });
    expect(statusCounts(raw, id)).toEqual({ confirmed: rows.length });
    // A series row is never armed on its own — the series carries the calendar.
    expect(rowsOf(raw, id).every((r) => r.SyncPending === 0)).toBe(true);
  });

  it('decline declines every pending row and the series', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    const n = rowsOf(raw, id).length;
    const res = await decide(env, id, { status: 'declined', ifVersion: 1 });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as Wire;
    expect(wire).toMatchObject({ status: 'declined', version: 2, overbookedDates: [] });
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'declined', Version: 2 });
    expect(statusCounts(raw, id)).toEqual({ declined: n });
  });

  it('a stale ifVersion is 409 series_changed and changes nothing', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    raw.prepare(`UPDATE BookingSeries SET Version = 3 WHERE Id = ?`).run(id);
    const n = rowsOf(raw, id).length;
    const res = await decide(env, id, { status: 'confirmed', ifVersion: 2 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('series_changed');
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'pending', Version: 3 });
    expect(statusCounts(raw, id)).toEqual({ pending: n });
  });

  it('a version that moves between the read and the batch is 409 series_changed, and the rows statement writes nothing', async () => {
    // The CAS is the batch's first statement; every row statement after it is guarded on the
    // version the CAS would have written. Moving the version just before the batch runs is a lost
    // race: the CAS changes nothing, and so must the rows statement.
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    const n = rowsOf(raw, id).length;
    const db = env.PAWSERVATION_DB;
    const racing = {
      ...env,
      PAWSERVATION_DB: {
        prepare: (sql: string) => db.prepare(sql),
        batch: (statements: D1PreparedStatement[]) => {
          // Another writer lands first, moving the version on to exactly what the CAS would write.
          raw.prepare(`UPDATE BookingSeries SET Version = Version + 1 WHERE Id = ?`).run(id);
          return db.batch(statements);
        },
      },
    } as unknown as Env;
    const res = await decide(racing, id, { status: 'confirmed', ifVersion: 1 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('series_changed');
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'pending', Version: 2 });
    expect(statusCounts(raw, id)).toEqual({ pending: n });
  });

  it('missing ifVersion is 400 if_version_required', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    for (const body of [{ status: 'confirmed' }, { status: 'confirmed', ifVersion: '1' }]) {
      const res = await decide(env, id, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('if_version_required');
    }
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'pending', Version: 1 });
  });

  it('a status other than confirmed or declined is 400 and changes nothing', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    const res = await decide(env, id, { status: 'cancelled', ifVersion: 1 });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_status');
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'pending', Version: 1 });
  });

  it('a series that is not pending is 409 series_not_pending', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    expect((await decide(env, id, { status: 'confirmed', ifVersion: 1 })).status).toBe(200);
    const res = await decide(env, id, { status: 'declined', ifVersion: 2 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('series_not_pending');
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'active', Version: 2 });
  });

  it('an unknown series is 404', async () => {
    const { env } = await world();
    const res = await decide(env, 'no-such-series', { status: 'confirmed', ifVersion: 1 });
    expect(res.status).toBe(404);
  });

  it('confirm over capacity without overrideCapacity is 409 requiresOverride with dates[]; with it, confirms and the body names the dates', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    const rows = rowsOf(raw, id);
    const date = rows[2].StartDate;
    // A single walk for Mochi on one of the series' dates, confirmed by the sitter — committed.
    const single = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({
          type: 'walk',
          optionKey: 'd30',
          startDate: date,
          petIds: ['pet_sp_mochi'],
          answers: {},
        }),
      },
      env,
    );
    expect(single.status).toBe(201);
    const singleId = ((await single.json()) as { id: string }).id;
    expect((await answerRow(env, singleId, { status: 'confirmed' })).status).toBe(200);
    // …and a single walk still PENDING on another series date, which committed-only ignores.
    const pendingDate = rows[4].StartDate;
    const pending = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({
          type: 'walk',
          optionKey: 'd30',
          startDate: pendingDate,
          petIds: ['pet_sp_mochi'],
          answers: {},
        }),
      },
      env,
    );
    expect(pending.status).toBe(201);
    // Only now does the slot hold one: the series' own pending rows fill every other date, and
    // they must not count against themselves.
    raw.exec(`UPDATE TenantServiceOptions SET Capacity = 1 WHERE Id = 'opt_sp_walk30'`);

    const refused = await decide(env, id, { status: 'confirmed', ifVersion: 1 });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      code: string;
      requiresOverride: boolean;
      dates: string[];
      error: string;
    };
    expect(body).toMatchObject({
      code: 'capacity_conflict',
      requiresOverride: true,
      dates: [date],
    });
    expect(body.error).not.toContain('$');
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'pending', Version: 1 });
    expect(statusCounts(raw, id)).toEqual({ pending: rows.length });

    const forced = await decide(env, id, {
      status: 'confirmed',
      ifVersion: 1,
      overrideCapacity: true,
    });
    expect(forced.status).toBe(200);
    expect((await forced.json()) as Wire).toMatchObject({
      status: 'active',
      overbookedDates: [date],
    });
    expect(statusCounts(raw, id)).toEqual({ confirmed: rows.length });
  });

  it('decline never runs the capacity warning', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    raw.exec(`UPDATE TenantServiceOptions SET Capacity = 0 WHERE Id = 'opt_sp_walk30'`);
    const res = await decide(env, id, { status: 'declined', ifVersion: 1 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Wire).overbookedDates).toEqual([]);
  });

  it('the series is re-armed for the calendar (SyncPending 1)', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    raw.prepare(`UPDATE BookingSeries SET SyncPending = 0 WHERE Id = ?`).run(id);
    expect((await decide(env, id, { status: 'confirmed', ifVersion: 1 })).status).toBe(200);
    expect(seriesOf(raw, id).SyncPending).toBe(1);
  });

  it("TENANT_B's admin cannot decide TENANT_A's series", async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    const n = rowsOf(raw, id).length;
    const res = await decide(
      env,
      id,
      { status: 'confirmed', ifVersion: 1 },
      TENANT_B,
      'happy-tails',
    );
    expect(res.status).toBe(404);
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'pending', Version: 1 });
    expect(statusCounts(raw, id)).toEqual({ pending: n });
  });

  it("the statements never touch another tenant's series, its rows or its sync flag", async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    raw.prepare(`UPDATE BookingSeries SET SyncPending = 0 WHERE Id = ?`).run(id);
    const n = rowsOf(raw, id).length;
    const db = env.PAWSERVATION_DB;
    await armSeriesSync(db, TENANT_B, id);
    const results = await db.batch([
      setSeriesStatusStatement(db, TENANT_B, id, ['pending'], 'active', 1),
    ]);
    expect((results[0].meta as { changes: number }).changes).toBe(0);
    // Even with the series already at the guarded version and status, the other tenant's id moves
    // no row.
    raw.prepare(`UPDATE BookingSeries SET Version = 2, Status = 'active' WHERE Id = ?`).run(id);
    await db.batch([confirmSeriesRowsStatement(db, TENANT_B, id, 2)]);
    raw.prepare(`UPDATE BookingSeries SET Status = 'declined' WHERE Id = ?`).run(id);
    await db.batch([declineSeriesRowsStatement(db, TENANT_B, id, 2)]);
    expect(seriesOf(raw, id)).toMatchObject({ SyncPending: 0 });
    expect(statusCounts(raw, id)).toEqual({ pending: n });
  });
});

describe('a walk of a series, answered on its own', () => {
  it('a row of a pending series refuses its own status change decide_series', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    const row = rowsOf(raw, id)[0];
    for (const status of ['confirmed', 'declined', 'cancelled']) {
      const res = await answerRow(env, row.Id, { status, overrideCapacity: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This walk belongs to a repeating request — confirm or decline the whole series.',
        code: 'decide_series',
      });
    }
    expect(rowsOf(raw, id)[0].Status).toBe('pending');
    expect(seriesOf(raw, id)).toMatchObject({ Status: 'pending', Version: 1 });
  });

  it('a row of an active series can be cancelled on its own (one week) and re-arms the series sync', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    expect((await decide(env, id, { status: 'confirmed', ifVersion: 1 })).status).toBe(200);
    raw.prepare(`UPDATE BookingSeries SET SyncPending = 0 WHERE Id = ?`).run(id);
    const [first, ...rest] = rowsOf(raw, id);
    const res = await answerRow(env, first.Id, { status: 'cancelled' });
    expect(res.status).toBe(200);
    const after = rowsOf(raw, id);
    expect(after[0]).toMatchObject({ Status: 'cancelled', SyncPending: 0 });
    expect(after.slice(1).every((r) => r.Status === 'confirmed')).toBe(true);
    expect(after).toHaveLength(rest.length + 1);
    expect(seriesOf(raw, id).SyncPending).toBe(1);
  });

  it('a single booking (no series) is answered as before', async () => {
    const { env, token } = await world();
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: json(token),
        body: JSON.stringify({
          type: 'walk',
          optionKey: 'd30',
          startDate: addDays(TODAY(), 10),
          petIds: ['pet_sp_mochi'],
          answers: {},
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const singleId = ((await res.json()) as { id: string }).id;
    expect((await answerRow(env, singleId, { status: 'declined' })).status).toBe(200);
  });
});

describe('the client is told once', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the client is emailed once for the series, not per row', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    expect(rowsOf(raw, id).length).toBeGreaterThan(1);
    // Email is configured only now, so the sitter's request notice never reaches the spy.
    Object.assign(env, RESEND);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await decide(env, id, { status: 'confirmed', ifVersion: 1 });
    expect(res.status).toBe(200);
    const wire = (await res.json()) as Wire;
    expect(wire.notified).toBe(true);
    const mail = spy.mock.calls
      .filter((c) => String(c[0]).includes('api.resend.com'))
      .map((c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, string>);
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe('jess@example.com');
    expect(mail[0].subject).toBe('Your repeating booking with Sunny Paws was confirmed');
    expect(mail[0].text).toContain(wire.pattern);
    expect(mail[0].text).not.toContain('$');
  });

  it('a failed send still decides, and says the client was not told', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, token);
    Object.assign(env, RESEND);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }));
    const res = await decide(env, id, { status: 'declined', ifVersion: 1 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Wire).notified).toBe(false);
    expect(seriesOf(raw, id).Status).toBe('declined');
  });
});
