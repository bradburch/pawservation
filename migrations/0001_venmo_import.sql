-- 0001 — Venmo CSV import (first migration after the 2026-07-27 re-baseline).
--
-- 1. EndUsers.VenmoUsername: the client's Venmo handle, needed only when it differs from the name
--    the sitter has for them. NULL (the default) means "match on their name".
-- 2. Payments.ExternalRef: the Venmo transaction id a payment was imported from; NULL for every
--    hand-recorded payment. The PARTIAL unique index below is the whole idempotency mechanism —
--    re-uploading the same CSV cannot insert a second row for a transaction this tenant already
--    has, and the WHERE clause keeps the many NULLs of hand-recorded payments unconstrained.
ALTER TABLE EndUsers ADD COLUMN VenmoUsername TEXT;
ALTER TABLE Payments ADD COLUMN ExternalRef TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_Payments_Tenant_ExternalRef
  ON Payments (TenantId, ExternalRef) WHERE ExternalRef IS NOT NULL;
