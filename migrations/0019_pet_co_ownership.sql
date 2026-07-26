-- 0019_pet_co_ownership.sql
-- Spec: docs/superpowers/specs/2026-07-25-invoicing-design.md (D2, Component 1)
--
-- Real pet co-ownership: a pet may have more than one owner. That is what makes an invoicing
-- "account" a genuine connected component of the owner<->pet graph (union-find, Component 2)
-- instead of a synonym for EndUsers.Id. EndUserPets.EndUserId STAYS as the primary/creating
-- owner — it is NOT NULL with an FK, and dropping it would rewrite every pet query in the
-- codebase — so PetOwners is additive: one backfilled row per existing pet.
--
-- TenantId is carried on PetOwners DELIBERATELY, unlike BookingRequestPets (which has none and
-- lets scope flow through its parents): the union-find source query wants every owner<->pet link
-- for one tenant in ONE tenant-scoped read, not a three-way join.
--
-- NOT IDEMPOTENT — apply exactly once per database (wrangler's runner is transactional).
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0019_pet_co_ownership.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0019_pet_co_ownership.sql

-- 1) The ownership edge list. PK (PetId, EndUserId) makes a duplicate link impossible.
CREATE TABLE IF NOT EXISTS PetOwners (
  TenantId  TEXT NOT NULL REFERENCES Tenants(Id),
  PetId     TEXT NOT NULL REFERENCES EndUserPets(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (PetId, EndUserId)
);

-- "Which pets does this customer own?" is the widget's hottest read; mirrors idx_EndUserPets_Tenant_User.
CREATE INDEX IF NOT EXISTS idx_PetOwners_Tenant_User ON PetOwners (TenantId, EndUserId);

-- 2) NULL = alive; a timestamp = the pet has died. Excluded from every bookable/quotable pet list
--    and from the union-find input, so a customer whose only pet has died drops out of accounts.
ALTER TABLE EndUserPets ADD COLUMN DeceasedAt TEXT;

-- 3) Backfill exactly one link per existing pet, from its creating owner.
INSERT INTO PetOwners (TenantId, PetId, EndUserId)
SELECT TenantId, Id, EndUserId FROM EndUserPets;
