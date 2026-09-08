import { describe, expect, it } from 'vitest';
import { cancellationFee, validateCancellationTiers } from '../../src/shared';

const TIERS = [
  { withinDays: 2, percent: 100 },
  { withinDays: 7, percent: 50 },
];

describe('cancellationFee', () => {
  it('tightest tier wins at the boundary', () => {
    expect(cancellationFee(TIERS, 20000, '2028-10-10', '2028-10-08')).toBe(20000); // 2 days out
    expect(cancellationFee(TIERS, 20000, '2028-10-10', '2028-10-03')).toBe(10000); // 7 days out
    expect(cancellationFee(TIERS, 20000, '2028-10-10', '2028-10-02')).toBe(0); // 8 days out
  });
  it('same-day and past-start count as 0 days out', () => {
    expect(cancellationFee(TIERS, 20000, '2028-10-10', '2028-10-10')).toBe(20000);
    expect(cancellationFee(TIERS, 20000, '2028-10-10', '2028-10-12')).toBe(20000);
  });
  it('rounds to whole dollars', () => {
    expect(
      cancellationFee([{ withinDays: 7, percent: 50 }], 7500, '2028-10-10', '2028-10-05'),
    ).toBe(3800);
  });
  it('empty tiers → 0', () => {
    expect(cancellationFee([], 20000, '2028-10-10', '2028-10-10')).toBe(0);
  });
  it('pins the whole-dollar rounding now that the unit is cents', () => {
    // $10 at 15% is $1.50, which the sitter's policy has always rounded to $2.
    expect(
      cancellationFee([{ withinDays: 7, percent: 15 }], 1000, '2026-10-10', '2026-10-08'),
    ).toBe(200);
    // $350 at 25% is $87.50, which rounds to $88.
    expect(
      cancellationFee([{ withinDays: 7, percent: 25 }], 35000, '2026-10-10', '2026-10-08'),
    ).toBe(8800);
    // Cancelling outside every tier owes nothing.
    expect(
      cancellationFee([{ withinDays: 7, percent: 15 }], 1000, '2026-10-10', '2026-01-01'),
    ).toBe(0);
  });
});

describe('cancellationFee on a cost it cannot round', () => {
  /**
   * The whole-dollar rounding (`(cents / 100) * percent → Math.round → × 100`) ASSUMES the cost is
   * a whole number of dollars. On 4550 it would quietly take a percentage of $45.50 and hand back
   * a whole-dollar figure computed off a base the booking never had — a fee that is wrong in a way
   * nothing downstream can see. Every stored `EstCost` is whole by construction, so the only ways
   * to get here are an un-migrated database (0015 applied to the code, not the data) or a row
   * written past both routes; both deserve a loud refusal rather than a plausible number.
   */
  it('throws rather than compute a fee off a base it had to reinterpret', () => {
    expect(() => cancellationFee(TIERS, 4550, '2028-10-10', '2028-10-08')).toThrow(RangeError);
    expect(() => cancellationFee(TIERS, 4550, '2028-10-10', '2028-10-08')).toThrow(/4550/);
    expect(() => cancellationFee(TIERS, 1, '2028-10-10', '2028-10-08')).toThrow(RangeError);
    expect(() => cancellationFee(TIERS, 45.5, '2028-10-10', '2028-10-08')).toThrow(RangeError);
  });
  it('still accepts every whole-dollar cost, including zero', () => {
    // A $0 stay is a real figure (a comped booking), and 0 % 100 is 0 — it must not be caught by
    // a guard aimed at fractions.
    expect(cancellationFee(TIERS, 0, '2028-10-10', '2028-10-08')).toBe(0);
    expect(cancellationFee(TIERS, 100, '2028-10-10', '2028-10-08')).toBe(100);
  });
});

describe('validateCancellationTiers', () => {
  it('accepts a sorted 1-5 tier schedule', () => {
    expect(validateCancellationTiers(TIERS)).toBe(true);
    expect(validateCancellationTiers([{ withinDays: 0, percent: 100 }])).toBe(true);
  });
  it('rejects non-arrays, empty, >5, unsorted, dup days, bad ranges, extra keys, non-integers', () => {
    expect(validateCancellationTiers(null)).toBe(false);
    expect(validateCancellationTiers([])).toBe(false);
    expect(
      validateCancellationTiers(
        Array.from({ length: 6 }, (_, i) => ({ withinDays: i, percent: 10 })),
      ),
    ).toBe(false);
    expect(validateCancellationTiers([TIERS[1], TIERS[0]])).toBe(false); // unsorted
    expect(
      validateCancellationTiers([
        { withinDays: 2, percent: 100 },
        { withinDays: 2, percent: 50 },
      ]),
    ).toBe(false);
    expect(validateCancellationTiers([{ withinDays: -1, percent: 50 }])).toBe(false);
    expect(validateCancellationTiers([{ withinDays: 2, percent: 0 }])).toBe(false);
    expect(validateCancellationTiers([{ withinDays: 2, percent: 101 }])).toBe(false);
    expect(validateCancellationTiers([{ withinDays: 2, percent: 50, extra: 1 }])).toBe(false);
    expect(validateCancellationTiers([{ withinDays: 1.5, percent: 50 }])).toBe(false);
  });
});
