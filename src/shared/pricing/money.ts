/**
 * Money is INTEGER CENTS everywhere it is stored or summed. Rates a sitter types are the one
 * exception and stay whole dollars; `estimateCost` (server/lib/availability.ts) is the single
 * place a rate becomes a cost and the single ×100 in the price path. Everything here is
 * arithmetic-free except the two conversions, which are exact by construction.
 */

export function dollarsToCents(dollars: number): number {
  if (!Number.isSafeInteger(dollars) || dollars < 0) {
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

const DOLLARS_INPUT = /^\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/;

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

export function formatCents(cents: number): string {
  const { sign, whole, frac } = splitCents(cents);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${grouped}.${frac}`;
}

export function formatCentsPlain(cents: number): string {
  const { sign, whole, frac } = splitCents(cents);
  return `${sign}${whole}.${frac}`;
}

export function formatCentsForKey(cents: number): string {
  const { sign, whole, frac } = splitCents(cents);
  return frac === '00' ? `${sign}${whole}` : `${sign}${whole}.${frac}`;
}
