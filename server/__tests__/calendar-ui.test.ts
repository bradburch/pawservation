import { describe, expect, it } from 'vitest';
import {
  monthGrid,
  shiftMonth,
  nextRangeSelection,
  isDateSelected,
  rangePosition,
} from '../../src/shared/index.js';

// ---------------------------------------------------------------------------
// monthGrid
// ---------------------------------------------------------------------------
describe('monthGrid', () => {
  it('July 2026: 3 leading nulls (Wednesday start), 31 day-cells, first cell is null, index-3 is 2026-07-01', () => {
    const cells = monthGrid('2026-07');
    const nullCount = cells.filter((c) => c === null).length;
    const dateCount = cells.filter((c) => c !== null).length;
    expect(nullCount).toBe(3); // July 1 2026 is a Wednesday (0=Sun … 3=Wed)
    expect(dateCount).toBe(31);
    expect(cells[0]).toBeNull();
    expect(cells[1]).toBeNull();
    expect(cells[2]).toBeNull();
    expect(cells[3]).toBe('2026-07-01');
    expect(cells[cells.length - 1]).toBe('2026-07-31');
  });

  it('February 2028 (leap year): 29 day-cells', () => {
    const cells = monthGrid('2028-02');
    expect(cells.filter((c) => c !== null).length).toBe(29);
  });

  it('February 2027 (non-leap year): 28 day-cells', () => {
    const cells = monthGrid('2027-02');
    expect(cells.filter((c) => c !== null).length).toBe(28);
  });

  it('December 2026: 31 day-cells, last cell is 2026-12-31', () => {
    const cells = monthGrid('2026-12');
    const dates = cells.filter((c) => c !== null);
    expect(dates.length).toBe(31);
    expect(dates[dates.length - 1]).toBe('2026-12-31');
    expect(cells[cells.length - 1]).toBe('2026-12-31');
  });

  it('December 2026: first date is 2026-12-01 at correct offset (Tuesday = 2 leading nulls)', () => {
    const cells = monthGrid('2026-12');
    const nullCount = cells.filter((c) => c === null).length;
    expect(nullCount).toBe(2); // Dec 1 2026 is a Tuesday
    expect(cells[2]).toBe('2026-12-01');
  });
});

// ---------------------------------------------------------------------------
// shiftMonth
// ---------------------------------------------------------------------------
describe('shiftMonth', () => {
  it('wraps forward: 2026-12 + 1 → 2027-01', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('wraps backward: 2026-01 - 1 → 2025-12', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('no wrap needed: 2026-07 + 1 → 2026-08', () => {
    expect(shiftMonth('2026-07', 1)).toBe('2026-08');
  });

  it('no wrap needed backward: 2026-07 - 1 → 2026-06', () => {
    expect(shiftMonth('2026-07', -1)).toBe('2026-06');
  });
});

// ---------------------------------------------------------------------------
// nextRangeSelection — range shape
// ---------------------------------------------------------------------------
describe('nextRangeSelection (range)', () => {
  const A = '2026-07-10';
  const B = '2026-07-15';
  const C = '2026-07-05';

  it('from empty value, tap A → {start:A}', () => {
    expect(nextRangeSelection({}, A, 'range')).toEqual({ start: A });
  });

  it('from {start:A} tap later B → {start:A, end:B}', () => {
    expect(nextRangeSelection({ start: A }, B, 'range')).toEqual({ start: A, end: B });
  });

  it('from {start:A} tap A again → {start:A} (no zero-length range — bug guard)', () => {
    const result = nextRangeSelection({ start: A }, A, 'range');
    expect(result).toEqual({ start: A });
    expect(result.end).toBeUndefined();
  });

  it('from {start:A} tap earlier date C → resets to {start:C}', () => {
    expect(nextRangeSelection({ start: A }, C, 'range')).toEqual({ start: C });
  });

  it('from complete {start:A, end:B} tap C → {start:C} (resets to new start)', () => {
    expect(nextRangeSelection({ start: A, end: B }, C, 'range')).toEqual({ start: C });
  });

  it('from complete {start:A, end:B} tap A → {start:A} (complete range resets)', () => {
    expect(nextRangeSelection({ start: A, end: B }, A, 'range')).toEqual({ start: A });
  });
});

// ---------------------------------------------------------------------------
// nextRangeSelection — single shape
// ---------------------------------------------------------------------------
describe('nextRangeSelection (single)', () => {
  it('replaces any prior selection', () => {
    expect(nextRangeSelection({ start: '2026-07-01' }, '2026-07-20', 'single')).toEqual({
      start: '2026-07-20',
    });
  });

  it('works from empty value', () => {
    expect(nextRangeSelection({}, '2026-07-05', 'single')).toEqual({ start: '2026-07-05' });
  });
});

// ---------------------------------------------------------------------------
// isDateSelected — range shape
// ---------------------------------------------------------------------------
describe('isDateSelected (range)', () => {
  const start = '2026-07-10';
  const end = '2026-07-15';
  const between = '2026-07-12';
  const before = '2026-07-09';
  const after = '2026-07-16';

  it('start is selected', () => {
    expect(isDateSelected({ start, end }, start, 'range')).toBe(true);
  });

  it('end is selected', () => {
    expect(isDateSelected({ start, end }, end, 'range')).toBe(true);
  });

  it('strictly-between date is selected', () => {
    expect(isDateSelected({ start, end }, between, 'range')).toBe(true);
  });

  it('date after end is NOT selected', () => {
    expect(isDateSelected({ start, end }, after, 'range')).toBe(false);
  });

  it('date before start is NOT selected', () => {
    expect(isDateSelected({ start, end }, before, 'range')).toBe(false);
  });

  it('with only start set: start is selected', () => {
    expect(isDateSelected({ start }, start, 'range')).toBe(true);
  });

  it('with only start set: other dates are NOT selected', () => {
    expect(isDateSelected({ start }, between, 'range')).toBe(false);
    expect(isDateSelected({ start }, end, 'range')).toBe(false);
  });

  it('with empty value: nothing is selected', () => {
    expect(isDateSelected({}, start, 'range')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDateSelected — single shape
// ---------------------------------------------------------------------------
describe('isDateSelected (single)', () => {
  const start = '2026-07-10';

  it('exact start is selected', () => {
    expect(isDateSelected({ start }, start, 'single')).toBe(true);
  });

  it('different date is NOT selected', () => {
    expect(isDateSelected({ start }, '2026-07-11', 'single')).toBe(false);
  });

  it('with empty value: nothing is selected', () => {
    expect(isDateSelected({}, start, 'single')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rangePosition — where a date sits in the selection, for range-band rendering
// ---------------------------------------------------------------------------
describe('rangePosition', () => {
  it('returns none when nothing selected', () => {
    expect(rangePosition({}, '2026-07-06', 'range')).toBe('none');
  });

  it('single shape: selected date is only, others none', () => {
    expect(rangePosition({ start: '2026-07-06' }, '2026-07-06', 'single')).toBe('only');
    expect(rangePosition({ start: '2026-07-06' }, '2026-07-07', 'single')).toBe('none');
  });

  it('range with only a start: start date is only', () => {
    expect(rangePosition({ start: '2026-07-06' }, '2026-07-06', 'range')).toBe('only');
    expect(rangePosition({ start: '2026-07-06' }, '2026-07-07', 'range')).toBe('none');
  });

  it('full range: start/middle/end, none outside', () => {
    const v = { start: '2026-07-06', end: '2026-07-09' };
    expect(rangePosition(v, '2026-07-06', 'range')).toBe('start');
    expect(rangePosition(v, '2026-07-07', 'range')).toBe('middle');
    expect(rangePosition(v, '2026-07-08', 'range')).toBe('middle');
    expect(rangePosition(v, '2026-07-09', 'range')).toBe('end');
    expect(rangePosition(v, '2026-07-05', 'range')).toBe('none');
    expect(rangePosition(v, '2026-07-10', 'range')).toBe('none');
  });
});
