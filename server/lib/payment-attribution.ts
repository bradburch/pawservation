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
 * A rounded split would silently create or destroy money. That guarantee only holds for inputs
 * that are actually whole dollars, so `credit.amount` and every booking's `outstanding` are
 * checked with `Number.isInteger` (and non-negativity) before any arithmetic runs — a fractional
 * or negative amount is refused rather than quietly producing a fractional or negative split.
 * `outstanding` is validated against the FULL, unfiltered `bookings` list, before the
 * `outstanding > 0` filter that picks out candidates: `NaN > 0` and `-50 > 0` are both false, so
 * checking only the filtered set would silently drop an unreadable booking from consideration
 * — indistinguishable from one that is genuinely settled — instead of refusing outright.
 *
 * The other rule is refusal over guessing: when the nearest-by-date choice is a genuine tie
 * among two or more different bookings and the credit cannot cover all of them, this returns
 * `ambiguous` naming every tied booking, rather than picking one by id order, array order, or
 * size. That choice belongs to the sitter — the same posture `resolveMatchClient`
 * (server/lib/payment-import.ts) takes toward a colliding payer name, and the calendar backfill
 * takes toward an event it cannot place unambiguously. A tie the credit could not have reached
 * anyway (it can't fully fund even the cheapest tied booking) is not a decision the sitter needs
 * to make, so it is not refused — the leftover simply becomes `remainder`.
 *
 * Dates are just as load-bearing as amounts: an unparseable or impossible `startDate` /
 * `paidDate` can't be sorted by distance without silently falling into an array-order tie-break
 * (`NaN` comparator results are unspecified), so every date is validated with the house
 * `isRealDate` (server/lib/validation.ts) — tolerant of a trailing `T…` time-of-day, stripped
 * before validation — before any distance is computed. Distances themselves are computed with
 * `parseDateUtc`/`MS_PER_DAY` (src/shared/util/dates.ts), the codebase's one date parse, so a
 * time-of-day on `paidDate` can never make every distance fractional and quietly disable tie
 * detection.
 */

import { isRealDate } from './validation.js';
import { MS_PER_DAY, parseDateUtc } from '../../src/shared/index.js';

export type UnpaidBooking = { bookingId: string; startDate: string; outstanding: number };
export type Credit = { paymentId: string; amount: number; paidDate: string };
export type Split = { bookingId: string; amount: number };
export type Proposal =
  | { ok: true; paymentId: string; splits: Split[]; remainder: number }
  | {
      ok: false;
      paymentId: string;
      reason:
        | 'no-unpaid-bookings'
        | 'ambiguous'
        | 'invalid-date'
        | 'invalid-amount'
        | 'duplicate-booking-id';
      detail: string;
    };

/** `value` (optionally carrying a `T…` time-of-day) names a real calendar day. */
function isUsableDate(value: string): boolean {
  return isRealDate(value.split('T')[0]);
}

/** Whole-day distance between two (optionally time-stamped) ISO date strings. */
function dayDistance(a: string, b: string): number {
  return Math.abs(parseDateUtc(a) - parseDateUtc(b)) / MS_PER_DAY;
}

export function proposeAttribution(credit: Credit, bookings: UnpaidBooking[]): Proposal {
  if (!Number.isInteger(credit.amount) || credit.amount < 0) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-amount',
      detail: `Payment ${credit.paymentId} has a non-whole-dollar or negative amount (${credit.amount}); refusing rather than risk a fractional or negative split.`,
    };
  }

  if (!isUsableDate(credit.paidDate)) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-date',
      detail: `Payment ${credit.paymentId} has an unreadable paid date ("${credit.paidDate}"); refusing rather than sort against an undefined distance.`,
    };
  }

  // Validated against ALL bookings, before the `outstanding > 0` filter below: both `NaN > 0`
  // and `-50 > 0` are false, so an unreadable outstanding would otherwise be silently dropped
  // from consideration rather than refused — indistinguishable from a booking that is genuinely
  // settled. Unreadable is not the same as zero.
  const badOutstanding = bookings.find(
    (b) => !Number.isInteger(b.outstanding) || b.outstanding < 0,
  );
  if (badOutstanding) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-amount',
      detail: `Booking ${badOutstanding.bookingId} has an unreadable outstanding amount (${badOutstanding.outstanding}); refusing rather than silently drop it from consideration.`,
    };
  }

  const unpaid = bookings.filter((b) => b.outstanding > 0);
  if (unpaid.length === 0) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'no-unpaid-bookings',
      detail: `No unpaid bookings to attribute payment ${credit.paymentId} against.`,
    };
  }

  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const b of unpaid) {
    if (seen.has(b.bookingId)) duplicateIds.add(b.bookingId);
    seen.add(b.bookingId);
  }
  if (duplicateIds.size > 0) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'duplicate-booking-id',
      detail: `Booking id(s) ${[...duplicateIds].join(', ')} appear more than once among this household's unpaid bookings; refusing rather than risk applying the credit to the same booking twice.`,
    };
  }

  const badDate = unpaid.find((b) => !isUsableDate(b.startDate));
  if (badDate) {
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'invalid-date',
      detail: `Booking ${badDate.bookingId} has an unreadable start date ("${badDate.startDate}"); refusing rather than sort against an undefined distance.`,
    };
  }

  // Order by date proximity to the credit, nearest first. Ties are left in place here — grouping
  // and refusing an unresolved tie happens explicitly below, not by however `sort` happens to
  // order equal elements.
  const ordered = [...unpaid].sort(
    (a, b) => dayDistance(a.startDate, credit.paidDate) - dayDistance(b.startDate, credit.paidDate),
  );

  let remaining = credit.amount;
  const splits: Split[] = [];
  let i = 0;

  while (i < ordered.length && remaining > 0) {
    // Collect every booking tied with ordered[i] for "nearest" — a contiguous run in sorted
    // order, since equal distances sort adjacent to each other.
    const distance = dayDistance(ordered[i].startDate, credit.paidDate);
    let j = i;
    while (
      j + 1 < ordered.length &&
      dayDistance(ordered[j + 1].startDate, credit.paidDate) === distance
    ) {
      j++;
    }
    const group = ordered.slice(i, j + 1);

    if (group.length === 1) {
      const booking = group[0];
      const take = Math.min(remaining, booking.outstanding);
      splits.push({ bookingId: booking.bookingId, amount: take });
      remaining -= take;
      i = j + 1;
      continue;
    }

    // A genuine tie among two or more bookings. If the credit can't even fully fund the cheapest
    // of them, there is nothing to decide between them — the choice is moot, so the rest simply
    // becomes remainder rather than dribbling an arbitrary partial amount to one of them by
    // array order.
    const smallestOutstanding = Math.min(...group.map((b) => b.outstanding));
    if (remaining < smallestOutstanding) {
      // Deliberate: stop here rather than reaching past this unaffordable tied group to fund a
      // farther, cheaper, unambiguous booking later in `ordered`. Skipping ahead would be a
      // judgment call about which stay the sitter meant to settle — nearest-first order is a
      // promise this function keeps, not a suggestion it route around when the front of the line
      // gets stuck. The unspent amount is reported as `remainder`, not lost.
      break;
    }

    const totalOutstanding = group.reduce((sum, b) => sum + b.outstanding, 0);
    if (remaining >= totalOutstanding) {
      // Every tied booking gets paid in full — again nothing to choose between them.
      for (const booking of group) {
        splits.push({ bookingId: booking.bookingId, amount: booking.outstanding });
        remaining -= booking.outstanding;
      }
      i = j + 1;
      continue;
    }

    // The credit can fully fund at least one tied booking but not all of them: which one(s) is
    // the sitter's call, not ours.
    return {
      ok: false,
      paymentId: credit.paymentId,
      reason: 'ambiguous',
      detail:
        `Payment ${credit.paymentId} is equidistant from bookings ${group.map((b) => b.bookingId).join(', ')}, ` +
        `and does not cover all of them — choose which to attribute it to.`,
    };
  }

  return { ok: true, paymentId: credit.paymentId, splits, remainder: remaining };
}
