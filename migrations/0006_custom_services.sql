-- Custom services: TenantServices becomes the authoritative, agnostic Service store.
-- Each row carries its own behavior (previously hardcoded per-type in SERVICE_CATALOG), the
-- ServiceType CHECK enums are dropped from all three tables so ServiceType is a per-tenant slug,
-- and every tenant gets rows for the five built-in templates (rows, not code, are the list now).
-- See docs/superpowers/specs/2026-07-07-custom-services-design.md.
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0006_custom_services.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0006_custom_services.sql
-- D1 runs a file inside a transaction where `PRAGMA foreign_keys` is a no-op; defer_foreign_keys
-- is its supported escape hatch — FKs are re-checked at COMMIT, when the renamed tables are back.
PRAGMA defer_foreign_keys = true;

-- 1) Rebuild TenantServices with behavior columns, backfilled from the old catalog values.
CREATE TABLE TenantServices_new (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1,
  Label TEXT NOT NULL,
  Icon TEXT NOT NULL DEFAULT 'paw',
  Shape TEXT NOT NULL CHECK (Shape IN ('range', 'single')),
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  HasDuration INTEGER NOT NULL DEFAULT 0,
  -- Which capacity POOL the service draws from (not the service's name): 'boarding' = pet-counted
  -- vs Tenants.MaxBoardingPets, 'housesit' = day-counted vs MaxHouseSitsPerDay, 'none' = unlimited.
  CapacityKind TEXT NOT NULL DEFAULT 'none' CHECK (CapacityKind IN ('boarding', 'housesit', 'none')),
  SortOrder INTEGER NOT NULL DEFAULT 0,
  Questions TEXT NOT NULL DEFAULT '[]',
  MinNights INTEGER,
  MaxNights INTEGER,
  MinPetCount INTEGER,
  MaxPetCount INTEGER,
  UNIQUE (TenantId, ServiceType)
);

INSERT INTO TenantServices_new
  (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind, SortOrder,
   Questions, MinNights, MaxNights, MinPetCount, MaxPetCount)
SELECT
  TenantId, ServiceType, Enabled,
  CASE ServiceType
    WHEN 'boarding' THEN 'Boarding'
    WHEN 'housesitting' THEN 'House sitting'
    WHEN 'daycare' THEN 'Day care'
    WHEN 'walk' THEN 'Walks'
    ELSE 'Check-ins' END,
  CASE ServiceType
    WHEN 'boarding' THEN 'bed'
    WHEN 'housesitting' THEN 'home'
    WHEN 'daycare' THEN 'sun'
    WHEN 'walk' THEN 'paw'
    ELSE 'clipboard' END,
  CASE ServiceType WHEN 'boarding' THEN 'range' WHEN 'housesitting' THEN 'range' ELSE 'single' END,
  CASE ServiceType
    WHEN 'boarding' THEN 'night'
    WHEN 'housesitting' THEN 'night'
    WHEN 'daycare' THEN 'day'
    ELSE 'visit' END,
  CASE WHEN ServiceType IN ('walk', 'checkin') THEN 1 ELSE 0 END,
  CASE ServiceType WHEN 'boarding' THEN 'boarding' WHEN 'housesitting' THEN 'housesit' ELSE 'none' END,
  CASE ServiceType
    WHEN 'boarding' THEN 0
    WHEN 'housesitting' THEN 1
    WHEN 'daycare' THEN 2
    WHEN 'walk' THEN 3
    ELSE 4 END,
  Questions, MinNights, MaxNights, MinPetCount, MaxPetCount
FROM TenantServices;

DROP TABLE TenantServices;
ALTER TABLE TenantServices_new RENAME TO TenantServices;

-- 2) Every tenant gets a (disabled) row for each built-in template it doesn't already have,
--    so the row set — not code — defines the tenant's service list from now on.
INSERT OR IGNORE INTO TenantServices
  (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind, SortOrder)
SELECT t.Id, tpl.ServiceType, 0, tpl.Label, tpl.Icon, tpl.Shape, tpl.RateUnit, tpl.HasDuration, tpl.CapacityKind, tpl.SortOrder
FROM Tenants t
CROSS JOIN (
  SELECT 'boarding' AS ServiceType, 'Boarding' AS Label, 'bed' AS Icon, 'range' AS Shape, 'night' AS RateUnit, 0 AS HasDuration, 'boarding' AS CapacityKind, 0 AS SortOrder
  UNION ALL SELECT 'housesitting', 'House sitting', 'home', 'range', 'night', 0, 'housesit', 1
  UNION ALL SELECT 'daycare', 'Day care', 'sun', 'single', 'day', 0, 'none', 2
  UNION ALL SELECT 'walk', 'Walks', 'paw', 'single', 'visit', 1, 'none', 3
  UNION ALL SELECT 'checkin', 'Check-ins', 'clipboard', 'single', 'visit', 1, 'none', 4
) tpl;

-- 3) Rebuild TenantServiceOptions without the ServiceType CHECK (RateUnit CHECK kept).
CREATE TABLE TenantServiceOptions_new (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  Label TEXT NOT NULL,
  DurationMinutes INTEGER,
  Rate INTEGER NOT NULL,
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  UNIQUE (TenantId, ServiceType, OptionKey)
);
INSERT INTO TenantServiceOptions_new
SELECT Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit
FROM TenantServiceOptions;
DROP TABLE TenantServiceOptions;
ALTER TABLE TenantServiceOptions_new RENAME TO TenantServiceOptions;

-- 4) Rebuild BookingRequests without the ServiceType CHECK ('blocked' stays a reserved slug).
CREATE TABLE BookingRequests_new (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL,
  StartDate TEXT NOT NULL,
  EndDate TEXT,
  OptionKey TEXT,
  PetType TEXT,
  PetCount INTEGER NOT NULL DEFAULT 1,
  StartTime TEXT,
  GCalEventId TEXT,
  EstCost INTEGER,
  Answers TEXT NOT NULL DEFAULT '{}',
  Status TEXT NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'confirmed', 'cancelled')),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO BookingRequests_new
SELECT Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetType, PetCount,
       StartTime, GCalEventId, EstCost, Answers, Status, CreatedAt
FROM BookingRequests;
DROP TABLE BookingRequests;
ALTER TABLE BookingRequests_new RENAME TO BookingRequests;
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_Dates ON BookingRequests (TenantId, StartDate);
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_User ON BookingRequests (TenantId, EndUserId);
PRAGMA defer_foreign_keys = false;
