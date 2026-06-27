-- pawbook schema (isolated D1: pawbook-db)
-- Model A invariants: TenantId on every table, composite uniqueness, immutable Tenants.Id.

CREATE TABLE IF NOT EXISTS Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  MaxBoardingPets INTEGER NOT NULL DEFAULT 2,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Sitter dashboard login. Email is the GLOBAL login identifier (resolves which tenant the
-- sitter manages), so it is globally unique; password is a PBKDF2 hash (see lib/password.ts).
CREATE TABLE IF NOT EXISTS TenantUsers (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Email TEXT NOT NULL UNIQUE,
  PasswordHash TEXT NOT NULL,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS TenantServices (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL CHECK (ServiceType IN ('boarding', 'housesitting', 'daycare', 'walk', 'checkin')),
  Enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (TenantId, ServiceType)
);

-- One row per priced option. Non-duration services (boarding/housesitting/daycare) have a single
-- option with DurationMinutes NULL; walks/check-ins have one row per sitter-defined duration.
-- Rate is free-typed whole dollars with NO relationship to duration.
CREATE TABLE IF NOT EXISTS TenantServiceOptions (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL CHECK (ServiceType IN ('boarding', 'housesitting', 'daycare', 'walk', 'checkin')),
  OptionKey TEXT NOT NULL,
  Label TEXT NOT NULL,
  DurationMinutes INTEGER,
  Rate INTEGER NOT NULL,
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  UNIQUE (TenantId, ServiceType, OptionKey)
);

-- Accepted species the sitter cares for. Mirrors TenantServices on/off pattern.
CREATE TABLE IF NOT EXISTS TenantPetTypes (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  PetType TEXT NOT NULL CHECK (PetType IN ('dog', 'cat')),
  Enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (TenantId, PetType)
);

CREATE TABLE IF NOT EXISTS EndUsers (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Email TEXT NOT NULL,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (TenantId, Email)
);

CREATE TABLE IF NOT EXISTS LoginCodes (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Code TEXT NOT NULL,
  ExpiresAt TEXT NOT NULL,
  UsedAt TEXT,
  -- Failed verify attempts; capped in consumeLoginCode so a 6-digit code can't be brute-forced.
  Attempts INTEGER NOT NULL DEFAULT 0
);

-- Blocked days are rows with ServiceType='blocked' (EndUserId NULL, Status 'confirmed'),
-- mirroring how production models blocked time as calendar events of type 'blocked'.
CREATE TABLE IF NOT EXISTS BookingRequests (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL CHECK (ServiceType IN ('boarding', 'housesitting', 'daycare', 'walk', 'checkin', 'blocked')),
  StartDate TEXT NOT NULL,
  EndDate TEXT, -- exclusive checkout for boarding/blocked ranges; NULL for single-day walks
  OptionKey TEXT, -- which TenantServiceOptions row the customer picked; NULL for blocked
  PetType TEXT, -- booked species ('dog'|'cat'); NULL for blocked. No pricing/capacity effect.
  PetCount INTEGER NOT NULL DEFAULT 1,
  EstCost INTEGER,
  Status TEXT NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'confirmed', 'cancelled')),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_Dates ON BookingRequests (TenantId, StartDate);
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_User ON BookingRequests (TenantId, EndUserId);

CREATE TABLE IF NOT EXISTS ProviderConnections (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Capability TEXT NOT NULL,
  Provider TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected', 'connected-stub')),
  ConnectedAt TEXT,
  UNIQUE (TenantId, Capability)
);
