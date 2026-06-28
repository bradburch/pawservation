import { describe, expect, it } from 'vitest';
import {
  buildCapacity,
  rangeHasConflict,
  type CapacityEvent,
  type CapacityLimits,
} from '../../src/shared/index.js';

const boarding = (start: string, end: string, petCount = 1): CapacityEvent => ({
  start_date: start,
  end_date: end,
  type: 'boarding',
  petCount,
});
const houseSit = (start: string, end: string): CapacityEvent => ({
  start_date: start,
  end_date: end,
  type: 'house-sit',
});
const blocked = (start: string, end: string): CapacityEvent => ({
  start_date: start,
  end_date: end,
  type: 'blocked',
});

const UNLIMITED: CapacityLimits = { maxBoardingPets: null, maxHouseSitsPerDay: null };

describe('rangeHasConflict with CapacityLimits', () => {
  it('auto-passes-through unlimited boarding (many overlaps, no limit)', () => {
    const cap = buildCapacity([
      boarding('2028-08-01', '2028-08-10', 5),
      boarding('2028-08-01', '2028-08-10', 9),
    ]);
    expect(rangeHasConflict('2028-08-02', '2028-08-06', 'boarding', cap, UNLIMITED, 7)).toBe(false);
  });

  it('still blocks admin-blocked dates even when unlimited', () => {
    const cap = buildCapacity([blocked('2028-08-03', '2028-08-05')]);
    expect(rangeHasConflict('2028-08-01', '2028-08-06', 'boarding', cap, UNLIMITED, 1)).toBe(true);
  });

  it('enforces a configured boarding pet cap', () => {
    const cap = buildCapacity([boarding('2028-08-01', '2028-08-05', 2)]);
    const limit3: CapacityLimits = { maxBoardingPets: 3, maxHouseSitsPerDay: null };
    // 2 already boarding mid-range: a 1-pet request fits (2+1<=3), a 2-pet request does not (2+2>3).
    expect(rangeHasConflict('2028-08-02', '2028-08-04', 'boarding', cap, limit3, 1)).toBe(false);
    expect(rangeHasConflict('2028-08-02', '2028-08-04', 'boarding', cap, limit3, 2)).toBe(true);
  });

  it('shares a boundary day (soft bookend) under a configured cap', () => {
    const cap = buildCapacity([boarding('2028-08-01', '2028-08-03', 2)]);
    const limit2: CapacityLimits = { maxBoardingPets: 2, maxHouseSitsPerDay: null };
    expect(rangeHasConflict('2028-08-03', '2028-08-05', 'boarding', cap, limit2, 2)).toBe(false);
  });

  it('enforces a configured house-sit cap; unlimited lets them stack', () => {
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-04')]);
    const oneSit: CapacityLimits = { maxBoardingPets: null, maxHouseSitsPerDay: 1 };
    expect(rangeHasConflict('2028-09-02', '2028-09-03', 'house-sit', cap, oneSit, 1)).toBe(true);
    expect(rangeHasConflict('2028-09-02', '2028-09-03', 'house-sit', cap, UNLIMITED, 1)).toBe(false);
  });

  it('keeps the structural house-sit/boarding ≤1-day overlap rule regardless of limits', () => {
    const cap = buildCapacity([boarding('2028-09-01', '2028-09-10', 1)]);
    // A house-sit overlapping 2 boarding days conflicts even with unlimited house-sits.
    expect(rangeHasConflict('2028-09-02', '2028-09-04', 'house-sit', cap, UNLIMITED, 1)).toBe(true);
    // Overlapping exactly 1 boarding day is allowed.
    expect(rangeHasConflict('2028-09-01', '2028-09-02', 'house-sit', cap, UNLIMITED, 1)).toBe(false);
  });
});
