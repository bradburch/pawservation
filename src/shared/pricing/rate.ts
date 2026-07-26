/**
 * The money-shape rule for a sitter-typed rate. Lives here (not in `server/lib/`) so the admin
 * bundle can import the SAME predicate the server enforces at its trust boundary instead of
 * hand-rolling it — the client use is UX only; the server still validates independently.
 */

/** Whole-dollar rate, at least $1 (free-typed; no relationship to duration). */
export function isValidRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
