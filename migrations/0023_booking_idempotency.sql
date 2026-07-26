-- 0023_booking_idempotency.sql
-- Client-supplied replay-protection key for POST /api/:slug/bookings (Idempotency-Key header).
-- Scoped per (tenant, customer) so one customer's key can never collide with or leak another's booking.
--
-- NOT IDEMPOTENT — the ALTER TABLE is not idempotent; apply exactly once per database.
-- The CREATE UNIQUE INDEX uses IF NOT EXISTS and is idempotent.

ALTER TABLE BookingRequests ADD COLUMN IdempotencyKey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_BookingRequests_IdempotencyKey
  ON BookingRequests (TenantId, EndUserId, IdempotencyKey)
  WHERE IdempotencyKey IS NOT NULL;
