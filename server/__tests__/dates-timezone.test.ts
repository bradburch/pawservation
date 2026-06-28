import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/util/dates.js';

describe('getPacificDateStr timezone parameter', () => {
  it('defaults to the instance default timezone', () => {
    expect(DEFAULT_TIMEZONE).toBe('America/Los_Angeles');
    // 2028-01-01 07:00 UTC is still 2027-12-31 in Los Angeles (UTC-8).
    const d = new Date('2028-01-01T07:00:00Z');
    expect(getPacificDateStr(d)).toBe('2027-12-31');
  });

  it('honors an explicit timezone', () => {
    // Same instant is already 2028-01-01 in Europe/London (UTC+0).
    const d = new Date('2028-01-01T07:00:00Z');
    expect(getPacificDateStr(d, 'Europe/London')).toBe('2028-01-01');
    // …and 2028-01-01 in Asia/Tokyo (UTC+9) well before that.
    expect(getPacificDateStr(d, 'Asia/Tokyo')).toBe('2028-01-01');
  });
});
