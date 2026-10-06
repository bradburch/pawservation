import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  datesIn,
  isoWeekday,
  maskFromNames,
  namesFromMask,
  parseProjectedId,
  patternWords,
  projectedId,
  projectionCap,
  skipWords,
  SKIP_REASONS,
  windowEnd,
} from '../lib/series-rule';

describe('weekday mask', () => {
  it('maps names to bits Monday-first and back', () => {
    expect(maskFromNames(['tuesday', 'thursday'])).toBe(2 | 8);
    expect(namesFromMask(2 | 8)).toEqual(['tuesday', 'thursday']);
    expect(maskFromNames(['Sunday'])).toBe(64); // case-insensitive
  });
  it('allows a repeated name', () => {
    expect(maskFromNames(['tuesday', 'Tuesday'])).toBe(2);
  });
  it('refuses empty, unknown and out-of-range', () => {
    expect(maskFromNames([])).toBeNull();
    expect(maskFromNames(['tuesday', 'funday'])).toBeNull();
    expect(namesFromMask(0)).toEqual([]);
    expect(() => namesFromMask(128)).toThrow(RangeError);
  });
  it('isoWeekday is 1 for a Monday and 7 for a Sunday', () => {
    expect(isoWeekday('2026-10-05')).toBe(1);
    expect(isoWeekday('2026-10-11')).toBe(7);
  });
});

describe('datesIn', () => {
  const rule = { weekdays: 2 | 8, startDate: '2026-10-13', endDate: null };
  it('lists matching dates inside [from, to], never before startDate', () => {
    expect(datesIn(rule, '2026-10-01', '2026-10-23')).toEqual([
      '2026-10-13',
      '2026-10-15',
      '2026-10-20',
      '2026-10-22',
    ]);
  });
  it('stops at endDate (inclusive)', () => {
    expect(datesIn({ ...rule, endDate: '2026-10-20' }, '2026-10-01', '2026-12-31')).toEqual([
      '2026-10-13',
      '2026-10-15',
      '2026-10-20',
    ]);
  });
  it('is empty when from > to', () => {
    expect(datesIn(rule, '2026-11-01', '2026-10-01')).toEqual([]);
  });
  it('crosses a DST change without skipping or repeating a date', () => {
    expect(
      datesIn({ weekdays: 64, startDate: '2026-10-25', endDate: null }, '2026-10-25', '2026-11-08'),
    ).toEqual(['2026-10-25', '2026-11-01', '2026-11-08']);
  });
});

describe('windowEnd', () => {
  it('is today + MaxAdvanceMonths', () =>
    expect(windowEnd('2026-10-06', 3, null)).toBe('2027-01-06'));
  it('treats unset as 12 months', () =>
    expect(windowEnd('2026-10-06', null, null)).toBe('2027-10-06'));
  it('honours 24', () => expect(windowEnd('2026-10-06', 24, null)).toBe('2028-10-06'));
  it('is capped by EndDate', () =>
    expect(windowEnd('2026-10-06', 12, '2026-12-01')).toBe('2026-12-01'));
  it('projectionCap is 24 months whatever the tenant says', () =>
    expect(projectionCap('2026-10-06')).toBe('2028-10-06'));
});

describe('projected ids', () => {
  it('round-trips', () => {
    const id = projectedId('0b9e7c1e-1111-4222-8333-444455556666', '2027-03-14');
    expect(id).toBe('series:0b9e7c1e-1111-4222-8333-444455556666:2027-03-14');
    expect(parseProjectedId(id)).toEqual({
      seriesId: '0b9e7c1e-1111-4222-8333-444455556666',
      date: '2027-03-14',
    });
  });
  it('refuses anything else, including a malformed date and a row id', () => {
    for (const bad of [
      'series::2027-03-14',
      'series:abc:2027-3-14',
      'series:abc:2027-02-30',
      'b1',
      'series:a:b:2027-03-14',
    ])
      expect(parseProjectedId(bad)).toBeNull();
  });
});

describe('words', () => {
  it('states an open series as open', () => {
    expect(patternWords({ weekdays: 2 | 8, startDate: '2026-10-13', endDate: null })).toBe(
      'every Tuesday and Thursday from 13 Oct, no end date',
    );
  });
  it('states an ended series with its last date', () => {
    expect(patternWords({ weekdays: 2, startDate: '2026-10-13', endDate: '2026-12-15' })).toBe(
      'every Tuesday from 13 Oct to 15 Dec',
    );
  });
  it('names three days with an Oxford-free list', () => {
    expect(patternWords({ weekdays: 1 | 4 | 16, startDate: '2026-10-12', endDate: null })).toBe(
      'every Monday, Wednesday and Friday from 12 Oct, no end date',
    );
  });
  it('has words for every skip reason, and none is a figure', () => {
    for (const r of SKIP_REASONS) expect(skipWords(r)).toMatch(/^[^$\d]+$/);
  });
});

describe('skip reasons match the schema', () => {
  // The CHECK list is written out in two SQL files and once here; they must not drift.
  for (const file of ['migrations/0019_booking_series.sql', 'sql/schema.sql']) {
    it(`${file} CHECK list equals SKIP_REASONS`, () => {
      const sql = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      const m =
        /BookingSeriesSkips[\s\S]*?Reason TEXT NOT NULL CHECK \(Reason IN \(([^)]*)\)\)/.exec(sql);
      expect(m).not.toBeNull();
      const listed = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
      expect(listed).toEqual([...SKIP_REASONS]);
    });
  }
});
