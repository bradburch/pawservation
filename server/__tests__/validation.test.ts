import { describe, expect, it } from 'vitest';
import {
  isValidRate,
  isValidDuration,
  DEFENSIVE_MAX_NIGHTS,
  isValidPetCount,
  validateBoardingRange,
} from '../lib/validation';

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

describe('configurable stay length', () => {
  it('rejects a stay over the tenant max with the configured number', () => {
    const err = validateBoardingRange('2028-01-01', '2028-01-20', 10);
    expect(err?.error).toBe('Stays are limited to 10 nights.');
  });

  it('allows any realistic stay when maxStayNights is null (auto pass-through)', () => {
    expect(validateBoardingRange('2028-01-01', '2030-01-01', null)).toBeNull();
  });

  it('still rejects an absurd range beyond the defensive rail even when unlimited', () => {
    const result = validateBoardingRange('2028-01-01', '2099-01-01', null);
    expect(result?.status).toBe(400);
    expect(result?.error).toBe('Invalid date range.');
    expect(DEFENSIVE_MAX_NIGHTS).toBe(3650);
  });

  it('pet count is bounded by the defensive rail, not a business cap of 50', () => {
    expect(isValidPetCount(60)).toBe(true); // 60 > old 50 cap, allowed now
    expect(isValidPetCount(1001)).toBe(false); // beyond defensive rail
  });
});
