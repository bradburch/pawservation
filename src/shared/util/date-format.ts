import { parseDateToUtcNoon, PACIFIC } from './dates.js';
export { PACIFIC };

/** Format a date-only string as a Pacific-time calendar date. */
function fmt(dateStr: string, opts: Intl.DateTimeFormatOptions): string {
  return parseDateToUtcNoon(dateStr).toLocaleDateString('en-US', { ...opts, timeZone: PACIFIC });
}

/** e.g. "Jun 7, 2026" */
export function formatDate(dateStr: string): string {
  return fmt(dateStr, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Time-of-day from a full ISO/datetime string, e.g. "9:00 AM" */
export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: PACIFIC,
  });
}

/** e.g. "June 2026" */
export function formatMonthYear(dateStr: string): string {
  return fmt(dateStr, { month: 'long', year: 'numeric' });
}

/** e.g. "Jun 7" — falls back to the raw string if parsing throws. */
export function formatShortDate(dateStr: string): string {
  try {
    return fmt(dateStr, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

/** e.g. "June 7" — long month, no year. */
export function formatDisplay(dateStr: string): string {
  return fmt(dateStr, { month: 'long', day: 'numeric' });
}

/** Format a Date as a medium-date / short-time string in Pacific time, e.g. "Jun 9, 2026, 5:00 PM". */
export function formatPacificTimestamp(date: Date): string {
  return date.toLocaleString('en-US', {
    timeZone: PACIFIC,
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
