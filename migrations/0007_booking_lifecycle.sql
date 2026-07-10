-- Sitter confirm/decline dashboard: a pending request the sitter declines is stored as
-- Status='cancelled' + this flag (Status stays a 3-value CHECK; SQLite can't widen a CHECK
-- without a full table rebuild). See
-- docs/superpowers/specs/2026-07-10-sitter-booking-dashboard-design.md.
-- Run against provisioned DBs (local then remote):
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0007_booking_lifecycle.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0007_booking_lifecycle.sql

ALTER TABLE BookingRequests ADD COLUMN Declined INTEGER NOT NULL DEFAULT 0;
