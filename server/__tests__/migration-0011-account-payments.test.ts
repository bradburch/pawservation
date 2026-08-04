import { readFileSync } from 'node:fs';
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
