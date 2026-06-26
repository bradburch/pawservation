import type { RequestType } from '../types/booking.js';
import type { EffectivePrice, PetGroupPricingRow } from './types.js';
import { getCombinedSetPrice } from './pet-group-pricing.js';
import { DEFAULT_RATES } from './default-rates.js';

/**
 * Billable units for a sit (boarding/house-sit), the hotel model in ONE place.
 *
 * `nights` is `nightsBetween(checkIn, checkOutExclusive)` — checkout is exclusive, so
 * Jun 1 → Jun 4 is 3 nights. Units depend on the booking's `costUnit`:
 *
 * - `'night'` bills per overnight → `nights` (a sit always bills ≥ 1 night).
 * - `'day'` is inclusive of the departure day → `nights + 1` (a same-day day-unit
 *   booking is 1 day, never 2).
 *
 * Single source of truth shared by the web dashboard (`calculateAppointmentCost`), the
 * sync invoicer (`calculateChargeAmount`), and the chat/MCP quote (`tool-execution`),
 * so the quote, the stamped cost, and the invoiced amount can never diverge. The
 * `Math.max(1, …)` floor keeps a degenerate 0-night row from billing 0 units.
 */
export function billableUnits(nights: number, costUnit: 'day' | 'night'): number {
  return costUnit === 'day' ? Math.max(1, nights + 1) : Math.max(1, nights);
}

/**
 * Resolve the per-unit booking cost for an exact set of pets: look up the SINGLE
 * combined-set {@link PetGroupPricingRow} for the pet COMBINATION, booking type, and
 * — for timed services (walk/check-in) — the requested visit `durationMinutes`,
 * falling back to the canonical {@link DEFAULT_RATES} rate for the booking type
 * (used when no exact entry matches and when no pets are given). There is NO per-pet
 * summation and NO proration across durations — the combination is priced as one
 * entry, exactly as Brad bills it; a 2-hour walk only matches a stored 2-hour walk.
 *
 * This is also the single source for timed-visit (walk/check-in) pricing: a combined
 * "Pedro & Remy Walk" resolves to its one bundled `PetGroupPricing` entry, never the
 * sum of per-pet rates, superseding the old per-event flat fallback.
 *
 * Single entry point for "what does this booking cost per unit" — shared by the
 * chat/MCP quote and the booking-service cost stamp so they never disagree. Returns
 * the paired `{ cost, costUnit }`; multiply `cost` by nights/visits to get the total.
 */
export function resolveBookingCost(
  rows: PetGroupPricingRow[],
  bookingType: RequestType,
  petIds: string[],
  defaultCostUnit: 'day' | 'night' = 'night',
  durationMinutes?: number | null,
): EffectivePrice {
  return getCombinedSetPrice(
    rows,
    bookingType,
    petIds,
    DEFAULT_RATES[bookingType],
    defaultCostUnit,
    durationMinutes,
  );
}
