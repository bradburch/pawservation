-- Earnings analytics: real payment records against bookings. Multiple rows per booking
-- (deposits/partial payments); amounts are whole dollars matching EstCost/Rate. PaidDate is
-- sitter-entered (payments are often recorded days late; monthly grouping follows the sitter's
-- stated date, not insertion time). See
-- docs/superpowers/specs/2026-07-11-earnings-analytics-design.md.
-- Run against provisioned DBs (local then remote):
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0008_payments.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0008_payments.sql

CREATE TABLE IF NOT EXISTS Payments (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  Amount INTEGER NOT NULL CHECK (Amount > 0), -- whole dollars, matching EstCost/Rate
  Method TEXT NOT NULL CHECK (Method IN ('cash', 'venmo', 'zelle', 'paypal', 'check', 'card', 'other')),
  PaidDate TEXT NOT NULL, -- 'YYYY-MM-DD', sitter-entered (defaults to today in the UI)
  Note TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_Payments_Tenant_Date ON Payments (TenantId, PaidDate);
CREATE INDEX IF NOT EXISTS idx_Payments_Tenant_Booking ON Payments (TenantId, BookingRequestId);
