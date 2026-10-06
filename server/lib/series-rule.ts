/**
 * THE SERIES RULE — pure, server-only, the one expander.
 *
 * A series stores weekdays as a bitmask (bit i = ISO weekday i + 1, so 1 is Monday and 64 Sunday)
 * and travels on the wire as lowercase English names. Dates are YYYY-MM-DD strings in the tenant's
 * own zone; nothing here reads a clock — `today` is always an argument — because the harness has
 * no clock to inject and the cron's "today" must be the one it computed once.
 *
 * Server-only on purpose: the widget never expands a pattern. A client-importable expander is how a
 * second one would start, and two expanders are two answers to "which Tuesdays".
 */
import { addDays, addMonths, DATE_RE, parseDateUtc } from '../../src/shared/util/dates';

export const SKIP_REASONS = ['full', 'time_off', 'unpriced_pet_set', 'cost_out_of_range',
  'unavailable', 'paused', 'cancelled'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export const WEEKDAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday'] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];
export const DEFAULT_SERIES_WINDOW_MONTHS = 12;
export const PROJECTION_MAX_MONTHS = 24;
export const OFFER_LIFETIME_DAYS = 7;
export type SeriesRule = { weekdays: number; startDate: string; endDate: string | null };

/** Names to a mask; a repeated name is allowed (it sets the same bit). Null for empty or unknown. */
export function maskFromNames(names: readonly string[]): number | null {
  if (names.length === 0) return null;
  let mask = 0;
  for (const raw of names) {
    const i = WEEKDAY_NAMES.indexOf(raw.trim().toLowerCase() as WeekdayName);
    if (i === -1) return null;
    mask |= 1 << i;
  }
  return mask;
}

export function namesFromMask(mask: number): WeekdayName[] {
  if (!Number.isInteger(mask) || mask < 0 || mask > 127) throw new RangeError(`weekday mask ${mask}`);
  return WEEKDAY_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
}

export function isoWeekday(date: string): number {
  const d = new Date(parseDateUtc(date)).getUTCDay(); // 0 = Sunday
  return d === 0 ? 7 : d;
}

export function datesIn(rule: SeriesRule, fromInclusive: string, toInclusive: string): string[] {
  const start = fromInclusive > rule.startDate ? fromInclusive : rule.startDate;
  const end = rule.endDate !== null && rule.endDate < toInclusive ? rule.endDate : toInclusive;
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if ((rule.weekdays & (1 << (isoWeekday(d) - 1))) !== 0) out.push(d);
  }
  return out;
}

export function windowEnd(today: string, maxAdvanceMonths: number | null, endDate: string | null): string {
  const horizon = addMonths(today, maxAdvanceMonths ?? DEFAULT_SERIES_WINDOW_MONTHS);
  return endDate !== null && endDate < horizon ? endDate : horizon;
}

export const projectionCap = (today: string): string => addMonths(today, PROJECTION_MAX_MONTHS);

export const projectedId = (seriesId: string, date: string): string => `series:${seriesId}:${date}`;

export function parseProjectedId(id: string): { seriesId: string; date: string } | null {
  const m = /^series:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (m === null || !DATE_RE.test(m[2])) return null;
  // A real calendar date: 2027-02-30 normalises to March and is refused.
  if (addDays(m[2], 0) !== m[2]) return null;
  return { seriesId: m[1], date: m[2] };
}

const DAY = (n: WeekdayName) => n[0].toUpperCase() + n.slice(1);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function patternWords(rule: SeriesRule): string {
  const days = list(namesFromMask(rule.weekdays).map(DAY));
  const tail = rule.endDate === null ? ', no end date' : ` to ${short(rule.endDate)}`;
  return `every ${days} from ${short(rule.startDate)}${tail}`;
}

const SKIP_WORDS: Record<SkipReason, string> = {
  full: 'your sitter is fully booked that day',
  time_off: 'your sitter is away that day',
  unpriced_pet_set: "your sitter hasn't set a price for these pets together",
  cost_out_of_range: "your sitter's rate for these pets can't be quoted exactly",
  unavailable: "that day can't be booked",
  paused: 'paused',
  cancelled: 'cancelled',
};
export const skipWords = (reason: SkipReason): string => SKIP_WORDS[reason];
