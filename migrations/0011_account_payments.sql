-- Migration 0011. A PAYMENT IS RECORDED AGAINST A HOUSEHOLD, NOT ONLY AGAINST A BOOKING.
--
-- A client who pays once a month writes one cheque for eight bookings. Until now the only place to
-- put that money was a single booking, so the sitter had to invent a split — $400 carved into eight
-- amounts nobody agreed to, each one wrong the moment a booking was edited — or drop it all on one
-- booking and leave seven reading as unpaid. Both are bookkeeping the sitter is doing FOR the
-- software. `Payments.AccountId` is the missing place to put it: the household (the connected
-- component of owners and pets that `src/shared/invoicing/accounts.ts` already derives and that
-- invoice numbering already keys off), which is the level she was paid at.
--
-- NUMBERED 0011, SKIPPING 0010, DELIBERATELY. `0010_premium_until.sql` exists on an unmerged branch
-- and is not on `main`; two different files sharing a number is a merge collision that no additive
-- change can defuse. A GAP is explicitly fine here (see migrations/README.md, "Numbering") — a
-- duplicate is not.
--
-- WHAT `AccountId` HOLDS, and what it does NOT reference. The value is an account id, which is a PET
-- id: the lexicographically-first pet of the household's component, exactly what `buildAccounts`
-- returns and what an invoice number is built from. It carries **no foreign key**, on purpose:
--   * an account is DERIVED from a graph rather than stored as a row, so there is no accounts table
--     to point at, and pointing at `EndUserPets` would assert a relationship ("this payment is about
--     this pet") that is not what the column means;
--   * that first-sorted pet can CHANGE — a new pet sorting earlier renames the account — so equality
--     against a stored id is the wrong question in the first place. Every reader instead resolves a
--     payment to "the household whose pets CONTAIN this id" (`buildHouseholdBalances`), which is
--     stable across renaming because the stored pet stays in the same component.
-- Tenancy is enforced where every other write enforces it: `insertAccountPayment` writes through an
-- `INSERT … SELECT … FROM EndUserPets WHERE TenantId = ?`, so a foreign account id inserts nothing.
--
-- EXACTLY ONE OF THE TWO, ENFORCED BY THE DATABASE: `CHECK ((BookingRequestId IS NULL) <> (AccountId
-- IS NULL))`. A row with NEITHER is money attached to nothing — invisible in every balance while
-- still counting as revenue. A row with BOTH is worse: two readers disagreeing about which one
-- decides, which is precisely how a payment gets counted twice. Written as one inequality over two
-- null-tests rather than as two CHECKs so there is a single expression to read and no way to satisfy
-- half of it.
--
-- WHY A TABLE REBUILD. `BookingRequestId` is `NOT NULL` today and SQLite cannot drop a NOT NULL with
-- `ALTER TABLE`; the CHECK above cannot be added by ALTER either. So this is the standard twelve-step
-- dance — create, copy, drop, rename.
--
-- THIS FILE MUST CONTAIN NO `BEGIN`/`COMMIT`/`SAVEPOINT`. It used to. The rebuild was wrapped in an
-- explicit `BEGIN TRANSACTION … COMMIT`, with `PRAGMA defer_foreign_keys = ON` set inside it so the
-- intermediate state (the moment `Payments` is briefly gone) would be judged at COMMIT rather than
-- statement by statement. That reasoning holds for local SQLite and for `node:sqlite`, which is what
-- the migration test below runs against — which is exactly why it passed every local check and its
-- own dedicated test and STILL could not be applied: Cloudflare D1's remote executor rejects
-- explicit SQL transactions outright, and `wrangler d1 execute --remote` on this file failed with
-- "To execute a transaction, please use the state.storage.transaction() or
-- state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT
-- statements." The test validated against an engine more permissive than the target; that is the
-- defect, not the missing wrapper. Two things made the wrapper unnecessary anyway: `grep
-- "REFERENCES Payments" sql/schema.sql` returns nothing, so no table has a foreign key into
-- `Payments` for `defer_foreign_keys` to have been protecting in the first place; and D1 applies a
-- `--file` execution atomically on its own, returning the database to its original state if any
-- statement fails, which is the same guarantee the explicit transaction was written to provide.
-- Nothing in the schema references `Payments`, so the rename rewrites no other table's clauses.
--
-- EVERY EXISTING ROW COMES OUT UNCHANGED, still pointing at its booking, with `AccountId` NULL —
-- which is exactly what "this payment was recorded against a booking" means under the new CHECK.
--
-- THE COPY NAMES ITS COLUMNS EXPLICITLY ON BOTH SIDES, and what that buys is worth stating exactly,
-- because the intuition runs backwards. It does NOT make a surprise column fail loudly: a column
-- present on the old `Payments` and absent from these two lists is simply never selected, the INSERT
-- succeeds, and that column goes out with the `DROP TABLE` below — SILENTLY, data included.
-- `SELECT *` is the form that WOULD have raised here, on a column-count mismatch against
-- `Payments_new`. So the risk this file actually carries is a dropped column, not a refused
-- migration, and `server/__tests__/migration-0011-account-payments.test.ts` pins that behaviour so
-- this paragraph cannot drift from the code again.
--
-- The explicit list is still the right choice, for the other reason: it pins every value to a NAMED
-- destination, so no column reordering or insertion can shift `Amount` into `PaidDate`. Losing a
-- column that nothing on this branch reads is recoverable from a backup; shifting money between
-- columns is corruption that reads as data. Anyone adding a column to `Payments` on another branch
-- must add it to BOTH lists here — this migration will not tell them.
--
-- All three indexes
-- are recreated, `idx_Payments_Tenant_ExternalRef` included: that partial unique index IS the Venmo
-- importer's idempotency mechanism (0001), and a rebuild that quietly dropped it would let a
-- replayed CSV insert the same transaction twice. `server/__tests__/migration-0011-account-payments.test.ts`
-- applies this file to a genuinely pre-migration table and asserts all of it, including that the
-- result is column-for-column and index-for-index identical to what a fresh `sql/schema.sql` builds.
CREATE TABLE Payments_new (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  -- Nullable as of 0011: NULL means this payment was recorded against the HOUSEHOLD below.
  BookingRequestId TEXT REFERENCES BookingRequests(Id),
  -- The household this payment settles: an account id (the lexicographically-first pet of the
  -- component `buildAccounts` returns). No FK — an account is derived, not stored. See the header.
  AccountId TEXT,
  Amount INTEGER NOT NULL CHECK (Amount > 0), -- whole dollars, matching EstCost/Rate
  Method TEXT NOT NULL CHECK (Method IN ('cash', 'venmo', 'zelle', 'paypal', 'check', 'card', 'other')),
  PaidDate TEXT NOT NULL, -- 'YYYY-MM-DD', sitter-entered (defaults to today in the UI)
  Note TEXT,
  -- Venmo transaction id when this payment came from a CSV import; NULL for hand-recorded ones.
  ExternalRef TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  -- A payment settles a booking or a household, never both and never neither.
  CHECK ((BookingRequestId IS NULL) <> (AccountId IS NULL))
);

INSERT INTO Payments_new
  (Id, TenantId, BookingRequestId, AccountId, Amount, Method, PaidDate, Note, ExternalRef, CreatedAt)
SELECT Id, TenantId, BookingRequestId, NULL, Amount, Method, PaidDate, Note, ExternalRef, CreatedAt
FROM Payments;

DROP TABLE Payments;
ALTER TABLE Payments_new RENAME TO Payments;

CREATE INDEX idx_Payments_Tenant_Date ON Payments (TenantId, PaidDate);
CREATE INDEX idx_Payments_Tenant_Booking ON Payments (TenantId, BookingRequestId);
-- Household payments are read per household, the way booking payments are read per booking.
CREATE INDEX idx_Payments_Tenant_Account ON Payments (TenantId, AccountId);
-- Idempotent re-import: a transaction id this tenant already recorded cannot be inserted twice.
-- PARTIAL so the NULLs of hand-recorded payments are unconstrained.
CREATE UNIQUE INDEX idx_Payments_Tenant_ExternalRef
  ON Payments (TenantId, ExternalRef) WHERE ExternalRef IS NOT NULL;
