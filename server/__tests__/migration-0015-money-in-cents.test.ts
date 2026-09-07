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
