import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import app from '../index';
import type { SeriesRow } from '../db/repo';
import { seriesAnswers, SeriesTermsGone } from '../lib/series-walks';
import { termsGoneFailure } from '../lib/series-ops';
import { projectionCap } from '../lib/series-rule';
import {
  addDays,
  addMonths,
  DEFAULT_TIMEZONE,
  getPacificDateStr,
  holidaysForYear,
} from '../../src/shared/index.js';
import {
  clearSeededBookings,
  createTestEnv,
  demoToken,
  endUserToken,
  futureWeekday,
  TENANT_A,
} from './helpers';

/**
 * A client's series, quote and request, through `app.request` with the client's own widget token.
 * Every date is relative to the real clock: the routes read `tenantToday(tenant)`, and a fixed
 * date stops being future.
 *
 * The seeded Sunny Paws `walk` / `d30` is $20 a walk (2000 cents), HasDuration = 1 (the option owns
 * the clock, so the client names no time), no HolidayRate, MaxAdvanceMonths NULL (a 12-month
 * window). Jess (eu_sp_jess) has Bella (dog) and Mochi (cat) and a phone on file.
 */

const TODAY = () => getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
const WINDOW_END = () => addMonths(TODAY(), 12);

type Walk = { date: string; estCostCents?: number; skipped?: string; words?: string };
type Quote = {
  walks: Walk[];
  estCostCentsEach: number | null;
  openEnded: boolean;
  pattern: string;
  windowEnd: string;
};
type WireWalk = {
  id: string;
  date: string;
  status: string;
  projected: boolean;
  estCostCents: number | null;
  feeIfCancelledTodayCents: number | null;
};
type Wire = {
  id: string;
  status: string;
  version: number;
  createdBy: string;
  type: string;
  optionKey: string | null;
  petIds: string[];
  pets: string[];
  weekdays: string[];
  startTime: string | null;
  startDate: string;
  endDate: string | null;
  openEnded: boolean;
  pattern: string;
  offerExpiresAt: string | null;
  windowEnd: string;
  estCostCentsEach: number | null;
  walks: WireWalk[];
  skips: { date: string; reason: string; words: string }[];
};

function body(over: Record<string, unknown> = {}) {
  return {
    type: 'walk',
    optionKey: 'd30',
    petIds: ['pet_sp_bella'],
    weekdays: ['tuesday', 'thursday'],
    startDate: futureWeekday(1, 14), // a Monday at least two weeks out
    endDate: null,
    ...over,
  };
}

async function world() {
  const { env, raw } = createTestEnv();
  await clearSeededBookings(env);
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return { env, raw, token };
}

function post(
  env: Env,
  token: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
  slug = 'sunny-paws',
) {
  return app.request(
    `/api/${slug}${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    },
    env,
  );
}

const count = (raw: DatabaseSync, table: string) =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const counts = (raw: DatabaseSync) => ({
  series: count(raw, 'BookingSeries'),
  seriesPets: count(raw, 'BookingSeriesPets'),
  skips: count(raw, 'BookingSeriesSkips'),
  bookings: count(raw, 'BookingRequests'),
  bookingPets: count(raw, 'BookingRequestPets'),
});

/** A day of time off: a `blocked` row covering [date, date + 1) — the engine's exclusive end. */
function blockDay(raw: DatabaseSync, id: string, date: string, days = 1) {
  raw
    .prepare(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, Status)
       VALUES (?, ?, NULL, 'blocked', ?, ?, 1, 'confirmed')`,
    )
    .run(id, TENANT_A, date, addDays(date, days));
}

describe('POST /api/:slug/series/quote', () => {
  it('quote: answers walks through the booking window by default, and through ?to= when asked (never past 24 months)', async () => {
    const { env, token } = await world();
    const res = await post(env, token, '/series/quote', body());
    expect(res.status).toBe(200);
    const q = (await res.json()) as Quote;
    expect(q.windowEnd).toBe(WINDOW_END());
    const last = q.walks[q.walks.length - 1].date;
    expect(last <= WINDOW_END()).toBe(true);
    expect(last > addDays(WINDOW_END(), -7)).toBe(true);
    expect(q.walks[0].date > TODAY()).toBe(true);
    expect(q.walks.every((w) => w.estCostCents === 2000)).toBe(true);
    expect(q.estCostCentsEach).toBe(2000);

    const wider = (await (
      await post(env, token, `/series/quote?to=${addMonths(TODAY(), 18)}`, body())
    ).json()) as Quote;
    const widerLast = wider.walks[wider.walks.length - 1].date;
    expect(widerLast > WINDOW_END()).toBe(true);
    expect(widerLast <= addMonths(TODAY(), 18)).toBe(true);

    const capped = (await (
      await post(env, token, `/series/quote?to=${addMonths(TODAY(), 120)}`, body())
    ).json()) as Quote;
    const cappedLast = capped.walks[capped.walks.length - 1].date;
    expect(cappedLast <= projectionCap(TODAY())).toBe(true);
    expect(cappedLast > addDays(projectionCap(TODAY()), -7)).toBe(true);
  });

  it('quote: a malformed ?to is refused invalid_date', async () => {
    const { env, token } = await world();
    const res = await post(env, token, '/series/quote?to=2027-02-30', body());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_date');
  });

  it('quote: a holiday in the span makes estCostCentsEach null', async () => {
    const { env, raw, token } = await world();
    raw.exec(
      `UPDATE TenantServices SET HolidayRate = 40 WHERE TenantId = '${TENANT_A}' AND ServiceType = 'walk'`,
    );
    // Thanksgiving is always a Thursday and always inside the next twelve months.
    const year = Number(TODAY().slice(0, 4));
    const thanksgiving = [...holidaysForYear(year), ...holidaysForYear(year + 1)].find(
      (h) => h.name === 'Thanksgiving' && h.date > addDays(TODAY(), 1),
    )!.date;
    const q = (await (
      await post(
        env,
        token,
        '/series/quote',
        body({ weekdays: ['thursday'], startDate: addDays(TODAY(), 1) }),
      )
    ).json()) as Quote;
    expect(q.walks.find((w) => w.date === thanksgiving)).toEqual({
      date: thanksgiving,
      estCostCents: 4000,
    });
    expect(q.walks.some((w) => w.estCostCents === 2000)).toBe(true);
    expect(q.estCostCentsEach).toBeNull();
  });

  it('quote: an open series says openEnded true and its pattern ends "no end date"', async () => {
    const { env, token } = await world();
    const q = (await (await post(env, token, '/series/quote', body())).json()) as Quote;
    expect(q.openEnded).toBe(true);
    expect(q.pattern.endsWith('no end date')).toBe(true);
    expect(q.pattern.startsWith('every Tuesday and Thursday from ')).toBe(true);

    const ended = (await (
      await post(
        env,
        token,
        '/series/quote',
        body({ endDate: addDays(body().startDate as string, 27) }),
      )
    ).json()) as Quote;
    expect(ended.openEnded).toBe(false);
    expect(ended.walks).toHaveLength(8);
  });

  it('quote: a skipped date carries its reason and its words, never a figure', async () => {
    const { env, raw, token } = await world();
    const start = body().startDate as string;
    const tuesday = addDays(start, 1);
    blockDay(raw, 'blk_q', tuesday);
    const q = (await (await post(env, token, '/series/quote', body())).json()) as Quote;
    expect(q.walks.find((w) => w.date === tuesday)).toEqual({
      date: tuesday,
      skipped: 'time_off',
      words: 'your sitter is away that day',
    });
  });

  it('quote: writes nothing', async () => {
    const { env, raw, token } = await world();
    const before = counts(raw);
    expect((await post(env, token, '/series/quote', body())).status).toBe(200);
    expect(counts(raw)).toEqual(before);
  });

  it('quote: needs the client token', async () => {
    const { env } = await world();
    const res = await app.request(
      '/api/sunny-paws/series/quote',
      { method: 'POST', body: JSON.stringify(body()) },
      env,
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/:slug/series', () => {
  it('request: creates the series pending, rows pending to the window (SyncPending 0, SeriesId set), skips recorded, one 201 body', async () => {
    const { env, raw, token } = await world();
    const start = body().startDate as string;
    const blocked = addDays(start, 8); // the second Tuesday
    blockDay(raw, 'blk_r', blocked);
    const res = await post(env, token, '/series', body());
    expect(res.status).toBe(201);
    const s = (await res.json()) as Wire;
    expect(s).toMatchObject({
      status: 'pending',
      version: 1,
      createdBy: 'client',
      type: 'walk',
      optionKey: 'd30',
      petIds: ['pet_sp_bella'],
      pets: ['Bella'],
      weekdays: ['tuesday', 'thursday'],
      startTime: null,
      startDate: start,
      endDate: null,
      openEnded: true,
      offerExpiresAt: null,
      windowEnd: WINDOW_END(),
      estCostCentsEach: 2000,
    });
    expect(s.pattern.endsWith('no end date')).toBe(true);
    expect(s.skips).toEqual([
      { date: blocked, reason: 'time_off', words: 'your sitter is away that day' },
    ]);
    expect(s.walks.length).toBeGreaterThan(90);
    expect(s.walks.every((w) => !w.projected && w.status === 'pending')).toBe(true);
    expect(s.walks.every((w) => w.estCostCents === 2000)).toBe(true);
    expect(s.walks.every((w) => w.feeIfCancelledTodayCents === 0)).toBe(true);
    expect(s.walks.some((w) => w.date === blocked)).toBe(false);

    const series = raw.prepare(`SELECT * FROM BookingSeries WHERE Id = ?`).get(s.id) as SeriesRow;
    expect(series).toMatchObject({
      TenantId: TENANT_A,
      EndUserId: 'eu_sp_jess',
      Status: 'pending',
      CreatedBy: 'client',
      Weekdays: 2 | 8,
      OptionKey: 'd30',
      MaterializedThrough: WINDOW_END(),
    });
    const rows = raw
      .prepare(
        `SELECT Id, StartDate, Status, SyncPending, SeriesId, EstCost FROM BookingRequests WHERE SeriesId = ? ORDER BY StartDate`,
      )
      .all(s.id) as {
      Id: string;
      StartDate: string;
      Status: string;
      SyncPending: number;
      SeriesId: string;
    }[];
    expect(rows.map((r) => r.Id)).toEqual(s.walks.map((w) => w.id));
    expect(rows.every((r) => r.Status === 'pending' && r.SyncPending === 0)).toBe(true);
    expect(rows[rows.length - 1].StartDate <= WINDOW_END()).toBe(true);
    expect(
      raw.prepare(`SELECT Date, Reason FROM BookingSeriesSkips WHERE SeriesId = ?`).all(s.id),
    ).toEqual([{ Date: blocked, Reason: 'time_off' }]);
    expect(raw.prepare(`SELECT PetId FROM BookingSeriesPets WHERE SeriesId = ?`).all(s.id)).toEqual(
      [{ PetId: 'pet_sp_bella' }],
    );
  });

  it('request: a series with no option named stores the option it is priced with', async () => {
    const { env, raw, token } = await world();
    const payload = body();
    delete (payload as Record<string, unknown>).optionKey;
    const res = await post(env, token, '/series', payload);
    expect(res.status).toBe(201);
    const s = (await res.json()) as Wire;
    expect(s.optionKey).toBe('d30');
    expect(raw.prepare(`SELECT OptionKey FROM BookingSeries WHERE Id = ?`).get(s.id)).toEqual({
      OptionKey: 'd30',
    });
  });

  it('request: an unknown option is refused unknown_option', async () => {
    const { env, raw, token } = await world();
    const before = counts(raw);
    const res = await post(env, token, '/series', body({ optionKey: 'd999' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unknown_option');
    expect(counts(raw)).toEqual(before);
  });

  it('request: holds capacity — a single booking for the same slot on a series date is then refused capacity_conflict', async () => {
    const { env, raw, token } = await world();
    raw.exec(`UPDATE TenantServiceOptions SET Capacity = 1 WHERE Id = 'opt_sp_walk30'`);
    const s = (await (await post(env, token, '/series', body())).json()) as Wire;
    const date = s.walks[0].date;
    const single = await post(env, token, '/bookings', {
      type: 'walk',
      optionKey: 'd30',
      startDate: date,
      petIds: ['pet_sp_mochi'],
      answers: {},
    });
    expect(single.status).toBe(409);
    expect(((await single.json()) as { code: string }).code).toBe('capacity_conflict');
  });

  it('request: all-or-nothing — a failure inside the batch leaves no series, no row, no skip', async () => {
    // The route refuses a bad pet before any write, so atomicity is proven by failing the request's
    // write at its LAST statement — the MaterializedThrough mark, swapped for one that fails
    // Weekdays' CHECK — after the series, its pets, every walk row and a skip were written before
    // it. In one batch they all roll back; run one by one, they would survive.
    const { env, raw, token } = await world();
    blockDay(raw, 'blk_aon', addDays(body().startDate as string, 1));
    const before = counts(raw);
    const db = env.PAWSERVATION_DB;
    let swapped = false;
    let batched = 0;
    const failing = {
      ...env,
      PAWSERVATION_DB: {
        prepare: (sql: string) => {
          if (!sql.includes('SET MaterializedThrough')) return db.prepare(sql);
          swapped = true;
          return { bind: () => db.prepare(`UPDATE BookingSeries SET Weekdays = 0`) };
        },
        batch: (statements: D1PreparedStatement[]) => {
          batched = Math.max(batched, statements.length);
          return db.batch(statements);
        },
      },
    } as unknown as Env;
    const res = await post(failing, token, '/series', body());
    expect(swapped).toBe(true);
    expect(res.status).toBe(500);
    expect(counts(raw)).toEqual(before);
    expect(batched).toBeGreaterThan(100); // series + pet + ~100 walks with their pets + a skip + mark
  });

  it('request: the same Idempotency-Key replays the first answer and creates nothing', async () => {
    const { env, raw, token } = await world();
    const first = await post(env, token, '/series', body(), { 'Idempotency-Key': 'series-once' });
    expect(first.status).toBe(201);
    const a = (await first.json()) as Wire;
    const after = counts(raw);
    const second = await post(env, token, '/series', body(), { 'Idempotency-Key': 'series-once' });
    expect(second.status).toBe(201);
    const b = (await second.json()) as Wire;
    expect(b).toEqual(a);
    expect(counts(raw)).toEqual(after);
  });

  it('request: a racer that lost the Idempotency-Key insert replays the winner', async () => {
    // The replay read misses (the winner had not committed yet), the batch then trips the unique
    // index on the key, and the re-read finds the winner's series — which is what is answered.
    const { env, raw, token } = await world();
    const won = (await (
      await post(env, token, '/series', body(), { 'Idempotency-Key': 'series-race' })
    ).json()) as Wire;
    const after = counts(raw);
    const db = env.PAWSERVATION_DB;
    let missed = false;
    const racing = {
      ...env,
      PAWSERVATION_DB: {
        prepare: (sql: string) => {
          if (!missed && sql.includes('FROM BookingSeries') && sql.includes('IdempotencyKey = ?')) {
            missed = true;
            return { bind: () => ({ first: async () => null }) };
          }
          return db.prepare(sql);
        },
        batch: (s: D1PreparedStatement[]) => db.batch(s),
      },
    } as unknown as Env;
    const res = await post(racing, token, '/series', body(), { 'Idempotency-Key': 'series-race' });
    expect(missed).toBe(true);
    expect(res.status).toBe(201);
    expect(((await res.json()) as Wire).id).toBe(won.id);
    expect(counts(raw)).toEqual(after);
  });

  it('request: an oversized Idempotency-Key is refused invalid_idempotency_key', async () => {
    const { env, token } = await world();
    const res = await post(env, token, '/series', body(), { 'Idempotency-Key': 'k'.repeat(129) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_idempotency_key');
  });

  it('request: a range service is refused series_single_day_only', async () => {
    const { env, raw, token } = await world();
    const before = counts(raw);
    const res = await post(
      env,
      token,
      '/series',
      body({ type: 'boarding', optionKey: 'standard' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('series_single_day_only');
    expect(counts(raw)).toEqual(before);
  });

  describe('each refusal answers its code and writes nothing', () => {
    const cases: {
      name: string;
      code: string;
      status?: number;
      setup?: (raw: DatabaseSync) => void;
      payload: () => Record<string, unknown>;
    }[] = [
      {
        name: 'an unknown weekday',
        code: 'invalid_weekdays',
        payload: () => body({ weekdays: ['funday'] }),
      },
      { name: 'no weekday', code: 'invalid_weekdays', payload: () => body({ weekdays: [] }) },
      {
        name: 'a weekday-only option on a Saturday',
        code: 'weekdays_only',
        payload: () => body({ type: 'morning-walk', optionKey: 'd30', weekdays: ['saturday'] }),
      },
      {
        name: 'a start inside the notice',
        code: 'too_soon',
        setup: (raw) =>
          raw.exec(
            `UPDATE TenantServices SET MinLeadDays = 30 WHERE TenantId = '${TENANT_A}' AND ServiceType = 'walk'`,
          ),
        payload: () => body({ startDate: addDays(TODAY(), 3) }),
      },
      {
        name: 'an end before the start',
        code: 'invalid_end_date',
        payload: () => body({ endDate: addDays(body().startDate as string, -1) }),
      },
      {
        name: 'no phone on file',
        code: 'phone_required',
        setup: (raw) => raw.exec(`UPDATE EndUsers SET Phone = NULL WHERE Id = 'eu_sp_jess'`),
        payload: () => body(),
      },
      {
        name: 'a pet set unpriced on every date',
        code: 'unpriced_pet_set',
        payload: () => body({ petIds: ['pet_sp_bella', 'pet_sp_mochi'] }),
      },
      {
        name: 'every date skipped',
        code: 'no_bookable_dates',
        status: 409,
        setup: (raw) => blockDay(raw, 'blk_all', body().startDate as string, 14),
        payload: () => body({ endDate: addDays(body().startDate as string, 13) }),
      },
      {
        name: 'a time that attracts an extra-time surcharge',
        code: 'series_extra_time',
        setup: (raw) =>
          raw.exec(
            `UPDATE TenantServices SET StandardArrivalTime = '08:00', EarlyArrivalFee = 10
              WHERE TenantId = '${TENANT_A}' AND ServiceType = 'daycare'`,
          ),
        payload: () => body({ type: 'daycare', optionKey: 'standard', startTime: '07:00' }),
      },
      {
        name: 'a time on a service whose option owns the clock',
        code: 'invalid_start_time',
        payload: () => body({ startTime: '07:00' }),
      },
      {
        name: 'a start in the past',
        code: 'date_in_past',
        payload: () => body({ startDate: addDays(TODAY(), -7) }),
      },
      {
        name: 'no pets',
        code: 'no_pets_selected',
        payload: () => body({ petIds: [] }),
      },
      {
        name: 'an unknown service',
        code: 'unknown_service_type',
        payload: () => body({ type: 'swimming' }),
      },
      {
        name: 'a switched-off service',
        code: 'service_not_offered',
        setup: (raw) =>
          raw.exec(
            `UPDATE TenantServices SET Enabled = 0 WHERE TenantId = '${TENANT_A}' AND ServiceType = 'walk'`,
          ),
        payload: () => body(),
      },
    ];
    for (const c of cases) {
      it(`request: ${c.name} → ${c.code}`, async () => {
        const { env, raw, token } = await world();
        c.setup?.(raw);
        const before = counts(raw);
        const res = await post(env, token, '/series', c.payload());
        expect(res.status).toBe(c.status ?? 400);
        expect(((await res.json()) as { code: string }).code).toBe(c.code);
        expect(counts(raw)).toEqual(before);
      });
    }
  });

  it('request: a start past the booking window is judged from its start, not refused', async () => {
    const { env, raw, token } = await world();
    const start = futureWeekday(1, 400); // past the 12-month window, inside the 24-month cap
    const res = await post(env, token, '/series', body({ startDate: start }));
    expect(res.status).toBe(201);
    const s = (await res.json()) as Wire;
    expect(s.walks).toEqual([]);
    expect(count(raw, 'BookingSeries')).toBe(1);
    expect(
      (
        raw.prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE SeriesId = ?`).get(s.id) as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it('request: the demo identity gets id demo-series and nothing persists', async () => {
    const { env, raw } = createTestEnv();
    const token = await demoToken(env, 'paws-and-relax');
    const demoPet = (
      raw
        .prepare(
          `SELECT p.Id FROM EndUserPets p JOIN EndUsers u ON u.Id = p.EndUserId
            WHERE u.TenantId = 'tnt_pawsandrelax' AND u.Email = 'demo@pawservation.com'`,
        )
        .get() as { Id: string }
    ).Id;
    const before = counts(raw);
    const res = await post(
      env,
      token,
      '/series',
      body({ petIds: [demoPet] }),
      {},
      'paws-and-relax',
    );
    expect(res.status).toBe(201);
    const s = (await res.json()) as Wire;
    expect(s.id).toBe('demo-series');
    expect(s.status).toBe('pending');
    expect(s.walks.length).toBeGreaterThan(0);
    expect(s.walks.every((w) => w.estCostCents === 2200)).toBe(true);
    expect(counts(raw)).toEqual(before);
  });

  it("request: U3 (happy-tails, same email) cannot name U1's pet → unknown_pet", async () => {
    const { env, raw } = createTestEnv();
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const before = counts(raw);
    const res = await post(
      env,
      token,
      '/series',
      body({ petIds: ['pet_sp_bella'] }),
      {},
      'happy-tails',
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('unknown_pet');
    expect(counts(raw)).toEqual(before);
  });
});

describe('a series carries its intake answers', () => {
  const QUESTIONS = JSON.stringify([
    { id: 'gate', label: 'Gate code', type: 'text', required: true },
  ]);

  it('request: every walk row carries the answers, the pre-fill is saved, and the same-email client of another sitter is untouched', async () => {
    const { env, raw, token } = await world();
    for (const t of [TENANT_A, 'tnt_happytails'])
      raw
        .prepare(
          `UPDATE TenantServices SET Questions = ? WHERE TenantId = ? AND ServiceType = 'walk'`,
        )
        .run(QUESTIONS, t);
    raw.exec(`INSERT INTO SavedAnswers (TenantId, EndUserId, ServiceType, QuestionId, Shape, Value)
              VALUES ('tnt_happytails', 'eu_ht_jess', 'walk', 'gate', 'text', 'B-side')`);

    const res = await post(env, token, '/series', body({ answers: { gate: '1234' } }));
    expect(res.status).toBe(201);
    const s = (await res.json()) as Wire;
    const rows = raw
      .prepare(`SELECT Answers FROM BookingRequests WHERE SeriesId = ?`)
      .all(s.id) as { Answers: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => JSON.parse(r.Answers).gate === '1234')).toBe(true);
    expect(
      raw
        .prepare(
          `SELECT TenantId, EndUserId, ServiceType, QuestionId, Value FROM SavedAnswers ORDER BY TenantId`,
        )
        .all(),
    ).toEqual([
      {
        TenantId: 'tnt_happytails',
        EndUserId: 'eu_ht_jess',
        ServiceType: 'walk',
        QuestionId: 'gate',
        Value: 'B-side',
      },
      {
        TenantId: TENANT_A,
        EndUserId: 'eu_sp_jess',
        ServiceType: 'walk',
        QuestionId: 'gate',
        Value: '1234',
      },
    ]);

    // The later extension's source: the series' earliest row.
    expect(await seriesAnswers(env.PAWSERVATION_DB, TENANT_A, s.id)).toEqual({ gate: '1234' });
    expect(await seriesAnswers(env.PAWSERVATION_DB, 'tnt_happytails', s.id)).toEqual({});
  });

  it('request: a missing required answer is refused invalid_answers and nothing is written', async () => {
    const { env, raw, token } = await world();
    raw
      .prepare(
        `UPDATE TenantServices SET Questions = ? WHERE TenantId = ? AND ServiceType = 'walk'`,
      )
      .run(QUESTIONS, TENANT_A);
    const before = counts(raw);
    const res = await post(env, token, '/series', body());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_answers');
    expect(counts(raw)).toEqual(before);
  });

  it('seriesAnswers: a series with no row yet answers {}', async () => {
    const { env } = await world();
    expect(await seriesAnswers(env.PAWSERVATION_DB, TENANT_A, 'no-such-series')).toEqual({});
  });
});

describe('termsGoneFailure — a term gone between the checks and the write', () => {
  it.each([
    ['service', 400, 'service_not_offered'],
    ['option', 400, 'unknown_option'],
    ['pet', 400, 'unknown_pet'],
  ] as const)("%s → %i %s, the single booking's code and status", (what, status, code) => {
    expect(termsGoneFailure(new SeriesTermsGone(what))).toMatchObject({ ok: false, status, code });
  });
});

describe("Idempotency-Key is the caller's own", () => {
  it("U2 and U3 sending U1's key each get their own series, never U1's", async () => {
    const { env, raw, token } = await world();
    raw.exec(`INSERT INTO EndUsers (Id, TenantId, Email, Name, Phone, Status)
              VALUES ('eu_sp_sam', '${TENANT_A}', 'sam@example.com', 'Sam', '555-0100', 'active')`);
    raw.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
              VALUES ('pet_sp_rex', '${TENANT_A}', 'eu_sp_sam', 'Rex', 'dog')`);
    raw.exec(
      `INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES ('${TENANT_A}', 'pet_sp_rex', 'eu_sp_sam')`,
    );
    const u1 = (await (
      await post(env, token, '/series', body(), { 'Idempotency-Key': 'shared-key' })
    ).json()) as Wire;

    const u2Token = await endUserToken(env, 'sunny-paws', 'sam@example.com');
    const u2 = await post(env, u2Token, '/series', body({ petIds: ['pet_sp_rex'] }), {
      'Idempotency-Key': 'shared-key',
    });
    expect(u2.status).toBe(201);
    const u2Body = (await u2.json()) as Wire;
    expect(u2Body.id).not.toBe(u1.id);
    expect(u2Body.pets).toEqual(['Rex']);

    const u3Token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const u3 = await post(
      env,
      u3Token,
      '/series',
      body({ petIds: ['pet_ht_otis'] }),
      { 'Idempotency-Key': 'shared-key' },
      'happy-tails',
    );
    expect(u3.status).toBe(201);
    const u3Body = (await u3.json()) as Wire;
    expect(u3Body.id).not.toBe(u1.id);
    expect(u3Body.pets).toEqual(['Otis']);
    expect(
      raw
        .prepare(`SELECT TenantId, EndUserId FROM BookingSeries ORDER BY TenantId, EndUserId`)
        .all(),
    ).toEqual([
      { TenantId: 'tnt_happytails', EndUserId: 'eu_ht_jess' },
      { TenantId: TENANT_A, EndUserId: 'eu_sp_jess' },
      { TenantId: TENANT_A, EndUserId: 'eu_sp_sam' },
    ]);
  });

  it('a unique violation that is not a key replay is rethrown, never answered as a replay', async () => {
    const { env, raw, token } = await world();
    const before = counts(raw);
    const db = env.PAWSERVATION_DB;
    const colliding = {
      ...env,
      PAWSERVATION_DB: {
        prepare: (sql: string) => db.prepare(sql),
        batch: async () => {
          throw new Error(
            'UNIQUE constraint failed: BookingRequests.SeriesId, BookingRequests.StartDate',
          );
        },
      },
    } as unknown as Env;
    const res = await post(colliding, token, '/series', body(), { 'Idempotency-Key': 'k-collide' });
    expect(res.status).toBe(500);
    expect(counts(raw)).toEqual(before);
  });
});

describe('the sitter is told of a series request', () => {
  afterEach(() => vi.restoreAllMocks());

  const RESEND = {
    RESEND_API_KEY: 'k',
    RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
    RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
  };

  async function mailWorld(contactEmail: string | null) {
    // The address is set before the first request: the tenant row is cached once resolved. The
    // login code is sent before email is configured, so it never reaches the spy.
    const { env, raw } = createTestEnv();
    raw.prepare(`UPDATE Tenants SET ContactEmail = ? WHERE Id = ?`).run(contactEmail, TENANT_A);
    await clearSeededBookings(env);
    const w = { env, raw, token: await endUserToken(env, 'sunny-paws', 'jess@example.com') };
    Object.assign(w.env, RESEND);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const sent = () =>
      spy.mock.calls
        .filter((c) => String(c[0]).includes('api.resend.com'))
        .map(
          (c) =>
            JSON.parse((c[1] as RequestInit).body as string) as {
              to: string;
              subject: string;
              text: string;
              html: string;
            },
        );
    return { ...w, sent };
  }

  it('request: one email to her contact address, with the pattern and the pets, and no figure', async () => {
    const { env, token, sent } = await mailWorld('sitter@sunnypaws.example');
    const res = await post(env, token, '/series', body());
    expect(res.status).toBe(201);
    const s = (await res.json()) as Wire;
    const mail = sent();
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe('sitter@sunnypaws.example');
    for (const part of [s.pattern, 'Bella', 'Walk', 'Jess Demo']) {
      expect(mail[0].text).toContain(part);
      expect(mail[0].html).toContain(part);
    }
    expect(mail[0].text).toContain('priced for its own date');
    expect(mail[0].text).not.toContain('$');
    expect(mail[0].html).not.toContain('$');
  });

  it('request: no contact address → no email', async () => {
    const { env, token, sent } = await mailWorld(null);
    expect((await post(env, token, '/series', body())).status).toBe(201);
    expect(sent()).toHaveLength(0);
  });

  it('request: an idempotent replay sends nothing more', async () => {
    const { env, token, sent } = await mailWorld('sitter@sunnypaws.example');
    await post(env, token, '/series', body(), { 'Idempotency-Key': 'mail-once' });
    await post(env, token, '/series', body(), { 'Idempotency-Key': 'mail-once' });
    expect(sent()).toHaveLength(1);
  });

  it('request: the demo identity sends nothing', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET ContactEmail = 'sitter@pr.example' WHERE Id = 'tnt_pawsandrelax'`);
    const token = await demoToken(env, 'paws-and-relax');
    Object.assign(env, RESEND);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const demoPet = (
      raw
        .prepare(
          `SELECT p.Id FROM EndUserPets p JOIN EndUsers u ON u.Id = p.EndUserId
            WHERE u.TenantId = 'tnt_pawsandrelax' AND u.Email = 'demo@pawservation.com'`,
        )
        .get() as { Id: string }
    ).Id;
    const res = await post(
      env,
      token,
      '/series',
      body({ petIds: [demoPet] }),
      {},
      'paws-and-relax',
    );
    expect(res.status).toBe(201);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('api.resend.com'))).toHaveLength(0);
  });
});
