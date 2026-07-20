-- Custom pet types: TenantPetTypes becomes the authoritative per-tenant species list (slug +
-- renamable Label, no CHECK enum), EndUserPets drops its ('dog','cat') CHECK so pets can carry
-- any tenant slug, and TenantServices gains AcceptedPetTypes — a JSON array of pet-type slugs,
-- NULL = accepts every enabled type (the schema-wide null-is-unlimited convention).
-- See docs/superpowers/specs/2026-07-19-animal-types-design.md.
--
-- NOT IDEMPOTENT — apply exactly once, and only via `wrangler d1 execute --file` (below). That
-- runner wraps the file in a single transaction, so an accidental re-run fails on the duplicate
-- ALTER/rebuild and rolls the whole file back, leaving data intact. A non-transactional runner
-- would instead partially re-apply and FLATTEN any custom pet-type Labels a sitter has since
-- edited back to their migration-time defaults. Never re-run; write a new migration instead.
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0014_custom_pet_types.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0014_custom_pet_types.sql
-- D1 runs a file inside a transaction where `PRAGMA foreign_keys` is a no-op; defer_foreign_keys
-- is its supported escape hatch — FKs are re-checked at COMMIT, when the renamed tables are back
-- (BookingRequestPets.PetId references EndUserPets(Id), which is rebuilt below).
PRAGMA defer_foreign_keys = true;

-- 1) Rebuild TenantPetTypes without the CHECK, adding Label (backfilled from the old enum).
CREATE TABLE TenantPetTypes_new (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  PetType TEXT NOT NULL,            -- per-tenant slug ('dog', 'rabbit', ...), immutable
  Label TEXT NOT NULL,              -- display name ('Dogs', 'Rabbits'), renamable
  Enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (TenantId, PetType)
);
INSERT INTO TenantPetTypes_new (TenantId, PetType, Label, Enabled)
SELECT TenantId, PetType,
       CASE PetType WHEN 'dog' THEN 'Dogs' ELSE 'Cats' END,
       Enabled
FROM TenantPetTypes;
DROP TABLE TenantPetTypes;
ALTER TABLE TenantPetTypes_new RENAME TO TenantPetTypes;

-- 2) Backfill: every tenant gets dog + cat rows (DISABLED) where absent. Required, not cosmetic:
--    the settings GET used to synthesize both toggles from the code enum, so a tenant with only
--    a dog row would silently lose its Cats toggle once rows drive the list (spec finding F1).
INSERT OR IGNORE INTO TenantPetTypes (TenantId, PetType, Label, Enabled)
SELECT t.Id, d.PetType, d.Label, 0
FROM Tenants t
CROSS JOIN (SELECT 'dog' AS PetType, 'Dogs' AS Label
            UNION ALL SELECT 'cat', 'Cats') d;

-- 3) Rebuild EndUserPets without its CHECK; PetType stays a plain TEXT slug so existing pets
--    keep working untouched.
CREATE TABLE EndUserPets_new (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Name TEXT NOT NULL,
  PetType TEXT NOT NULL, -- tenant pet-type slug
  Notes TEXT, -- care notes the sitter keeps (feeding, meds, temperament)
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO EndUserPets_new (Id, TenantId, EndUserId, Name, PetType, Notes, CreatedAt)
SELECT Id, TenantId, EndUserId, Name, PetType, Notes, CreatedAt FROM EndUserPets;
DROP TABLE EndUserPets;
ALTER TABLE EndUserPets_new RENAME TO EndUserPets;
CREATE INDEX IF NOT EXISTS idx_EndUserPets_Tenant_User ON EndUserPets (TenantId, EndUserId);

-- 4) Per-service acceptance list. NULL for every existing service = accepts all enabled types,
--    i.e. today's behavior exactly.
ALTER TABLE TenantServices ADD COLUMN AcceptedPetTypes TEXT;

PRAGMA defer_foreign_keys = false;
