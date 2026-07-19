-- Weekday-only options (onboarding-wizard walk presets): 1 = bookable Mon-Fri only.
-- Server rejects Sat/Sun bookings for these options; the widget greys weekends out.
ALTER TABLE TenantServiceOptions ADD COLUMN WeekdaysOnly INTEGER NOT NULL DEFAULT 0;
