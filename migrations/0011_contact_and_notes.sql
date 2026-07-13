-- UX round: business contact info, client phone, pet care notes.
-- Declined already added by 0007_booking_lifecycle.sql (custom-services lineage); not repeated here.
ALTER TABLE Tenants ADD COLUMN ContactEmail TEXT;
ALTER TABLE Tenants ADD COLUMN ContactPhone TEXT;
ALTER TABLE EndUsers ADD COLUMN Phone TEXT;
ALTER TABLE EndUserPets ADD COLUMN Notes TEXT;
