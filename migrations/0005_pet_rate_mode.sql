-- Per-pet pricing mode (owner directive 2026-07-28):
--   TenantServices.PetRateMode — how a pet SET with no stored pet-set rate is priced.
--     'exact'  = REFUSE it (`priced: false`, code `unpriced_pet_set`) — the behaviour every
--                service has had until now, and the DEFAULT for every existing row.
--     'linear' = the option's own Rate x the number of DISTINCT pets on the booking.
--
-- Why this does not break the no-inferred-pricing invariant: the invariant's purpose is "a rate
-- the sitter did not type is a price they did not agree to." A stored per-service mode IS a typed
-- choice, so the multiplication only ever happens where a sitter opted into it. An explicitly
-- stored pet-set rate (PetGroupPricing / TenantServicePetRates) still WINS over the multiplier —
-- a sitter who typed a two-dog rate gets that rate, never 2x the one-dog rate.
--
-- Additive and backward-compatible: NOT NULL DEFAULT 'exact' backfills every existing row with
-- today's behaviour, so applying this migration changes no price anywhere.

ALTER TABLE TenantServices
  ADD COLUMN PetRateMode TEXT NOT NULL DEFAULT 'exact'
  CHECK (PetRateMode IN ('exact', 'linear'));
