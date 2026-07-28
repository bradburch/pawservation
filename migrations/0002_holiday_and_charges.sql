-- Migration 0002. Note: 0001 lives on the unmerged feat/venmo-import branch — this branch's
-- migrations/ was empty at the time this file was created, so numbering restarts here.
--
-- WS-H: holiday rates + extra charges.
--
-- 1. TenantServices.HolidayRate — an OPTIONAL, EXPLICIT, whole-dollar rate charged for billed
--    units that fall on a listed US holiday (src/shared/util/us-holidays.ts). NULL = no holiday
--    pricing, which is every service until a sitter sets one and is byte-identical to the
--    pre-holiday price. It is a STORED RATE in the same unit as the service's own RateUnit, never
--    a multiplier and never scaled by pet count — see server/lib/holiday-cost.ts.
--
-- 2. BookingCharges — one-off extras a sitter adds to a booking after the fact (vet visit,
--    haircut). Deliberately a separate table rather than an EstCost edit: EstCost is the price the
--    quote promised and is written exactly once, so total due = EstCost + SUM(charges).
--    Tenant-keyed, so it is also added to deleteTenantCompletely's child-first delete list.

ALTER TABLE TenantServices ADD COLUMN HolidayRate INTEGER;

CREATE TABLE IF NOT EXISTS BookingCharges (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  Label TEXT NOT NULL,
  Amount INTEGER NOT NULL CHECK (Amount >= 1), -- whole dollars, matching EstCost/Rate/Payments
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_BookingCharges_Tenant_Booking
  ON BookingCharges (TenantId, BookingRequestId);
