import { describe, expect, it } from 'vitest';
import {
  centsToWholeDollars,
  dollarsToCents,
  formatCents,
  formatCentsForKey,
  formatCentsPlain,
  isValidCents,
  parseDollarsInput,
} from '../../src/shared/pricing/money';

describe('money', () => {
  it('converts whole dollars to cents exactly and refuses fractions', () => {
    expect(dollarsToCents(45)).toBe(4500);
    expect(dollarsToCents(0)).toBe(0);
    expect(() => dollarsToCents(45.5)).toThrow();
    expect(() => dollarsToCents(-1)).toThrow();
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
  it('formats cents for people, for CSV cells, and for dedupe keys', () => {
    expect(formatCents(4550)).toBe('$45.50');
    expect(formatCents(123400)).toBe('$1,234.00');
    expect(formatCents(-1200)).toBe('-$12.00');
    expect(formatCents(5)).toBe('$0.05');
    expect(formatCentsPlain(4550)).toBe('45.50');
    expect(formatCentsPlain(123400)).toBe('1234.00');
    expect(formatCentsForKey(4500)).toBe('45');
    expect(formatCentsForKey(4550)).toBe('45.50');
  });
});
