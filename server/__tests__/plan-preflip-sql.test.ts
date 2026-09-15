import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isDisabled, isPlanCurrent, premiumNow } from '../lib/premium';
import { createTestEnv } from './helpers';

/**
 * THE PRE-FLIP SQL IS A FOURTH COPY OF THE RULE, and this is what keeps it the same rule.
 *
 * `isPlanCurrent` (server/lib/premium.ts) is the one expression allowed to decide whether a business
 * holds a current plan, and the AD-13 scanner refuses a second one anywhere under `server/` or
 * `app/`. The runbook in README.md then hands the platform owner a `SELECT` to run BY HAND before
 * setting `PLAN_ENFORCE` — "every row it returns is a business whose dashboard goes read-only" — and
 * that sentence is a claim that the SQL and the predicate agree on every row. Nothing checked it.
 *
 * So this file READS THE SQL OUT OF THE README — it spells no comparison of its own, which is what
 * keeps the scanner green over it — seeds every combination of the three dated columns (null, past,
 * future) with the account switched on and off, runs the README's own statement over them, and
 * asserts: a slug comes back EXACTLY when the account is on and `isPlanCurrent` says false. Edit the
 * runbook's SQL and this test says whether the predicate still agrees; edit the predicate and it
 * says whether the runbook does.
 */

const README = readFileSync(join(import.meta.dirname, '..', '..', 'README.md'), 'utf8');

/** The statement between the quotes of the runbook's `--command`, whitespace collapsed. */
function preflipSql(): string {
  const block = /--command \\\n\s*"([\s\S]*?)"/.exec(README);
  if (!block) throw new Error('README.md no longer carries the pre-flip check — see this test');
  return block[1].replace(/\s+/g, ' ').trim();
}

const STATES = ['null', 'past', 'future'] as const;
type State = (typeof STATES)[number];

const value = (state: State, now: Date): string | null =>
  state === 'null'
    ? null
    : premiumNow(new Date(now.getTime() + (state === 'past' ? -1 : 1) * 3_600_000));

describe('the README’s pre-flip SELECT agrees with isPlanCurrent on every row', () => {
  it('reads a real SELECT over Tenants out of the runbook', () => {
    const sql = preflipSql();
    expect(sql).toMatch(/^SELECT Slug FROM Tenants WHERE /);
    expect(sql).toContain("datetime('now')");
  });

  it('returns a slug exactly when the account is on and the predicate says not current', async () => {
    const { env, raw } = createTestEnv();
    // The harness's own two tenants stay (they hold child rows) and are filtered out of the answer
    // by the matrix's prefix — which also makes the seeded book a live control: both hold no grant,
    // so the runbook lists them, as it will list every un-comped demo tenant in production.
    const now = new Date();
    const expected = new Set<string>();
    let seeded = 0;
    for (const billed of STATES)
      for (const comped of STATES)
        for (const premium of STATES)
          for (const disabled of [false, true]) {
            const slug = `m-${billed}-${comped}-${premium}-${disabled ? 'off' : 'on'}`;
            const row = {
              DisabledAt: disabled ? premiumNow(now) : null,
              Plan: billed === 'null' ? null : ('solo' as const),
              BilledUntil: value(billed, now),
              CompedUntil: value(comped, now),
              PremiumUntil: value(premium, now),
            };
            raw
              .prepare(
                `INSERT INTO Tenants (Id, Slug, DisplayName, DisabledAt, Plan, BilledUntil, CompedUntil, PremiumUntil)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                `tnt_${slug}`,
                slug,
                slug,
                row.DisabledAt,
                row.Plan,
                row.BilledUntil,
                row.CompedUntil,
                row.PremiumUntil,
              );
            seeded += 1;
            if (!isDisabled(row) && !isPlanCurrent(row, now)) expected.add(slug);
          }
    expect(seeded).toBe(54);
    // NOT VACUOUS in either direction: some rows come back and some do not.
    expect(expected.size).toBeGreaterThan(0);
    expect(expected.size).toBeLessThan(seeded);

    const { results } = await env.PAWSERVATION_DB.prepare(preflipSql()).all<{ Slug: string }>();
    const slugs = results.map((r) => r.Slug);
    expect(slugs).toContain('sunny-paws'); // the control: an un-comped seeded tenant is listed
    expect(new Set(slugs.filter((slug) => slug.startsWith('m-')))).toEqual(expected);
    // Spelled out, so a reader can see the shape of the agreement without re-deriving it: the
    // 8 rows with three nulls or three past instants, switched on, and no others.
    expect(expected.size).toBe(8);
  });
});
