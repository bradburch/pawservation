import { describe, expect, it } from 'vitest';
import {
  normalizePayerName,
  parseAmount,
  resolveMatchClient,
  sanitizeCell,
} from '../lib/payment-import';

describe('payment-import shared helpers', () => {
  it('parses a whole-dollar amount INTO CENTS and still refuses a fractional one', () => {
    expect(parseAmount('+ $45.00')).toEqual({ sign: '+', cents: 4500 });
    expect(parseAmount('1,250')).toEqual({ sign: '+', cents: 125000 });
    expect(parseAmount('- $885.00')).toEqual({ sign: '-', cents: 88500 });
    // 0015 made the STORAGE unit cents; the importer's contract with the sitter is unchanged, so a
    // fractional row is still reported rather than recorded. See parseAmount's own note.
    expect(parseAmount('$45.50')).toBeNull();
    expect(parseAmount('$0')).toBeNull();
    expect(parseAmount('not money')).toBeNull();
  });

  it('defuses a spreadsheet formula', () => {
    expect(sanitizeCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(sanitizeCell('  Jess   Rivera ')).toBe('Jess Rivera');
  });

  it('folds a display name and a handle onto one key', () => {
    expect(normalizePayerName('@Jess-Demo')).toBe(normalizePayerName('Jess Demo'));
  });

  it('REFUSES a payer name matching two clients rather than picking one', () => {
    const clients = [
      { accountId: 'a1', name: 'Jess Demo', venmoUsername: null },
      { accountId: 'a2', name: 'jess demo', venmoUsername: null },
    ] as Parameters<typeof resolveMatchClient>[0];
    expect(resolveMatchClient(clients, 'Jess Demo')).toBeNull();
  });
});
