import { nightsBetween } from '../util/dates';

/**
 * One tier of a service's cancellation policy: cancelling within `withinDays`
 * days of the start date owes `percent` % of the booking's estimated cost.
 */
export type CancellationTier = { withinDays: number; percent: number };

/**
 * Fee owed for cancelling on `todayStr` (YYYY-MM-DD, already rendered in the
 * tenant's timezone) a booking starting `startDate`. Tiers are sorted ascending
 * by withinDays (validateCancellationTiers enforces this at the trust
 * boundary), so the first match is the tightest tier. Cancelling on or after
 * the start date counts as 0 days out. 0 outside every tier.
 *
 * `estCostCents` is CENTS, and so is the result — but the fee itself is still a
 * WHOLE-DOLLAR amount, expressed in cents: the percentage is taken in dollars,
 * rounded to the dollar exactly as a sitter's policy has always rounded it, and
 * scaled back up. $350 at 25% is $87.50 → $88 → 8800, not 8750. Moving the unit
 * must not quietly make a cancellation fee a cent-precise figure; that is a
 * pricing-policy change, and this function makes none.
 *
 * That rounding ASSUMES `estCostCents` is a whole number of dollars, which every
 * stored `EstCost` is (`estimateCost` multiplies whole-dollar rates; both routes
 * that let a sitter correct one refuse a fraction). The assumption is asserted
 * rather than trusted: on a fractional cost the dollar rounding would silently
 * charge a percentage of a DIFFERENT figure than the one on the booking, and a
 * fee quietly computed off the wrong base is worse than a loud refusal. It also
 * catches the un-migrated-database case (0015 applied to the code, not the data)
 * at the one place that would otherwise absorb it without a symptom.
 */
export function cancellationFee(
  tiers: CancellationTier[],
  estCostCents: number,
  startDate: string,
  todayStr: string,
): number {
  if (!Number.isSafeInteger(estCostCents) || estCostCents % 100 !== 0) {
    throw new RangeError(
      `cancellationFee: estCostCents must be a whole number of dollars in cents, got ${estCostCents}`,
    );
  }
  const daysUntil = Math.max(0, nightsBetween(todayStr, startDate));
  const tier = tiers.find((t) => daysUntil <= t.withinDays);
  if (!tier) return 0;
  return Math.round(((estCostCents / 100) * tier.percent) / 100) * 100;
}

/** Trust-boundary validator for admin-supplied tier config. */
export function validateCancellationTiers(value: unknown): value is CancellationTier[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return false;
  let prevDays = -1;
  for (const t of value) {
    if (typeof t !== 'object' || t === null || Object.keys(t).length !== 2) return false;
    const { withinDays, percent } = t as Record<string, unknown>;
    if (typeof withinDays !== 'number' || !Number.isInteger(withinDays)) return false;
    if (withinDays < 0 || withinDays <= prevDays) return false;
    if (typeof percent !== 'number' || !Number.isInteger(percent)) return false;
    if (percent < 1 || percent > 100) return false;
    prevDays = withinDays;
  }
  return true;
}
