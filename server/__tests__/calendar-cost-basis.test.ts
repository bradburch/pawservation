import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { getTenantBySlug, setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { adminHeaders, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Classified } from '../lib/calendar-backfill';

/**
 * `Tenants.CalendarCostBasis` (migration 0013) — how a description `Cost:` on a RANGE-shaped
 * service (boarding, house sitting) is read when the calendar backfill adopts an event.
 *
 *   'total'     — the figure is the whole charge for the stay. THE DEFAULT.
 *   'per-night' — the figure is a nightly rate, multiplied by the stay's nights.
 *
 * WHY 'total' IS THE DEFAULT, and why that is not merely a compatibility choice: the two ways of
 * being wrong are not symmetric. Reading a total as a per-night rate triples a 3-night stay and
 * OVERCHARGES A REAL CLIENT — money taken from someone who never agreed to it. Reading a
 * per-night rate as a total undercharges the sitter, which is her own revenue to forgo and her own
 * setting to change. When the stored setting is wrong, the harm must fall on the party who owns
 * the setting. 'total' is also the behaviour every tenant had before per-night multiplication
 * existed, so applying 0013 moves nobody's money until someone chooses it.
 *
 * A SINGLE-shaped service (a walk, a drop-in) has no nights to bill: its `Cost:` is the whole
 * charge under BOTH values, and the setting must never reach that path. Proved in
 * `calendar-backfill.test.ts` against the pure classifier and again end-to-end below.
 */

const MIGRATION = readFileSync(
  join(import.meta.dirname, '..', '..', 'migrations', '0013_calendar_cost_basis.sql'),
  'utf8',
);

describe('Tenants.CalendarCostBasis — storage and the default', () => {
  it("every seeded tenant reads 'total', the safe interpretation", async () => {
    // ** THE DEFAULT LOCK. ** Flip the column's DEFAULT to 'per-night' and this fails — which is
    // the point: that flip would silently multiply every existing tenant's adopted stays by their
    // own length, billing clients for money nobody quoted them.
    const { env } = createTestEnv();
    for (const slug of ['sunny-paws', 'happy-tails', 'paws-and-relax']) {
      const t = await getTenantBySlug(env.PAWSERVATION_DB, slug);
      expect(t!.CalendarCostBasis).toBe('total');
    }
  });

  it("stamps 'total' — not NULL — on a tenant row that predates the column", () => {
    // A FRESH schema.sql having the right default says nothing about a database that already has
    // rows, which is every real one. So rewind a real database to the pre-0013 shape, apply the
    // REAL migration file, and ask what the tenants that were already sitting there now read.
    const { raw } = createTestEnv();
    raw.exec('ALTER TABLE Tenants DROP COLUMN CalendarCostBasis;');
    const before = raw.prepare('SELECT * FROM Tenants ORDER BY Id').all();
    expect(before.length).toBeGreaterThan(0);
    expect(before[0]).not.toHaveProperty('CalendarCostBasis');

    raw.exec(MIGRATION);

    const after = raw.prepare('SELECT * FROM Tenants ORDER BY Id').all();
    // Same rows, same values, plus exactly one new column reading 'total' on every one of them:
    // a business that never chose an interpretation keeps the one it has always had.
    expect(after).toEqual(before.map((row) => ({ ...row, CalendarCostBasis: 'total' })));
  });

  it('refuses a value outside the union at the database itself', () => {
    const { raw } = createTestEnv();
    expect(() =>
      raw.exec(`UPDATE Tenants SET CalendarCostBasis = 'per-week' WHERE Id = '${TENANT_A}'`),
    ).toThrow();
  });
});

describe('PUT/GET /:slug/admin/settings — calendarCostBasis', () => {
  const put = async (env: Env, body: unknown): Promise<Response> =>
    app.request(
      '/api/sunny-paws/admin/settings',
      { method: 'PUT', headers: await adminHeaders(TENANT_A), body: JSON.stringify(body) },
      env,
    );

  const stored = async (env: Env): Promise<string> =>
    (await getTenantBySlug(env.PAWSERVATION_DB, 'sunny-paws'))!.CalendarCostBasis;

  it('round-trips a chosen value, and publishes it back on the GET', async () => {
    const { env } = createTestEnv();
    expect((await put(env, { calendarCostBasis: 'per-night' })).status).toBe(204);
    expect(await stored(env)).toBe('per-night');

    const settings = (await (
      await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as { calendarCostBasis: string };
    // The admin UI renders the sitter's stored choice; a GET that omitted it would render the
    // default and then save that default back over her choice on her next unrelated edit.
    expect(settings.calendarCostBasis).toBe('per-night');

    expect((await put(env, { calendarCostBasis: 'total' })).status).toBe(204);
    expect(await stored(env)).toBe('total');
  });

  it('refuses anything outside the two values rather than coercing it', async () => {
    const { env } = createTestEnv();
    expect((await put(env, { calendarCostBasis: 'per-night' })).status).toBe(204);
    for (const bad of ['per-week', 'PER-NIGHT', '', 0, 1, true, null, {}]) {
      // 400, and — just as important — the tenant's real choice is still standing. Coercing an
      // unrecognised value to the default would quietly undo a setting the request never named.
      expect((await put(env, { calendarCostBasis: bad })).status).toBe(400);
      expect(await stored(env)).toBe('per-night');
    }
  });

  it('leaves a stored choice alone when the field is omitted entirely', async () => {
    // ** THE HAZARD `updateTenantSettings`'s own comment warns about. ** That UPDATE overwrites
    // this column unconditionally, so a PUT that says nothing about the cost basis — the admin
    // app's every other save, and every partial PATCH — must carry the tenant's CURRENT value
    // through, not a default. Getting this wrong silently reverts the sitter's choice on the next
    // time she changes her brand colour.
    const { env } = createTestEnv();
    expect((await put(env, { calendarCostBasis: 'per-night' })).status).toBe(204);
    expect((await put(env, { displayName: 'Sunny Paws Pet Care' })).status).toBe(204);
    expect(await stored(env)).toBe('per-night');
  });
});

/**
 * The wiring, end to end: the setting lives on the tenant row the backfill route has ALREADY
 * loaded, and it must reach the pure classifier from there. The classifier's own arithmetic is
 * proved in `calendar-backfill.test.ts`; what these prove is that the number the sitter sees in
 * the preview is computed under HER stored choice rather than a hardcoded convention.
 */
describe('the backfill preview reads the tenant’s stored cost basis', () => {
  async function connectCalendar(env: Env) {
    await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
      access: await encryptToken(TEST_SECRET, 'access-1'),
      refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
      expiresAt: '2030-01-01T00:00:00Z',
      calendarId: 'primary',
    });
  }

  /** Bella (dog, seeded for sunny-paws) — a 3-night boarding and a one-day walk, each carrying a
   *  sitter-typed `Cost:` in its description. */
  function mockCalendar() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'ev_board',
                summary: 'Bella Boarding',
                description: 'Cost: 100',
                status: 'confirmed',
                updated: '2026-07-27T00:00:00Z',
                start: { date: '2026-06-10' },
                end: { date: '2026-06-13' },
              },
              {
                id: 'ev_walk',
                // Deliberately spanning three days: a walk is SINGLE-shaped, so there are no
                // nights whatever the calendar says, and a per-night multiplication that skipped
                // the shape gate would read $120 here.
                summary: 'Bella Walk',
                description: 'Cost: 40',
                status: 'confirmed',
                updated: '2026-07-27T00:00:00Z',
                start: { date: '2026-06-15' },
                end: { date: '2026-06-18' },
              },
            ],
          }),
          { status: 200 },
        ),
    );
  }

  async function previewCosts(env: Env): Promise<Record<string, number>> {
    const res = await app.request(
      '/api/sunny-paws/admin/calendar/backfill/preview',
      {
        method: 'POST',
        headers: await adminHeaders(TENANT_A),
        body: JSON.stringify({ from: '2026-06-01', to: '2026-06-30' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { adopt: Classified[] };
    return Object.fromEntries(
      body.adopt.map((row) => [row.eventId, (row as { estCost: number }).estCost]),
    );
  }

  it('adopts a 3-night boarding at the typed figure under the default', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    mockCalendar();
    // Nothing has touched the setting: `Cost: 100` is $100 for the whole stay.
    expect(await previewCosts(env)).toEqual({ ev_board: 100, ev_walk: 40 });
    vi.restoreAllMocks();
  });

  it('adopts the same boarding at 3x once the sitter chooses per-night — the walk unmoved', async () => {
    const { env } = createTestEnv();
    await connectCalendar(env);
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await adminHeaders(TENANT_A),
        body: JSON.stringify({ calendarCostBasis: 'per-night' }),
      },
      env,
    );
    expect(res.status).toBe(204);
    mockCalendar();
    // The boarding triples; the WALK is single-shaped and has no nights, so its figure is the
    // whole charge under either setting and must not move.
    expect(await previewCosts(env)).toEqual({ ev_board: 300, ev_walk: 40 });
    vi.restoreAllMocks();
  });
});
