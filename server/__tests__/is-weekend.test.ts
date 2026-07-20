import { describe, expect, it } from 'vitest';
import { isWeekend } from '../../src/shared/index.js';

// Day-of-week of a date-ONLY string is timezone-free — the same calendar date is the same
// weekday everywhere — so these are plain fixed-date assertions (2028-07-22 is a Saturday).
describe('isWeekend', () => {
  it('true for a Saturday', () => {
    expect(isWeekend('2028-07-22')).toBe(true);
  });

  it('true for a Sunday', () => {
    expect(isWeekend('2028-07-23')).toBe(true);
  });

  it('false for a Monday', () => {
    expect(isWeekend('2028-07-24')).toBe(false);
  });

  it('false for a Friday', () => {
    expect(isWeekend('2028-07-21')).toBe(false);
  });
});
