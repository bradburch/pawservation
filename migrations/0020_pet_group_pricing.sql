-- 0020_pet_group_pricing.sql
-- Explicit rates for a specific set of pets, keyed per OPTION (owner amendment, 2026-07-26).
--
-- GroupKey IS the sorted, comma-joined pet-id list — see buildGroupKey in
-- src/shared/pricing/pet-set-rates.ts. Pet ids are crypto.randomUUID() values and therefore
-- comma-free, so members are recoverable by splitting on ',' and no join table is needed.
--
-- OptionKey pins duration, so no '|<duration>' suffix or DurationMinutes column is needed: two
-- options of one service may share a duration (server/routes/admin.ts:252-255), so a duration
-- suffix alone cannot tell "Morning 30" from "Evening 30" apart. RateUnit is dropped too — the
-- billing unit comes from TenantServices.RateUnit, and storing a second copy here is exactly the
-- drift PR #65 removed from the option-rate path.
--
-- Lookup is exact-match only — a rate for two pets must never price three — so there is
-- deliberately no prefix or partial index here. Additive: nothing reads this table yet.
--
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0020_pet_group_pricing.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0020_pet_group_pricing.sql

CREATE TABLE IF NOT EXISTS PetGroupPricing (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  GroupKey TEXT NOT NULL,
  Rate INTEGER NOT NULL CHECK (Rate > 0),
  UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (TenantId, ServiceType, OptionKey, GroupKey)
);
