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
