-- 0025_service_description.sql
-- Optional SHORT description a sitter writes for one of their services, displayed to pet owners
-- in the embed widget's service picker. Plain text; NULL = absent (no blurb shown). The 200-char
-- cap is enforced by the admin PUT (server/routes/admin.ts), deliberately not by a CHECK: a
-- length rule is a product decision that must be changeable without a table rebuild.
--
-- NOT IDEMPOTENT — apply exactly once per database (wrangler's runner is transactional).
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --command "ALTER TABLE TenantServices ADD COLUMN Description TEXT;"
--   npx wrangler d1 execute pawbook-db --remote --command "ALTER TABLE TenantServices ADD COLUMN Description TEXT;"

ALTER TABLE TenantServices ADD COLUMN Description TEXT;
