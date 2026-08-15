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
/**
 * How many attributions one `POST .../attribute/apply` request may carry — the cap the server
 * enforces AND the size the panel chunks a longer approved set into, one constant so the two can
 * never drift (the same arrangement `MAX_BACKFILL_EVENTS` has with `CalendarBackfillPanel`).
 *
 * THE ARITHMETIC, because a number like this is only defensible if it is shown. Cloudflare counts
 * every binding call against a per-invocation subrequest ceiling of 50 on the Workers Free plan
 * (docs/superpowers/specs/2026-08-09-calendar-backfill-design.md:52,144 — "Binding calls count.").
 * One attribution costs, measured:
 *
 *   2  the account graph (live links + deceased-pet anchor links)
 *   1  the source payment, re-read because its own `Amount` is the only authority
 *   2  the candidate bookings' live outstanding, and their booking<->pet edges
 *   1  the write itself — `db.batch` is ONE binding call however many statements it carries
 *   1  the "was the source taken from under us?" re-read, on the batch-abort path only
 *   = 7 worst case, 6 ordinarily
 *
 * plus the request's own fixed overhead, which is `tenantMiddleware` → `resolveTenant`
 * (server/lib/tenant-resolve.ts): 1 KV `get` when the tenant is cached, or `get` + a D1 read +
 * `put` = 3 when it is not. `adminAuth` adds NOTHING — it verifies a JWT in-process and makes no
 * binding call at all. So the worst case is 3 + 6 × 7 = 45, five subrequests clear of the ceiling.
 * Those reads deliberately do NOT hoist out of the loop: each
 * attribution must see the previous one's write committed, which is what refuses a second credit
 * landing on a booking the first already settled (server/db/repo.ts, `applyAttribution`). Lower
 * this if the per-attribution cost ever rises; do not raise it to make a caller's life easier.
 */
export const MAX_ATTRIBUTIONS_PER_REQUEST = 6;

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

/**
 * Order a sitter's approved credits so HER OWN PICKS ARE SENT FIRST.
 *
 * `applyAttribution` processes a request's attributions in order, each re-reading live state, so
 * when two approved credits name the same stay the FIRST one wins and the second is refused for
 * overpaying. That makes send order a decision about which credit gets recorded — and the winning
 * credit's own `PaidDate`, `Method` and `Note` are what end up stamped on the booking.
 *
 * The preview proposes a household's credits closest-pair-first and the panel pre-ticks those
 * proposals; a credit the sitter placed herself (a tie she broke, or one the sequencing skipped)
 * is one the server proposed nothing for. Sending proposals first would let the automatic guess
 * beat the deliberate correction — the guess `docs/superpowers/specs/2026-08-10-payment-attribution-design.md`
 * rejects in as many words — and would make the sitter untick a box the panel ticked for her just
 * to be heard. So hers go first and the guess is the one that comes back refused.
 *
 * Stable within each group: `Array.prototype.sort` is required to be stable, so credits keep the
 * preview's own order among themselves.
 */
export function sitterPicksFirst<T extends { serverRemainder: number | null }>(credits: T[]): T[] {
  return [...credits].sort(
    (a, b) => Number(a.serverRemainder !== null) - Number(b.serverRemainder !== null),
  );
}
