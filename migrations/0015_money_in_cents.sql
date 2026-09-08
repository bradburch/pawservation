-- Migration 0015. MONEY IS STORED IN CENTS.
--
-- Every stored cost, fee, charge and payment moves from whole dollars to integer cents, so a
-- $45.50 payment can be recorded and so `EstCost + Σ BookingCharges.Amount − Σ Payments.Amount`
-- is one-unit arithmetic in every SQL expression that computes a balance. Rates a sitter types
-- (TenantServices.*Rate, TenantServiceOptions.Rate, HolidayRate, EarlyArrivalFee,
-- LateDepartureFee, the pet-set rate tables) STAY whole dollars; `estimateCost` is where a rate
-- becomes a COST, and `extraTimeSurcharges` (server/lib/booking-times.ts) is where the two flat
-- extra-time fees become CHARGES — those two are the ×100s in the price path.
--
-- Every existing value is a whole dollar, so ×100 is exact and no balance changes by a cent.
-- No `Tenants` column changes, so the KV tenant-config cache key does not move.
-- THIS FILE MUST CONTAIN NO `BEGIN`/`COMMIT`/`SAVEPOINT` (D1 rejects them; see 0011). D1 applies
-- a `--file` atomically on its own, so the guard below is about RE-RUNS, not about partial ones.
--
-- IDEMPOTENT AND INSPECTABLE, via one row in `SchemaMeta` (sql/schema.sql). Without it an applied
-- and an un-applied database are indistinguishable — the shape does not change, so a stored 250
-- is either $250 unmigrated or $2.50 migrated and nothing can tell you which — and a second run
-- multiplies every balance by 100 again, SILENTLY. So: the marker is created and defaulted to
-- 'dollars' if absent, every UPDATE is guarded on it still reading 'dollars', and the last
-- statement flips it to 'cents'. Run this file twice and the second run changes nothing.
--
-- To check the state of a database before or after:
--   SELECT Value FROM SchemaMeta WHERE Key = 'money_unit';
-- 'dollars' (or no row) = not yet migrated; 'cents' = migrated, and re-running is a no-op.

CREATE TABLE IF NOT EXISTS SchemaMeta (
  Key TEXT PRIMARY KEY,
  Value TEXT NOT NULL
);

-- Absent = a database that predates the marker, which is by definition still in dollars. A fresh
-- database built from sql/schema.sql already carries 'cents' and this INSERT does nothing to it.
INSERT OR IGNORE INTO SchemaMeta (Key, Value) VALUES ('money_unit', 'dollars');

UPDATE BookingRequests SET EstCost = EstCost * 100
  WHERE EstCost IS NOT NULL AND (SELECT Value FROM SchemaMeta WHERE Key = 'money_unit') = 'dollars';
UPDATE BookingRequests SET CancellationFee = CancellationFee * 100
  WHERE CancellationFee IS NOT NULL AND (SELECT Value FROM SchemaMeta WHERE Key = 'money_unit') = 'dollars';
UPDATE BookingCharges SET Amount = Amount * 100
  WHERE (SELECT Value FROM SchemaMeta WHERE Key = 'money_unit') = 'dollars';
UPDATE Payments SET Amount = Amount * 100
  WHERE (SELECT Value FROM SchemaMeta WHERE Key = 'money_unit') = 'dollars';

UPDATE SchemaMeta SET Value = 'cents' WHERE Key = 'money_unit';
