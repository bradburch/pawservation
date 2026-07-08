-- UX round: business contact info, client phone, pet care notes, and a distinct
-- "declined" marker for booking requests (kept as a flag beside the Status enum —
-- widening the Status CHECK would need a full table rebuild).
-- ponytail: fold Declined into Status if BookingRequests ever needs a rebuild migration anyway.
ALTER TABLE Tenants ADD COLUMN ContactEmail TEXT;
ALTER TABLE Tenants ADD COLUMN ContactPhone TEXT;
ALTER TABLE EndUsers ADD COLUMN Phone TEXT;
ALTER TABLE EndUserPets ADD COLUMN Notes TEXT;
ALTER TABLE BookingRequests ADD COLUMN Declined INTEGER NOT NULL DEFAULT 0;
