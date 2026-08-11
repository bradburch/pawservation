/**
 * The panel's own mirror of `proposeAttribution`'s conservation guard
 * (server/lib/payment-attribution.ts) — PURE, plain data in, plain data out, no D1/env/fetch,
 * same as every other module in `src/shared`.
 *
 * `AttributionPanel.tsx` lets a sitter edit which booking(s) a credit lands on and for how much
 * before ever calling `POST .../attribute/apply`. This is what lets it refuse a set of splits
 * that doesn't conserve — INLINE, before the round trip — rather than let the server's own
 * conservation check (`applyAttribution`'s re-derivation) turn a bad edit into a `skipped` entry
 * the sitter then has to go re-read and fix. It invents no number of its own: every split amount
 * here is either a proposal's own figure or something the sitter typed, and this only checks
 * whether they add up — the same "whole dollars, exact integer arithmetic, no rounding" rule the
 * server-side proposer states for itself.
 */
export function balancedRemainder(
  creditAmount: number,
  splits: { amount: number }[],
): number | null {
  if (!Number.isInteger(creditAmount) || creditAmount < 0) return null;

  let sum = 0;
  for (const s of splits) {
    if (!Number.isInteger(s.amount) || s.amount <= 0) return null;
    sum += s.amount;
  }
  if (sum > creditAmount) return null;

  return creditAmount - sum;
}
