ALTER TABLE TenantServiceOptions ADD COLUMN StartTime TEXT; -- 'HH:MM'; NULL = no fixed window
ALTER TABLE TenantServiceOptions ADD COLUMN EndTime TEXT;   -- 'HH:MM'; NULL = no fixed window
ALTER TABLE TenantServiceOptions ADD COLUMN Capacity INTEGER; -- max concurrent bookings/date; NULL = unlimited
