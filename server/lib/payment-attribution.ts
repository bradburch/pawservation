/**
 * Propose how one already-recorded credit should attach to a household's unpaid bookings — the
 * pure decision at the center of payment attribution. A sitter who imported payment history from
 * another system can end up with money the product cannot place: correct against the household,
 * unattached to any stay, so every booking still reads unpaid and the client reads "in credit".
 * This is the proposer, not the applier — it decides a split, it never writes one.
 *
 * PURE. No D1, no env, no fetch — takes plain data, returns plain data.
 *
 * The one invariant this module exists to uphold is CONSERVATION:
 * `splits.reduce((sum, s) => sum + s.amount, 0) + remainder === credit.amount`, exactly, in every
 * branch. Whole dollars throughout, exact integer arithmetic — no `Math.round`, no floating point.
 * A rounded split would silently create or destroy money.
 *
 * The other rule is refusal over guessing: when the nearest-by-date choice is a genuine tie
 * between two different bookings and the credit cannot cover both, this returns `ambiguous`
 * rather than picking one by id order, array order, or size. That choice belongs to the sitter —
 * the same posture `resolveMatchClient` (server/lib/payment-import.ts) takes toward a colliding
 * payer name, and the calendar backfill takes toward an event it cannot place unambiguously.
 */

export type UnpaidBooking = { bookingId: string; startDate: string; outstanding: number };
export type Credit = { paymentId: string; amount: number; paidDate: string };
export type Split = { bookingId: string; amount: number };
export type Proposal =
  | { ok: true; paymentId: string; splits: Split[]; remainder: number }
  | { ok: false; paymentId: string; reason: 'no-unpaid-bookings' | 'ambiguous'; detail: string };

/** Whole-day distance between two ISO date strings, independent of sign. */
function dayDistance(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(Date.parse(a) - Date.parse(b)) / msPerDay;
}

export function proposeAttribution(credit: Credit, bookings: UnpaidBooking[]): Proposal {
  const unpaid = bookings.filter((b) => b.outstanding > 0);
  if (unpaid.length === 0) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'no-unpaid-bookings',
      detail: `No unpaid bookings to attribute payment ${credit.paymentId} against.`,
    };
  }

  // Order by date proximity to the credit, nearest first. Ties are left in place here — detecting
  // and refusing an unresolved tie happens explicitly below, not by however `sort` happens to order
  // equal elements.
  const ordered = [...unpaid].sort(
    (a, b) => dayDistance(a.startDate, credit.paidDate) - dayDistance(b.startDate, credit.paidDate),
  );

  let remaining = credit.amount;
  const splits: Split[] = [];

  for (let i = 0; i < ordered.length && remaining > 0; i++) {
    const booking = ordered[i];

    // A genuine tie for "next in line": the current candidate and the next one are equidistant
    // from the credit's date, they are different bookings, and the credit cannot cover both of
    // their outstanding balances. Choosing between them is the sitter's call.
    const next = ordered[i + 1];
    if (
      next &&
      dayDistance(booking.startDate, credit.paidDate) ===
        dayDistance(next.startDate, credit.paidDate)
    ) {
      const bothCovered = remaining >= booking.outstanding + next.outstanding;
      if (!bothCovered) {
        return {
          ok: false,
          paymentId: credit.paymentId,
          reason: 'ambiguous',
          detail:
            `Payment ${credit.paymentId} is equidistant from bookings ${booking.bookingId} and ` +
            `${next.bookingId}, and does not cover both — choose which to attribute it to.`,
        };
      }
    }

    const take = Math.min(remaining, booking.outstanding);
    splits.push({ bookingId: booking.bookingId, amount: take });
    remaining -= take;
  }

  return { ok: true, paymentId: credit.paymentId, splits, remainder: remaining };
}
