import type { RequestType } from '../types/booking.js';

/**
 * Canonical app-level default per-unit rates for each booking service, used when a
 * customer has no `PetPricing` row for the booking type.
 *
 * Single source of truth across the whole app: the booking tile picker
 * (`DEFAULT_PRICING`), the chat/MCP cost quote (`lookupEstimatedCost`), and the
 * booking-service cost stamp (`resolveSitCost`) all derive from this — so the rate a
 * customer sees, the rate the agent quotes, and the rate written to the calendar event
 * can never drift apart. Boarding/house-sit are per-night; walks/check-ins are per-visit.
 */
export const DEFAULT_RATES: Record<RequestType, number> = {
  boarding: 90,
  'house-sit': 100,
  walk: 40,
  'check-in': 40,
};
