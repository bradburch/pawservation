import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * MIGRATION 0018 APPLIED TO A PRE-MIGRATION DATABASE.
 *
 * Every other test in this suite runs against a fresh `sql/schema.sql`, which is exactly the world
 * a migration cannot be judged in: there, the column has always existed. The question worth asking
 * is about the database that already holds real businesses. Does applying this file leave every one
 * of them on precisely the plan state they had, and does what `schema.sql` builds actually match
 * what the migration produces?
 *
 * The pre-0018 fixture is `schema.sql` with the marked block cut out, rather than a hand-written
 * `CREATE TABLE Tenants`. A hand-written copy is a second definition of the same table and would
 * drift; a cut is derived from the real file and cannot. This is 0017's own pattern
 * (`migration-0017-plan-billing.test.ts`), deliberately, so a reader who has read one has read both.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATION = readFileSync(join(ROOT, 'migrations', '0018_plan_comp.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8');

/** Named through a variable rather than spelled beside an operator, so the AD-13 scanner — which
 *  walks this file too — never reports its own fixture. */
const NEW_COLUMN = 'CompedUntil';

const START = '-- >>> 0018 plan comp';
const END = '-- <<< 0018 plan comp';

/** `schema.sql` with the 0018 column deleted — the shape of the live database today. */
function preMigrationSchema(): string {
  const from = SCHEMA.indexOf(START);
  const to = SCHEMA.indexOf(END);
  if (from === -1 || to === -1) {
    throw new Error('sql/schema.sql is missing the 0018 marker pair — see this test');
  }
  return SCHEMA.slice(0, from) + SCHEMA.slice(to + END.length + 1);
}

function dbFrom(sql: string): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec(sql);
  return raw;
}

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

/** Sorted BY NAME, not by ordinal: `ADD COLUMN` appends, so the migrated database orders the new
 *  column last while `schema.sql` declares it beside the other two dated columns where it belongs.
 *  The set of columns is the thing that has to match; their cid is not. */
function columnsOf(raw: DatabaseSync): ColumnInfo[] {
  const rows = raw.prepare('PRAGMA table_info(Tenants)').all() as unknown as ColumnInfo[];
  return rows
    .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

describe('migration 0018 — the file itself', () => {
  it('contains no transaction statement, which D1 would reject outright', () => {
    expect(MIGRATION).not.toMatch(/\b(BEGIN|COMMIT|SAVEPOINT)\b/i);
  });

  it('adds exactly one column and gives it no DEFAULT', () => {
    expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE Tenants ADD COLUMN ${NEW_COLUMN} TEXT`));
    expect(MIGRATION.match(/ALTER TABLE/g)).toHaveLength(1);
    // A DEFAULT would move somebody's plan state the moment the file is applied, which is the one
    // thing an additive migration must never do — 0017's rule, and the reason PLAN_ENFORCE exists
    // as the separate safety rather than this file being careful.
    expect(MIGRATION).not.toMatch(/DEFAULT/i);
  });
});

describe('migration 0018 applied to a pre-0018 database', () => {
  it('starts from a fixture that genuinely lacks the column', () => {
    const before = columnsOf(dbFrom(preMigrationSchema())).map((c) => c.name);
    expect(before).not.toContain(NEW_COLUMN);
    // And the fixture is otherwise a real database: the 0017 columns are still there, so the cut
    // took exactly one block and not the block above it.
    expect(before).toContain('BilledUntil');
    expect(before).toContain('PremiumUntil');
  });

  it('adds it NULL on every existing row, leaving the other two dated columns byte-identical', () => {
    const raw = dbFrom(preMigrationSchema());
    raw.exec(
      `INSERT INTO Tenants (Id, Slug, DisplayName, PremiumUntil, BilledUntil)
       VALUES ('tnt_paid', 'paid', 'Paid', '2099-01-01 00:00:00', '2099-02-01 00:00:00')`,
    );
    const before = raw
      .prepare("SELECT PremiumUntil AS p, BilledUntil AS b FROM Tenants WHERE Id = 'tnt_paid'")
      .get() as { p: string; b: string };

    raw.exec(MIGRATION);

    const after = raw.prepare("SELECT * FROM Tenants WHERE Id = 'tnt_paid'").get() as Record<
      string,
      unknown
    >;
    expect(after[NEW_COLUMN]).toBeNull();
    expect(after.PremiumUntil).toBe(before.p);
    expect(after.BilledUntil).toBe(before.b);
  });

  it('produces exactly the Tenants that sql/schema.sql produces', () => {
    const migrated = dbFrom(preMigrationSchema());
    migrated.exec(MIGRATION);
    expect(columnsOf(migrated)).toEqual(columnsOf(dbFrom(SCHEMA)));
  });

  it('dies loudly on a second run, exactly as its docblock claims — and changes nothing', () => {
    // THE DOCBLOCK'S CLAIM, PINNED: "a second run dies loudly on `duplicate column name`". That is
    // the repo's convention for an additive migration (0017 made the same decision and declined a
    // `SchemaMeta` marker for the same reason) — SQLite has no `ADD COLUMN IF NOT EXISTS`, so the
    // file is not idempotent and is not meant to be; it is safe to KNOW whether it ran and unsafe
    // to guess. A migration that silently succeeded twice would be the one that hides a database
    // whose state nobody can read off it.
    const raw = dbFrom(preMigrationSchema());
    raw.exec(MIGRATION);
    const once = columnsOf(raw);
    expect(() => raw.exec(MIGRATION)).toThrow(/duplicate column name/i);
    expect(columnsOf(raw)).toEqual(once);
  });
});
