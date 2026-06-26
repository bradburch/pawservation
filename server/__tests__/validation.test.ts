import { describe, expect, it } from 'vitest';
import { isValidRate, isValidDuration } from '../lib/validation';

describe('option validation', () => {
  it('accepts whole-dollar rates >= 1', () => {
    expect(isValidRate(1)).toBe(true);
    expect(isValidRate(35)).toBe(true);
    expect(isValidRate(0)).toBe(false);
    expect(isValidRate(-5)).toBe(false);
    expect(isValidRate(9.5)).toBe(false);
  });

  it('accepts positive integer durations', () => {
    expect(isValidDuration(30)).toBe(true);
    expect(isValidDuration(0)).toBe(false);
    expect(isValidDuration(15.5)).toBe(false);
    expect(isValidDuration(-1)).toBe(false);
  });
});
