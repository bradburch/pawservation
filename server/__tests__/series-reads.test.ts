import { describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import app from '../index';
import { projectionCap } from '../lib/series-rule';
import { addDays, addMonths, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
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
 * Every walk is a booking, for any range asked. The series reads (`/series/mine`, `/admin/series`,
 * `/admin/series/:id`) and the projection arm of both booking lists, through `app.request`.
 *
 * Dates are relative to the real clock (the routes read `tenantToday`). Sunny Paws' `walk` / `d30`
 * is 2000 cents a walk with a 12-month booking window (MaxAdvanceMonths NULL); Jess (eu_sp_jess)
 * owns Bella. U3 is Happy Tails' Jess — the same email under another sitter.
 */

const TODAY = () => getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
const WINDOW_END = () => addMonths(TODAY(), 12);

type Row = Record<string, unknown> & { id: string; startDate: string; seriesId: string | null };
type WireWalk = {
  id: string;
  date: string;
  status: string;
  projected: boolean;
  estCostCents: number | null;
};
type Wire = {
  id: string;
  status: string;
  version: number;
  endUserId?: string;
  customerName?: string | null;
  walks: WireWalk[];
  skips: { date: string; reason: string; words: string }[];
};

/** The client list's row keys before series existed, plus `seriesId` — and nothing else. */
const MINE_KEYS = [
  'id',
  'type',
  'startDate',
  'endDate',
  'startTime',
  'departureTime',
  'optionKey',
  'petIds',
  'petCount',
  'pets',
  'answers',
  'estCostCents',
  'charges',
  'chargesTotalCents',
  'cancellationFeeCents',
  'cancellable',
  'editable',
  'feeIfCancelledTodayCents',
  'status',
  'seriesId',
].sort();

async function world() {
  const { env, raw } = createTestEnv();
  await clearSeededBookings(env);
  await clearSeededBookings(env, TENANT_B);
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return { env, raw, token };
}

const get = (env: Env, path: string, headers: Record<string, string>) =>
  app.request(path, { headers }, env);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A Tuesday series requested by Jess (pending), optionally activated as the sitter would. */
async function seedSeries(
  env: Env,
  raw: DatabaseSync,
  token: string,
  opts: { active?: boolean; weekdays?: string[] } = {},
): Promise<string> {
  const res = await app.request(
    '/api/sunny-paws/series',
    {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'walk',
        optionKey: 'd30',
        petIds: ['pet_sp_bella'],
        weekdays: opts.weekdays ?? ['tuesday'],
        startDate: futureWeekday(1, 14),
        endDate: null,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  if (opts.active) {
    raw.prepare(`UPDATE BookingSeries SET Status = 'active' WHERE Id = ?`).run(id);
    raw.prepare(`UPDATE BookingRequests SET Status = 'confirmed' WHERE SeriesId = ?`).run(id);
  }
  return id;
}

/** A sitter's offer awaiting the client — seeded directly (the offer route arrives later). */
function seedOffer(
  raw: DatabaseSync,
  id = 'series_offer_1',
  tenantId = TENANT_A,
  endUserId = 'eu_sp_jess',
) {
  raw
    .prepare(
      `INSERT INTO BookingSeries (Id, TenantId, EndUserId, ServiceType, OptionKey, Weekdays, StartDate,
         Status, CreatedBy, OfferExpiresAt, CreatedAt, UpdatedAt)
       VALUES (?, ?, ?, 'walk', 'd30', 4, ?, 'pending_client', 'sitter', ?, datetime('now'), datetime('now'))`,
    )
    .run(id, tenantId, endUserId, addDays(TODAY(), 1), addDays(TODAY(), 7));
  raw
    .prepare(`INSERT INTO BookingSeriesPets (SeriesId, PetId) VALUES (?, ?)`)
    .run(id, tenantId === TENANT_A ? 'pet_sp_bella' : 'pet_ht_otis');
  return id;
}

/** The first date on or after `from` with the given UTC weekday (0 = Sunday). */
function onOrAfter(from: string, weekday: number): string {
  let d = from;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== weekday) d = addDays(d, 1);
  return d;
}

/** The type of a value as a strict parser sees it: null apart from object, arrays apart too. */
const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * A projected row carries every key a real row carries, each with a type a real row can have —
 * so a whole-list-strict reader never drops the list over one projected row. Its only extra keys
 * are `projected` and `skipped`.
 */
function expectSameShape(projected: Row, real: Row, nullable: string[]) {
  const extra = new Set(['projected', 'skipped']);
  expect(
    Object.keys(projected)
      .filter((k) => !extra.has(k))
      .sort(),
  ).toEqual(Object.keys(real).sort());
  for (const k of Object.keys(real)) {
    const p = kind(projected[k]);
    const r = kind(real[k]);
    if (p === r) continue;
    // A key that is null on one side and a value on the other is the same field (a cost, a time).
    expect(nullable.includes(k) && (p === 'null' || r === 'null'), `key ${k}: ${p} vs ${r}`).toBe(
      true,
    );
  }
}

describe('GET /api/:slug/bookings/mine — the projection arm', () => {
  it('mine: a date a year past the window is answered as a confirmed projected booking with a price', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, raw, token, { active: true });
    const target = onOrAfter(addDays(WINDOW_END(), 300), 2);
    const res = await get(
      env,
      `/api/sunny-paws/bookings/mine?from=${target}&to=${addDays(target, 6)}`,
      bearer(token),
    );
    expect(res.status).toBe(200);
    const { bookings } = (await res.json()) as { bookings: Row[] };
    const walk = bookings.find((b) => b.startDate === target);
    expect(walk).toMatchObject({
      id: `series:${id}:${target}`,
      type: 'walk',
      status: 'confirmed',
      projected: true,
      estCostCents: 2000,
      seriesId: id,
      petIds: ['pet_sp_bella'],
      pets: ['Bella'],
      optionKey: 'd30',
      editable: false,
      charges: [],
      chargesTotalCents: 0,
      cancellationFeeCents: null,
    });
    expect(walk).not.toHaveProperty('skipped');
    // from/to bound the projection only: the real rows inside the window are all still there.
    const real = bookings.filter((b) => b.projected === undefined);
    expect(real.length).toBeGreaterThan(40);
    expect(real.every((b) => b.seriesId === id)).toBe(true);
    // Exactly one projected walk in a one-week span of a Tuesday series.
    expect(bookings.filter((b) => b.projected === true)).toHaveLength(1);
    expectSameShape(walk!, real[0], ['estCostCents', 'feeIfCancelledTodayCents', 'startTime']);
  });

  it('mine: without to, no projected walk appears and the body equals the pre-series shape plus seriesId', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, raw, token, { active: true });
    seedOffer(raw);
    for (const path of [
      '/api/sunny-paws/bookings/mine',
      `/api/sunny-paws/bookings/mine?from=${TODAY()}`,
    ]) {
      const { bookings } = (await (await get(env, path, bearer(token))).json()) as {
        bookings: Row[];
      };
      expect(bookings.length).toBeGreaterThan(40);
      for (const b of bookings) {
        expect(Object.keys(b).sort()).toEqual(MINE_KEYS);
        expect(b.id.startsWith('series:')).toBe(false);
        expect(b.seriesId).toBe(id); // the offer has no row, so nothing of it appears
      }
    }
  });

  it('mine: to is capped at 24 months from today', async () => {
    const { env, raw, token } = await world();
    await seedSeries(env, raw, token, { active: true });
    const res = await get(
      env,
      `/api/sunny-paws/bookings/mine?to=${addMonths(TODAY(), 120)}`,
      bearer(token),
    );
    const { bookings } = (await res.json()) as { bookings: Row[] };
    const projected = bookings.filter((b) => b.projected === true).map((b) => b.startDate);
    const cap = projectionCap(TODAY());
    expect(projected.length).toBeGreaterThan(40);
    expect(projected.every((d) => d <= cap)).toBe(true);
    expect(projected.some((d) => d > addDays(cap, -7))).toBe(true);
  });

  it('mine: a recorded skip in the span is a projected row carrying skipped and no figure', async () => {
    const { env, raw, token } = await world();
    // Time off on the first Tuesday of the series, before it is requested: the request records it.
    const first = onOrAfter(futureWeekday(1, 14), 2);
    raw
      .prepare(
        `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, Status)
         VALUES ('off_1', ?, NULL, 'blocked', ?, ?, 1, 'confirmed')`,
      )
      .run(TENANT_A, first, addDays(first, 1));
    const id = await seedSeries(env, raw, token, { active: true });
    const { bookings } = (await (
      await get(env, `/api/sunny-paws/bookings/mine?to=${addDays(first, 1)}`, bearer(token))
    ).json()) as { bookings: Row[] };
    expect(bookings.find((b) => b.startDate === first)).toMatchObject({
      id: `series:${id}:${first}`,
      projected: true,
      skipped: 'time_off',
      estCostCents: null,
      cancellable: false,
      feeIfCancelledTodayCents: null,
    });
  });
});

describe('GET /api/:slug/admin/bookings — the projection arm', () => {
  it('admin bookings with to: projected rows carry paidTotalCents 0, charges [], chargesTotalCents 0', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, raw, token, { active: true });
    // One single booking, so the comparison against a single row below has a row to compare with:
    // rows are listed whatever the range, so a near date shows in a list asked for a far one.
    const booked = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'walk',
          optionKey: 'd30',
          startDate: addDays(TODAY(), 9),
          petIds: ['pet_sp_mochi'],
          answers: {},
        }),
      },
      env,
    );
    expect(booked.status).toBe(201);
    const target = onOrAfter(addDays(WINDOW_END(), 30), 2);
    const res = await get(
      env,
      `/api/sunny-paws/admin/bookings?from=${target}&to=${addDays(target, 6)}`,
      await adminHeaders(TENANT_A),
    );
    expect(res.status).toBe(200);
    const { bookings } = (await res.json()) as { bookings: Row[] };
    const walk = bookings.find((b) => b.projected === true);
    expect(walk).toMatchObject({
      id: `series:${id}:${target}`,
      startDate: target,
      status: 'confirmed',
      estCostCents: 2000,
      paidTotalCents: 0,
      charges: [],
      chargesTotalCents: 0,
      cancellationFeeCents: null,
      customerEmail: 'jess@example.com',
      customerName: 'Jess Demo',
      petNames: ['Bella'],
      petCount: 1,
      external: false,
      externalSummary: null,
      isBackfilled: false,
      seriesId: id,
    });
    const real = bookings.find((b) => b.projected === undefined && b.seriesId === id)!;
    expect(real).toBeDefined();
    expectSameShape(walk!, real, ['estCostCents', 'feeIfCancelledTodayCents', 'startTime']);
    // …and against a single booking's row too, which is the shape every reader already knows.
    const single = bookings.find((b) => b.projected === undefined && b.seriesId === null);
    expect(single).toBeDefined();
    expectSameShape(walk!, single!, [
      'estCostCents',
      'feeIfCancelledTodayCents',
      'startTime',
      'endDate',
      'departureTime',
      'optionKey',
      'cancellationFeeCents',
      // A single booking belongs to no series: the key is there, and null.
      'seriesId',
    ]);
  });

  it('admin bookings without to is the row list only', async () => {
    const { env, raw, token } = await world();
    await seedSeries(env, raw, token, { active: true });
    seedOffer(raw);
    const { bookings } = (await (
      await get(env, '/api/sunny-paws/admin/bookings', await adminHeaders(TENANT_A))
    ).json()) as { bookings: Row[] };
    expect(bookings.some((b) => b.id.startsWith('series:') || 'projected' in b)).toBe(false);
  });

  it('every list reads terms, rates and capacity once per service and option, not once per series', async () => {
    const to = addMonths(TODAY(), 20);
    const queriesFor = async (series: number, path: string, sitter: boolean) => {
      const { env, raw, token } = await world();
      for (let i = 0; i < series; i++) await seedSeries(env, raw, token, { active: true });
      const headers = sitter ? await adminHeaders(TENANT_A) : bearer(token);
      const prepare = vi.spyOn(env.PAWSERVATION_DB, 'prepare');
      const res = await get(env, `${path}?to=${to}`, headers);
      expect(res.status).toBe(200);
      const n = prepare.mock.calls.length;
      prepare.mockRestore();
      return n;
    };
    for (const [path, sitter] of [
      ['/api/sunny-paws/admin/bookings', true],
      ['/api/sunny-paws/bookings/mine', false],
      ['/api/sunny-paws/admin/series', true],
      ['/api/sunny-paws/series/mine', false],
    ] as const)
      expect(await queriesFor(3, path, sitter), path).toBe(await queriesFor(1, path, sitter));
  });
});

describe('the series reads', () => {
  it('admin series list filters by status and returns version, rows, projected walks for the span, and skips with words', async () => {
    const { env, raw, token } = await world();
    const first = onOrAfter(futureWeekday(1, 14), 2);
    raw
      .prepare(
        `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, Status)
         VALUES ('off_1', ?, NULL, 'blocked', ?, ?, 1, 'confirmed')`,
      )
      .run(TENANT_A, first, addDays(first, 1));
    const active = await seedSeries(env, raw, token, { active: true });
    const pending = await seedSeries(env, raw, token, { weekdays: ['thursday'] });
    const to = addMonths(TODAY(), 18);
    const headers = await adminHeaders(TENANT_A);

    const res = await get(env, `/api/sunny-paws/admin/series?status=active&to=${to}`, headers);
    expect(res.status).toBe(200);
    const { series } = (await res.json()) as { series: Wire[] };
    expect(series.map((s) => s.id)).toEqual([active]);
    const s = series[0];
    expect(s).toMatchObject({
      status: 'active',
      version: 1,
      endUserId: 'eu_sp_jess',
      customerName: 'Jess Demo',
    });
    const rows = s.walks.filter((w) => !w.projected);
    const projected = s.walks.filter((w) => w.projected);
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.every((w) => w.status === 'confirmed' && !w.id.startsWith('series:'))).toBe(true);
    expect(projected.length).toBeGreaterThan(20);
    expect(projected.every((w) => w.date > WINDOW_END() && w.date <= to)).toBe(true);
    expect(projected[0]).toMatchObject({ status: 'confirmed', estCostCents: 2000 });
    expect(s.skips).toContainEqual({
      date: first,
      reason: 'time_off',
      words: expect.any(String),
    });
    expect(s.skips.find((k) => k.date === first)!.words.length).toBeGreaterThan(0);

    // Two statuses, comma-separated; none named → every series.
    const both = (await (
      await get(env, '/api/sunny-paws/admin/series?status=active,pending', headers)
    ).json()) as { series: Wire[] };
    expect(both.series.map((x) => x.id).sort()).toEqual([active, pending].sort());
    const all = (await (await get(env, '/api/sunny-paws/admin/series', headers)).json()) as {
      series: Wire[];
    };
    expect(all.series).toHaveLength(2);
    // An unknown status is refused, not ignored.
    const bad = await get(env, '/api/sunny-paws/admin/series?status=active,nope', headers);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'invalid_status' });

    // One by id: the same wire, the same span.
    const one = await get(env, `/api/sunny-paws/admin/series/${active}?to=${to}`, headers);
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(s);
  });

  it('series/mine answers the client her own series with their walks', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, raw, token, { active: true });
    const res = await get(env, '/api/sunny-paws/series/mine', bearer(token));
    expect(res.status).toBe(200);
    const { series } = (await res.json()) as { series: Wire[] };
    expect(series.map((s) => s.id)).toEqual([id]);
    expect(series[0]).not.toHaveProperty('endUserId');
    expect(series[0]).not.toHaveProperty('customerName');
    // Default span: through the window — rows only for an active series.
    expect(series[0].walks.every((w) => !w.projected && w.date <= WINDOW_END())).toBe(true);
    const wide = (await (
      await get(env, `/api/sunny-paws/series/mine?to=${addMonths(TODAY(), 18)}`, bearer(token))
    ).json()) as { series: Wire[] };
    expect(wide.series[0].walks.some((w) => w.projected)).toBe(true);
  });

  it('a pending_client offer projects every walk including inside the window, status offered', async () => {
    const { env, raw, token } = await world();
    const id = seedOffer(raw);
    const { series } = (await (
      await get(env, '/api/sunny-paws/series/mine', bearer(token))
    ).json()) as { series: Wire[] };
    const offer = series.find((s) => s.id === id)!;
    expect(offer.status).toBe('pending_client');
    expect(offer.walks.length).toBeGreaterThan(40);
    expect(offer.walks.every((w) => w.projected && w.status === 'offered')).toBe(true);
    expect(offer.walks[0].date <= addDays(TODAY(), 8)).toBe(true); // inside the window

    const to = addDays(TODAY(), 21);
    const { bookings } = (await (
      await get(env, `/api/sunny-paws/bookings/mine?to=${to}`, bearer(token))
    ).json()) as { bookings: Row[] };
    const offered = bookings.filter((b) => b.seriesId === id);
    expect(offered.length).toBeGreaterThanOrEqual(3);
    for (const b of offered)
      expect(b).toMatchObject({
        projected: true,
        status: 'offered',
        cancellable: false,
        feeIfCancelledTodayCents: null,
      });
  });

  it("projected id: U3 cannot read U1's series by id or by projected walk", async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, raw, token, { active: true });
    const offer = seedOffer(raw);
    const u3 = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const to = addMonths(TODAY(), 18);

    // Another sitter's admin: 404, never 403, for the series and for the offer.
    for (const sid of [id, offer]) {
      const res = await get(
        env,
        `/api/happy-tails/admin/series/${sid}`,
        await adminHeaders(TENANT_B),
      );
      expect(res.status).toBe(404);
    }
    // …and her list and her bookings list name neither.
    const theirs = (await (
      await get(env, `/api/happy-tails/admin/series?to=${to}`, await adminHeaders(TENANT_B))
    ).json()) as { series: Wire[] };
    expect(theirs.series).toEqual([]);
    const theirBookings = (await (
      await get(env, `/api/happy-tails/admin/bookings?to=${to}`, await adminHeaders(TENANT_B))
    ).json()) as { bookings: Row[] };
    expect(JSON.stringify(theirBookings)).not.toContain(id);
    expect(JSON.stringify(theirBookings)).not.toContain(offer);

    // U3 — the same email under the other sitter — sees none of U1's series or walks.
    const mine = (await (
      await get(env, `/api/happy-tails/series/mine?to=${to}`, bearer(u3))
    ).json()) as { series: Wire[] };
    expect(mine.series).toEqual([]);
    const u3Bookings = await (
      await get(env, `/api/happy-tails/bookings/mine?to=${to}`, bearer(u3))
    ).text();
    expect(u3Bookings).not.toContain(id);
    expect(u3Bookings).not.toContain(offer);

    // An unknown id under the right sitter is the same 404.
    const unknown = await get(
      env,
      '/api/sunny-paws/admin/series/nope',
      await adminHeaders(TENANT_A),
    );
    expect(unknown.status).toBe(404);
  });

  it('invalid from/to is 400 invalid_range', async () => {
    const { env, raw, token } = await world();
    const id = await seedSeries(env, raw, token);
    const admin = await adminHeaders(TENANT_A);
    const later = addDays(TODAY(), 10);
    const bad = [
      'to=tomorrow',
      'to=2027-02-30',
      `from=${later}&to=${TODAY()}`,
      'from=2027-1-1&to=2027-02-01',
    ];
    const routes: [string, Record<string, string>][] = [
      ['/api/sunny-paws/bookings/mine', bearer(token)],
      ['/api/sunny-paws/series/mine', bearer(token)],
      ['/api/sunny-paws/admin/bookings', admin],
      ['/api/sunny-paws/admin/series', admin],
      [`/api/sunny-paws/admin/series/${id}`, admin],
    ];
    for (const [path, headers] of routes)
      for (const q of bad) {
        const res = await get(env, `${path}?${q}`, headers);
        expect(res.status, `${path}?${q}`).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'invalid_range' });
      }
  });
});
