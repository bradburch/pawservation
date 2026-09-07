-- Migration 0015. MONEY IS STORED IN CENTS.
--
-- Every stored cost, fee, charge and payment moves from whole dollars to integer cents, so a
-- $45.50 payment can be recorded and so `EstCost + Σ BookingCharges.Amount − Σ Payments.Amount`
-- is one-unit arithmetic in every SQL expression that computes a balance. Rates a sitter types
-- (TenantServices.*Rate, TenantServiceOptions.Rate, HolidayRate, EarlyArrivalFee,
-- LateDepartureFee, the pet-set rate tables) STAY whole dollars; `estimateCost` is the one place a
-- rate becomes a cost and multiplies by 100.
--
-- Every existing value is a whole dollar, so ×100 is exact and no balance changes by a cent.
-- No `Tenants` column changes, so the KV tenant-config cache key does not move.
-- THIS FILE MUST CONTAIN NO `BEGIN`/`COMMIT`/`SAVEPOINT` (D1 rejects them; see 0011).

UPDATE BookingRequests SET EstCost = EstCost * 100 WHERE EstCost IS NOT NULL;
UPDATE BookingRequests SET CancellationFee = CancellationFee * 100 WHERE CancellationFee IS NOT NULL;
UPDATE BookingCharges SET Amount = Amount * 100;
UPDATE Payments SET Amount = Amount * 100;
