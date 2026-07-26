-- pawbook schema (isolated D1: pawbook-db)
-- Model A invariants: TenantId on every table, composite uniqueness, immutable Tenants.Id.

CREATE TABLE IF NOT EXISTS Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  -- RETIRED by 0015 (service-level attributes): caps/stay-length now live on TenantServices
  -- (MaxConcurrentPets / MaxPerDay / MaxNights). Columns stay so schema.sql, the local DB, and
  -- the remote DB keep the exact same shape; no code reads or writes them. Drop in a future 0016+.
  MaxBoardingPets INTEGER,
  MaxHouseSitsPerDay INTEGER,
  MaxStayNights INTEGER,
  -- NULL = instance default (DEFAULT_TIMEZONE).
  Timezone TEXT,
  -- Optional contact details shown to clients in the booking widget.
  ContactEmail TEXT,
  ContactPhone TEXT,
  -- NULL = active; timestamp = disabled by the owner (widget dark + admin read-only).
  DisabledAt TEXT,
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
  -- Which capacity RULE the service uses (not the service's name): 'boarding' and 'housesit' both
  -- count PETS against their own MaxConcurrentPets; 'none' = unlimited (blocked days only).
  CapacityKind TEXT NOT NULL DEFAULT 'none' CHECK (CapacityKind IN ('boarding', 'housesit', 'none')),
  SortOrder INTEGER NOT NULL DEFAULT 0,
  -- Per-service intake questions (JSON array of ServiceQuestion, see src/shared/booking/service-rules.ts)
  -- + optional booking-level limits. NULL limit = unlimited, matching the Tenants Max* convention.
  Questions TEXT NOT NULL DEFAULT '[]',
  MinNights INTEGER,
  MaxNights INTEGER,
  MinPetCount INTEGER,
  MaxPetCount INTEGER,
  -- JSON array of pet-type slugs this service accepts; NULL = accepts every registry type
  -- (null-is-unlimited convention). An empty array is invalid for an ENABLED service.
  AcceptedPetTypes TEXT,
  -- Per-service capacity (added by 0015; NULL = unlimited). MaxConcurrentPets is the pets-per-day
  -- cap for BOTH pool kinds (0017): CapacityKind='boarding' and 'housesit' both read it — a booking
  -- with three pets uses three slots. A cap on a 'none'-kind service is rejected on PUT. MaxPerDay
  -- is RETIRED (0017 folded it into MaxConcurrentPets); the column stays for shape lockstep but no
  -- code reads or writes it. Drop in a future cleanup migration.
  MaxConcurrentPets INTEGER,
  MaxPerDay INTEGER,
  -- Tiered cancellation policy (added by 0016); JSON array like
  -- [{"withinDays":2,"percent":100},{"withinDays":7,"percent":50}]. NULL = no fee.
  CancellationTiers TEXT,
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
  -- RETIRED in place (no migration): the billing unit is read from TenantServices.RateUnit; this
  -- copy is read by nothing and is not even SELECTed into the app's types. NOT NULL with no
  -- DEFAULT, so writes must still supply it. No drop scheduled — that needs expand/contract across
  -- two hand-applied production migrations to remove a column that causes no defect.
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  -- A fixed clock window (both set together, or both NULL). Windowed options derive
  -- DurationMinutes from this window server-side (see server/routes/admin.ts); Capacity caps
  -- concurrent bookings against this option on one date. NULL = unlimited, matching the
  -- null-is-unlimited convention used throughout this schema.
  StartTime TEXT,
  EndTime TEXT,
  Capacity INTEGER,
  -- Int-bool: 1 = this option is bookable Mon-Fri only (server rejects Sat/Sun at booking
  -- validation; the embed widget greys weekends). 0 = any day.
  WeekdaysOnly INTEGER NOT NULL DEFAULT 0,
  UNIQUE (TenantId, ServiceType, OptionKey)
);

-- Explicit rate for a specific set of pets, keyed per service (0020). GroupKey is the sorted,
-- comma-joined pet-id list with a '|<duration>' suffix for timed services — see buildGroupKey in
-- src/shared/pricing/pet-set-rates.ts. Exact-match only; nothing reads this table yet.
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

-- Explicit rate for a species count ("2 dogs"), applying to every client, keyed per OPTION (0021).
-- MixKey is species-sorted 'slug:count' joined by '|' — see buildMixKey in
-- src/shared/pricing/pet-set-rates.ts. Keyed per option (duration already pinned), so unlike
-- PetGroupPricing this needs no RateUnit/DurationMinutes. Exact-match only; nothing reads this yet.
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

-- Accepted species the sitter cares for — per-tenant rows (slug + renamable Label), mirroring
-- the TenantServices rows-not-code model. Slug is immutable; rename changes Label only.
CREATE TABLE IF NOT EXISTS TenantPetTypes (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  PetType TEXT NOT NULL,            -- per-tenant slug ('dog', 'rabbit', ...), immutable
  Label TEXT NOT NULL,              -- display name ('Dogs', 'Rabbits'), renamable
  -- RETIRED by 0015: the registry is pure slug+label; behavior derives from per-service
  -- AcceptedPetTypes. Column stays for shape lockstep; no code reads or writes it.
  Enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (TenantId, PetType)
);

CREATE TABLE IF NOT EXISTS EndUsers (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Email TEXT NOT NULL,
  Name TEXT,
  Phone TEXT,
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
  PetType TEXT, -- tenant pet-type slug (first selected pet); NULL for blocked. No pricing/capacity effect.
  PetCount INTEGER NOT NULL DEFAULT 1 CHECK (PetCount >= 1), -- fresh-install only; existing DBs enforce this in app code (validation.ts)
  StartTime TEXT, -- 'HH:MM' wall-clock for timed bookings (walk/check-in); NULL = all-day event
  GCalEventId TEXT, -- Google Calendar event id created for this booking; NULL if none/unsynced
  EstCost INTEGER,
  -- Fee assessed at cancel time, whole dollars, matches EstCost (added by 0016). NULL = none assessed.
  CancellationFee INTEGER,
  Answers TEXT NOT NULL DEFAULT '{}', -- JSON {questionId: answer}; questions defined on TenantServices
  Status TEXT NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'confirmed', 'cancelled')),
  -- 1 when a pending request was declined by the sitter (stored as Status 'cancelled' + this
  -- flag; widening the CHECK above would require a table rebuild on existing databases).
  Declined INTEGER NOT NULL DEFAULT 0,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_Dates ON BookingRequests (TenantId, StartDate);
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Slot
  ON BookingRequests (TenantId, ServiceType, OptionKey, StartDate);
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_User ON BookingRequests (TenantId, EndUserId);

CREATE TABLE IF NOT EXISTS EndUserPets (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Name TEXT NOT NULL,
  PetType TEXT NOT NULL, -- tenant pet-type slug
  Notes TEXT, -- care notes the sitter keeps (feeding, meds, temperament)
  -- NULL = alive; timestamp = deceased (0019). Excluded from every bookable/quotable pet list.
  DeceasedAt TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_EndUserPets_Tenant_User ON EndUserPets (TenantId, EndUserId);

-- Which of the customer's pets each booking is for. Tenant scope flows through EndUserPets/BookingRequests.
CREATE TABLE IF NOT EXISTS BookingRequestPets (
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  PetId TEXT NOT NULL REFERENCES EndUserPets(Id),
  PRIMARY KEY (BookingRequestId, PetId)
);

-- Owner<->pet edges (0019). AUTHORITATIVE ownership: /me, the booking-time ownership gate, and
-- union-find invoicing accounts all read this, not EndUserPets.EndUserId (which stays as the
-- primary/creating owner). TenantId is carried here DELIBERATELY, unlike BookingRequestPets above:
-- the union-find source query must be one tenant-scoped read, not a three-way join.
CREATE TABLE IF NOT EXISTS PetOwners (
  TenantId  TEXT NOT NULL REFERENCES Tenants(Id),
  PetId     TEXT NOT NULL REFERENCES EndUserPets(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (PetId, EndUserId)
);
CREATE INDEX IF NOT EXISTS idx_PetOwners_Tenant_User ON PetOwners (TenantId, EndUserId);

-- Recorded payments against bookings (earnings analytics). Multiple rows per booking
-- (deposits/partials); whole dollars matching EstCost/Rate. PaidDate is sitter-entered.
CREATE TABLE IF NOT EXISTS Payments (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  Amount INTEGER NOT NULL CHECK (Amount > 0), -- whole dollars, matching EstCost/Rate
  Method TEXT NOT NULL CHECK (Method IN ('cash', 'venmo', 'zelle', 'paypal', 'check', 'card', 'other')),
  PaidDate TEXT NOT NULL, -- 'YYYY-MM-DD', sitter-entered (defaults to today in the UI)
  Note TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_Payments_Tenant_Date ON Payments (TenantId, PaidDate);
CREATE INDEX IF NOT EXISTS idx_Payments_Tenant_Booking ON Payments (TenantId, BookingRequestId);

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

-- Invite-only signup + owner console (spec 2026-07-18).
-- Both tables are INSTANCE-LEVEL — a deliberate, documented exception to the
-- "TenantId on every table" invariant: they gate entry INTO the tenancy model,
-- so they cannot themselves be tenant rows.

-- Platform-owner accounts (instance-level, deliberately NOT tenant-scoped).
-- Membership is governed by the OWNER_EMAILS secret; this table only stores
-- the password hash for emails that secret already names.
CREATE TABLE IF NOT EXISTS OwnerUsers (
  Id TEXT PRIMARY KEY,
  Email TEXT NOT NULL UNIQUE,
  PasswordHash TEXT NOT NULL,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner-managed signup allowlist (instance-level, deliberately NOT tenant-
-- scoped). TenantId/ClaimedAt stay NULL until the sitter completes setup.
CREATE TABLE IF NOT EXISTS AllowedSitters (
  Email TEXT PRIMARY KEY,
  AddedAt TEXT NOT NULL DEFAULT (datetime('now')),
  ClaimedAt TEXT,
  TenantId TEXT REFERENCES Tenants(Id)
);
