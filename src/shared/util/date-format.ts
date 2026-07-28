import { addDays, nightsBetween, parseDateToUtcNoon, PACIFIC } from './dates.js';
export { PACIFIC };

/** Format a date-only string as a Pacific-time calendar date. */
function fmt(dateStr: string, opts: Intl.DateTimeFormatOptions): string {
  return parseDateToUtcNoon(dateStr).toLocaleDateString('en-US', { ...opts, timeZone: PACIFIC });
}

/** e.g. "Jun 7, 2026" */
export function formatDate(dateStr: string): string {
  return fmt(dateStr, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** e.g. "Jun 7" — falls back to the raw string if parsing throws. */
export function formatShortDate(dateStr: string): string {
  try {
    return fmt(dateStr, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * "Jun 7" for a date in the current year, "Jun 7, 2028" otherwise. For lists that mix years
 * (a customer's bookings, the admin's outstanding balances): hiding the year there made a
 * 2028 booking above a next-month one read as a broken sort order.
 */
export function formatFriendlyDate(dateStr: string): string {
  try {
    const thisYear = new Date().toLocaleDateString('en-US', {
      timeZone: PACIFIC,
      year: 'numeric',
    });
    return dateStr.slice(0, 4) === thisYear
      ? fmt(dateStr, { month: 'short', day: 'numeric' })
      : fmt(dateStr, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

/**
 * Humanize an end-EXCLUSIVE blocked date range for display, e.g.
 * `('2028-07-03', '2028-07-05')` → "Jul 3 – 4, 2028 · 2 days".
 * A null end (or end = start + 1) is a single day: "Jul 3, 2028 · 1 day".
 * The month is elided within one month; full dates are shown across years.
 */
export function formatBlockRange(startDate: string, endDateExclusive: string | null): string {
  const start = startDate.slice(0, 10);
  const lastDay = endDateExclusive ? addDays(endDateExclusive.slice(0, 10), -1) : start;
  if (lastDay <= start) return `${formatDate(start)} · 1 day`;
  const days = nightsBetween(start, lastDay) + 1;
  const sameYear = start.slice(0, 4) === lastDay.slice(0, 4);
  const sameMonth = sameYear && start.slice(5, 7) === lastDay.slice(5, 7);
  if (!sameYear) return `${formatDate(start)} – ${formatDate(lastDay)} · ${days} days`;
  const endPart = sameMonth ? fmt(lastDay, { day: 'numeric' }) : formatShortDate(lastDay);
  return `${formatShortDate(start)} – ${endPart}, ${start.slice(0, 4)} · ${days} days`;
}
