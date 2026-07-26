-- 0020_pet_group_pricing.sql
-- Explicit rates for a specific set of pets.
--
-- GroupKey IS the sorted, comma-joined pet-id list, with a '|<duration>' suffix for services
-- that carry a duration (see buildGroupKey in src/shared/pricing/pet-set-rates.ts). Pet ids are
-- crypto.randomUUID() values and therefore comma-free, so members are recoverable by splitting
-- on ',' and no join table is needed.
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
  GroupKey TEXT NOT NULL,
  Rate INTEGER NOT NULL CHECK (Rate > 0),
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  DurationMinutes INTEGER,
  UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (TenantId, ServiceType, GroupKey)
);
