/**
 * The money-shape rule for a sitter-typed rate. Lives here (not in `server/lib/`) so the admin
 * bundle can import the SAME predicate the server enforces at its trust boundary instead of
 * hand-rolling it — the client use is UX only; the server still validates independently.
 */

/** Whole-dollar rate, at least $1 (free-typed; no relationship to duration). */
export function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * How ONE service prices a pet set it has no stored rate for (`TenantServices.PetRateMode`).
 *
 * - `'exact'` — REFUSE it. The set has no price unless the sitter typed one for exactly that set.
 * - `'linear'` — the option's own rate × the number of distinct pets.
 *
 * This is the ONLY sanctioned way a pet COUNT may reach the price path, and it reaches it only
 * because the sitter stored this choice: their stored mode is the typed consent that keeps "a rate
 * the sitter did not type is a price they did not agree to" true. A stored pet-set rate always
 * wins over the multiplier. The union lives here, next to `isValidRate`, for the same reason that
 * predicate does — the admin bundle must render the sitter's choice from the same type the server
 * validates against, without ever computing money.
 */
export type PetRateMode = 'exact' | 'linear';

export function isPetRateMode(value: unknown): value is PetRateMode {
  return value === 'exact' || value === 'linear';
}
