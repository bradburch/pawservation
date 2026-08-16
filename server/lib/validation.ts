import {
  addDays,
  addMonths,
  DATE_RE,
  formatFriendlyDate,
  getPacificDateStr,
  nightsBetween,
  PAYMENT_METHODS,
  isPaymentMethod,
  isValidRate,
  isPetRateMode,
  isCalendarCostBasis,
  type PaymentMethod,
  type PetRateMode,
  type CalendarCostBasis,
} from '../../src/shared/index.js';

/** `isValidRate`/`isPetRateMode` live in `src/shared/pricing/rate.ts`, and `isCalendarCostBasis` in
 * `src/shared/pricing/calendar-cost-basis.ts`, so the admin bundle imports the SAME predicates;
 * re-exported here unchanged, and still enforced server-side at the trust boundary. */
export {
  PAYMENT_METHODS,
  isPaymentMethod,
  isValidRate,
  isPetRateMode,
  isCalendarCostBasis,
  type PaymentMethod,
  type PetRateMode,
  type CalendarCostBasis,
};

/**
 * Shared request-validation guards. `DATE_RE` alone accepts impossible dates ("2026-02-30"),
 * which round-trip to a different calendar day and produce negative night counts / garbage cost
 * — so date inputs go through `isRealDate`, and ranges are bounded.
 */

// Pragmatic email shape check (not RFC-complete)
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Safety rail (NOT a business cap): bounds the per-request capacity loop so an unlimited stay
 * length can't burn CPU. ~10 years — far beyond any real booking. */
export const DEFENSIVE_MAX_NIGHTS = 3650;

/** Safety rail (NOT a business cap): input sanity bound on a single request's pet count. */
export const DEFENSIVE_MAX_PET_COUNT = 1000;

/** Business cap (unlike the DEFENSIVE rails above): the most pets one booking may carry,
 * enforced on the admin settings PUT for MaxPetCount. */
export const MAX_PET_COUNT_CAP = 15;

/** Sanity rail for TenantServices.MinLeadDays: 0..90 days of notice (0 = same-day OK). */
export const MAX_LEAD_DAYS_CAP = 90;
/** Sanity rail for Tenants.MaxAdvanceMonths: 1..24 months of booking horizon. */
export const MAX_ADVANCE_MONTHS_CAP = 24;

/**
 * Business cap for Tenants.HousesitBoardingOverlapDays (0006). TWO, not a rail: a shared day has to
 * be a HANDOVER — the request arriving as everything else departs, or departing as everything else
 * arrives — and a stay can do that at most twice, once at each of its own ends. So 3 and 300 behave
 * identically to 2, and refusing them keeps the stored number honest about what it buys instead of
 * implying mid-stay overlap can be unlocked with a bigger figure.
 */
export const MAX_OVERLAP_DAYS_CAP = 2;

/** The product default for `Tenants.HousesitBoardingOverlapDays` — one handover day. Mirrors the
 *  column's own `DEFAULT 1`, and is the fallback for a tenant row that predates the column (a
 *  cached one, see `checkRange`); reading a missing value as "no limit" would silently switch the
 *  rule off for everybody. */
export const DEFAULT_OVERLAP_DAYS = 1;

/** True for the overlap allowance's accepted domain: null (= no limit) or a whole 0..2. */
export function isValidOverlapDays(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_OVERLAP_DAYS_CAP)
  );
}

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

export type DateRangeError = { error: string; code: string; status: 400 };

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
  if (!isRealDate(start))
    return { error: 'Invalid start date.', code: 'invalid_date', status: 400 };
  if (!isRealDate(end) || end <= start)
    return { error: 'Invalid end date.', code: 'invalid_date', status: 400 };
  if (!isFutureOrToday(start, timezone))
    return { error: 'That date is in the past.', code: 'date_in_past', status: 400 };
  const nights = nightsBetween(start, end);
  // Defensive rail first: an over-rail range is malformed input, not "over capacity".
  if (nights > DEFENSIVE_MAX_NIGHTS)
    return { error: 'Invalid date range.', code: 'invalid_date_range', status: 400 };
  if (maxStayNights !== null && nights > maxStayNights)
    return {
      error: `Stays are limited to ${maxStayNights} nights.`,
      code: 'stay_too_long',
      status: 400,
    };
  return null;
}

/**
 * The booking window (0004): a request's START date must give the service its minimum notice
 * (`TenantServices.MinLeadDays`) and stay inside the business-wide horizon
 * (`Tenants.MaxAdvanceMonths`). Both NULL = unlimited; lead days 0 = same-day allowed. "Today"
 * is the tenant's timezone, the same clock every other past/future check here uses. Runs AFTER
 * the shape validators, so `start` is already a real, non-past date at every call site — the
 * quote, the month grid painter, and the booking POST must all agree on this rule.
 */
export function validateBookingWindow(
  start: string,
  minLeadDays: number | null,
  maxAdvanceMonths: number | null,
  timezone?: string,
): DateRangeError | null {
  const today = getPacificDateStr(undefined, timezone);
  if (minLeadDays !== null && minLeadDays > 0 && start < addDays(today, minLeadDays)) {
    const earliest = addDays(today, minLeadDays);
    return {
      error: `This service needs ${minLeadDays} day${minLeadDays === 1 ? '' : 's'} of notice — the earliest date you can request is ${formatFriendlyDate(earliest)}.`,
      code: 'too_soon',
      status: 400,
    };
  }
  if (maxAdvanceMonths !== null && start > addMonths(today, maxAdvanceMonths)) {
    const latest = addMonths(today, maxAdvanceMonths);
    return {
      error: `Requests open up ${maxAdvanceMonths} month${maxAdvanceMonths === 1 ? '' : 's'} ahead — the latest date you can request is ${formatFriendlyDate(latest)}.`,
      code: 'too_far_ahead',
      status: 400,
    };
  }
  return null;
}

/** Validate a single-day (walk) date. */
export function validateSingleDate(date: string, timezone?: string): DateRangeError | null {
  if (!isRealDate(date)) return { error: 'Invalid date.', code: 'invalid_date', status: 400 };
  if (!isFutureOrToday(date, timezone))
    return { error: 'That date is in the past.', code: 'date_in_past', status: 400 };
  return null;
}

/** Positive whole-minute duration. */
export function isValidDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** True for a valid 'HH:MM' 24-hour wall-clock string (00:00–23:59). */
export function isValidTimeString(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Whole minutes from `start` to `end`, both 'HH:MM' on the same day. Callers validate
 * `end > start` before calling — this does no ordering check itself. */
export function minutesBetweenTimes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}
