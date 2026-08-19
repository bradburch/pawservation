import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  addBookingPets,
  getTenantBySlug,
  insertAccountPayment,
  insertBookingRequest,
  insertInvitedCustomer,
} from '../db/repo';
import {
  MAX_LATE_PAYMENT_DAYS,
  MAX_SPILL_DAYS,
  proposeAttribution,
  type UnpaidBooking,
} from '../lib/payment-attribution';
import { adminHeaders, createTestEnv, seedPets, TENANT_A } from './helpers';

/**
 * `Tenants.AttributionSpillDays` (migration 0014) — how far back ONE payment may reach to cover
 * stays EARLIER than the one it most closely matches. The bound on a SPILL, i.e. on the second and
 * later stays a credit funds; the primary match is governed by `MAX_LATE_PAYMENT_DAYS` /
 * `MAX_PREPAYMENT_DAYS` and is untouched by this setting.
 *
 * WHY IT IS PER-TENANT AT ALL. The number was 14, hardcoded, calibrated against one sitter whose
 * clients pay weekly — and at 14 the feature is unusable for a sitter who invoices monthly. A $480
 * payment covering twelve $40 walks across a month settles the nearest walk and then refuses every
 * walk more than a fortnight back, so most of every monthly payment falls out as remainder — and
 * PERMANENTLY, because the remainder row inherits the source `PaidDate`, so re-attributing it
 * reproduces the same refusal. The load-bearing spill rule is FULL SETTLEMENT, not distance
 * (`MAX_SPILL_DAYS`'s own comment already concedes the measured cases are separated by coverage and
 * not by days); the distance bound exists because the sitter asked for one, and a bound one sitter
 * asked for is exactly the kind of rule that belongs on her own tenant row.
 *
 * THE DEFAULT IS 14 — `MAX_SPILL_DAYS`, still the single place the number is written in TypeScript
 * — so applying 0014 changes no tenant's proposals. The upper bound is `MAX_LATE_PAYMENT_DAYS`
 * (90): a spill target further out than the primary window can never be a candidate in the first
 * place, so a larger value would be silently inert, which is worse than refused.
 */

const MIGRATION = readFileSync(
  join(import.meta.dirname, '..', '..', 'migrations', '0014_attribution_spill_days.sql'),
  'utf8',
);

/**
 * THE MONTHLY INVOICER, as a fixture: twelve $40 walks spread across D1–D28 of one month, settled
 * by a single $480 transfer on D35. Every walk is inside `MAX_LATE_PAYMENT_DAYS`, so the primary
 * window is not what decides anything here — only the spill bound is. Distances from the payment
 * are 7, 11, 13, 16, 18, 20, 23, 25, 27, 30, 32 and 34 days, all distinct, so nothing ties and
 * nothing is refused as ambiguous.
 */
const MONTHLY_WALKS = [
  '2026-06-01',
  '2026-06-03',
  '2026-06-05',
  '2026-06-08',
  '2026-06-10',
  '2026-06-12',
  '2026-06-15',
  '2026-06-17',
  '2026-06-19',
  '2026-06-22',
  '2026-06-24',
  '2026-06-28',
];
const MONTHLY_PAID = '2026-07-05';
const MONTHLY_TOTAL = 480;
/** 06-28 (7 days out), 06-24 (11) and 06-22 (13) are the only walks within the default 14. */
const FUNDED_AT_DEFAULT = 3;

const monthlyBookings = (): UnpaidBooking[] =>
  MONTHLY_WALKS.map((startDate, i) => ({
    bookingId: `w${String(i).padStart(2, '0')}`,
    startDate,
    endDate: null,
    outstanding: 40,
  }));

const monthlyCredit = { paymentId: 'pay_monthly', amount: MONTHLY_TOTAL, paidDate: MONTHLY_PAID };

describe('proposeAttribution — the spill window is an argument with a default of MAX_SPILL_DAYS', () => {
  it('defaults to MAX_SPILL_DAYS when no window is passed — today’s behaviour, unchanged', () => {
    // ** THE DEFAULT LOCK ON THE PURE FUNCTION. ** Raise or lower the default and this fails: a
    // caller that says nothing about the window must get exactly the 14-day rule every existing
    // caller and every existing test was written against.
    const out = proposeAttribution(monthlyCredit, monthlyBookings());
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.splits.map((s) => s.bookingId)).toEqual(['w11', 'w10', 'w09']);
    expect(out.remainder).toBe(MONTHLY_TOTAL - FUNDED_AT_DEFAULT * 40);
    // Three quarters of a monthly invoice left unplaced — the failure this setting exists for.
    expect(out.remainder).toBeGreaterThan(MONTHLY_TOTAL / 2);
  });

  it('passing MAX_SPILL_DAYS explicitly is identical to passing nothing', () => {
    expect(proposeAttribution(monthlyCredit, monthlyBookings(), undefined, MAX_SPILL_DAYS)).toEqual(
      proposeAttribution(monthlyCredit, monthlyBookings()),
    );
  });

  it('funds every walk of the month once the window is widened to 45', () => {
    // ** THE POINT OF THE WHOLE CHANGE. ** Ignore the argument and keep reading the module
    // constant, and this fails: the farthest walk is 34 days out.
    const out = proposeAttribution(monthlyCredit, monthlyBookings(), undefined, 45);
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.splits).toHaveLength(MONTHLY_WALKS.length);
    expect(out.splits.reduce((sum, s) => sum + s.amount, 0)).toBe(MONTHLY_TOTAL);
    expect(out.remainder).toBe(0);
  });

  it('a window of 0 funds the primary match and nothing else', () => {
    // 0 is a meaningful value, not "unset": one payment settles one stay, never a batch. It must
    // NOT be read as falsy-therefore-default — that mutation makes this test fail.
    const out = proposeAttribution(monthlyCredit, monthlyBookings(), undefined, 0);
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.splits).toEqual([{ bookingId: 'w11', amount: 40 }]);
    expect(out.remainder).toBe(MONTHLY_TOTAL - 40);
  });

  it('a wider window still cannot reach past the PRIMARY window, which it does not touch', () => {
    // A stay outside `MAX_LATE_PAYMENT_DAYS` is dropped before spill is ever considered, so the
    // widest legal setting cannot resurrect it. This is why the CHECK's ceiling is 90: anything
    // above it would be silently inert.
    const out = proposeAttribution(
      { paymentId: 'p', amount: 80, paidDate: '2026-07-05' },
      [
        { bookingId: 'near', startDate: '2026-07-04', endDate: null, outstanding: 40 },
        { bookingId: 'ancient', startDate: '2026-01-01', endDate: null, outstanding: 40 },
      ],
      undefined,
      MAX_LATE_PAYMENT_DAYS,
    );
    expect(out).toMatchObject({ ok: true });
    if (!out.ok) return;
    expect(out.splits).toEqual([{ bookingId: 'near', amount: 40 }]);
    expect(out.remainder).toBe(40);
  });

  it('the full-settlement rule still outranks the window — a widened one funds nothing partially', () => {
    // Widening the distance bound must not turn spill into "dribble whatever is left onto the next
    // stay": a leftover that cannot settle a spill target in full still stops there.
    const out = proposeAttribution(
      { paymentId: 'p', amount: 50, paidDate: '2026-07-05' },
      [
        { bookingId: 'near', startDate: '2026-07-04', endDate: null, outstanding: 40 },
        { bookingId: 'far', startDate: '2026-06-10', endDate: null, outstanding: 100 },
      ],
      undefined,
      45,
    );
    expect(out).toEqual({
      ok: true,
      paymentId: 'p',
      splits: [{ bookingId: 'near', amount: 40 }],
      remainder: 10,
    });
  });
});

describe('Tenants.AttributionSpillDays — storage, the default, and the CHECK', () => {
  it('every seeded tenant reads MAX_SPILL_DAYS', async () => {
    // ** THE DEFAULT LOCK ON THE COLUMN. ** Change the SQL DEFAULT and this fails — which is what
    // keeps the schema's 14 and the module's `MAX_SPILL_DAYS` from drifting apart, given SQL cannot
    // import the constant.
    const { env } = createTestEnv();
    for (const slug of ['sunny-paws', 'happy-tails', 'paws-and-relax']) {
      const t = await getTenantBySlug(env.PAWSERVATION_DB, slug);
      expect(t!.AttributionSpillDays).toBe(MAX_SPILL_DAYS);
    }
  });

  it('stamps 14 — not NULL — on a tenant row that predates the column', () => {
    // A fresh schema.sql having the right default says nothing about a database that already has
    // rows, which is every real one. Rewind a real database to the pre-0014 shape, apply the REAL
    // migration file, and ask what the tenants already sitting there now read.
    const { raw } = createTestEnv();
    raw.exec('ALTER TABLE Tenants DROP COLUMN AttributionSpillDays;');
    const before = raw.prepare('SELECT * FROM Tenants ORDER BY Id').all();
    expect(before.length).toBeGreaterThan(0);
    expect(before[0]).not.toHaveProperty('AttributionSpillDays');

    raw.exec(MIGRATION);

    const after = raw.prepare('SELECT * FROM Tenants ORDER BY Id').all();
    // Same rows, same values, plus exactly one new column reading 14 on every one of them: a
    // business that never chose a window keeps the one it has always had.
    expect(after).toEqual(before.map((row) => ({ ...row, AttributionSpillDays: MAX_SPILL_DAYS })));
  });

  it('refuses a value outside the range at the database itself', () => {
    const { raw } = createTestEnv();
    for (const bad of [-1, MAX_LATE_PAYMENT_DAYS + 1, 365]) {
      expect(() =>
        raw.exec(`UPDATE Tenants SET AttributionSpillDays = ${bad} WHERE Id = '${TENANT_A}'`),
      ).toThrow();
    }
  });

  it('accepts both ends of the range at the database itself', () => {
    const { raw } = createTestEnv();
    for (const good of [0, MAX_LATE_PAYMENT_DAYS]) {
      expect(() =>
        raw.exec(`UPDATE Tenants SET AttributionSpillDays = ${good} WHERE Id = '${TENANT_A}'`),
      ).not.toThrow();
    }
  });
});

describe('PUT/GET /:slug/admin/settings — attributionSpillDays', () => {
  const put = async (env: Env, body: unknown): Promise<Response> =>
    app.request(
      '/api/sunny-paws/admin/settings',
      { method: 'PUT', headers: await adminHeaders(TENANT_A), body: JSON.stringify(body) },
      env,
    );

  const stored = async (env: Env): Promise<number> =>
    (await getTenantBySlug(env.PAWSERVATION_DB, 'sunny-paws'))!.AttributionSpillDays;

  it('round-trips a chosen value, and publishes it back on the GET', async () => {
    const { env } = createTestEnv();
    expect((await put(env, { attributionSpillDays: 45 })).status).toBe(204);
    expect(await stored(env)).toBe(45);

    const settings = (await (
      await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as { attributionSpillDays: number };
    // The admin renders the sitter's stored choice; a GET that omitted it would render the default
    // and then save that default back over her choice on her next unrelated edit.
    expect(settings.attributionSpillDays).toBe(45);

    expect((await put(env, { attributionSpillDays: 0 })).status).toBe(204);
    expect(await stored(env)).toBe(0);
  });

  it('refuses a value above the primary window rather than clamping it', async () => {
    const { env } = createTestEnv();
    expect((await put(env, { attributionSpillDays: 45 })).status).toBe(204);
    expect((await put(env, { attributionSpillDays: MAX_LATE_PAYMENT_DAYS + 1 })).status).toBe(400);
    expect(await stored(env)).toBe(45);
    expect((await put(env, { attributionSpillDays: MAX_LATE_PAYMENT_DAYS })).status).toBe(204);
    expect(await stored(env)).toBe(MAX_LATE_PAYMENT_DAYS);
  });

  it('refuses a non-integer, a negative and a non-number rather than coercing', async () => {
    const { env } = createTestEnv();
    expect((await put(env, { attributionSpillDays: 45 })).status).toBe(204);
    for (const bad of [-1, 14.5, '14', '', true, null, {}, NaN]) {
      // 400, and — just as important — the tenant's real choice is still standing. Coercing an
      // unusable value would quietly undo a setting the request never meant to change.
      expect((await put(env, { attributionSpillDays: bad })).status).toBe(400);
      expect(await stored(env)).toBe(45);
    }
  });

  it('leaves a stored choice alone when the field is omitted entirely', async () => {
    // ** THE HAZARD `updateTenantSettings`'s own comment warns about. ** That UPDATE overwrites the
    // column unconditionally, so a PUT that says nothing about the window — the admin app's every
    // other save, and every partial PATCH — must carry the tenant's CURRENT value through, not a
    // default. Getting this wrong silently reverts her to 14 the next time she edits her colour.
    const { env } = createTestEnv();
    expect((await put(env, { attributionSpillDays: 45 })).status).toBe(204);
    expect((await put(env, { displayName: 'Sunny Paws Pet Care' })).status).toBe(204);
    expect(await stored(env)).toBe(45);
  });
});

/**
 * The wiring, end to end: the setting lives on the tenant row the preview route has ALREADY loaded,
 * and it must reach the pure proposer from there. The proposer's own arithmetic is proved above;
 * these prove the split a sitter is shown is computed under HER stored window.
 */
describe('the attribution preview reads the tenant’s stored spill window', () => {
  const TENANT_C = 'tnt_pawsandrelax';
  const SLUG_C = 'paws-and-relax';

  async function monthlyHousehold(env: Env, raw: DatabaseSync): Promise<void> {
    const owner = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'monthly@example.com',
      'monthly',
    );
    const petIds = seedPets(raw, TENANT_C, owner.Id, [{ id: 'p_monthly', petType: 'dog' }]);
    for (const startDate of MONTHLY_WALKS) {
      const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_C, {
        endUserId: owner.Id,
        serviceType: 'walk',
        startDate,
        endDate: null,
        optionKey: 'standard',
        petCount: 1,
        estCost: 40,
        status: 'confirmed',
      });
      await addBookingPets(env.PAWSERVATION_DB, TENANT_C, id, petIds);
    }
    await insertAccountPayment(env.PAWSERVATION_DB, TENANT_C, {
      accountId: petIds[0],
      amount: MONTHLY_TOTAL,
      method: 'venmo',
      paidDate: MONTHLY_PAID,
      note: null,
      externalRef: null,
    });
  }

  async function preview(env: Env): Promise<{ splits: number; remainder: number }> {
    const res = await app.request(
      `/api/${SLUG_C}/admin/payments/attribute/preview`,
      { method: 'POST', headers: await adminHeaders(TENANT_C), body: JSON.stringify({}) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposals: { splits: unknown[]; remainder: number }[];
    };
    expect(body.proposals).toHaveLength(1);
    return { splits: body.proposals[0].splits.length, remainder: body.proposals[0].remainder };
  }

  it('leaves most of a monthly payment as remainder under the default', async () => {
    const { env, raw } = createTestEnv();
    await monthlyHousehold(env, raw);
    expect(await preview(env)).toEqual({
      splits: FUNDED_AT_DEFAULT,
      remainder: MONTHLY_TOTAL - FUNDED_AT_DEFAULT * 40,
    });
  });

  it('funds the whole month once the sitter widens her window to 45', async () => {
    const { env, raw } = createTestEnv();
    await monthlyHousehold(env, raw);
    const res = await app.request(
      `/api/${SLUG_C}/admin/settings`,
      {
        method: 'PUT',
        headers: await adminHeaders(TENANT_C),
        body: JSON.stringify({ attributionSpillDays: 45 }),
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(await preview(env)).toEqual({ splits: MONTHLY_WALKS.length, remainder: 0 });
  });
});
