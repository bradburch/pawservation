-- Client-supplied replay-protection key for POST /api/:slug/bookings (Idempotency-Key header).
-- Scoped per (tenant, customer) so one customer's key can never collide with or leak another's booking.
ALTER TABLE BookingRequests ADD COLUMN IdempotencyKey TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS BookingRequests_IdempotencyKey
  ON BookingRequests (TenantId, EndUserId, IdempotencyKey)
  WHERE IdempotencyKey IS NOT NULL;
