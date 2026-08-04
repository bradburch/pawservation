import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createTestEnv, TENANT_A } from './helpers';

/**
 * MIGRATION 0011 APPLIED TO A PRE-MIGRATION DATABASE.
 *
 * The rest of the suite proves that a FRESH `sql/schema.sql` behaves — which is exactly what a
 * migration cannot be judged by. `Payments.BookingRequestId` is `NOT NULL` today and SQLite has no
 * `ALTER TABLE … DROP NOT NULL`, so 0011 is a table REBUILD (create, copy, drop, rename), and the
 * question a rebuild has to answer is whether the rows that were already in there came out the other
 * side unchanged. So this file rewinds a real database to the old table, applies the real migration
 * file, and asks.
 */
const MIGRATION = readFileSync(
  join(import.meta.dirname, '..', '..', 'migrations', '0011_account_payments.sql'),
  'utf8',
);

/**
 * `Payments` EXACTLY as it stood before 0011, copied verbatim out of `sql/schema.sql` at that
 * commit — indexes included, since `DROP TABLE` takes a table's indexes with it.
 *
 * **Do not update this to match schema.sql.** Its entire purpose is to be the OLD shape; a copy
 * kept "current" would make this file assert that the migration works on a database that has
 * already had it applied, which is the one case nobody needs proved.
 */
const PRE_MIGRATION_PAYMENTS = `
CREATE TABLE Payments (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  Amount INTEGER NOT NULL CHECK (Amount > 0),
  Method TEXT NOT NULL CHECK (Method IN ('cash', 'venmo', 'zelle', 'paypal', 'check', 'card', 'other')),
  PaidDate TEXT NOT NULL,
  Note TEXT,
  ExternalRef TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_Payments_Tenant_Date ON Payments (TenantId, PaidDate);
CREATE INDEX idx_Payments_Tenant_Booking ON Payments (TenantId, BookingRequestId);
CREATE UNIQUE INDEX idx_Payments_Tenant_ExternalRef
  ON Payments (TenantId, ExternalRef) WHERE ExternalRef IS NOT NULL;
`;

/** A database holding the OLD Payments table plus two payments recorded the old way. */
function preMigrationDb(): DatabaseSync {
  const { raw } = createTestEnv();
  // Rewind: the migrated table (and its indexes) go, the old one comes back. Everything else —
  // Tenants, BookingRequests, the seeded rows both foreign keys point at — is the real schema.
  raw.exec('DROP TABLE Payments;');
  raw.exec(PRE_MIGRATION_PAYMENTS);
  raw.exec(`
    INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate, Note, ExternalRef, CreatedAt)
    VALUES
      ('pay_hand', '${TENANT_A}', 'seed_sp_board1', 150, 'cash', '2026-06-01', 'deposit', NULL, '2026-06-01 10:00:00'),
      ('pay_venmo', '${TENANT_A}', 'seed_sp_board1', 100, 'venmo', '2026-06-14', NULL, 'venmo-txn-77', '2026-06-14 11:30:00');
  `);
  return raw;
}

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null };

const columns = (raw: DatabaseSync): ColumnInfo[] =>
  raw.prepare('PRAGMA table_info(Payments)').all() as unknown as ColumnInfo[];

const indexNames = (raw: DatabaseSync): string[] =>
  (
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'Payments'")
      .all() as unknown as { name: string }[]
  )
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_autoindex'))
    .sort();

describe('migration 0011 (account-level payments) against a pre-migration database', () => {
  it('leaves every existing payment byte-for-byte intact, still pointing at its booking', () => {
    const raw = preMigrationDb();
    const before = raw.prepare('SELECT * FROM Payments ORDER BY Id').all();
    raw.exec(MIGRATION);
    const after = raw.prepare('SELECT * FROM Payments ORDER BY Id').all();
    // Same rows, same values — plus exactly one new column, NULL on every pre-existing row: a
    // payment that was recorded against a booking is still a payment against that booking.
    expect(after).toEqual(before.map((row) => ({ ...row, AccountId: null })));
    expect(after.map((r) => (r as { BookingRequestId: string }).BookingRequestId)).toEqual([
      'seed_sp_board1',
      'seed_sp_board1',
    ]);
  });

  /**
   * WHAT THE EXPLICIT COLUMN LIST ACTUALLY DOES, pinned because the header used to claim the
   * opposite. `INSERT INTO … (cols) SELECT cols FROM Payments` names both sides, so a column the
   * old table has and the list does not is simply not selected: the copy succeeds and the column
   * and its data go out with the `DROP TABLE`. SILENTLY. `SELECT *` is the form that would have
   * raised (a column-count mismatch against the new table), which is the reverse of "fails loudly".
   *
   * Nothing is wrong with the migration — an explicit list is still the right choice, because the
   * failure mode it DOES prevent (values shifting into the wrong columns) corrupts money, while
   * this one loses a column that by definition no code on this branch reads. The comment is what
   * was wrong, and this test is what keeps the corrected one honest.
   */
  it('SILENTLY DROPS a column the old table had that the copy does not name', () => {
    const raw = preMigrationDb();
    // A column some other branch added to the old table before this migration ran.
    raw.exec('ALTER TABLE Payments ADD COLUMN ReconciledAt TEXT;');
    raw.exec("UPDATE Payments SET ReconciledAt = '2026-06-02' WHERE Id = 'pay_hand';");
    expect(columns(raw).map((c) => c.name)).toContain('ReconciledAt');

    // No error: this is the whole point. The migration applies cleanly…
    expect(() => raw.exec(MIGRATION)).not.toThrow();

    // …and the column, with everything in it, is gone.
    expect(columns(raw).map((c) => c.name)).not.toContain('ReconciledAt');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM Payments').get()).toEqual({ n: 2 });
  });

  it('makes BookingRequestId nullable and adds AccountId', () => {
    const raw = preMigrationDb();
    raw.exec(MIGRATION);
    const cols = columns(raw);
    expect(cols.find((c) => c.name === 'BookingRequestId')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'AccountId')).toMatchObject({ type: 'TEXT', notnull: 0 });
  });

  it('enforces EXACTLY ONE of BookingRequestId / AccountId on every row', () => {
    const raw = preMigrationDb();
    raw.exec(MIGRATION);
    const insert = (booking: string | null, account: string | null) =>
      raw
        .prepare(
          `INSERT INTO Payments (Id, TenantId, BookingRequestId, AccountId, Amount, Method, PaidDate)
           VALUES ('pay_new', ?, ?, ?, 40, 'cash', '2026-07-01')`,
        )
        .run(TENANT_A, booking, account);

    expect(() => insert(null, null)).toThrow(/constraint/i); // neither: a payment against nothing
    expect(() => insert('seed_sp_board1', 'p_rex')).toThrow(/constraint/i); // both: which one is it?
    expect(() => insert(null, 'p_rex')).not.toThrow(); // household payment: allowed
  });

  it('keeps the Venmo re-import guard and the booking foreign key', () => {
    const raw = preMigrationDb();
    raw.exec(MIGRATION);
    // The partial unique index is the importer's whole idempotency mechanism (0001). A rebuild that
    // dropped it would let a replayed CSV insert the same transaction twice, silently.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate, ExternalRef)
           VALUES ('pay_replay', ?, 'seed_sp_board1', 100, 'venmo', '2026-06-14', 'venmo-txn-77')`,
        )
        .run(TENANT_A),
    ).toThrow(/unique/i);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate)
           VALUES ('pay_orphan', ?, 'no-such-booking', 100, 'cash', '2026-06-14')`,
        )
        .run(TENANT_A),
    ).toThrow(/foreign key/i);
  });

  it('lands on the same table a fresh sql/schema.sql builds', () => {
    // The rule this repo keeps tripping over: a migration and the baseline must agree, or the test
    // suite (which only ever sees schema.sql) proves nothing about the database that actually ran.
    const migrated = preMigrationDb();
    migrated.exec(MIGRATION);
    const { raw: fresh } = createTestEnv();
    expect(columns(migrated)).toEqual(columns(fresh));
    expect(indexNames(migrated)).toEqual(indexNames(fresh));
  });
});

/**
 * NO MIGRATION MAY CONTAIN AN EXPLICIT SQL TRANSACTION. This is the test that would have caught
 * 0011's original bug: it wrapped its table rebuild in `BEGIN TRANSACTION … COMMIT` (with
 * `PRAGMA defer_foreign_keys = ON` inside), which `node:sqlite` — the engine every test in this
 * file and this suite runs against — happily accepts. Cloudflare D1's remote executor does not:
 * `wrangler d1 execute --remote` on that file failed with "To execute a transaction, please use
 * the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL
 * BEGIN TRANSACTION or SAVEPOINT statements." Every local check passed, the migration's own
 * dedicated test passed, and it still could not be applied to production — because the test
 * validated against an engine more permissive than the target. D1 applies a `--file` execution
 * atomically on its own (and restores the original state on any failure), so no migration needs
 * — or is allowed — to hand-roll a transaction.
 *
 * Statements are checked with SQL comments (`-- …`) stripped first, so a migration is free to
 * DISCUSS `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT` in its prose (as this file's own header now
 * does, explaining exactly this bug) without tripping the check meant for actual SQL statements.
 */
describe('no migration file uses an explicit SQL transaction', () => {
  const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'migrations');
  const REJECTED = /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/i;

  // Drop `-- ...` line comments before scanning, so prose ABOUT these keywords (explaining why
  // they're banned) doesn't false-positive as an occurrence of the keywords themselves.
  const stripSqlComments = (sql: string): string =>
    sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');

  const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

  it('found at least one migration file to check (the check itself is not vacuous)', () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(migrationFiles).toContain('0011_account_payments.sql');
  });

  it.each(migrationFiles)('%s contains no BEGIN/COMMIT/ROLLBACK/SAVEPOINT statement', (file) => {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    expect(sql).not.toMatch(REJECTED);
  });

  it('0011_account_payments.sql specifically no longer wraps its rebuild in a transaction', () => {
    // The exact regression: this file used to open with BEGIN TRANSACTION / PRAGMA
    // defer_foreign_keys and close with COMMIT. Assert directly against the loaded MIGRATION
    // constant (not just the directory scan above) so this fails even if the file ever moves.
    const sql = stripSqlComments(MIGRATION);
    expect(sql).not.toMatch(REJECTED);
    expect(sql).not.toContain('defer_foreign_keys');
  });
});
