/**
 * How a sitter's calendar describes money — `Tenants.CalendarCostBasis` (migration 0013).
 *
 * The calendar backfill reads a `Cost:` line out of an event's description and adopts that figure
 * rather than the rate card. On a RANGE-shaped service (boarding, house sitting) the figure is
 * ambiguous on its face, and which reading is right is a fact about the individual sitter's own
 * habit in her own calendar — not something any code can derive:
 *
 * - `'total'`     — the figure is the whole charge for the stay. THE DEFAULT.
 * - `'per-night'` — the figure is a nightly rate; the backfill multiplies it by the stay's nights.
 *
 * A SINGLE-shaped service (a walk, a drop-in) has no nights to bill, so its `Cost:` is the whole
 * charge under BOTH values and this setting must never reach that path.
 *
 * `'total'` IS THE DEFAULT AS A SAFETY CHOICE, not merely a compatible one. The two ways of being
 * wrong are not symmetric: reading a total AS a per-night rate triples a three-night stay and
 * OVERCHARGES A REAL CLIENT — money taken from someone who never agreed to it. Reading a
 * per-night rate as a total undercharges the sitter, which is her own revenue to forgo and her own
 * setting to correct. Where the stored value may be wrong, err toward the harm that belongs to the
 * party who owns the setting.
 *
 * Lives here, next to `isPetRateMode`, for the same reason that predicate does: the admin bundle
 * renders the sitter's stored choice from the SAME type the server validates against, and neither
 * side computes money from it.
 */
export type CalendarCostBasis = 'total' | 'per-night';

/** The product default for `Tenants.CalendarCostBasis`. Mirrors the column's own DEFAULT. */
export const DEFAULT_CALENDAR_COST_BASIS: CalendarCostBasis = 'total';

export function isCalendarCostBasis(value: unknown): value is CalendarCostBasis {
  return value === 'total' || value === 'per-night';
}
