import { addDays, holidayNameOn } from '../../src/shared/index.js';

/**
 * The holiday half of the price formula, isolated. Pure (no DB, no I/O) but deliberately
 * SERVER-ONLY: the client never computes money (CLAUDE.md), so this lives in `server/lib/`
 * rather than `src/shared/`. The client gets the holiday CALENDAR from
 * `src/shared/util/us-holidays.ts` — dates and names — and gets the resulting price from the
 * server's quote.
 *
 * ── Why this is its own module ────────────────────────────────────────────────────────────────
 * `feat/rate-enforcement` (pet-mix PR 3, spec 2026-07-26 §4) converts `estimateCost` to a
 * `PriceResult` return and feeds it a rate resolved from pet-set rate tables. That change rewrites
 * `estimateCost`'s body and signature. This module must survive it UNTOUCHED, because the two
 * features are orthogonal:
 *
 *     cost = r x n_normal + h x n_holiday          (h NULL  =>  every unit at r)
 *
 * `r` is whatever base rate the resolution produced — flat option rate, species-count rate, or
 * pet-id rate. This helper never asks where `r` came from, and the pet-set resolution never
 * learns that holidays exist. Composing them is a one-line call from `estimateCost`, and neither
 * feature's tests need to know about the other.
 *
 * ── The invariants this file is bound by ──────────────────────────────────────────────────────
 * - **No multipliers.** `holidayRate` is an explicit whole-dollar rate the sitter stored. There is
 *   no "x1.5 on holidays" here and there must never be — a rate the sitter did not type is a
 *   price they did not agree to. A holiday rate BELOW the base rate is legal and priced as given.
 * - **No pet count.** Neither function takes one. Two dogs over Christmas cost what one dog costs
 *   unless the sitter stored a different rate; the holiday split multiplies UNITS OF TIME only.
 * - **Units of time only.** The single arithmetic here is (stored rate) x (count of units).
 */

/** A booking's billed units, partitioned by whether they fall on a listed US holiday. */
export type UnitSplit = {
  /** Total billed units — exactly what `billableUnits` returned. Never changed by holidays. */
  units: number;
  /** How many of `units` begin on a listed holiday. 0 <= holidayUnits <= units. */
  holidayUnits: number;
};

/**
 * Partition `units` billed units starting at `startDate`.
 *
 * THE CONVENTION: the `i`th billed unit falls on `addDays(startDate, i)` — a unit is named by the
 * date it BEGINS. For a night-billed stay that means a night is holiday-priced when its CHECK-IN
 * date is a holiday (the night of Dec 24 -> 25 is a Christmas Eve night, charged once, not twice);
 * for a day-billed stay `billableUnits` already includes the departure day, so the same expression
 * enumerates exactly the days charged; for a single-day service there is one unit, on the date
 * itself. This matches `nightsBetween` (nights counted by start date) and the admin calendar's
 * `paintDays` (paints `[start, endExclusive)`), so the day the calendar marks as a holiday is
 * always the day the price charged for.
 */
export function splitUnits(startDate: string, units: number): UnitSplit {
  const n = Math.max(0, Math.trunc(units));
  let holidayUnits = 0;
  for (let i = 0; i < n; i++) {
    if (holidayNameOn(addDays(startDate, i)) !== null) holidayUnits++;
  }
  return { units: n, holidayUnits };
}

/**
 * `rate x normal units + holidayRate x holiday units`. A NULL `holidayRate` (the default, and
 * every service until a sitter sets one) prices every unit at `rate` — byte-identical to the
 * pre-holiday formula, which is the compatibility lock in `availability.test.ts`.
 *
 * `holidayUnits` is clamped into `[0, units]`: a split that disagrees with its own total is bad
 * data, and the safe answer is to bill the units that exist rather than invent or drop revenue.
 */
export function holidayAwareCost(
  rate: number,
  holidayRate: number | null,
  split: UnitSplit,
): number {
  if (holidayRate == null) return rate * split.units;
  const holiday = Math.min(Math.max(split.holidayUnits, 0), split.units);
  return rate * (split.units - holiday) + holidayRate * holiday;
}
