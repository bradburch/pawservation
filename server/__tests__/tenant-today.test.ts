import { describe, expect, it } from 'vitest';
import { tenantToday } from '../lib/tenant-today';
import { DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';

describe('tenantToday', () => {
  // 03:30 UTC on the 13th is still the 12th in Los Angeles and already the 13th in Auckland.
  const now = new Date('2030-03-13T03:30:00Z');

  it("reads the date on the sitter's own calendar", () => {
    expect(tenantToday({ Timezone: 'Pacific/Auckland' }, now)).toBe('2030-03-13');
    expect(tenantToday({ Timezone: 'America/Los_Angeles' }, now)).toBe('2030-03-12');
  });

  it('a missing timezone is the instance default', () => {
    expect(tenantToday({ Timezone: null }, now)).toBe(getPacificDateStr(now, DEFAULT_TIMEZONE));
  });

  it('a stored timezone Intl does not recognise falls back to the instance default, never throws', () => {
    expect(tenantToday({ Timezone: 'Mars/Olympus_Mons' }, now)).toBe(
      getPacificDateStr(now, DEFAULT_TIMEZONE),
    );
  });
});
