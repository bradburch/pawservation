import { describe, expect, it } from 'vitest';
import { holidayAwareCost, splitUnits } from '../lib/holiday-cost';

describe('splitUnits — which billed units land on a holiday', () => {
  it('counts a unit by the date it BEGINS', () => {
    // Dec 23 check-in, 3 nights: nights begin Dec 23, 24, 25. Two are holidays.
    expect(splitUnits('2026-12-23', 3)).toEqual({ units: 3, holidayUnits: 2 });
  });

  it('does not count the checkout day', () => {
    // 1 night, Dec 24 -> Dec 25. ONE holiday night (the one worked), not two.
    expect(splitUnits('2026-12-24', 1)).toEqual({ units: 1, holidayUnits: 1 });
  });

  it('counts zero when no unit lands on a holiday', () => {
    expect(splitUnits('2026-03-02', 5)).toEqual({ units: 5, holidayUnits: 0 });
  });

  it('handles a single unit on and off a holiday', () => {
    expect(splitUnits('2026-07-04', 1)).toEqual({ units: 1, holidayUnits: 1 });
    expect(splitUnits('2026-07-05', 1)).toEqual({ units: 1, holidayUnits: 0 });
  });

  it('crosses a year boundary correctly', () => {
    // Dec 30 + 3 units => Dec 30, Dec 31 (NYE), Jan 1 (NYD). Two holidays, two YEARS.
    expect(splitUnits('2026-12-30', 3)).toEqual({ units: 3, holidayUnits: 2 });
  });

  it('never reports a negative or fractional unit count', () => {
    expect(splitUnits('2026-12-25', 0)).toEqual({ units: 0, holidayUnits: 0 });
  });
});

describe('holidayAwareCost — stored rate x time units, never a multiplier', () => {
  it('prices every unit at the base rate when there is no holiday rate', () => {
    expect(holidayAwareCost(40, null, { units: 3, holidayUnits: 2 })).toBe(120);
  });

  it('prices holiday units at the holiday rate and the rest at the base rate', () => {
    // 3 nights, 2 on holidays: 1 x $40 + 2 x $75.
    expect(holidayAwareCost(40, 75, { units: 3, holidayUnits: 2 })).toBe(190);
  });

  it('prices an all-holiday stay entirely at the holiday rate', () => {
    expect(holidayAwareCost(40, 75, { units: 2, holidayUnits: 2 })).toBe(150);
  });

  it('is identical to the base-rate formula when no unit is a holiday', () => {
    expect(holidayAwareCost(40, 75, { units: 4, holidayUnits: 0 })).toBe(160);
  });

  it('accepts a holiday rate LOWER than the base rate (a stored rate, not a surcharge)', () => {
    expect(holidayAwareCost(40, 20, { units: 2, holidayUnits: 1 })).toBe(60);
  });

  it('clamps a nonsensical holidayUnits rather than inventing units', () => {
    expect(holidayAwareCost(40, 75, { units: 2, holidayUnits: 9 })).toBe(150);
    expect(holidayAwareCost(40, 75, { units: 2, holidayUnits: -3 })).toBe(80);
  });
});
