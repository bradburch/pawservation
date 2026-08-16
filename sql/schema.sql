-- pawservation schema (isolated D1: pawservation-db)
-- Model A invariants: TenantId on every table, composite uniqueness, immutable Tenants.Id.

CREATE TABLE IF NOT EXISTS Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  -- NULL = instance default (DEFAULT_TIMEZONE).
  Timezone TEXT,
  -- Optional contact details shown to clients in the booking widget.
  ContactEmail TEXT,
  ContactPhone TEXT,
  -- Profile-level booking horizon (0004): a request may not START more than this many calendar
  -- months from today (tenant timezone, day-clamped). NULL = no limit. One value for the whole
  -- business — the per-service knob is TenantServices.MinLeadDays.
  MaxAdvanceMonths INTEGER,
  -- How many days a request may overlap OPPOSITE-kind occupancy — a house sit over boarding or
  -- boarding over a house sit (0006). Tenant-wide because it models the sitter's own whereabouts,
  -- not a pool. A shared day only ever counts as a HANDOVER: the request arrives on a day
  -- everything else departs on, or departs on a day everything else arrives on. 0 = never; 1 = the
  -- default; 2 = one at each end of the stay; NULL = no limit. Above 2 is unreachable.
  HousesitBoardingOverlapDays INTEGER DEFAULT 1,
  -- NULL = active; timestamp = disabled by the owner (widget dark + admin read-only).
  DisabledAt TEXT,
  -- Paid-through instant, set and cleared by the platform owner (0010). NULL = free, which is what
  -- every tenant is until an owner says otherwise. Stored in the `datetime('now')` shape
  -- ('YYYY-MM-DD HH:MM:SS', UTC) like DisabledAt/CreatedAt, because a fixed-width UTC string
  -- compares lexicographically in chronological order — entitlement is the string comparison
  -- `PremiumUntil > now`, evaluated on every read (server/lib/premium.ts). Deliberately a moment
  -- and not a boolean: a boolean needs a job to flip it and is wrong for as long as that job is
  -- late. The free product stores this and publishes one derived flag; it gates nothing itself.
  PremiumUntil TEXT,
  -- How the calendar backfill reads a description `Cost:` on a RANGE-shaped service (0013):
  -- 'total' = that figure is the whole charge for the stay; 'per-night' = it is a nightly rate and
  -- the backfill multiplies it by the stay's nights. A SINGLE-shaped service (a walk) has no
  -- nights, so its `Cost:` is the whole charge under both and this setting never reaches it.
  -- DEFAULT 'total' deliberately: reading a total as a per-night rate OVERCHARGES A CLIENT, while
  -- reading a per-night rate as a total only undercharges the sitter — the harm the sitter owns
  -- and can correct herself. It is also the pre-0013 behaviour, so no tenant's billing changes
  -- until someone chooses per-night in the admin.
  CalendarCostBasis TEXT NOT NULL DEFAULT 'total'
    CHECK (CalendarCostBasis IN ('total', 'per-night')),
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
  -- Optional SHORT blurb the sitter writes, shown to pet owners under the service name in the
  -- embed widget (0025). Plain text, capped at 200 chars by the admin PUT. NULL = absent.
  Description TEXT,
  Shape TEXT NOT NULL CHECK (Shape IN ('range', 'single')),
  -- 'walk' added by 0024: walks are priced per WALK, not per visit. The unit is printed straight
  -- from this column, so a new noun needs a new allowed value, not a display-time substitution.
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit', 'walk')),
  HasDuration INTEGER NOT NULL DEFAULT 0, -- options priced per duration (walk/check-in style)?
  -- Which capacity RULE the service uses (not the service's name): 'boarding' and 'housesit' both
  -- count PETS against their own MaxConcurrentPets; 'none' = unlimited (blocked days only).
  CapacityKind TEXT NOT NULL DEFAULT 'none' CHECK (CapacityKind IN ('boarding', 'housesit', 'none')),
  SortOrder INTEGER NOT NULL DEFAULT 0,
  -- Per-service intake questions (JSON array of ServiceQuestion, see src/shared/booking/service-rules.ts)
  -- + optional booking-level limits. NULL limit = unlimited. There is deliberately NO MinNights
  -- and NO MinPetCount: the minimum stay is structurally 1 night and services have only a
  -- max-pets limit — a settings PUT that still sends either is rejected, not silently dropped.
  Questions TEXT NOT NULL DEFAULT '[]',
  MaxNights INTEGER,
  MaxPetCount INTEGER,
  -- Minimum notice in days for this service's START date, evaluated in the tenant's timezone
  -- (0004). NULL or 0 = same-day requests allowed; 1 = earliest requestable date is tomorrow.
  MinLeadDays INTEGER,
  -- JSON array of pet-type slugs this service accepts; NULL = accepts every registry type
  -- (null-is-unlimited convention). An empty array is invalid for an ENABLED service.
  AcceptedPetTypes TEXT,
  -- Per-service capacity (NULL = unlimited). MaxConcurrentPets is the pets-per-day cap for BOTH
  -- pool kinds: CapacityKind='boarding' and 'housesit' both read it — a booking with three pets
  -- uses three slots. A cap on a 'none'-kind service is rejected on PUT.
  MaxConcurrentPets INTEGER,
  -- Tiered cancellation policy (added by 0016); JSON array like
  -- [{"withinDays":2,"percent":100},{"withinDays":7,"percent":50}]. NULL = no fee.
  CancellationTiers TEXT,
  -- Optional explicit whole-dollar rate for billed units falling on a listed US holiday
  -- (src/shared/util/us-holidays.ts). NULL = no holiday pricing (today's behavior). Same unit as
  -- RateUnit. A STORED rate, never a multiplier and never pet-count-scaled — the price formula
  -- (server/lib/holiday-cost.ts) may only multiply a stored rate by units of time.
  HolidayRate INTEGER CHECK (HolidayRate IS NULL OR HolidayRate >= 1),
  -- How a pet SET with no stored pet-set rate is priced (0005). 'exact' = REFUSE it (the original
  -- no-inferred-pricing behaviour); 'linear' = the option's own rate x the number of distinct
  -- pets. The default is 'exact', so a row nobody chose a mode for prices exactly as it did before
  -- this column existed. A stored pet-set rate ALWAYS wins over the multiplier — the multiplier is
  -- only the fallback the sitter opted into, and their stored choice IS the typed consent that
  -- keeps "a rate the sitter did not type is a price they did not agree to" true.
  PetRateMode TEXT NOT NULL DEFAULT 'exact' CHECK (PetRateMode IN ('exact', 'linear')),
  -- Extra-time surcharge (0009). The hours a stay NORMALLY starts and ends, plus two independent
  -- FLAT whole-dollar fees for an owner-set arrival before / departure after them. All four
  -- nullable, and each side needs BOTH its time and its fee to do anything: NULL = the feature is
  -- off, the HolidayRate convention. Settable only where the OWNER sets the times at all
  -- (HasDuration = 0: boarding, house sitting, daycare) — on a walk or check-in the option's slot
  -- IS the clock, so a "standard hour" there would be config a sitter typed that never applies.
  --
  -- Deliberately FLAT and PER STAY, not per hour and not per day: an hourly fee needs a rounding
  -- rule and a rounding rule is a price the sitter did not type, and a stay has exactly ONE arrival
  -- and ONE departure, so billing a multi-night stay per day for a single early drop-off invents an
  -- event that never happened. The consequence is that the whole feature performs no
  -- multiplication — it sums stored amounts.
  --
  -- The fee is NOT part of EstCost: it lands as a BookingCharges row (see BookingCharges.Origin
  -- below and server/lib/booking-times.ts), so estimateCost stays "units of time x a stored rate"
  -- and total due stays EstCost + SUM(charges).
  StandardArrivalTime TEXT,
  StandardDepartureTime TEXT,
  EarlyArrivalFee INTEGER CHECK (EarlyArrivalFee IS NULL OR EarlyArrivalFee >= 1),
  LateDepartureFee INTEGER CHECK (LateDepartureFee IS NULL OR LateDepartureFee >= 1),
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
  -- The billing unit is TenantServices.RateUnit — options deliberately carry no copy of it.
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

-- Explicit rate for a specific pet-id set, keyed per OPTION so OptionKey pins duration — no
-- suffix or DurationMinutes column needed. GroupKey is the sorted, comma-joined pet-id list —
-- see buildGroupKey in src/shared/pricing/pet-set-rates.ts. The billing unit comes from
-- TenantServices.RateUnit. Written one row at a time by the admin pet-group-rate routes
-- (upsert/delete-one — group rows scale with the client base); exact-match only, read for
-- pricing by loadPetSetRates (server/lib/availability.ts), which feeds estimateCost — see
-- CLAUDE.md's pet-set-rates paragraph.
CREATE TABLE IF NOT EXISTS PetGroupPricing (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  GroupKey TEXT NOT NULL,
  Rate INTEGER NOT NULL CHECK (Rate > 0),
  UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (TenantId, ServiceType, OptionKey, GroupKey)
);

-- Explicit rate for a species count ("2 dogs"), applying to every client, keyed per OPTION (0021).
-- MixKey is species-sorted 'slug:count' joined by '|' — see buildMixKey in
-- src/shared/pricing/pet-set-rates.ts. Keyed per option (duration already pinned), so unlike
-- PetGroupPricing this needs no RateUnit/DurationMinutes. Exact-match only; written by the
-- admin settings PUT (per-option replace); read for pricing by loadPetSetRates
-- (server/lib/availability.ts), which feeds estimateCost — see CLAUDE.md's pet-set-rates
-- paragraph.
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
  UNIQUE (TenantId, PetType)
);

CREATE TABLE IF NOT EXISTS EndUsers (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Email TEXT NOT NULL,
  Name TEXT,
  Phone TEXT,
  -- Only needed when the client's Venmo handle differs from the name above; NULL = match on Name.
  -- Read exclusively by the Venmo CSV importer (server/lib/venmo.ts).
  VenmoUsername TEXT,
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

-- Intake answers a customer has already given, re-offered as the PRE-FILL on their next booking
-- for the same service (0007). Customer-authored content about their own pets: written only by
-- the booking POST, from what that customer actually submitted, and read only back to them.
--
-- Keyed (TenantId, EndUserId, ServiceType, QuestionId): the question's own stable id, scoped to
-- the service that asked it, because ids are unique only within a service's Questions JSON.
-- `Shape` is `questionShape()` (src/shared/booking/service-rules.ts) AS OF THE ANSWER — a saved
-- answer pre-fills only when the question still has that shape, so a sitter who rewords or
-- retypes a question drops the stale answer instead of resurrecting it against a changed
-- question. The pre-fill is re-validated on read AND re-validated as a normal answer on the next
-- POST; it is never trusted.
CREATE TABLE IF NOT EXISTS SavedAnswers (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL,
  QuestionId TEXT NOT NULL,
  Shape TEXT NOT NULL,
  Value TEXT NOT NULL,
  UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (TenantId, EndUserId, ServiceType, QuestionId)
);

CREATE INDEX IF NOT EXISTS idx_SavedAnswers_Lookup
  ON SavedAnswers (TenantId, EndUserId);

-- A long-lived credential a customer issues to THEMSELVES (0012), so something other than the
-- widget can call the booking API as them. `server/lib/llms.ts` publishes how to check
-- availability, quote, book, change and cancel — and every one of those endpoints needs
-- endUserAuth, whose only other credential is a 24h widget JWT minted by the widget's own
-- email-code flow. Without this table that document describes an API nothing outside the widget
-- can use. A token grants exactly what its owner could already do in the widget: same tenant,
-- same end user, no more.
--
-- Only a SHA-256 of the token is stored, never the token. Plain SHA-256 rather than
-- TenantUsers.PasswordHash's PBKDF2 because the input is 256 CSPRNG bits, not a human-chosen
-- password: there is nothing to slow an attacker down about, and this hash is recomputed on every
-- authenticated request. server/lib/personal-access-token.ts owns that argument in full.
--
-- RevokedAt is a timestamp rather than a DELETE, so the hash survives revocation (a dead secret
-- can never land on a live row) and the owner keeps a record. There is deliberately no expiry
-- column: the widget JWT's TTL *is* its revocation, and having a real one is the point of this
-- table. LastUsedAt is a recognition aid ("is this the one my laptop uses?"), stamped at coarse
-- resolution so a chatty client does not make a write out of every read.
CREATE TABLE IF NOT EXISTS PersonalAccessTokens (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  -- The owner's own label for the client they issued it to ("my laptop", "my assistant"): how they
  -- tell one token from another in the revoke list, so it is required. Never interpreted.
  Name TEXT NOT NULL,
  TokenHash TEXT NOT NULL, -- lowercase hex SHA-256; the plaintext is disclosed once, at creation
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  LastUsedAt TEXT,
  RevokedAt TEXT -- NULL = live; set = dead from that instant, filtered by the auth lookup
);

-- The authentication lookup, bound on every PAT-authenticated request. UNIQUE costs nothing here
-- and turns a hash collision — or a bug that re-inserted a secret — into a write-time error
-- rather than an ambiguous read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_PersonalAccessTokens_Hash
  ON PersonalAccessTokens (TenantId, TokenHash);

-- The owner's own list, and the scope of every management route.
CREATE INDEX IF NOT EXISTS idx_PersonalAccessTokens_Owner
  ON PersonalAccessTokens (TenantId, EndUserId);

-- Blocked days are rows with ServiceType='blocked' (EndUserId NULL, Status 'confirmed'),
-- mirroring how production models blocked time as calendar events of type 'blocked'.
-- Materialized Google events are rows with ServiceType='external' (see calendar-sync.ts).
CREATE TABLE IF NOT EXISTS BookingRequests (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL, -- tenant service slug, or the reserved 'blocked' or 'external'
  StartDate TEXT NOT NULL,
  EndDate TEXT, -- exclusive checkout for boarding/blocked ranges; NULL for single-day walks
  OptionKey TEXT, -- which TenantServiceOptions row the customer picked; NULL for blocked
  PetCount INTEGER NOT NULL DEFAULT 1 CHECK (PetCount >= 1),
  -- 'HH:MM' wall-clock. Duration-priced services (walk/check-in, HasDuration = 1): the option's
  -- slot time. Everything else (boarding, house sitting, daycare): the owner's optional ARRIVAL
  -- time. NULL = all-day / not given.
  StartTime TEXT,
  -- 'HH:MM' wall-clock, ALWAYS owner-set and never an option's clock (0008) — deliberately not a
  -- mirror of StartTime's dual purpose, and deliberately not named EndTime, which on
  -- TenantServiceOptions means the far edge of a bookable WINDOW. On a range stay it is the
  -- departure time on the END date, so it may legally be earlier in the day than StartTime; on a
  -- single-day booking both times are on StartDate and it must be strictly later. NULL = not given.
  DepartureTime TEXT,
  GCalEventId TEXT, -- Google Calendar event id created for this booking; NULL if none/unsynced
  -- Calendar-sync outbox: 1 = this row has a state change Google has not confirmed yet
  -- (create/update/delete derived from Status+GCalEventId at re-drive time). Set in the SAME
  -- statement as the state change, cleared only on push success, re-driven by the cron sweep.
  -- Always 0 for 'external' (Google is the writer there); 'blocked' rows use the outbox exactly
  -- like bookings.
  SyncPending INTEGER NOT NULL DEFAULT 0,
  -- ServiceType='external' rows only: the Google event's summary, shown on the admin calendar.
  -- External rows are Google-owned mirrors (EndUserId NULL, Status 'confirmed', EstCost NULL,
  -- GCalEventId = the Google id): they block capacity like blocked days and are read-only here.
  ExternalSummary TEXT,
  EstCost INTEGER,
  -- Fee assessed at cancel time, whole dollars, matches EstCost (added by 0016). NULL = none assessed.
  CancellationFee INTEGER,
  Answers TEXT NOT NULL DEFAULT '{}', -- JSON {questionId: answer}; questions defined on TenantServices
  -- 'declined' is the sitter's "no" to a still-pending request; a confirmed booking is
  -- cancelled, never declined. Both are terminal.
  Status TEXT NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'confirmed', 'cancelled', 'declined')),
  Source TEXT, -- attribution channel: 'mcp', 'voice', etc.; NULL = embed widget (0022)
  IdempotencyKey TEXT, -- replay-protection key, unique per (TenantId, EndUserId) (0023)
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_Dates ON BookingRequests (TenantId, StartDate);
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Slot
  ON BookingRequests (TenantId, ServiceType, OptionKey, StartDate);
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Tenant_User ON BookingRequests (TenantId, EndUserId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_BookingRequests_IdempotencyKey
  ON BookingRequests (TenantId, EndUserId, IdempotencyKey)
  WHERE IdempotencyKey IS NOT NULL;
-- Upsert target for materialized Google events: one row per (tenant, Google event id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_BookingRequests_External
  ON BookingRequests (TenantId, GCalEventId) WHERE ServiceType = 'external';

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
CREATE INDEX IF NOT EXISTS idx_BookingRequestPets_Pet ON BookingRequestPets (PetId);

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

-- Recorded payments (earnings analytics). Multiple rows per booking (deposits/partials); whole
-- dollars matching EstCost/Rate. PaidDate is sitter-entered.
--
-- A payment settles EITHER one booking OR one household — never both, never neither (0011). The
-- household form exists because that is how clients actually pay: one cheque a month covering eight
-- bookings is ONE row against the household, not a split the sitter had to invent. The `CHECK` is
-- what keeps the two readable as one ledger: a row with neither is money attached to nothing, and a
-- row with both is two readers disagreeing about which side counts it, which is how a payment gets
-- counted twice.
CREATE TABLE IF NOT EXISTS Payments (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  -- NULL when this payment was recorded against the household in AccountId below.
  BookingRequestId TEXT REFERENCES BookingRequests(Id),
  -- The household this payment settles: an ACCOUNT ID, which is a pet id — the lexicographically-
  -- first pet of the connected component `src/shared/invoicing/accounts.ts` derives, the same
  -- identity invoice numbering keys off. Deliberately NO foreign key: an account is derived from
  -- the owner<->pet graph rather than stored as a row, so there is nothing to reference, and the
  -- first-sorted pet can change when pets are added. Readers therefore resolve a payment to "the
  -- household whose pets CONTAIN this id" rather than by equality on the account id, which is
  -- stable across that renaming. Tenancy is enforced by the writer (`insertAccountPayment` inserts
  -- through a tenant-scoped SELECT over EndUserPets), like every other guarded write here.
  AccountId TEXT,
  Amount INTEGER NOT NULL CHECK (Amount > 0), -- whole dollars, matching EstCost/Rate
  Method TEXT NOT NULL CHECK (Method IN ('cash', 'venmo', 'zelle', 'paypal', 'check', 'card', 'other')),
  PaidDate TEXT NOT NULL, -- 'YYYY-MM-DD', sitter-entered (defaults to today in the UI)
  Note TEXT,
  -- Venmo transaction id when this payment came from a CSV import; NULL for hand-recorded ones.
  -- Deliberately absent from PaymentRow and from every payments wire payload: it is written by the
  -- importer and read only in aggregate, so the type system prevents anything else trusting it.
  ExternalRef TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  -- A payment settles a booking or a household, never both and never neither.
  CHECK ((BookingRequestId IS NULL) <> (AccountId IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_Payments_Tenant_Date ON Payments (TenantId, PaidDate);
CREATE INDEX IF NOT EXISTS idx_Payments_Tenant_Booking ON Payments (TenantId, BookingRequestId);
-- Household payments are read per household, the way booking payments are read per booking.
CREATE INDEX IF NOT EXISTS idx_Payments_Tenant_Account ON Payments (TenantId, AccountId);
-- Idempotent re-import: a transaction id this tenant already recorded cannot be inserted twice.
-- PARTIAL so the NULLs of hand-recorded payments are unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_Payments_Tenant_ExternalRef
  ON Payments (TenantId, ExternalRef) WHERE ExternalRef IS NOT NULL;

-- One-off extras a sitter adds to a booking after the fact (vet visit, haircut). Deliberately a
-- separate table rather than an EstCost edit: EstCost is the price the quote promised and is
-- written exactly once, so total due = EstCost + SUM(charges). Money owed, the sibling of
-- Payments (money in).
CREATE TABLE IF NOT EXISTS BookingCharges (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  Label TEXT NOT NULL,
  Amount INTEGER NOT NULL CHECK (Amount >= 1), -- whole dollars, matching EstCost/Rate/Payments
  -- PROVENANCE (0009). NULL = the sitter typed this charge herself, which is every row that
  -- existed before this column and every row the admin Charges panel writes. The two
  -- 'extra_time_*' values mark a charge DERIVED from the booking's own times, which is what lets a
  -- customer edit that MOVES those times re-derive exactly those rows and leave hers untouched —
  -- including a fee she deliberately deleted, since an edit that moves nothing re-derives nothing.
  -- Values are owned by server/lib/booking-times.ts / server/types.ts's EXTRA_TIME_ORIGINS.
  Origin TEXT CHECK (Origin IS NULL OR Origin IN ('extra_time_early', 'extra_time_late')),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_BookingCharges_Tenant_Booking
  ON BookingCharges (TenantId, BookingRequestId);

CREATE TABLE IF NOT EXISTS ProviderConnections (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Capability TEXT NOT NULL,
  Provider TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected', 'connected')),
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
