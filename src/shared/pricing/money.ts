/**
 * Money is INTEGER CENTS everywhere it is stored or summed. Rates a sitter types are the one
 * exception and stay whole dollars; `estimateCost` (server/lib/availability.ts) is the single
 * place a rate becomes a cost and the single ×100 in the price path. Everything here is
 * arithmetic-free except the two conversions, which are exact by construction.
 *
 * ZERO IS LEGAL IN ONE DIRECTION AND NOT THE OTHER, deliberately. `dollarsToCents(0)` returns 0
 * because a booking really can cost nothing (a comped stay, a waived cancellation fee, an empty
 * month's bar), and a converter that refused it would force every caller to special-case a real
 * figure. `isValidCents(0)` is false because it guards a boundary where the figure is a PAYMENT,
 * a CHARGE or a SPLIT — a payment of nothing is not a payment, and accepting it would write a
 * ledger row that says money moved when none did. The two are not in disagreement: one converts a
 * unit, the other admits an amount.
 */

/**
 * The largest amount any hand-entered money boundary accepts: $1,000,000, matching
 * `MAX_BACKFILL_EST_COST` (server/routes/admin.ts) so a sitter meets ONE ceiling wherever she types
 * a figure. A sanity rail, not a business rule — without it `isValidCents` admits
 * `Number.MAX_SAFE_INTEGER` cents ($90 trillion), which is a typo nobody meant and a number that
 * poisons every sum it lands in.
 */
export const MAX_AMOUNT_CENTS = 100_000_000;

export function dollarsToCents(dollars: number): number {
  // The ×100 must land back inside the safe-integer range, or the result is a float that looks
  // like money and sums wrong. Guarded rather than assumed: a rate arrives from a column.
  if (!Number.isSafeInteger(dollars) || dollars < 0 || !Number.isSafeInteger(dollars * 100)) {
    throw new RangeError(
      `dollarsToCents: expected a whole non-negative dollar amount, got ${dollars}`,
    );
  }
  return dollars * 100;
}

export function centsToWholeDollars(cents: number): number {
  if (!Number.isSafeInteger(cents) || cents % 100 !== 0) {
    throw new RangeError(`centsToWholeDollars: ${cents} is not a whole number of dollars`);
  }
  return cents / 100;
}

export function isValidCents(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** `isValidCents` plus the `MAX_AMOUNT_CENTS` ceiling — the predicate every route that accepts a
 *  typed amount (payments, charges, attribution splits) uses at its trust boundary. */
export function isValidAmountCents(value: unknown): value is number {
  return isValidCents(value) && value <= MAX_AMOUNT_CENTS;
}

/** Accepts "45", "45.50", "1,234.00" — and rejects a mis-grouped or leading-zero whole part
 *  ("0,123", "012"), which is a typo rather than a figure and must not silently become $123. Zero
 *  itself stays spellable ("0.01" is a cent, "0" is refused by `isValidCents` below). */
const DOLLARS_INPUT = /^\$?\s*(0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export function parseDollarsInput(raw: string): number | null {
  const m = DOLLARS_INPUT.exec(raw.trim());
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ''));
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(2, '0'));
  const cents = whole * 100 + frac;
  return isValidCents(cents) ? cents : null;
}

function splitCents(cents: number): { sign: string; whole: string; frac: string } {
  const abs = Math.abs(cents);
  return {
    sign: cents < 0 ? '-' : '',
    whole: String(Math.trunc(abs / 100)),
    frac: String(abs % 100).padStart(2, '0'),
  };
}

/**
 * The three formatters below are DISPLAY, and display never throws: a page that renders one bad
 * figure must not be a blank page. A non-integer or non-finite input is not money, so rather than
 * emit "$0.12.5" or "$NaN.NaN" — strings a reader would take for an amount — they hand back
 * `String(cents)`, which is visibly not a formatted amount and carries the offending value.
 */
function isMoney(cents: number): boolean {
  return Number.isInteger(cents);
}

export function formatCents(cents: number): string {
  if (!isMoney(cents)) return String(cents);
  const { sign, whole, frac } = splitCents(cents);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${frac}`;
}

export function formatCentsPlain(cents: number): string {
  if (!isMoney(cents)) return String(cents);
  const { sign, whole, frac } = splitCents(cents);
  return `${sign}${whole}.${frac}`;
}

export function formatCentsForKey(cents: number): string {
  if (!isMoney(cents)) return String(cents);
  const { sign, whole, frac } = splitCents(cents);
  return frac === '00' ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}

/**
 * The ONE sentence every amount boundary answers a refused figure with — server routes and the
 * client forms alike, derived from the bounds themselves so the copy cannot drift from the rule.
 * Spoken in DOLLARS, because dollars are what the sitter typed: telling her the limit in cents
 * makes her do the arithmetic the whole unit change exists to spare her.
 */
export const AMOUNT_RANGE_MESSAGE = `Enter an amount between ${formatCents(1)} and ${formatCents(
  MAX_AMOUNT_CENTS,
).replace(/\.00$/, '')}.`;
