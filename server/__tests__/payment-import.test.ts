import { describe, expect, it } from 'vitest';
import {
  normalizePayerName,
  parseAmount,
  resolveMatchClient,
  sanitizeCell,
} from '../lib/payment-import';

describe('payment-import shared helpers', () => {
  it('parses a whole-dollar amount and refuses cents', () => {
    expect(parseAmount('+ $45.00')).toEqual({ sign: '+', dollars: 45 });
    expect(parseAmount('1,250')).toEqual({ sign: '+', dollars: 1250 });
    expect(parseAmount('- $885.00')).toEqual({ sign: '-', dollars: 885 });
    // Cents are unrepresentable — reported, never rounded into a wrong ledger entry.
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
