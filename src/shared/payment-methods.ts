/**
 * How a sitter collected money. Mirrors the SQL CHECK on Payments.Method — keep in lockstep.
 * Adding/removing a method here requires updating sql/schema.sql's CHECK constraint too (SQLite
 * can't ALTER a CHECK, so that's a table-rebuild migration, not a plain column add).
 */
export const PAYMENT_METHODS = [
  'cash',
  'venmo',
  'zelle',
  'paypal',
  'check',
  'card',
  'other',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}
