// Costs are integer dollars. Brad's billing has never used fractional dollars,
// so the per-unit rate (`cost`) is displayed as-is — no rounding mode, no
// integer-cents conversion. If fractional rates ever land in the pricing table,
// switch to integer cents end-to-end (DB write, this module, the UI).

/** The billing unit a per-unit rate is quoted in. `null` ⇒ flat (timed services). */
export type CostUnit = 'day' | 'night' | null;

/**
 * A single combined-set pricing entry, keyed by the COMBINATION of pets, the booking
 * type, and — for timed services — the visit DURATION. Like a walk: "Pedro Walk",
 * "Pedro & Remy Walk", and "Remy Walk" are distinct entries, and a 2-hour walk is a
 * distinct entry from a 1-hour walk. A booking is priced by the entry for its exact
 * pet set + duration as a single row — there is NO per-pet arithmetic and NO
 * proration across durations anywhere in the cost path.
 *
 * `groupKey` is the composite key (build it with {@link pricingCompositeKey}): the
 * sorted, de-duplicated, comma-joined member PetIds, with the duration appended for
 * timed services. `petIds` is the same membership as an array. `durationMinutes` is
 * the visit length in minutes for timed services, or `null` for sits.
 */
export interface PetGroupPricingRow {
  groupKey: string;
  bookingType: string;
  cost: number;
  costUnit: CostUnit;
  petIds: string[];
  durationMinutes: number | null;
}

export interface EffectivePrice {
  cost: number;
  costUnit: string;
}
