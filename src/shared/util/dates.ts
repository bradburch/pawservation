/** Milliseconds in one day. */
export const MS_PER_DAY = 86_400_000;

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Instance-default business timezone used when a tenant has none set. */
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';
/** Internal alias used by the Pacific-specific offset helpers below; new code should
 *  prefer DEFAULT_TIMEZONE (and accept an explicit timezone where a tenant can set one). */
export const PACIFIC = DEFAULT_TIMEZONE;

/**
 * Parse a `YYYY-MM-DD` (or ISO `YYYY-MM-DDTHH:MM:SS…`) string to the UTC
 * milliseconds of that calendar date at midnight.
 *
 * Booking dates are date-only values representing Pacific calendar days. We
 * anchor them to UTC so all arithmetic (night counts, day stepping) is on
 * abstract calendar days — never shifted by the runtime's local zone (which is
 * UTC on Workers and whatever the browser happens to be). This is the single
 * parse used by every other helper here.
 */
/** Split a `YYYY-MM-DD` (or ISO) string into `[year, monthIndex (0-based), day]`. */
function ymd(dateStr: string): [number, number, number] {
  const [year, month, day] = dateStr.split('T')[0].split('-').map(Number);
  return [year, month - 1, day];
}

export function parseDateUtc(dateStr: string): number {
  return Date.UTC(...ymd(dateStr));
}

/**
 * Parse a `YYYY-MM-DD` (or ISO) string to a Date at UTC noon. UTC noon keeps the
 * calendar day stable when formatted in Pacific time regardless of offset.
 */
export function parseDateToUtcNoon(dateStr: string): Date {
  const [y, m, d] = ymd(dateStr);
  return new Date(Date.UTC(y, m, d, 12, 0, 0));
}

/**
 * The single source of truth for counting nights in a booking.
 *
 * `checkIn` is the (inclusive) first night; `checkOutExclusive` is the
 * checkout date — the morning the pet leaves, with no overnight. So a stay
 * from June 7 to June 12 is 5 nights (the 7th, 8th, 9th, 10th, 11th).
 *
 * DST-immune (parsed as UTC calendar days). Matches the server contract
 * (`requestDateRange` endDate is exclusive) and the chat/MCP agent. The booking
 * calendar, chat agent, MCP server, and invoice cost all route through this.
 */
export function nightsBetween(checkIn: string, checkOutExclusive: string): number {
  return Math.round((parseDateUtc(checkOutExclusive) - parseDateUtc(checkIn)) / MS_PER_DAY);
}

/**
 * Add `days` (may be negative) to a `YYYY-MM-DD` date, returning `YYYY-MM-DD`.
 * Pure calendar arithmetic, DST-immune. The one stepper for both the booking
 * calendar (client) and the booking service (server).
 */
export function addDays(dateStr: string, days: number): string {
  return new Date(parseDateUtc(dateStr) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Today (or `date`) as a `YYYY-MM-DD` string in the given `timezone` (defaults to
 * DEFAULT_TIMEZONE — the instance business timezone). All "is this in the past / what
 * day is it" checks across the chat agent, MCP server, and booking service must use this
 * rather than the runtime's local or UTC date, so a booking near midnight resolves to the
 * correct business day. Pass a tenant's configured timezone to honor a non-default sitter.
 */
export function getPacificDateStr(
  date: Date = new Date(),
  timezone: string = DEFAULT_TIMEZONE,
): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * True when a `YYYY-MM-DD` date is a Saturday or Sunday. The day-of-week of a date-only
 * string is timezone-free (the same calendar date is the same weekday in every zone), so
 * this stays pure UTC arithmetic — shared by the server's weekday-only booking check and
 * the widget's mirror that marks weekends unavailable.
 */
export function isWeekend(dateStr: string): boolean {
  const day = new Date(parseDateUtc(dateStr)).getUTCDay();
  return day === 0 || day === 6;
}

/** Milliseconds in one hour. */
const MS_PER_HOUR = 3_600_000;

/**
 * Pacific-time UTC offset in minutes for a given instant (e.g. 420 for PDT, 480
 * for PST). Derived from `Intl` so it's DST-correct without a tz database.
 */
function pacificOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC,
    timeZoneName: 'shortOffset',
  }).formatToParts(at);
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-8';
  const m = tz.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  if (!m) return 480;
  const hours = parseInt(m[1], 10);
  const mins = parseInt(m[2] ?? '0', 10);
  return -(hours * 60 + Math.sign(hours) * mins);
}

// NOTE: pacificDayStartUtcMs / hoursUntilStart are the cancellation-window helpers and are NOT
// yet timezone-parameterized — they hardcode PACIFIC (the instance default). They have no live
// callers today; thread a tenant `timezone` through them (like getPacificDateStr) when the
// cancellation-policy feature lands, or a non-default sitter's fee windows will use Pacific.

/** UTC milliseconds of the START of the Pacific calendar day `YYYY-MM-DD` (00:00 Pacific). */
export function pacificDayStartUtcMs(dateStr: string): number {
  const utcMidnight = parseDateUtc(dateStr);
  // Offset at ~Pacific-noon avoids the rare midnight DST-transition ambiguity.
  const offsetMin = pacificOffsetMinutes(new Date(utcMidnight + 12 * MS_PER_HOUR));
  return utcMidnight + offsetMin * 60_000;
}

/**
 * Hours from `now` until an appointment starts. Timed visits use their exact ISO
 * `startDatetime`; date-only sits anchor to the START of their Pacific calendar
 * day (the business timezone) — NOT UTC midnight — so cancellation-fee windows
 * engage at the policy boundary. Negative means the appointment is already past.
 */
export function hoursUntilStart(
  startDatetime: string | undefined,
  startDate: string,
  now: Date = new Date(),
): number {
  const nowMs = now.getTime();
  const startMs = startDatetime
    ? new Date(startDatetime).getTime()
    : pacificDayStartUtcMs(startDate);
  return (startMs - nowMs) / MS_PER_HOUR;
}
