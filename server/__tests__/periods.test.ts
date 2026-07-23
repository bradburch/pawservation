import { describe, expect, it } from 'vitest';
import { quarterlyBreakdown, quarterSinceDate } from '../../src/shared/analytics/periods.js';

describe('quarterlyBreakdown', () => {
  // A two-calendar-year monthly[] (the rolling 12-month window shape), currentYear = 2026.
  const monthly = [
    { Month: '2025-08', Total: 100 },
    { Month: '2025-09', Total: 200 },
    { Month: '2025-10', Total: 300 },
    { Month: '2025-11', Total: 400 },
    { Month: '2025-12', Total: 500 },
    { Month: '2026-01', Total: 10 },
    { Month: '2026-02', Total: 20 },
    { Month: '2026-03', Total: 30 },
    { Month: '2026-04', Total: 40 },
    { Month: '2026-05', Total: 0 }, // a month with no revenue contributes 0
    { Month: '2026-06', Total: 60 },
    { Month: '2026-07', Total: 70 },
  ];

  it('ytd sums only current-year months (prior-year months excluded)', () => {
    const { ytd } = quarterlyBreakdown(monthly, 2026);
    expect(ytd).toBe(230); // 10+20+30+40+0+60+70; none of the 2025 months
  });

  it('each quarter sums its months; a mid-year Q4 is 0; all four slots always present', () => {
    const { quarters } = quarterlyBreakdown(monthly, 2026);
    expect(quarters).toHaveLength(4);
    expect(quarters).toEqual([
      { q: 1, total: 60 }, // Jan+Feb+Mar = 10+20+30
      { q: 2, total: 100 }, // Apr+May+Jun = 40+0+60
      { q: 3, total: 70 }, // Jul present; Aug/Sep 2026 absent → count as 0
      { q: 4, total: 0 }, // no Q4 months present yet
    ]);
  });

  it('returns all four quarter slots even for an empty monthly[]', () => {
    const { ytd, quarters } = quarterlyBreakdown([], 2026);
    expect(ytd).toBe(0);
    expect(quarters).toEqual([
      { q: 1, total: 0 },
      { q: 2, total: 0 },
      { q: 3, total: 0 },
      { q: 4, total: 0 },
    ]);
  });
});

describe('quarterSinceDate', () => {
  it('maps a month to the first day of its quarter', () => {
    expect(quarterSinceDate(2026, 1)).toBe('2026-01-01');
    expect(quarterSinceDate(2026, 3)).toBe('2026-01-01');
    expect(quarterSinceDate(2026, 4)).toBe('2026-04-01');
    expect(quarterSinceDate(2026, 6)).toBe('2026-04-01');
    expect(quarterSinceDate(2026, 7)).toBe('2026-07-01');
    expect(quarterSinceDate(2026, 9)).toBe('2026-07-01');
    expect(quarterSinceDate(2026, 10)).toBe('2026-10-01');
    expect(quarterSinceDate(2026, 12)).toBe('2026-10-01');
  });
});
