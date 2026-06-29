import { DATE_RE, getPacificDateStr, nightsBetween } from '../../src/shared/index.js';

/**
 * Shared request-validation guards. `DATE_RE` alone accepts impossible dates ("2026-02-30"),
 * which round-trip to a different calendar day and produce negative night counts / garbage cost
 * — so date inputs go through `isRealDate`, and ranges are bounded.
 */

/** Safety rail (NOT a business cap): bounds the per-request capacity loop so an unlimited stay
 * length can't burn CPU. ~10 years — far beyond any real booking. */
export const DEFENSIVE_MAX_NIGHTS = 3650;

/** Safety rail (NOT a business cap): input sanity bound on a single request's pet count. */
export const DEFENSIVE_MAX_PET_COUNT = 1000;

/** True for a whole number in [1, DEFENSIVE_MAX_PET_COUNT]. */
export function isValidPetCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= DEFENSIVE_MAX_PET_COUNT
  );
}

/**
 * A nullable per-tenant limit: `null` (unlimited) or a positive integer within `max` — a
 * defensive ceiling, NOT a business cap. Shared by the admin route's capacity/stay-length guards.
 */
export function isNullableLimit(value: unknown, max: number): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max)
  );
}

/** True only for a well-formed, real calendar date (rejects Feb 30, month 13, etc.). */
export function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  // Date.UTC rolls overflow forward (Feb 30 → Mar 2); a real date round-trips unchanged.
  // Compare via UTC fields only — reading local fields would shift the day in non-UTC zones.
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isFutureOrToday(value: string, timezone?: string): boolean {
  return value >= getPacificDateStr(undefined, timezone);
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
  maxStayNights: number | null,
  timezone?: string,
): DateRangeError | null {
  if (!isRealDate(start)) return { error: 'Invalid start date.', status: 400 };
  if (!isRealDate(end) || end <= start) return { error: 'Invalid end date.', status: 400 };
  if (!isFutureOrToday(start, timezone)) return { error: 'That date is in the past.', status: 400 };
  const nights = nightsBetween(start, end);
  // Defensive rail first: an over-rail range is malformed input, not "over capacity".
  if (nights > DEFENSIVE_MAX_NIGHTS) return { error: 'Invalid date range.', status: 400 };
  if (maxStayNights !== null && nights > maxStayNights)
    return { error: `Stays are limited to ${maxStayNights} nights.`, status: 400 };
  return null;
}

/** Validate a single-day (walk) date. */
export function validateSingleDate(date: string, timezone?: string): DateRangeError | null {
  if (!isRealDate(date)) return { error: 'Invalid date.', status: 400 };
  if (!isFutureOrToday(date, timezone)) return { error: 'That date is in the past.', status: 400 };
  return null;
}

/** Whole-dollar rate, at least $1 (free-typed; no relationship to duration). */
export function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** Positive whole-minute duration. */
export function isValidDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
