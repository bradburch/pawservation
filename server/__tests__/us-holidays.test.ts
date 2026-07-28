import { describe, expect, it } from 'vitest';
import {
  holidayNameOn,
  holidaysForYear,
  holidaysInMonth,
  US_HOLIDAY_NAMES,
} from '../../src/shared/index.js';
import type { UsHoliday } from '../../src/shared/index.js';

/** The dates below are the real calendar answers, checked by hand — they are the point of
 *  this file. A change that "fixes" a failure by editing an expected date here has broken the
 *  feature, not the test. */
describe('holidaysForYear — known years', () => {
  it('computes all twelve listed holidays for 2026', () => {
    expect(holidaysForYear(2026)).toEqual([
      { date: '2026-01-01', name: "New Year's Day" },
      { date: '2026-01-19', name: 'Martin Luther King Jr. Day' },
      { date: '2026-02-16', name: "Presidents' Day" },
      { date: '2026-05-25', name: 'Memorial Day' },
      { date: '2026-06-19', name: 'Juneteenth' },
      { date: '2026-07-04', name: 'Independence Day' },
      { date: '2026-09-07', name: 'Labor Day' },
      { date: '2026-11-26', name: 'Thanksgiving' },
      { date: '2026-11-27', name: 'Day after Thanksgiving' },
      { date: '2026-12-24', name: 'Christmas Eve' },
      { date: '2026-12-25', name: 'Christmas Day' },
      { date: '2026-12-31', name: "New Year's Eve" },
    ]);
  });

  it('computes the floating holidays for 2025', () => {
    const byName = new Map(holidaysForYear(2025).map((h) => [h.name, h.date]));
    expect(byName.get('Martin Luther King Jr. Day')).toBe('2025-01-20');
    expect(byName.get("Presidents' Day")).toBe('2025-02-17');
    expect(byName.get('Memorial Day')).toBe('2025-05-26'); // last Monday, not the 4th
    expect(byName.get('Labor Day')).toBe('2025-09-01'); // month starts ON a Monday
    expect(byName.get('Thanksgiving')).toBe('2025-11-27');
    expect(byName.get('Day after Thanksgiving')).toBe('2025-11-28');
  });

  it('computes the floating holidays for 2027', () => {
    const byName = new Map(holidaysForYear(2027).map((h) => [h.name, h.date]));
    expect(byName.get('Martin Luther King Jr. Day')).toBe('2027-01-18');
    expect(byName.get("Presidents' Day")).toBe('2027-02-15'); // month starts ON a Monday
    expect(byName.get('Memorial Day')).toBe('2027-05-31'); // a 5-Monday May
    expect(byName.get('Labor Day')).toBe('2027-09-06');
    expect(byName.get('Thanksgiving')).toBe('2027-11-25');
  });

  it('handles a leap year (2028)', () => {
    const byName = new Map(holidaysForYear(2028).map((h) => [h.name, h.date]));
    expect(byName.get('Memorial Day')).toBe('2028-05-29');
    expect(byName.get('Thanksgiving')).toBe('2028-11-23');
    expect(byName.get('Day after Thanksgiving')).toBe('2028-11-24');
  });

  it('returns dates sorted ascending, one per listed name', () => {
    for (const year of [2025, 2026, 2027, 2028, 2030]) {
      const list = holidaysForYear(year);
      expect(list).toHaveLength(US_HOLIDAY_NAMES.length);
      expect(list.map((h) => h.name)).toEqual([...US_HOLIDAY_NAMES]);
      expect([...list].sort((a, b) => a.date.localeCompare(b.date))).toEqual([...list]);
    }
  });

  it('does NOT shift a holiday to an observed weekday', () => {
    // Jul 4 2026 is a Saturday; Jul 4 2027 is a Sunday. Neither yields a Jul 3 / Jul 5 entry:
    // a pet is in care on the actual date regardless of which day a bank closes.
    expect(holidayNameOn('2026-07-04')).toBe('Independence Day');
    expect(holidayNameOn('2026-07-03')).toBeNull();
    expect(holidayNameOn('2027-07-05')).toBeNull();
  });
});

describe('holidayNameOn / holidaysInMonth', () => {
  it('names a holiday date and returns null for an ordinary one', () => {
    expect(holidayNameOn('2026-12-25')).toBe('Christmas Day');
    expect(holidayNameOn('2026-12-26')).toBeNull();
  });

  it('accepts an ISO datetime and reads only its calendar date', () => {
    expect(holidayNameOn('2026-12-25T23:30:00Z')).toBe('Christmas Day');
  });

  it('returns only the viewed month, in date order', () => {
    expect(holidaysInMonth('2026-11')).toEqual([
      { date: '2026-11-26', name: 'Thanksgiving' },
      { date: '2026-11-27', name: 'Day after Thanksgiving' },
    ]);
    expect(holidaysInMonth('2026-10')).toEqual([]);
    // December carries three, and none of January's leak in.
    expect(holidaysInMonth('2026-12').map((h) => h.date)).toEqual([
      '2026-12-24',
      '2026-12-25',
      '2026-12-31',
    ]);
  });

  it('is stable across calls and never hands out a mutable shared array', () => {
    const a = holidaysForYear(2026);
    const b = holidaysForYear(2026);
    expect(b).toEqual(a);
    expect(() => (a as UsHoliday[]).push({ date: 'x', name: 'x' })).toThrow();
  });
});
