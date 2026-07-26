-- 0021_pet_mix_rates.sql
-- Explicit rates for a species count ("2 dogs"), applying to every client.
--
-- MixKey is the canonical form from buildMixKey in src/shared/pricing/pet-set-rates.ts: species
-- slugs sorted, 'slug:count' joined by '|' (e.g. 'cat:1|dog:2'). Keyed per OPTION, which already
-- pins duration, so unlike PetGroupPricing this table needs no RateUnit or DurationMinutes — the
-- unit still comes from TenantServices.RateUnit.
--
-- Lookup is exact-match only. Additive: nothing reads this table yet.
--
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0021_pet_mix_rates.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0021_pet_mix_rates.sql

CREATE TABLE IF NOT EXISTS TenantServicePetRates (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  MixKey TEXT NOT NULL,
  Rate INTEGER NOT NULL CHECK (Rate > 0),
  UNIQUE (TenantId, ServiceType, OptionKey, MixKey)
);

CREATE INDEX IF NOT EXISTS idx_TenantServicePetRates_Lookup
  ON TenantServicePetRates (TenantId, ServiceType, OptionKey);
