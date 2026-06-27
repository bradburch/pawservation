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
 * The `Math.max(1, …)` floor keeps a degenerate 0-night row from billing 0 units.
 */
export function billableUnits(nights: number, costUnit: 'day' | 'night'): number {
  return costUnit === 'day' ? Math.max(1, nights + 1) : Math.max(1, nights);
}
