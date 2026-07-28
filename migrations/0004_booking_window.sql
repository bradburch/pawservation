-- Booking window (owner directive 2026-07-28):
--  * TenantServices.MinLeadDays — per-service minimum notice, in days, evaluated in the
--    tenant's timezone. NULL (or 0) = same-day requests allowed; 1 = the earliest requestable
--    start date is tomorrow. Applies to the START date of a request only.
--  * Tenants.MaxAdvanceMonths — ONE profile-level horizon for the whole business. NULL = no
--    limit; 8 = a request may not START more than 8 calendar months from today (day-clamped:
--    Jan 31 + 1 month = the last day of February).
-- Both are NULL-=-unlimited, matching MaxNights / MaxConcurrentPets semantics.

ALTER TABLE TenantServices ADD COLUMN MinLeadDays INTEGER;
ALTER TABLE Tenants ADD COLUMN MaxAdvanceMonths INTEGER;
