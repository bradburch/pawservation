-- Sitter-managed pets per customer + the booking→pets join (see
-- docs/superpowers/specs/2026-06-30-customer-pets-and-login-gate-design.md).
-- Run against provisioned DBs (local then remote):
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0004_customer_pets.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0004_customer_pets.sql

CREATE TABLE IF NOT EXISTS EndUserPets (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Name TEXT NOT NULL,
  PetType TEXT NOT NULL CHECK (PetType IN ('dog', 'cat')),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_EndUserPets_Tenant_User ON EndUserPets (TenantId, EndUserId);

CREATE TABLE IF NOT EXISTS BookingRequestPets (
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  PetId TEXT NOT NULL REFERENCES EndUserPets(Id),
  PRIMARY KEY (BookingRequestId, PetId)
);
