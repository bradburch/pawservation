-- Per-service intake questions + booking-level constraints (min/max nights, min/max pet count).
-- See docs/superpowers/specs/2026-07-04-service-rules-engine-design.md.
-- Run against provisioned DBs (local then remote):
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0005_service_rules.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0005_service_rules.sql

ALTER TABLE TenantServices ADD COLUMN Questions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE TenantServices ADD COLUMN MinNights INTEGER;
ALTER TABLE TenantServices ADD COLUMN MaxNights INTEGER;
ALTER TABLE TenantServices ADD COLUMN MinPetCount INTEGER;
ALTER TABLE TenantServices ADD COLUMN MaxPetCount INTEGER;

ALTER TABLE BookingRequests ADD COLUMN Answers TEXT NOT NULL DEFAULT '{}';
