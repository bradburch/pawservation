-- Migration 0016. A SITTER CAN ISSUE HERSELF AN ACCESS TOKEN.
-- Mirror of 0012 (PersonalAccessTokens) for the sitter side: same entropy, same hash, no expiry.
-- Additive only. No Tenants column, so the KV tenant-config cache key does not move.
-- THIS FILE MUST CONTAIN NO BEGIN/COMMIT/SAVEPOINT.
CREATE TABLE IF NOT EXISTS TenantAccessTokens (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  TenantUserId TEXT NOT NULL REFERENCES TenantUsers(Id),
  Name TEXT NOT NULL,
  TokenHash TEXT NOT NULL,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  LastUsedAt TEXT,
  RevokedAt TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_TenantAccessTokens_Hash ON TenantAccessTokens (TenantId, TokenHash);
CREATE INDEX IF NOT EXISTS idx_TenantAccessTokens_Owner ON TenantAccessTokens (TenantId, TenantUserId);
