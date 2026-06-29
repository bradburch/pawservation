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
 * Parse a `YYYY-MM-DD` (or ISO) string to a Date at LOCAL midnight. Used for
 * client-side ordering/relative display in the Pacific user's browser. Prefer
 * `parseDateUtc` for timezone-neutral arithmetic.
 */
export function parseLocalDate(dateStr: string): Date {
  return new Date(...ymd(dateStr));
}

/**
 * Parse a `YYYY-MM-DD` (or ISO) string to a Date at UTC noon. UTC noon keeps the
 * calendar day stable when formatted in Pacific time regardless of offset.
 */
export function parseDateToUtcNoon(dateStr: string): Date {
  const [y, m, d] = ymd(dateStr);
  return new Date(Date.UTC(y, m, d, 12, 0, 0));
}

/** Format a Date as `YYYY-MM-DD` from its local calendar fields. */
export function dateToStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Add whole `months` (may be negative) to a Date, returning a new Date.
 *
 * End-of-month is CLAMPED, not overflowed: Jan 31 + 1 month → Feb 28 (not Mar 3),
 * and Mar 31 − 1 month → Feb 28. The day is preserved when the target month has
 * enough days. Clamping is the conventional calendar semantic and every caller is
 * correct (or strictly better) under it: callers either normalize the result to the
 * 1st of the month (calendar timeMin/timeMax, calculations, read.ts), slice to
 * year-month (tool-execution cutoff), or use a coarse multi-month lookback/lookahead
 * horizon where a ≤3-day month-end boundary shift is immaterial. No caller relied on
 * the prior bare-`setMonth` overflow. Operates in the local-time frame (production
 * Workers run in UTC); see `tests/dates.test.ts` for the Pacific-frame coverage that
 * pins this clamp off-UTC.
 */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const targetDay = d.getDate();
  d.setDate(1); // avoid month-overflow while stepping the month
  d.setMonth(d.getMonth() + months);
  const lastDayOfTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(targetDay, lastDayOfTargetMonth));
  return d;
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

/**
 * Parse a SQLite `datetime('now')` timestamp (`"YYYY-MM-DD HH:MM:SS"`, space-separated,
 * UTC, no `T`/`Z`) to epoch milliseconds.
 *
 * D1/SQLite stores these as bare UTC strings. `new Date("2026-06-10 12:34:56")` is
 * implementation-defined and V8 parses it as LOCAL time, so on any non-UTC runtime
 * (local dev / CI on America/Los_Angeles) it is silently shifted by the host's offset.
 * We normalize to ISO-8601 UTC (`T` separator + `Z`) before parsing so the result is
 * the same on every runtime. Already-ISO strings (with `T`, with or without `Z`) are
 * handled too. Returns `NaN` for unparseable input (callers decide the failure policy).
 */
export function parseSqliteUtc(timestamp: string): number {
  const trimmed = timestamp.trim();
  // Already ISO with an explicit zone: parse as-is. A bare `T`-form without a zone is
  // still ambiguous, so append `Z`. Space-separated SQLite form: swap space→`T`, add `Z`.
  const hasT = trimmed.includes('T');
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const iso = hasT ? (hasZone ? trimmed : `${trimmed}Z`) : `${trimmed.replace(' ', 'T')}Z`;
  return new Date(iso).getTime();
}
