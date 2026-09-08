import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

/**
 * MIGRATION 0015 APPLIED TO A PRE-MIGRATION DATABASE.
 *
 * Every other test in this suite runs against a FRESH `sql/schema.sql`, where the four money
 * columns have always held cents — which is precisely the world a data migration cannot be judged
 * in. 0015 changes no shape at all: it is four `UPDATE … * 100` statements, so the only questions
 * worth asking are the ones about VALUES. Does every stored figure move by exactly ×100, does a
 * NULL stay NULL rather than becoming 0, and are the RATE columns (whole dollars by design, and
 * deliberately not scaled) left alone? A ×100 that quietly filled in a NULL, or that caught a rate
 * table, would not fail anywhere — it would just make every subsequent balance wrong.
 *
 * So: a bare database built from `sql/schema.sql`, seeded with rows in the OLD unit, run through
 * the real migration file, and read back.
 *
 * AND the questions the `SchemaMeta.money_unit` marker exists to answer, which are about running
 * the file at the WRONG time rather than about any one value: a second run must change nothing
 * (the ×100 is not idempotent on its own, and its second application is silent), and a fresh
 * `schema.sql` database — already born in cents, and the world every other test in this suite
 * runs in — must come through untouched.
 */
const MIGRATION_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
  '0015_money_in_cents.sql',
);
const MIGRATION = readFileSync(MIGRATION_PATH, 'utf8');
const SCHEMA = readFileSync(join(import.meta.dirname, '..', '..', 'sql', 'schema.sql'), 'utf8');

const TENANT = 'tnt_premig';

/**
 * A database holding pre-0015 rows: every money column in WHOLE DOLLARS, the way the product wrote
 * them before this branch. Deliberately built from `schema.sql` alone rather than `createTestEnv`,
 * so the only money in here is money this file put there and an assertion cannot be satisfied by a
 * seed row that happened to have the right value.
 */
function preMigrationDb(): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec(SCHEMA);
  // `schema.sql` seeds the marker at 'cents' when — as here, at this point — the money tables are
  // empty, because a database it builds from nothing is born in cents. This fixture is
  // deliberately the OTHER world — a real database as it stands the moment before 0015
  // is hand-applied — so the marker is wound back to match the dollar rows seeded below. Winding
  // it back HERE rather than deleting the row keeps the fixture honest about which state it is:
  // 'dollars' is what an existing production database will read once 0015 creates the row.
  raw.exec(`UPDATE SchemaMeta SET Value = 'dollars' WHERE Key = 'money_unit'`);
  raw.exec(`
    INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('${TENANT}', 'premig', 'Pre-Migration');

    -- A $250 stay with no cancellation fee, and a $180 stay that was cancelled for $100.
    INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, EstCost, CancellationFee, Status)
    VALUES
      ('br_plain', '${TENANT}', 'boarding', '2026-06-01', '2026-06-06', 1, 250, NULL, 'confirmed'),
      ('br_cancelled', '${TENANT}', 'boarding', '2026-07-01', '2026-07-04', 1, 180, 100, 'cancelled');

    -- A $45 extra and a $75 payment, both against the plain stay.
    INSERT INTO BookingCharges (Id, TenantId, BookingRequestId, Label, Amount)
    VALUES ('bc_vet', '${TENANT}', 'br_plain', 'Vet visit', 45);

    INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate)
    VALUES ('pay_dep', '${TENANT}', 'br_plain', 75, 'cash', '2026-05-20');

    -- A RATE the sitter typed: $50 a night. 0015 must NOT touch this.
    INSERT INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, Rate)
    VALUES ('tso_std', '${TENANT}', 'boarding', 'standard', 'Standard', 50);
  `);
  return raw;
}

const one = <T>(raw: DatabaseSync, sql: string): T => raw.prepare(sql).get() as unknown as T;

/** The migration's own guard, read back — 'dollars' before, 'cents' after, and the only thing in
 *  the database that can tell those two states apart. */
const marker = (raw: DatabaseSync): unknown =>
  (one<{ Value: unknown }>(raw, `SELECT Value FROM SchemaMeta WHERE Key = 'money_unit'`) ?? {})
    .Value;

/** Every figure the migration can touch, in one comparable shape — so "changed nothing" is
 *  asserted over all four columns at once rather than one `expect` at a time. */
const all = (raw: DatabaseSync, sql: string): unknown[] =>
  raw.prepare(sql).all() as unknown as unknown[];
const money = (raw: DatabaseSync) => ({
  bookings: all(raw, 'SELECT Id, EstCost, CancellationFee FROM BookingRequests ORDER BY Id'),
  charges: all(raw, 'SELECT Id, Amount FROM BookingCharges ORDER BY Id'),
  payments: all(raw, 'SELECT Id, Amount FROM Payments ORDER BY Id'),
});

describe('migration 0015 (money in cents) against a pre-migration database', () => {
  it('multiplies every stored cost, fee, charge and payment by exactly 100', () => {
    const raw = preMigrationDb();
    raw.exec(MIGRATION);

    expect(one(raw, "SELECT EstCost FROM BookingRequests WHERE Id = 'br_plain'")).toEqual({
      EstCost: 25000,
    });
    expect(
      one(raw, "SELECT EstCost, CancellationFee FROM BookingRequests WHERE Id = 'br_cancelled'"),
    ).toEqual({ EstCost: 18000, CancellationFee: 10000 });
    expect(one(raw, "SELECT Amount FROM BookingCharges WHERE Id = 'bc_vet'")).toEqual({
      Amount: 4500,
    });
    expect(one(raw, "SELECT Amount FROM Payments WHERE Id = 'pay_dep'")).toEqual({ Amount: 7500 });
  });

  it('leaves a NULL cancellation fee NULL — "none assessed" is not "$0.00"', () => {
    // The `WHERE … IS NOT NULL` guard on the two BookingRequests statements. Without it SQLite
    // would leave the NULL alone anyway (NULL * 100 is NULL), but the guard is what makes that
    // intentional rather than incidental, and a fee of 0 is a DIFFERENT fact from no fee at all —
    // OUTSTANDING_WHERE_SQL reads a stored 0 as a receivable of nothing, and a NULL as no cancel.
    const raw = preMigrationDb();
    raw.exec(MIGRATION);
    expect(one(raw, "SELECT CancellationFee FROM BookingRequests WHERE Id = 'br_plain'")).toEqual({
      CancellationFee: null,
    });
  });

  it('does NOT scale a rate the sitter typed', () => {
    // Rates stay whole dollars (`estimateCost` is the single ×100 in the price path). A migration
    // that caught this column would multiply every future quote by 100 with nothing to notice it.
    const raw = preMigrationDb();
    raw.exec(MIGRATION);
    expect(one(raw, "SELECT Rate FROM TenantServiceOptions WHERE Id = 'tso_std'")).toEqual({
      Rate: 50,
    });
  });

  it("flips the marker to 'cents', so an applied database says so", () => {
    const raw = preMigrationDb();
    expect(marker(raw)).toBe('dollars');
    raw.exec(MIGRATION);
    expect(marker(raw)).toBe('cents');
  });

  it('is a NO-OP on a second run — the ×100 does not happen twice', () => {
    // The failure this guard exists for. Nothing about a re-run errors: without the marker every
    // stored balance is silently multiplied by 100 again, and the database still looks fine.
    const raw = preMigrationDb();
    raw.exec(MIGRATION);
    const after = money(raw);
    raw.exec(MIGRATION);
    expect(money(raw)).toEqual(after);
    expect(marker(raw)).toBe('cents');
  });

  it('leaves a FRESH schema.sql database alone — it is already in cents', () => {
    // Every other test in this suite runs against exactly this database, and `createTestEnv`
    // builds one per test. If 0015 could scale it, the marker would be worthless: the file has to
    // be safe to run against a database that never needed it.
    const raw = new DatabaseSync(':memory:');
    raw.exec(SCHEMA);
    expect(marker(raw)).toBe('cents');
    raw.exec(`
      INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('${TENANT}', 'fresh', 'Fresh');
      INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, EstCost, CancellationFee, Status)
      VALUES ('br_fresh', '${TENANT}', 'boarding', '2026-06-01', '2026-06-06', 1, 4550, 1000, 'confirmed');
      INSERT INTO BookingCharges (Id, TenantId, BookingRequestId, Label, Amount)
      VALUES ('bc_fresh', '${TENANT}', 'br_fresh', 'Vet visit', 4500);
      INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate)
      VALUES ('pay_fresh', '${TENANT}', 'br_fresh', 7550, 'cash', '2026-05-20');
    `);
    const before = money(raw);
    raw.exec(MIGRATION);
    expect(money(raw)).toEqual(before);
    expect(marker(raw)).toBe('cents');
  });

  /**
   * THE SEED IS CONDITIONAL, AND THIS IS THE FAILURE IT EXISTS FOR. `sql/schema.sql` is not
   * applied only to empty databases — `npm run seed:local` re-applies it over an existing one, and
   * `seed:remote` has been pointed at production. An unconditional `money_unit = 'cents'` seed
   * would therefore stamp 'cents' onto a DOLLARS-era database, and every guarded UPDATE in 0015
   * would then find the marker already flipped, do nothing, and report success — leaving every
   * balance a hundred times too small with nothing in the database left to say so. Silent, and
   * unrecoverable by re-running anything.
   *
   * So re-applying schema.sql over a database that HAS stored money must leave no marker at all,
   * which is exactly what an un-migrated database looks like, and 0015 must then migrate it
   * normally off its own `INSERT OR IGNORE … 'dollars'`.
   */
  it('re-applying schema.sql over a dollars-era database leaves NO marker, so 0015 still fires', () => {
    const raw = preMigrationDb();
    // The state a real production database is in: dollar rows, and no marker yet (the row is only
    // created by 0015 itself, which has not run).
    raw.exec(`DELETE FROM SchemaMeta WHERE Key = 'money_unit'`);
    expect(marker(raw)).toBeUndefined();

    // What `seed:local` / `seed:remote` does. It must NOT claim this database is in cents.
    raw.exec(SCHEMA);
    expect(marker(raw)).toBeUndefined();

    raw.exec(MIGRATION);
    expect(marker(raw)).toBe('cents');
    expect(one(raw, "SELECT EstCost FROM BookingRequests WHERE Id = 'br_plain'")).toEqual({
      EstCost: 25000,
    });
    expect(one(raw, "SELECT Amount FROM Payments WHERE Id = 'pay_dep'")).toEqual({ Amount: 7500 });
    expect(one(raw, "SELECT Amount FROM BookingCharges WHERE Id = 'bc_vet'")).toEqual({
      Amount: 4500,
    });
  });

  it('re-applying schema.sql over an ALREADY-MIGRATED database leaves its marker alone', () => {
    // The other direction of the same statement: once 0015 has run, the marker says 'cents' and
    // `INSERT OR IGNORE` cannot overwrite it — so a later seed run neither disarms nor re-arms it.
    const raw = preMigrationDb();
    raw.exec(MIGRATION);
    const after = money(raw);
    raw.exec(SCHEMA);
    expect(marker(raw)).toBe('cents');
    expect(money(raw)).toEqual(after);
  });

  it('contains no BEGIN/COMMIT/SAVEPOINT statement', () => {
    // D1's remote executor rejects explicit transactions outright — the bug 0011 shipped and could
    // not apply. The directory-wide scan in migration-0011-account-payments.test.ts covers this
    // file too; asserted here as well against the loaded constant so 0015 fails on its own terms.
    const sql = MIGRATION.split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i);
  });
});
