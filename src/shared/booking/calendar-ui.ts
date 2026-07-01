// Pure calendar grid and selection logic — no runtime dependencies, UTC-anchored
// to stay timezone-neutral (same approach as src/shared/util/dates.ts).

export type RangeValue = { start?: string; end?: string };

/**
 * Cells for a month grid: leading nulls for the weekday offset of the 1st,
 * then 'YYYY-MM-DD' per day.
 *
 * Uses UTC so the result is identical in every runtime timezone.
 */
export function monthGrid(month: string): (string | null)[] {
  const [y, m] = month.split('-').map(Number);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun … 6=Sat
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); // last day of month
  const cells: (string | null)[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) {
    cells.push(`${month}-${String(d).padStart(2, '0')}`);
  }
  return cells;
}

/**
 * Shift a 'YYYY-MM' month string by `delta` months, handling year rollover
 * in both directions.
 */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  let newM = m + delta;
  let newY = y;
  while (newM < 1) {
    newM += 12;
    newY--;
  }
  while (newM > 12) {
    newM -= 12;
    newY++;
  }
  return `${newY}-${String(newM).padStart(2, '0')}`;
}

/**
 * Next selection when `date` is tapped.
 *
 * single → always `{start: date}`.
 *
 * range:
 *   - If no start, end already set, or date <= start: reset to `{start: date}`.
 *   - Otherwise (date is strictly after current start): `{start, end: date}`.
 *
 * The `<=` guard prevents the zero-night-range bug (tapping the same day twice).
 */
export function nextRangeSelection(
  value: RangeValue,
  date: string,
  shape: 'single' | 'range',
): RangeValue {
  if (shape === 'single') return { start: date };
  if (!value.start || value.end || date <= value.start) return { start: date };
  return { start: value.start, end: date };
}

/**
 * Is `date` part of the current selection?
 *
 * single → equals start.
 * range  → start, end, or strictly between start and end (inclusive of end).
 *          With only start set, only start itself is selected.
 */
export function isDateSelected(
  value: RangeValue,
  date: string,
  shape: 'single' | 'range',
): boolean {
  if (!value.start) return false;
  if (shape === 'single') return value.start === date;
  // range
  if (date === value.start) return true;
  if (value.end !== undefined && date > value.start && date <= value.end) return true;
  return false;
}

export type RangePosition = 'none' | 'only' | 'start' | 'middle' | 'end';

/** Where `date` sits inside the current selection, for range-band rendering. */
export function rangePosition(
  value: RangeValue,
  date: string,
  shape: 'single' | 'range',
): RangePosition {
  if (!isDateSelected(value, date, shape)) return 'none';
  if (shape === 'single' || !value.end) return 'only';
  if (date === value.start) return 'start';
  if (date === value.end) return 'end';
  return 'middle';
}
