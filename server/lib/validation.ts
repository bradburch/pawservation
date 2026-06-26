import { getPacificDateStr, nightsBetween } from "../../src/shared/index.js";

/**
 * Shared request-validation guards. `DATE_RE` alone accepts impossible dates ("2026-02-30"),
 * which round-trip to a different calendar day and produce negative night counts / garbage cost
 * — so date inputs go through `isRealDate`, and ranges are bounded.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Longest bookable span; also caps the per-request capacity loop so a huge range can't burn CPU. */
export const MAX_RANGE_NIGHTS = 365;

/** Upper bound on a single request's pet count — keeps absurd values out of capacity arithmetic. */
export const MAX_PET_COUNT = 50;

/** True for a whole number in [1, MAX_PET_COUNT]. */
export function isValidPetCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PET_COUNT
  );
}

/** True only for a well-formed, real calendar date (rejects Feb 30, month 13, etc.). */
export function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  // Date.UTC rolls overflow forward (Feb 30 → Mar 2); a real date round-trips unchanged.
  // Compare via UTC fields only — reading local fields would shift the day in non-UTC zones.
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function isFutureOrToday(value: string): boolean {
  return value >= getPacificDateStr();
}

export type DateRangeError = { error: string; status: 400 };

/**
 * Validate a boarding date range. Returns null when valid, or an error payload + status.
 * Enforces: real calendar dates, exclusive end strictly after start, not in the past,
 * and a bounded span.
 */
export function validateBoardingRange(
  start: string,
  end: string,
): DateRangeError | null {
  if (!isRealDate(start)) return { error: "Invalid start date.", status: 400 };
  if (!isRealDate(end) || end <= start)
    return { error: "Invalid end date.", status: 400 };
  if (nightsBetween(start, end) > MAX_RANGE_NIGHTS)
    return {
      error: `Stays are limited to ${MAX_RANGE_NIGHTS} nights.`,
      status: 400,
    };
  return null;
}

/** Validate a single-day (walk) date. */
export function validateSingleDate(date: string): DateRangeError | null {
  if (!isRealDate(date)) return { error: "Invalid date.", status: 400 };
  return null;
}

/** Whole-dollar rate, at least $1 (free-typed; no relationship to duration). */
export function isValidRate(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Positive whole-minute duration. */
export function isValidDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
