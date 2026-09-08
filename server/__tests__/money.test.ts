import { describe, expect, it } from 'vitest';
import {
  AMOUNT_RANGE_MESSAGE,
  centsToWholeDollars,
  dollarsToCents,
  formatCents,
  formatCentsForKey,
  formatCentsPlain,
  isValidAmountCents,
  isValidCents,
  MAX_AMOUNT_CENTS,
  parseDollarsInput,
} from '../../src/shared/pricing/money';

describe('money', () => {
  it('converts whole dollars to cents exactly and refuses fractions', () => {
    expect(dollarsToCents(45)).toBe(4500);
    expect(dollarsToCents(0)).toBe(0);
    expect(() => dollarsToCents(45.5)).toThrow();
    expect(() => dollarsToCents(-1)).toThrow();
  });
  it('refuses a dollar figure whose ×100 would leave the safe-integer range', () => {
    // `Number.MAX_SAFE_INTEGER` is itself a whole non-negative dollar amount, so the input guard
    // alone passes it — and the PRODUCT is a float that is no longer exact money. Guarding the
    // product is what makes the conversion "exact by construction" true rather than nearly true.
    expect(() => dollarsToCents(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    expect(() => dollarsToCents(10 ** 15)).toThrow(RangeError);
    // The largest dollar figure that still converts exactly stays converting.
    expect(dollarsToCents(90_071_992_547_409)).toBe(9_007_199_254_740_900);
  });
  it('caps an accepted amount at $1,000,000, and says so in dollars', () => {
    // `isValidCents` bounds nothing above: a payment of MAX_SAFE_INTEGER cents ($90 trillion)
    // passes every one of its checks. `isValidAmountCents` is the predicate a trust boundary uses.
    expect(isValidCents(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isValidAmountCents(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(MAX_AMOUNT_CENTS).toBe(100_000_000);
    expect(isValidAmountCents(MAX_AMOUNT_CENTS)).toBe(true);
    expect(isValidAmountCents(MAX_AMOUNT_CENTS + 1)).toBe(false);
    expect(isValidAmountCents(0)).toBe(false);
    expect(isValidAmountCents(45.5)).toBe(false);
    // The sentence every boundary answers with is DOLLARS — she typed dollars, and a limit
    // quoted as "100000000" makes her count zeros.
    expect(AMOUNT_RANGE_MESSAGE).toBe('Enter an amount between $0.01 and $1,000,000.');
  });
  it('converts cents to whole dollars only when whole', () => {
    expect(centsToWholeDollars(4500)).toBe(45);
    expect(() => centsToWholeDollars(4550)).toThrow();
  });
  it('validates cents as a positive safe integer', () => {
    expect(isValidCents(1)).toBe(true);
    expect(isValidCents(4550)).toBe(true);
    expect(isValidCents(0)).toBe(false);
    expect(isValidCents(45.5)).toBe(false);
    expect(isValidCents('4550')).toBe(false);
    expect(isValidCents(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
  it('parses what a sitter types', () => {
    expect(parseDollarsInput('45')).toBe(4500);
    expect(parseDollarsInput('45.5')).toBe(4550);
    expect(parseDollarsInput('45.50')).toBe(4550);
    expect(parseDollarsInput(' $1,234.00 ')).toBe(123400);
    expect(parseDollarsInput('0.01')).toBe(1);
    expect(parseDollarsInput('45.505')).toBeNull();
    expect(parseDollarsInput('0')).toBeNull();
    expect(parseDollarsInput('0.00')).toBeNull();
    expect(parseDollarsInput('-5')).toBeNull();
    expect(parseDollarsInput('abc')).toBeNull();
    expect(parseDollarsInput('')).toBeNull();
  });
  it('refuses a mis-grouped or leading-zero whole part rather than reading past it', () => {
    // "0,123" is a typo — a stray comma, or a copy-paste of half a figure. Reading it as $123 is
    // the worst available answer: it accepts a number the sitter did not type and never says so.
    expect(parseDollarsInput('0,123')).toBeNull();
    expect(parseDollarsInput('012')).toBeNull();
    expect(parseDollarsInput('1,23')).toBeNull();
    expect(parseDollarsInput('0,123.45')).toBeNull();
    // …while every well-formed figure, grouped or not, still parses — including the ones that
    // START with a zero legitimately, which is how cents are spelled.
    expect(parseDollarsInput('0.50')).toBe(50);
    expect(parseDollarsInput('123')).toBe(12300);
    expect(parseDollarsInput('1234')).toBe(123400);
    expect(parseDollarsInput('1,234')).toBe(123400);
    expect(parseDollarsInput('1,234,567')).toBe(123456700);
  });
  it('formats cents for people, for CSV cells, and for dedupe keys', () => {
    expect(formatCents(4550)).toBe('$45.50');
    expect(formatCents(123400)).toBe('$1,234.00');
    expect(formatCents(-1200)).toBe('-$12.00');
    expect(formatCents(5)).toBe('$0.05');
    // Zero is a real figure on every one of these surfaces — a $0 cancellation fee, an empty
    // month's bar, a booking with nothing owing — so both formatters are pinned at it.
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCentsPlain(4550)).toBe('45.50');
    expect(formatCentsPlain(123400)).toBe('1234.00');
    expect(formatCentsForKey(4500)).toBe('45');
    expect(formatCentsForKey(4550)).toBe('45.50');
    expect(formatCentsForKey(0)).toBe('0');
  });
  it('never renders a non-integer as money, and never throws doing it', () => {
    // A fraction of a cent split into whole/frac produces "$45.50.5" — a figure that exists in no
    // currency and that a reader would take for an amount. `NaN` produces "$NaN.NaN". Display
    // must not throw either (a page that renders one bad figure must not be a blank page), so
    // both are handed back as the raw value, which is visibly not a formatted amount.
    expect(formatCents(4550.5)).toBe('4550.5');
    expect(formatCentsPlain(4550.5)).toBe('4550.5');
    expect(formatCentsForKey(4550.5)).toBe('4550.5');
    expect(formatCents(NaN)).toBe('NaN');
    expect(formatCents(Infinity)).toBe('Infinity');
    expect(formatCentsPlain(-Infinity)).toBe('-Infinity');
    expect(() => formatCents(NaN)).not.toThrow();
    // The one shape that must NOT appear: a dollar figure with a second dot in it.
    expect(formatCents(4550.5)).not.toMatch(/\$\d[^\s]*\.\d+\./);
  });
});
