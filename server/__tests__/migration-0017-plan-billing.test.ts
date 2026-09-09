import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * MIGRATION 0017 APPLIED TO A PRE-MIGRATION DATABASE.
 *
 * Every other test in this suite runs against a fresh `sql/schema.sql`, which is exactly the world
 * a migration cannot be judged in: there, the five columns have always existed. The questions worth
 * asking are about the database that already holds real sitters. Does applying this file leave
 * every one of them on precisely the entitlement they had? Does it leave `PremiumUntil` untouched?
 * And does what `schema.sql` builds actually match what the migration produces — which nothing in
 * this repo checks today, per-migration parity being the only kind it has.
 *
 * The pre-0017 fixture is `schema.sql` with the marked block cut out, rather than a hand-written
 * `CREATE TABLE Tenants`. A hand-written copy is a second definition of the same table, and it
 * would drift; a cut is derived from the real file and cannot.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const MIGRATION = readFileSync(join(ROOT, 'migrations', '0017_plan_billing.sql'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'sql', 'schema.sql'), 'utf8');

const NEW_COLUMNS = [
  'Plan',
  'BilledUntil',
  'StripeCustomerId',
  'StripeSubscriptionId',
  'LastBillingEventAt',
];

const START = '-- >>> 0017 plan billing';
const END = '-- <<< 0017 plan billing';

/** `schema.sql` with the five 0017 columns deleted — the shape of the live database today. */
function preMigrationSchema(): string {
  const from = SCHEMA.indexOf(START);
  const to = SCHEMA.indexOf(END);
  if (from === -1 || to === -1) {
    throw new Error('sql/schema.sql is missing the 0017 marker pair — see this test');
  }
  return SCHEMA.slice(0, from) + SCHEMA.slice(to + END.length + 1);
}

function dbFrom(sql: string): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec(sql);
  return raw;
}

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

/** Sorted BY NAME, not by ordinal: `ADD COLUMN` appends, so the migrated database orders the five
 *  after `CreatedAt` while `schema.sql` declares them beside `PremiumUntil` where they belong. The
 *  set of columns is the thing that has to match; their cid is not. */
function columnsOf(raw: DatabaseSync): ColumnInfo[] {
  const rows = raw.prepare('PRAGMA table_info(Tenants)').all() as unknown as ColumnInfo[];
  return rows
    .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const tableSql = (raw: DatabaseSync): string =>
  (
    raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='Tenants'").get() as {
      sql: string;
    }
  ).sql;

describe('migration 0017 — the file itself', () => {
  it('contains no transaction statement, which D1 would reject outright', () => {
    expect(MIGRATION).not.toMatch(/\b(BEGIN|COMMIT|SAVEPOINT)\b/i);
  });

  it('adds five columns and gives none of them a DEFAULT', () => {
    for (const column of NEW_COLUMNS) {
      expect(MIGRATION).toMatch(new RegExp(`ALTER TABLE Tenants ADD COLUMN ${column} TEXT`));
    }
    expect(MIGRATION).not.toMatch(/DEFAULT/i);
  });
});

describe('migration 0017 applied to a pre-0017 database', () => {
  it('starts from a fixture that genuinely lacks the five columns', () => {
    const before = columnsOf(dbFrom(preMigrationSchema())).map((c) => c.name);
    for (const column of NEW_COLUMNS) expect(before).not.toContain(column);
  });

  it('adds all five, NULL on every existing row, and leaves PremiumUntil byte-identical', () => {
    const raw = dbFrom(preMigrationSchema());
    raw.exec(
      `INSERT INTO Tenants (Id, Slug, DisplayName, PremiumUntil)
       VALUES ('tnt_comped', 'comped', 'Comped', '2099-01-01 00:00:00')`,
    );
    const premiumBefore = (
      raw.prepare("SELECT PremiumUntil AS p FROM Tenants WHERE Id = 'tnt_comped'").get() as {
        p: string;
      }
    ).p;

    raw.exec(MIGRATION);

    const after = raw.prepare("SELECT * FROM Tenants WHERE Id = 'tnt_comped'").get() as Record<
      string,
      unknown
    >;
    for (const column of NEW_COLUMNS) expect(after[column]).toBeNull();
    expect(after.PremiumUntil).toBe(premiumBefore);
  });

  it('produces exactly the Tenants that sql/schema.sql produces', () => {
    const migrated = dbFrom(preMigrationSchema());
    migrated.exec(MIGRATION);
    expect(columnsOf(migrated)).toEqual(columnsOf(dbFrom(SCHEMA)));
  });

  it('carries the same CHECK on Plan through both routes into the database', () => {
    const migrated = dbFrom(preMigrationSchema());
    migrated.exec(MIGRATION);
    const constraint = "CHECK (Plan IS NULL OR Plan IN ('solo', 'pro'))";
    expect(tableSql(migrated)).toContain(constraint);
    expect(tableSql(dbFrom(SCHEMA))).toContain(constraint);
  });

  it('refuses a Plan outside the two values, at the database as well as at the route', () => {
    const raw = dbFrom(SCHEMA);
    raw.exec("INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('tnt_x', 'x', 'X')");
    expect(() => raw.exec("UPDATE Tenants SET Plan = 'enterprise' WHERE Id = 'tnt_x'")).toThrow();
    raw.exec("UPDATE Tenants SET Plan = 'solo' WHERE Id = 'tnt_x'");
  });
});
