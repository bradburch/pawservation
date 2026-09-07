import { describe, expect, it } from 'vitest';
import {
  normalizePayerName,
  parseAmount,
  resolveMatchClient,
  sanitizeCell,
} from '../lib/payment-import';

describe('payment-import shared helpers', () => {
  it('parses an amount INTO CENTS, fractions included', () => {
    expect(parseAmount('+ $45.00')).toEqual({ sign: '+', cents: 4500 });
    expect(parseAmount('1,250')).toEqual({ sign: '+', cents: 125000 });
    expect(parseAmount('- $885.00')).toEqual({ sign: '-', cents: 88500 });
    // THE POINT OF THIS TASK: $45.50 is a real thing a client sends, and the ledger has held cents
    // since 0015, so it is now RECORDED rather than reported back to the sitter to enter by hand.
    expect(parseAmount('+ $45.50')).toEqual({ sign: '+', cents: 4550 });
    expect(parseAmount('$0.99')).toEqual({ sign: '+', cents: 99 });
    expect(parseAmount('- $250.50')).toEqual({ sign: '-', cents: 25050 });
    // One cent is the floor, not one dollar: below it there is no payment to record.
    expect(parseAmount('$0.00')).toBeNull();
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
