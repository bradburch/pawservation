-- 0022_booking_source.sql
-- Attribution channel for a booking: 'mcp', 'voice', etc. NULL = the embed widget.
-- Deliberately no CHECK constraint: adding a new channel later must not require a table rebuild.
--
-- NOT IDEMPOTENT — apply exactly once per database (wrangler's runner is transactional).
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --command "ALTER TABLE BookingRequests ADD COLUMN Source TEXT;"
--   npx wrangler d1 execute pawbook-db --remote --command "ALTER TABLE BookingRequests ADD COLUMN Source TEXT;"

ALTER TABLE BookingRequests ADD COLUMN Source TEXT;
