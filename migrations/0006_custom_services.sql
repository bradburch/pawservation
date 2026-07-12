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

-- 0) Canonical template behavior — one definition, used to both backfill existing rows (1) and
--    seed missing ones (2), instead of two independently hand-typed encodings that could drift.
CREATE TEMP TABLE _service_templates (
  ServiceType TEXT PRIMARY KEY,
  Label TEXT NOT NULL,
  Icon TEXT NOT NULL,
  Shape TEXT NOT NULL,
  RateUnit TEXT NOT NULL,
  HasDuration INTEGER NOT NULL,
  CapacityKind TEXT NOT NULL,
  SortOrder INTEGER NOT NULL
);
INSERT INTO _service_templates
  (ServiceType, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind, SortOrder)
VALUES
  ('boarding', 'Boarding', 'bed', 'range', 'night', 0, 'boarding', 0),
  ('housesitting', 'House sitting', 'home', 'range', 'night', 0, 'housesit', 1),
  ('daycare', 'Day care', 'sun', 'single', 'day', 0, 'none', 2),
  ('walk', 'Walks', 'paw', 'single', 'visit', 1, 'none', 3),
  ('checkin', 'Check-ins', 'clipboard', 'single', 'visit', 1, 'none', 4);

-- 1) Rebuild TenantServices with behavior columns, backfilled from _service_templates. The old
--    ServiceType CHECK constrained every existing row to these 5 slugs, so the JOIN is exhaustive.
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
  ts.TenantId, ts.ServiceType, ts.Enabled, tpl.Label, tpl.Icon, tpl.Shape, tpl.RateUnit,
  tpl.HasDuration, tpl.CapacityKind, tpl.SortOrder,
  ts.Questions, ts.MinNights, ts.MaxNights, ts.MinPetCount, ts.MaxPetCount
FROM TenantServices ts
JOIN _service_templates tpl ON tpl.ServiceType = ts.ServiceType;

DROP TABLE TenantServices;
ALTER TABLE TenantServices_new RENAME TO TenantServices;

-- 2) Every tenant gets a (disabled) row for each built-in template it doesn't already have,
--    so the row set — not code — defines the tenant's service list from now on.
INSERT OR IGNORE INTO TenantServices
  (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind, SortOrder)
SELECT t.Id, tpl.ServiceType, 0, tpl.Label, tpl.Icon, tpl.Shape, tpl.RateUnit, tpl.HasDuration, tpl.CapacityKind, tpl.SortOrder
FROM Tenants t
CROSS JOIN _service_templates tpl;

DROP TABLE _service_templates;

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
