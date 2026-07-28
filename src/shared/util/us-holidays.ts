/**
 * The fixed, listed set of US holidays a pet-care business prices differently — computed, not
 * fetched, so `src/shared/` stays dependency-free (a CLAUDE.md invariant).
 *
 * This module deals in CALENDAR FACTS ONLY: dates and names, never money. That is what makes it
 * safe to share with the two client bundles — the admin calendar and the booking widget both mark
 * these days, while the price they imply is computed server-side (see `server/lib/holiday-cost.ts`
 * and `estimateCost`). Do not add a rate, a multiplier, or a dollar amount to this file.
 *
 * The set is DELIBERATELY FIXED and hand-listed. It is not the federal holiday list (that has no
 * Christmas Eve, no New Year's Eve, no day after Thanksgiving — the three days sitters most
 * reliably charge for), and it is not sitter-configurable in this phase. Adding a holiday means
 * editing `US_HOLIDAY_NAMES` and `buildYear` together.
 *
 * NO OBSERVED-DAY SHIFTING. When July 4 falls on a Saturday the federal observance moves to
 * July 3, but the pet is in the sitter's care on July 4 — the work happens on the real calendar
 * date, so that is the date priced. Locked by a test.
 *
 * All arithmetic is UTC-anchored calendar arithmetic, matching `util/dates.ts`: a date-only string
 * names the same calendar day in every timezone, so no tenant timezone is involved here.
 */

/** One listed holiday on a specific calendar date. `date` is 'YYYY-MM-DD'. */
export type UsHoliday = { readonly date: string; readonly name: string };

/**
 * The twelve listed holidays, in calendar order. Exported so UI hint text ("Holiday rate applies
 * on: …") is generated from the same list the pricing uses and cannot drift out of step with it.
 */
export const US_HOLIDAY_NAMES = [
  "New Year's Day",
  'Martin Luther King Jr. Day',
  "Presidents' Day",
  'Memorial Day',
  'Juneteenth',
  'Independence Day',
  'Labor Day',
  'Thanksgiving',
  'Day after Thanksgiving',
  'Christmas Eve',
  'Christmas Day',
  "New Year's Eve",
] as const;

/** 'YYYY-MM-DD' for a UTC-anchored (year, 0-based month, day). */
function iso(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/**
 * The day-of-month of the `n`th `weekday` (0=Sun … 6=Sat) in a month — e.g. the 3rd Monday of
 * January. `n` is 1-based and callers only ever pass values that exist in a 28+-day month.
 */
function nthWeekday(year: number, monthIndex: number, weekday: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  return 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7;
}

/** The day-of-month of the LAST `weekday` in a month (Memorial Day's rule). */
function lastWeekday(year: number, monthIndex: number, weekday: number): number {
  // Day 0 of the NEXT month is the last day of this one.
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
}

function buildYear(year: number): readonly UsHoliday[] {
  const thanksgiving = nthWeekday(year, 10, 4, 4); // 4th Thursday of November
  return Object.freeze([
    { date: iso(year, 0, 1), name: US_HOLIDAY_NAMES[0] },
    { date: iso(year, 0, nthWeekday(year, 0, 1, 3)), name: US_HOLIDAY_NAMES[1] }, // 3rd Mon Jan
    { date: iso(year, 1, nthWeekday(year, 1, 1, 3)), name: US_HOLIDAY_NAMES[2] }, // 3rd Mon Feb
    { date: iso(year, 4, lastWeekday(year, 4, 1)), name: US_HOLIDAY_NAMES[3] }, // last Mon May
    { date: iso(year, 5, 19), name: US_HOLIDAY_NAMES[4] },
    { date: iso(year, 6, 4), name: US_HOLIDAY_NAMES[5] },
    { date: iso(year, 8, nthWeekday(year, 8, 1, 1)), name: US_HOLIDAY_NAMES[6] }, // 1st Mon Sep
    { date: iso(year, 10, thanksgiving), name: US_HOLIDAY_NAMES[7] },
    { date: iso(year, 10, thanksgiving + 1), name: US_HOLIDAY_NAMES[8] },
    { date: iso(year, 11, 24), name: US_HOLIDAY_NAMES[9] },
    { date: iso(year, 11, 25), name: US_HOLIDAY_NAMES[10] },
    { date: iso(year, 11, 31), name: US_HOLIDAY_NAMES[11] },
  ] as UsHoliday[]);
}

// Per-year memo. The result is deterministic and frozen, so caching is invisible to callers —
// it exists because a month grid asks about the same year 35 times per render.
const cache = new Map<number, readonly UsHoliday[]>();

/**
 * Every listed holiday in `year`, sorted by date. The returned array is frozen; treat it as
 * read-only (callers that need to sort or splice must copy first).
 */
export function holidaysForYear(year: number): readonly UsHoliday[] {
  let list = cache.get(year);
  if (!list) {
    list = buildYear(year);
    cache.set(year, list);
  }
  return list;
}

/**
 * The holiday name on a 'YYYY-MM-DD' (or ISO datetime) date, or null. The single predicate the
 * price path and both calendars use — "is this day a holiday" must have exactly one answer.
 */
export function holidayNameOn(date: string): string | null {
  const day = date.slice(0, 10);
  const year = Number(day.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return holidaysForYear(year).find((h) => h.date === day)?.name ?? null;
}

/** Listed holidays inside one 'YYYY-MM' month, in date order. Powers the calendar markers. */
export function holidaysInMonth(month: string): readonly UsHoliday[] {
  const year = Number(month.slice(0, 4));
  if (!Number.isFinite(year)) return [];
  return holidaysForYear(year).filter((h) => h.date.startsWith(`${month}-`));
}
