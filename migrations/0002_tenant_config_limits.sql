-- WARNING: DATA-DESTRUCTIVE ON RE-RUN against a live DB — it rebuilds Tenants keeping only 6
-- columns, wiping MaxHouseSitsPerDay/MaxStayNights/Timezone. Do not run this directly against
-- an already-provisioned DB; see the baselining procedure in migrations/README.md first.
-- Make MaxBoardingPets nullable (NULL = unlimited) and add the new optional config columns.
-- SQLite cannot ALTER away a NOT NULL/DEFAULT, so rebuild Tenants preserving existing rows and
-- their MaxBoardingPets values (existing sitters keep their cap; only new tenants default to NULL).
-- Run against already-provisioned DBs:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0002_tenant_config_limits.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0002_tenant_config_limits.sql
--
-- BEHAVIORAL NOTE: this ships alongside making house-sits FIRST-CLASS capacity events (they no
-- longer consume a boarding slot). Existing tenants with housesitting bookings will see those
-- bookings stop blocking boarding capacity; with MaxHouseSitsPerDay defaulting to NULL (unlimited)
-- only the structural ≤1-day house-sit/boarding overlap rule applies. This is intended.
PRAGMA foreign_keys=OFF;
CREATE TABLE Tenants_new (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  MaxBoardingPets INTEGER,
  MaxHouseSitsPerDay INTEGER,
  MaxStayNights INTEGER,
  Timezone TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO Tenants_new (Id, Slug, DisplayName, AccentColor, MaxBoardingPets, CreatedAt)
  SELECT Id, Slug, DisplayName, AccentColor, MaxBoardingPets, CreatedAt FROM Tenants;
DROP TABLE Tenants;
ALTER TABLE Tenants_new RENAME TO Tenants;
PRAGMA foreign_keys=ON;
