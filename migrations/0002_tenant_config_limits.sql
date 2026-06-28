-- Make MaxBoardingPets nullable (NULL = unlimited) and add the new optional config columns.
-- SQLite cannot ALTER away a NOT NULL/DEFAULT, so rebuild Tenants preserving existing rows and
-- their MaxBoardingPets values (existing sitters keep their cap; only new tenants default to NULL).
-- Run against already-provisioned DBs:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0002_tenant_config_limits.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0002_tenant_config_limits.sql
PRAGMA foreign_keys=OFF;
ALTER TABLE Tenants RENAME TO Tenants_old;
CREATE TABLE Tenants (
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
INSERT INTO Tenants (Id, Slug, DisplayName, AccentColor, MaxBoardingPets, CreatedAt)
  SELECT Id, Slug, DisplayName, AccentColor, MaxBoardingPets, CreatedAt FROM Tenants_old;
DROP TABLE Tenants_old;
PRAGMA foreign_keys=ON;
