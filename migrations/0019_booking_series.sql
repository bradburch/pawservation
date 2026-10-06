-- A repeating booking is a stored series. BookingSeries holds the terms (who, which pets, which
-- service and option, which weekdays, what time, from when, until when or open); each walk inside
-- the sitter's booking window is an ordinary BookingRequests row carrying SeriesId; every walk
-- beyond it is projected on read from this rule. BookingSeriesSkips records weeks that were not
-- booked and why. Additive: every existing booking keeps SeriesId NULL and stays a single booking.
-- Apply by hand: npx wrangler d1 execute pawservation-db --remote --file ./migrations/0019_booking_series.sql
CREATE TABLE IF NOT EXISTS BookingSeries (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT,
  Weekdays INTEGER NOT NULL CHECK (Weekdays BETWEEN 1 AND 127),
  StartTime TEXT,
  StartDate TEXT NOT NULL,
  EndDate TEXT,
  Status TEXT NOT NULL CHECK (Status IN
    ('pending', 'pending_client', 'active', 'ended', 'declined', 'expired')),
  CreatedBy TEXT NOT NULL CHECK (CreatedBy IN ('client', 'sitter')),
  OfferExpiresAt TEXT,
  MaterializedThrough TEXT,
  Version INTEGER NOT NULL DEFAULT 1,
  GCalEventId TEXT,
  SyncPending INTEGER NOT NULL DEFAULT 0,
  IdempotencyKey TEXT,
  CreatedAt TEXT NOT NULL,
  UpdatedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_BookingSeries_Tenant_Status ON BookingSeries (TenantId, Status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_BookingSeries_Idem ON BookingSeries (TenantId, EndUserId, IdempotencyKey)
  WHERE IdempotencyKey IS NOT NULL;

CREATE TABLE IF NOT EXISTS BookingSeriesPets (
  SeriesId TEXT NOT NULL REFERENCES BookingSeries(Id),
  PetId TEXT NOT NULL REFERENCES EndUserPets(Id),
  PRIMARY KEY (SeriesId, PetId)
);

CREATE TABLE IF NOT EXISTS BookingSeriesSkips (
  SeriesId TEXT NOT NULL REFERENCES BookingSeries(Id),
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Date TEXT NOT NULL,
  Reason TEXT NOT NULL CHECK (Reason IN ('full', 'time_off', 'unpriced_pet_set',
    'cost_out_of_range', 'unavailable', 'paused', 'cancelled')),
  CreatedAt TEXT NOT NULL,
  PRIMARY KEY (SeriesId, Date)
);

ALTER TABLE BookingRequests ADD COLUMN SeriesId TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_BookingRequests_Series_Date
  ON BookingRequests (SeriesId, StartDate) WHERE SeriesId IS NOT NULL;
