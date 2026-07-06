-- Covering index for the windowed-slot capacity path (countSlotBookings / listSlotBookingCounts).
CREATE INDEX IF NOT EXISTS idx_BookingRequests_Slot
  ON BookingRequests (TenantId, ServiceType, OptionKey, StartDate);
