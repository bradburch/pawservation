-- ############################################################################
-- ## RUN THIS FILE EXACTLY ONCE PER DATABASE. NEVER RE-RUN IT AFTER 0025.   ##
-- ############################################################################
--
-- This is a TABLE REBUILD driven by an EXPLICIT column list. The list below is TenantServices'
-- shape as of 0023. 0025 adds TenantServices.Description, which is NOT in that list — so
-- re-running this file on a database that already has 0025 applied SILENTLY DROPS the Description
-- column and every value in it, and reports success while doing it. There is no error to notice.
--
-- The blast radius is not one settings page: repo.listServices() SELECTs Description
-- unconditionally and is called from 13 non-test sites, including server/routes/bookings.ts (both
-- the create and the list path), so a missing column is a total per-tenant outage — no bookings
-- can be made or read until it is restored.
--
-- APPLY ORDER IS THEREFORE FIXED: 0024 first, then 0025. Never the reverse, and never 0024 twice.
-- (server/__tests__/migration-0024.test.ts asserts re-runnability against the pre-0025 schema,
-- which is exactly why it cannot catch this — do not read that test as permission to re-run.)
--
-- ----------------------------------------------------------------------------
-- Walks are priced per WALK, not per visit.
--
-- The billing noun is printed straight from TenantServices.RateUnit (the widget's option list,
-- the admin rate rows, the setup wizard's "/unit"), and the invariant is that the number, its
-- noun, and the price all come from one column — so 'walk' has to become a real allowed value
-- rather than a display-time substitution. SQLite cannot ALTER a CHECK constraint, so both
-- tables carrying a RateUnit CHECK are rebuilt (precedent: 0006_custom_services.sql).
--
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0024_walk_rate_unit.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0024_walk_rate_unit.sql
--
-- Apply against a DB already at 0023 and NOT yet at 0025 — the column lists below are
-- sql/schema.sql's exact 0023 shape. See the one-run-only warning at the top of this file.
--
-- D1 runs a file inside a transaction where `PRAGMA foreign_keys` is a no-op; defer_foreign_keys
-- is its supported escape hatch — FKs are re-checked at COMMIT, when the renamed tables are back.
PRAGMA defer_foreign_keys = true;

-- 1) TenantServices — same columns as sql/schema.sql, RateUnit CHECK widened with 'walk'.
CREATE TABLE TenantServices_new (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1,
  Label TEXT NOT NULL,
  Icon TEXT NOT NULL DEFAULT 'paw',
  Shape TEXT NOT NULL CHECK (Shape IN ('range', 'single')),
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit', 'walk')),
  HasDuration INTEGER NOT NULL DEFAULT 0,
  CapacityKind TEXT NOT NULL DEFAULT 'none' CHECK (CapacityKind IN ('boarding', 'housesit', 'none')),
  SortOrder INTEGER NOT NULL DEFAULT 0,
  Questions TEXT NOT NULL DEFAULT '[]',
  MinNights INTEGER,
  MaxNights INTEGER,
  MinPetCount INTEGER,
  MaxPetCount INTEGER,
  AcceptedPetTypes TEXT,
  MaxConcurrentPets INTEGER,
  MaxPerDay INTEGER,
  CancellationTiers TEXT,
  UNIQUE (TenantId, ServiceType)
);
INSERT INTO TenantServices_new
  (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind,
   SortOrder, Questions, MinNights, MaxNights, MinPetCount, MaxPetCount, AcceptedPetTypes,
   MaxConcurrentPets, MaxPerDay, CancellationTiers)
SELECT
  TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind,
  SortOrder, Questions, MinNights, MaxNights, MinPetCount, MaxPetCount, AcceptedPetTypes,
  MaxConcurrentPets, MaxPerDay, CancellationTiers
FROM TenantServices;
DROP TABLE TenantServices;
ALTER TABLE TenantServices_new RENAME TO TenantServices;

-- 2) TenantServiceOptions — same columns as sql/schema.sql; its RateUnit is RETIRED in place
--    (written, never read) but still NOT NULL, so the copy must keep passing the widened CHECK.
CREATE TABLE TenantServiceOptions_new (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  Label TEXT NOT NULL,
  DurationMinutes INTEGER,
  Rate INTEGER NOT NULL,
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit', 'walk')),
  StartTime TEXT,
  EndTime TEXT,
  Capacity INTEGER,
  WeekdaysOnly INTEGER NOT NULL DEFAULT 0,
  UNIQUE (TenantId, ServiceType, OptionKey)
);
INSERT INTO TenantServiceOptions_new
  (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime,
   EndTime, Capacity, WeekdaysOnly)
SELECT
  Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime,
  EndTime, Capacity, WeekdaysOnly
FROM TenantServiceOptions;
DROP TABLE TenantServiceOptions;
ALTER TABLE TenantServiceOptions_new RENAME TO TenantServiceOptions;

-- 3) Move existing walk services onto the new unit.
-- ponytail: name-matching heuristic, deliberately. There is no column that says "this row came
-- from the walk template", so slug/label matching is the only signal available. It is wrong in
-- BOTH directions, and both are accepted:
--   * False POSITIVE — a service created from the CHECK-IN template but named e.g. "Walk & feed"
--     is swept in and prints "/walk" instead of "/visit".
--   * False NEGATIVE — a real walk service named without the word ("Morning stroll", "Trail
--     time") keeps "/visit" forever, so ONE tenant can show $22/visit next to $22/walk on two
--     rows that behave identically. Nothing re-runs this heuristic later; the sitter renames the
--     service (which does not change the unit) or lives with it.
-- Accepted because the unit is a NOUN: no price, quantity, capacity, or booking behavior changes
-- either way (billableUnits only ever sees 'night'/'day'). Do not build a template-provenance
-- column, or a repair job, just to make a label read better.
UPDATE TenantServices
   SET RateUnit = 'walk'
 WHERE RateUnit = 'visit'
   AND (ServiceType LIKE '%walk%' OR Label LIKE '%walk%');

-- Keep the retired per-option copy consistent with its parent service (read by nothing; this
-- only avoids a confusing mismatch for anyone reading the table by hand).
UPDATE TenantServiceOptions
   SET RateUnit = 'walk'
 WHERE RateUnit = 'visit'
   AND ServiceType IN (SELECT ServiceType FROM TenantServices
                        WHERE TenantId = TenantServiceOptions.TenantId AND RateUnit = 'walk');

PRAGMA defer_foreign_keys = false;
