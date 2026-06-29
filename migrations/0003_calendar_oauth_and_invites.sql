-- Phase 1 (Google Calendar OAuth) + Phase 2 (invite-only customers).
-- Run against already-provisioned DBs (local first, then remote):
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0003_calendar_oauth_and_invites.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0003_calendar_oauth_and_invites.sql

-- 1. BookingRequests: time-of-day for timed events + the created Google event id.
ALTER TABLE BookingRequests ADD COLUMN StartTime TEXT;
ALTER TABLE BookingRequests ADD COLUMN GCalEventId TEXT;

-- 2. EndUsers become the provider-managed customer list. Existing rows are grandfathered 'active'
--    (the DEFAULT applies to every backfilled row), so the new gate never locks out prior bookers.
ALTER TABLE EndUsers ADD COLUMN Name TEXT;
ALTER TABLE EndUsers ADD COLUMN InvitedAt TEXT;
ALTER TABLE EndUsers ADD COLUMN Status TEXT NOT NULL DEFAULT 'active' CHECK (Status IN ('invited', 'active'));

-- 3. ProviderConnections: widen Status CHECK to include 'connected' + add encrypted-token columns.
--    SQLite cannot ALTER a CHECK, so rebuild the table preserving FK + UNIQUE and copying rows.
PRAGMA foreign_keys=OFF;
CREATE TABLE ProviderConnections_new (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Capability TEXT NOT NULL,
  Provider TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected', 'connected-stub', 'connected')),
  ConnectedAt TEXT,
  AccessToken TEXT,
  RefreshToken TEXT,
  TokenExpiresAt TEXT,
  CalendarId TEXT,
  UNIQUE (TenantId, Capability)
);
INSERT INTO ProviderConnections_new (Id, TenantId, Capability, Provider, Status, ConnectedAt)
  SELECT Id, TenantId, Capability, Provider, Status, ConnectedAt FROM ProviderConnections;
DROP TABLE ProviderConnections;
ALTER TABLE ProviderConnections_new RENAME TO ProviderConnections;
PRAGMA foreign_keys=ON;
