-- pawbook schema (isolated D1: pawbook-db)
-- Model A invariants: TenantId on every table, composite uniqueness, immutable Tenants.Id.

CREATE TABLE IF NOT EXISTS Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  -- All four are NULL = unlimited / instance-default. New tenants omit them.
  MaxBoardingPets INTEGER,
  MaxHouseSitsPerDay INTEGER,
  MaxStayNights INTEGER,
  Timezone TEXT,
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

-- The authoritative, agnostic Service store: one row per service a tenant offers, each carrying
-- its own behavior. ServiceType is a per-tenant SLUG (built-ins: boarding/housesitting/daycare/
-- walk/checkin; sitters add custom ones like 'morning-walk' from templates — SERVICE_TEMPLATES
-- in server/lib/services.ts). 'blocked' is reserved (see BookingRequests).
CREATE TABLE IF NOT EXISTS TenantServices (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1,
  Label TEXT NOT NULL,
  Icon TEXT NOT NULL DEFAULT 'paw', -- widget icon key: bed|home|sun|paw|clipboard
  Shape TEXT NOT NULL CHECK (Shape IN ('range', 'single')),
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  HasDuration INTEGER NOT NULL DEFAULT 0, -- options priced per duration (walk/check-in style)?
  -- Which capacity POOL the service draws from (not the service's name): 'boarding' = pet-counted
  -- vs Tenants.MaxBoardingPets, 'housesit' = day-counted vs MaxHouseSitsPerDay, 'none' = unlimited.
  CapacityKind TEXT NOT NULL DEFAULT 'none' CHECK (CapacityKind IN ('boarding', 'housesit', 'none')),
  SortOrder INTEGER NOT NULL DEFAULT 0,
  -- Per-service intake questions (JSON array of ServiceQuestion, see src/shared/booking/service-rules.ts)
  -- + optional booking-level limits. NULL limit = unlimited, matching the Tenants Max* convention.
  Questions TEXT NOT NULL DEFAULT '[]',
  MinNights INTEGER,
  MaxNights INTEGER,
  MinPetCount INTEGER,
  MaxPetCount INTEGER,
  UNIQUE (TenantId, ServiceType)
);

-- One row per priced option. Non-duration services have a single option with DurationMinutes
-- NULL; HasDuration services (walk/check-in style) have one row per sitter-defined duration.
-- Rate is free-typed whole dollars with NO relationship to duration.
CREATE TABLE IF NOT EXISTS TenantServiceOptions (
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
  Name TEXT,
  InvitedAt TEXT,
  Status TEXT NOT NULL DEFAULT 'active' CHECK (Status IN ('invited', 'active')),
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
  ServiceType TEXT NOT NULL, -- tenant service slug, or the reserved 'blocked'
  StartDate TEXT NOT NULL,
  EndDate TEXT, -- exclusive checkout for boarding/blocked ranges; NULL for single-day walks
  OptionKey TEXT, -- which TenantServiceOptions row the customer picked; NULL for blocked
  PetType TEXT, -- booked species ('dog'|'cat'); NULL for blocked. No pricing/capacity effect.
  PetCount INTEGER NOT NULL DEFAULT 1,
  StartTime TEXT, -- 'HH:MM' wall-clock for timed bookings (walk/check-in); NULL = all-day event
  GCalEventId TEXT, -- Google Calendar event id created for this booking; NULL if none/unsynced
  EstCost INTEGER,
  Answers TEXT NOT NULL DEFAULT '{}', -- JSON {questionId: answer}; questions defined on TenantServices
  Status TEXT NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'confirmed', 'cancelled')),
  Declined INTEGER NOT NULL DEFAULT 0,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_Dates ON BookingRequests (TenantId, StartDate);
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_User ON BookingRequests (TenantId, EndUserId);

CREATE TABLE IF NOT EXISTS EndUserPets (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Name TEXT NOT NULL,
  PetType TEXT NOT NULL CHECK (PetType IN ('dog', 'cat')),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_EndUserPets_Tenant_User ON EndUserPets (TenantId, EndUserId);

-- Which of the customer's pets each booking is for. Tenant scope flows through EndUserPets/BookingRequests.
CREATE TABLE IF NOT EXISTS BookingRequestPets (
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  PetId TEXT NOT NULL REFERENCES EndUserPets(Id),
  PRIMARY KEY (BookingRequestId, PetId)
);

CREATE TABLE IF NOT EXISTS ProviderConnections (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Capability TEXT NOT NULL,
  Provider TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected', 'connected-stub', 'connected')),
  ConnectedAt TEXT,
  -- AES-GCM ciphertext (base64 iv||ct), key derived from TOKEN_SECRET. NEVER returned to a client.
  AccessToken TEXT,
  RefreshToken TEXT,
  TokenExpiresAt TEXT,
  CalendarId TEXT,
  UNIQUE (TenantId, Capability)
);
