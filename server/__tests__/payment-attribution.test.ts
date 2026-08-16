import { describe, expect, it } from 'vitest';
import {
  MAX_LATE_PAYMENT_DAYS,
  MAX_PREPAYMENT_DAYS,
  MAX_SPILL_DAYS,
  nearestCandidateDistance,
  proposeAttribution,
} from '../lib/payment-attribution';
import type { UnpaidBooking } from '../lib/payment-attribution';
import { addDays } from '../../src/shared/index.js';

const credit = (amount: number, paidDate = '2026-07-10') => ({ paymentId: 'p1', amount, paidDate });
/** A SINGLE-DAY service — `BookingRequests.EndDate` is NULL, the shape a walk or drop-in has.
 *  Every test written before proximity became an interval uses this, and none of their numbers
 *  may move: a null end date must still measure from `startDate` alone. */
const bk = (bookingId: string, startDate: string, outstanding: number): UnpaidBooking => ({
  bookingId,
  startDate,
  endDate: null,
  outstanding,
});
/** A RANGE-shaped stay — boarding or house sitting, `EndDate` set (exclusive checkout). */
const stay = (
  bookingId: string,
  startDate: string,
  endDate: string,
  outstanding: number,
): UnpaidBooking => ({ bookingId, startDate, endDate, outstanding });

describe('proposeAttribution', () => {
  it('fills the nearest booking first', () => {
    const out = proposeAttribution(credit(40), [
      bk('b_far', '2026-01-01', 40),
      bk('b_near', '2026-07-09', 40),
    ]);
    expect(out).toEqual({
      ok: true,
      paymentId: 'p1',
      splits: [{ bookingId: 'b_near', amount: 40 }],
      remainder: 0,
    });
  });

  it('splits one payment across several bookings, stopping at the first it cannot settle', () => {
    // $100 settles b1 and b2 outright. The $20 left cannot finish b3, and a spill that only
    // part-pays a stay is the fiction the spill rule exists to refuse (see its own describe
    // below) — so b3 gets nothing and the $20 is reported as remainder.
    const out = proposeAttribution(credit(100), [
      bk('b1', '2026-07-09', 40),
      bk('b2', '2026-07-11', 40),
      bk('b3', '2026-07-20', 40),
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.splits).toEqual([
      { bookingId: 'b1', amount: 40 },
      { bookingId: 'b2', amount: 40 },
    ]);
    expect(out.remainder).toBe(20);
  });

  it('leaves the excess as account credit', () => {
    const out = proposeAttribution(credit(100), [bk('b1', '2026-07-09', 40)]);
    expect(out.ok && out.splits).toEqual([{ bookingId: 'b1', amount: 40 }]);
    expect(out.ok && out.remainder).toBe(60);
  });

  it('conserves the amount in every case', () => {
    for (const amount of [1, 39, 40, 41, 1000]) {
      const out = proposeAttribution(credit(amount), [
        bk('b1', '2026-07-09', 40),
        bk('b2', '2026-07-12', 25),
      ]);
      // This pair of bookings is never tied (distances 1 and 2 from '2026-07-10'), so every one
      // of these amounts must resolve — asserting `ok` per iteration is stronger than "at least
      // one resolved" and would catch an implementation that always refused.
      expect(out.ok).toBe(true);
      if (!out.ok) continue;
      const total = out.splits.reduce((sum, s) => sum + s.amount, 0) + out.remainder;
      expect(total).toBe(amount);
    }
  });

  it('REFUSES a tie it cannot cover rather than picking by id order', () => {
    // Both one day BEFORE the payment — same distance, same side of it, so proximity genuinely
    // cannot separate them. $40 covers exactly one — choosing is the sitter's call, not ours.
    const out = proposeAttribution(credit(40), [
      bk('b_tied_a', '2026-07-09', 40),
      bk('b_tied_b', '2026-07-09', 40),
    ]);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('ambiguous');
    expect(out.ok === false && out.detail).toContain('b_tied_a');
    expect(out.ok === false && out.detail).toContain('b_tied_b');
  });

  it('reports a household with nothing unpaid', () => {
    expect(proposeAttribution(credit(40), [])).toMatchObject({
      ok: false,
      reason: 'no-unpaid-bookings',
    });
    expect(proposeAttribution(credit(40), [bk('b1', '2026-07-09', 0)])).toMatchObject({
      ok: false,
      reason: 'no-unpaid-bookings',
    });
  });

  it('ignores bookings already fully paid off (outstanding 0) when picking the nearest unpaid one', () => {
    const out = proposeAttribution(credit(40), [
      bk('b_paid', '2026-07-10', 0),
      bk('b_owed', '2026-07-01', 40),
    ]);
    expect(out).toEqual({
      ok: true,
      paymentId: 'p1',
      splits: [{ bookingId: 'b_owed', amount: 40 }],
      remainder: 0,
    });
  });

  it('does NOT flag a tie as ambiguous when the credit covers both tied bookings in full', () => {
    // Both exactly 1 day before the payment, but $80 is enough to fully cover both — nothing to
    // choose between.
    const out = proposeAttribution(credit(80), [
      bk('b_tied_a', '2026-07-09', 40),
      bk('b_tied_b', '2026-07-09', 40),
    ]);
    expect(out).toEqual({
      ok: true,
      paymentId: 'p1',
      splits: [
        { bookingId: 'b_tied_a', amount: 40 },
        { bookingId: 'b_tied_b', amount: 40 },
      ],
      remainder: 0,
    });
  });

  it('refuses a tie even when the tied bookings have different outstanding amounts', () => {
    const out = proposeAttribution(credit(10), [
      bk('b_small', '2026-07-09', 100),
      bk('b_big', '2026-07-09', 5),
    ]);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('ambiguous');
    expect(out.ok === false && out.detail).toContain('b_small');
    expect(out.ok === false && out.detail).toContain('b_big');
  });

  it('a booking on the exact paid date is unambiguously nearest when every other booking is farther', () => {
    const out = proposeAttribution(credit(10), [
      bk('b_exact', '2026-07-10', 10),
      bk('b_close', '2026-07-11', 10),
      bk('b_far', '2026-08-01', 10),
    ]);
    expect(out).toEqual({
      ok: true,
      paymentId: 'p1',
      splits: [{ bookingId: 'b_exact', amount: 10 }],
      remainder: 0,
    });
  });

  describe('fix round 1: dates, amounts, and duplicate ids never silently move money', () => {
    it('refuses an unparseable booking startDate instead of letting array order decide', () => {
      const forward = proposeAttribution(credit(40), [
        bk('bad', 'not-a-date', 40),
        bk('good', '2026-07-09', 40),
      ]);
      const backward = proposeAttribution(credit(40), [
        bk('good', '2026-07-09', 40),
        bk('bad', 'not-a-date', 40),
      ]);
      // Same refusal regardless of array order — the old bug paid 'bad' in full and flipped who
      // got paid when the array order flipped.
      expect(forward).toEqual(backward);
      expect(forward.ok).toBe(false);
      expect(forward.ok === false && forward.reason).toBe('invalid-date');
      expect(forward.ok === false && forward.detail).toContain('bad');
    });

    it('refuses an impossible calendar date (Feb 30) the same way as outright garbage', () => {
      const out = proposeAttribution(credit(40), [bk('b1', '2026-02-30', 40)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-date');
      expect(out.ok === false && out.detail).toContain('b1');
    });

    it('refuses an unreadable credit.paidDate', () => {
      const out = proposeAttribution(credit(40, 'not-a-date'), [bk('b1', '2026-07-09', 40)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-date');
      expect(out.ok === false && out.detail).toContain('p1');
    });

    it('still detects a same-day tie when paidDate carries a time-of-day suffix', () => {
      // Before the fix, a T-suffixed paidDate made every distance fractional, so no two
      // distances were ever exactly equal and this tie went undetected — the credit was paid in
      // full to whichever booking sorted first.
      const out = proposeAttribution(credit(40, '2026-07-10T12:00:00Z'), [
        bk('b_tied_a', '2026-07-09', 40),
        bk('b_tied_b', '2026-07-09', 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      expect(out.ok === false && out.detail).toContain('b_tied_a');
      expect(out.ok === false && out.detail).toContain('b_tied_b');
    });

    it('a T-suffixed paidDate still resolves cleanly against a non-tied booking', () => {
      const out = proposeAttribution(credit(40, '2026-07-10T23:59:59Z'), [
        bk('b1', '2026-07-09', 40),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b1', amount: 40 }],
        remainder: 0,
      });
    });

    it('refuses two unpaid bookings that share a bookingId rather than double-applying the credit', () => {
      const out = proposeAttribution(credit(80), [
        bk('dup', '2026-07-09', 40),
        bk('dup', '2026-07-11', 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('duplicate-booking-id');
      expect(out.ok === false && out.detail).toContain('dup');
    });

    it('refuses a non-integer (fractional) outstanding balance', () => {
      const out = proposeAttribution(credit(10), [bk('b1', '2026-07-09', 40.5)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-amount');
      expect(out.ok === false && out.detail).toContain('b1');
    });

    it('refuses a non-integer (fractional) credit amount', () => {
      const out = proposeAttribution(credit(40.25), [bk('b1', '2026-07-09', 40)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-amount');
    });

    it('refuses a NaN credit amount rather than propagating NaN into remainder', () => {
      const out = proposeAttribution(credit(NaN), [bk('b1', '2026-07-09', 40)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-amount');
    });

    it('refuses a negative credit amount rather than producing a negative account credit', () => {
      const out = proposeAttribution(credit(-50), [bk('b1', '2026-07-09', 40)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-amount');
    });

    it('a zero-amount credit resolves cleanly to no splits and no remainder', () => {
      const out = proposeAttribution(credit(0), [bk('b1', '2026-07-09', 40)]);
      expect(out).toEqual({ ok: true, paymentId: 'p1', splits: [], remainder: 0 });
    });

    it('names every member of a 3-way tie the credit cannot fully cover', () => {
      // Single-letter ids ('a', 'b', 'c') would pass this assertion against the refusal prose
      // itself ("...bookings...", "...cover...") even if nobody were actually named — distinctive
      // ids make the assertion discriminate.
      const out = proposeAttribution(credit(50), [
        bk('bk_alpha', '2026-07-09', 40),
        bk('bk_bravo', '2026-07-09', 40),
        bk('bk_charlie', '2026-07-09', 40),
      ]);
      // All three start the same day, one day before the payment — same distance, same side, so
      // all three tie.
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      expect(out.ok === false && out.detail).toContain('bk_alpha');
      expect(out.ok === false && out.detail).toContain('bk_bravo');
      expect(out.ok === false && out.detail).toContain('bk_charlie');
    });

    it('names every member of a 4-way tie the credit cannot fully cover', () => {
      const out = proposeAttribution(credit(100), [
        bk('bk_whiskey', '2026-07-09', 40),
        bk('bk_xray', '2026-07-09', 40),
        bk('bk_yankee', '2026-07-09', 40),
        bk('bk_zulu', '2026-07-09', 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      for (const id of ['bk_whiskey', 'bk_xray', 'bk_yankee', 'bk_zulu']) {
        expect(out.ok === false && out.detail).toContain(id);
      }
    });

    it('does not refuse a tie the credit could never have reached, and still keeps the unambiguous split it already made', () => {
      // N is uniquely nearest (same day) and gets paid in full first. What's left ($1) can't
      // fully fund either A or B (both $40, both starting the day before the payment, so tied) —
      // nothing to decide between them, so it becomes remainder instead of voiding the whole
      // proposal.
      const out = proposeAttribution(credit(31), [
        bk('N', '2026-07-10', 30),
        bk('A', '2026-07-09', 40),
        bk('B', '2026-07-09', 40),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'N', amount: 30 }],
        remainder: 1,
      });
    });
  });

  describe('fix round 2: an unreadable outstanding is refused, never silently dropped', () => {
    it('refuses a NaN outstanding rather than silently excluding it and paying a farther booking instead', () => {
      // Before the fix, `outstanding > 0` filtered this out before the integer guard ever ran
      // (NaN > 0 is false), so the credit went in full to the farther booking with ok: true.
      const out = proposeAttribution(credit(40), [
        bk('near', '2026-07-09', NaN),
        bk('far', '2026-08-01', 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-amount');
      expect(out.ok === false && out.detail).toContain('near');
    });

    it('refuses a negative outstanding rather than treating it the same as fully paid', () => {
      const out = proposeAttribution(credit(40), [
        bk('b1', '2026-07-09', -50),
        bk('b2', '2026-08-01', 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-amount');
      expect(out.ok === false && out.detail).toContain('b1');
    });

    it('refuses an all-unreadable booking list rather than reporting the household as settled', () => {
      // Before the fix this reported `no-unpaid-bookings` — telling the sitter their household
      // is settled when in fact none of the outstanding amounts could be read at all.
      const out = proposeAttribution(credit(40), [
        bk('b1', '2026-07-09', NaN),
        bk('b2', '2026-08-01', NaN),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-amount');
    });

    it('a distant unaffordable tie leaves a farther, unambiguous, fully-fundable booking unpaid (deliberate)', () => {
      // A and B tie at 1 day before the payment and together cost more than the credit; C is
      // farther (10 days) but alone costs exactly what's left over. This function does not reach
      // past the nearer, stuck tie to fund C — that would be a guess about which stay the sitter
      // meant to settle.
      const out = proposeAttribution(credit(30), [
        bk('A', '2026-07-09', 40),
        bk('B', '2026-07-09', 40),
        bk('C', '2026-07-20', 30),
      ]);
      expect(out).toEqual({ ok: true, paymentId: 'p1', splits: [], remainder: 30 });
    });
  });

  /**
   * THE STALENESS FLOOR. Proximity is the only matching rule this function has, so it only means
   * something while the candidates are actually near: a dry run over the live `brad-paws` tenant
   * put 52 of 77 proposed splits ($1,895 of $2,640) more than eighteen months from the stay they
   * were proposed against, ordered purely by which of two equally meaningless distances was
   * smaller. These assert that a credit with no candidate inside its proximity windows
   * (`MAX_LATE_PAYMENT_DAYS` behind the payment, `MAX_PREPAYMENT_DAYS` ahead of it) is REFUSED and
   * reported, never placed — and, just as importantly, that a credit which does have a near
   * candidate is still placed on it exactly as before.
   */
  describe('the staleness floor: no candidate near enough is a refusal, not a proposal', () => {
    it('REFUSES a credit whose nearest unpaid stay is far beyond the floor, naming the gap and that stay', () => {
      const nearest = addDays('2026-07-10', -200);
      const out = proposeAttribution(credit(42), [
        bk('bk_ancient', addDays('2026-07-10', -600), 40),
        bk('bk_nearest', nearest, 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('no-recent-booking');
      // The sitter has to be able to see WHY, which means the actual distance and the actual stay
      // — not a generic "too far".
      expect(out.ok === false && out.detail).toContain('200');
      expect(out.ok === false && out.detail).toContain(nearest);
    });

    it('places a credit on the one candidate inside the floor and leaves the excess as remainder', () => {
      // The floor filters CANDIDATES; it does not refuse a credit that has a good match merely
      // because it also has money left over. The $60 excess must NOT dribble onto a stay 400 days
      // away, and the whole credit must not be refused either.
      const out = proposeAttribution(credit(100), [
        bk('b_near', '2026-07-09', 40),
        bk('b_far', addDays('2026-07-10', 400), 60),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_near', amount: 40 }],
        remainder: 60,
      });
    });

    it('accepts a stay exactly MAX_LATE_PAYMENT_DAYS BEFORE the payment and refuses one a day earlier', () => {
      // The generous direction: the stay already happened and the money is settling it late.
      const atFloor = addDays('2026-07-10', -MAX_LATE_PAYMENT_DAYS);
      const beyondFloor = addDays('2026-07-10', -(MAX_LATE_PAYMENT_DAYS + 1));

      expect(proposeAttribution(credit(40), [bk('b_at', atFloor, 40)])).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_at', amount: 40 }],
        remainder: 0,
      });

      const beyond = proposeAttribution(credit(40), [bk('b_beyond', beyondFloor, 40)]);
      expect(beyond.ok).toBe(false);
      expect(beyond.ok === false && beyond.reason).toBe('no-recent-booking');
    });

    it('accepts a stay exactly MAX_PREPAYMENT_DAYS AFTER the payment and refuses one a day later', () => {
      // The tight direction: money ahead of a stay is a deposit on something imminent, and the
      // window says how imminent. Sharing a ceiling with the late-payment window would let a
      // payment a quarter ahead of a walk read as prepaying it.
      const atFloor = addDays('2026-07-10', MAX_PREPAYMENT_DAYS);
      const beyondFloor = addDays('2026-07-10', MAX_PREPAYMENT_DAYS + 1);

      expect(proposeAttribution(credit(40), [bk('b_at', atFloor, 40)])).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_at', amount: 40 }],
        remainder: 0,
      });

      const beyond = proposeAttribution(credit(40), [bk('b_beyond', beyondFloor, 40)]);
      expect(beyond.ok).toBe(false);
      expect(beyond.ok === false && beyond.reason).toBe('no-recent-booking');
    });

    it('a stay ON the paid date is inside the window from the PAST side, never the prepayment one', () => {
      // Same-day is settlement — the strongest match there is. It must not be classified as a
      // stay still to come, which is what a `>=` in the direction test would do.
      expect(MAX_PREPAYMENT_DAYS).toBeLessThan(MAX_LATE_PAYMENT_DAYS);
      expect(proposeAttribution(credit(40), [bk('b_same_day', '2026-07-10', 40)])).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_same_day', amount: 40 }],
        remainder: 0,
      });
    });

    it('still reports no-unpaid-bookings, not the floor, for a household with nothing outstanding', () => {
      // Order of refusals matters: "this household is settled" and "nothing is near enough" are
      // different facts and the sitter acts on them differently. The settled one wins.
      const out = proposeAttribution(credit(40), [bk('b_far_paid', addDays('2026-07-10', 500), 0)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('no-unpaid-bookings');
    });

    it('still reports the data faults, not the floor, when a distant booking is also unreadable', () => {
      // The floor cannot run before the dates and amounts are known good — a distance off an
      // unparseable date is `NaN`, which compares false against any ceiling.
      const badDate = proposeAttribution(credit(40), [
        bk('b_far', addDays('2026-07-10', 500), 40),
        bk('b_broken', 'not-a-date', 40),
      ]);
      expect(badDate.ok === false && badDate.reason).toBe('invalid-date');

      const badAmount = proposeAttribution(credit(40), [
        bk('b_far', addDays('2026-07-10', 500), 40),
        bk('b_broken', addDays('2026-07-10', 501), 40.5),
      ]);
      expect(badAmount.ok === false && badAmount.reason).toBe('invalid-amount');
    });

    it('leaves the tie refusal exactly as it was when both tied stays are inside the floor', () => {
      // The floor is an ADDITIONAL refusal, never a relaxation of an existing one: a tie inside
      // the floor is still the sitter's call, and a far third candidate does not change that.
      const out = proposeAttribution(credit(40), [
        bk('b_tied_a', '2026-07-09', 40),
        bk('b_tied_b', '2026-07-09', 40),
        bk('b_far', addDays('2026-07-10', 400), 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      expect(out.ok === false && out.detail).toContain('b_tied_a');
      expect(out.ok === false && out.detail).toContain('b_tied_b');
      // The far booking was filtered out before ordering, so it is not one of the tied names.
      expect(out.ok === false && out.detail).not.toContain('b_far');
    });
  });

  /**
   * DIRECTIONAL PROXIMITY. A payment settles services that have ALREADY HAPPENED, so proximity
   * is asymmetric: a stay a week in the past is the obvious candidate for a payment, and a stay
   * a week in the future has not been delivered yet. The sitter said it plainly — *"someone may
   * forget to pay one week and then send 2 weeks in one payment"* — and the symmetric rule could
   * not express it: it ranked the forgotten week and the undelivered one exactly equal, and
   * reported the pair as an ambiguous tie.
   */
  describe('directional proximity: a payment settles stays that have already happened', () => {
    it("THE SITTER'S CASE: forgot a week, sent double — splits onto both stays, nearest first", () => {
      // Two $25 walks, 07-13 (the week they forgot) and 07-20. One $50 payment on 07-20.
      const out = proposeAttribution(credit(50, '2026-07-20'), [
        bk('b_forgotten', '2026-07-13', 25),
        bk('b_this_week', '2026-07-20', 25),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [
          { bookingId: 'b_this_week', amount: 25 },
          { bookingId: 'b_forgotten', amount: 25 },
        ],
        remainder: 0,
      });
    });

    it('prefers the stay in the PAST over one the same distance in the future, and reports no tie', () => {
      // 07-13 and 07-27 are both 7 days from a 07-20 payment; $25 covers exactly one of them.
      // Under the symmetric rule this was an ambiguous tie. It is not ambiguous at all: 07-27
      // has not happened yet.
      const out = proposeAttribution(credit(25, '2026-07-20'), [
        bk('b_past', '2026-07-13', 25),
        bk('b_future', '2026-07-27', 25),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_past', amount: 25 }],
        remainder: 0,
      });
    });

    it('orders a whole run of stays past-first, then future, each nearest-first', () => {
      // Distances from 07-20: p1 = 1 day past, p2 = 10 days past, f1 = 1 day future.
      // Direction outranks distance, so the 10-day-old stay is funded before the 1-day-future
      // one — an ordering the absolute-distance sort could never produce.
      const out = proposeAttribution(credit(75, '2026-07-20'), [
        bk('b_future_1', '2026-07-21', 25),
        bk('b_past_1', '2026-07-19', 25),
        bk('b_past_10', '2026-07-10', 25),
      ]);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.splits).toEqual([
        { bookingId: 'b_past_1', amount: 25 },
        { bookingId: 'b_past_10', amount: 25 },
        { bookingId: 'b_future_1', amount: 25 },
      ]);
      expect(out.remainder).toBe(0);
    });

    it('STILL refuses two equally-past stays as a tie — direction narrows ties, it does not remove them', () => {
      const out = proposeAttribution(credit(25, '2026-07-20'), [
        bk('b_past_a', '2026-07-13', 25),
        bk('b_past_b', '2026-07-13', 25),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      expect(out.ok === false && out.detail).toContain('b_past_a');
      expect(out.ok === false && out.detail).toContain('b_past_b');
    });

    it('still refuses two equally-FUTURE stays as a tie, when nothing in the past outranks them', () => {
      const out = proposeAttribution(credit(25, '2026-07-20'), [
        bk('b_future_a', '2026-07-27', 25),
        bk('b_future_b', '2026-07-27', 25),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      expect(out.ok === false && out.detail).toContain('b_future_a');
      expect(out.ok === false && out.detail).toContain('b_future_b');
    });

    it('THE ASYMMETRY ITSELF: a stay 60 days AFTER is refused at a distance a stay 60 days BEFORE is accepted at', () => {
      // The single statement of why this change exists. 60 days is inside the late-payment
      // window and outside the prepayment one, so the same distance resolves differently
      // depending only on which side of the payment the stay falls.
      const before = proposeAttribution(credit(40, '2026-07-20'), [
        bk('b_before', addDays('2026-07-20', -60), 40),
      ]);
      expect(before).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_before', amount: 40 }],
        remainder: 0,
      });

      const after = proposeAttribution(credit(40, '2026-07-20'), [
        bk('b_after', addDays('2026-07-20', 60), 40),
      ]);
      expect(after.ok).toBe(false);
      expect(after.ok === false && after.reason).toBe('no-recent-booking');
    });

    it("the live tenant's shape: an April payment does not land on a July walk", () => {
      // 53 of 58 splits measured on the live tenant were payments made ~84–90 days BEFORE the
      // stay they were matched to — April/May money landing on July walks because the April/May
      // walks are not adopted yet. Under a directional rule that refuses, and the refusal is the
      // correct answer.
      const out = proposeAttribution(credit(40, '2026-04-27'), [bk('b_july', '2026-07-20', 40)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('no-recent-booking');
    });

    it('says WHICH WAY the nearest stay is off, so the sitter can see how the data is wrong', () => {
      // "84 days later" and "84 days earlier" are two different diagnoses; a direction-free
      // sentence tells the sitter neither.
      const late = proposeAttribution(credit(40, '2026-07-20'), [
        bk('b_old', addDays('2026-07-20', -200), 40),
      ]);
      expect(late.ok === false && late.detail).toContain('200 days before');

      const early = proposeAttribution(credit(40, '2026-07-20'), [
        bk('b_ahead', addDays('2026-07-20', 84), 40),
      ]);
      expect(early.ok === false && early.detail).toContain('84 days after');
    });
  });

  /**
   * WHAT A LEFTOVER MAY SPILL ONTO. Pouring the running remainder into each nearer stay in turn
   * produces the bundled payment correctly and produces a fiction just as readily: on the live
   * tenant, Kelly Snider's $50 settled that day's $40 walk and then dribbled the last $10 onto a
   * $100 boarding from twelve days earlier, covering a tenth of it. The sitter reads that stay as
   * 10% paid; what actually happened is that she was tipped $10 on a walk.
   *
   * The measured cases separate on COVERAGE, not distance: every good spill in that tenant
   * (Jenna's four walks at exactly $30, Dwayne's three at exactly $40, Asja's eleven stays each
   * covered in full) fully settles the stay it lands on, and the bad one is the only partial. So
   * the rule is full settlement for every stay after the first, with `MAX_SPILL_DAYS` as a
   * secondary bound — Kelly's bad spill is 12 days out while some of Jenna's good ones are 9, so
   * distance alone could never have told them apart.
   */
  describe('the spill rule: a leftover only lands on a stay it can settle outright', () => {
    it("KELLY'S CASE: the leftover after a same-day walk does not part-pay a boarding twelve days back", () => {
      // $50 on 07-29: $40 settles that day's pack walk, and the $10 left is a tip on the walk, not
      // a tenth of a $100 boarding from 07-17.
      const out = proposeAttribution(credit(50, '2026-07-29'), [
        bk('b_walk', '2026-07-29', 40),
        bk('b_boarding', '2026-07-17', 100),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_walk', amount: 40 }],
        remainder: 10,
      });
    });

    it("THE BUNDLED CASE STILL WORKS: Jenna's $120 settles four $30 walks inside the fortnight", () => {
      // The spill rule must not cost the case the whole feature exists for. Four walks, each
      // covered in full, nearest first, nothing left over.
      const out = proposeAttribution(credit(120, '2026-07-30'), [
        bk('b_w1', '2026-07-30', 30),
        bk('b_w2', '2026-07-27', 30),
        bk('b_w3', '2026-07-24', 30),
        bk('b_w4', '2026-07-21', 30),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [
          { bookingId: 'b_w1', amount: 30 },
          { bookingId: 'b_w2', amount: 30 },
          { bookingId: 'b_w3', amount: 30 },
          { bookingId: 'b_w4', amount: 30 },
        ],
        remainder: 0,
      });
    });

    it('A DEPOSIT STILL WORKS: the NEAREST stay may still be part-paid', () => {
      // The full-settlement rule governs stays after the first and nothing else — $60 against a
      // $150 boarding is a deposit, a real thing a sitter records, and it must keep resolving.
      const out = proposeAttribution(credit(60, '2026-07-20'), [
        bk('b_boarding', '2026-07-18', 150),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_boarding', amount: 60 }],
        remainder: 0,
      });
    });

    it('a second stay it cannot settle STOPS the spill — it does not skip ahead to a cheaper one', () => {
      // $60 settles the $50 stay a day back; $10 is left, the next candidate owes $40, and a $10
      // stay sits further away that the leftover could cover exactly. Reaching past the next
      // candidate to fund it would be a guess about which stay the sitter meant — nearest-first is
      // a promise this function keeps, the same one it keeps for an unaffordable tie.
      const out = proposeAttribution(credit(60, '2026-07-20'), [
        bk('b_near', '2026-07-19', 50),
        bk('b_next', '2026-07-15', 40),
        bk('b_cheap', '2026-07-10', 10),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_near', amount: 50 }],
        remainder: 10,
      });
    });

    it('a spill target beyond MAX_SPILL_DAYS gets nothing, even though the leftover would settle it in full', () => {
      const first = bk('b_first', '2026-07-20', 40);
      const beyond = proposeAttribution(credit(70, '2026-07-20'), [
        first,
        bk('b_spill', addDays('2026-07-20', -(MAX_SPILL_DAYS + 1)), 30),
      ]);
      expect(beyond).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_first', amount: 40 }],
        remainder: 30,
      });

      // Exactly at the bound is inside it.
      const atBound = proposeAttribution(credit(70, '2026-07-20'), [
        first,
        bk('b_spill', addDays('2026-07-20', -MAX_SPILL_DAYS), 30),
      ]);
      expect(atBound).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [
          { bookingId: 'b_first', amount: 40 },
          { bookingId: 'b_spill', amount: 30 },
        ],
        remainder: 30 - 30,
      });
    });

    it('the spill bound binds only the stays after the first — the nearest stay keeps the primary windows', () => {
      // A single stay 60 days back is well beyond MAX_SPILL_DAYS and still inside
      // MAX_LATE_PAYMENT_DAYS, and it is the first stay, so it is funded exactly as before. A
      // bound applied to the first stay would silently shrink the primary window to a fortnight.
      expect(MAX_SPILL_DAYS).toBeLessThan(MAX_PREPAYMENT_DAYS);
      expect(MAX_SPILL_DAYS).toBeLessThan(MAX_LATE_PAYMENT_DAYS);
      const out = proposeAttribution(credit(40, '2026-07-20'), [
        bk('b_old', addDays('2026-07-20', -60), 40),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_old', amount: 40 }],
        remainder: 0,
      });
    });

    it('conserves the credit exactly when the spill is refused', () => {
      // The stopped money becomes remainder; it is never dropped, and never rounded to make the
      // arithmetic close.
      for (const amount of [45, 50, 79, 140]) {
        const out = proposeAttribution(credit(amount, '2026-07-29'), [
          bk('b_walk', '2026-07-29', 40),
          bk('b_boarding', '2026-07-17', 100),
        ]);
        expect(out.ok).toBe(true);
        if (!out.ok) continue;
        expect(out.splits.reduce((sum, s) => sum + s.amount, 0) + out.remainder).toBe(amount);
      }
    });
  });

  /**
   * PROXIMITY IS MEASURED TO THE WHOLE STAY, NOT TO ITS FIRST DAY. Reported by the sitter reading
   * real proposals: *"This payment is in August. The end date is far away. Not all payments should
   * be windowed by start date — end date is also a consideration."* Her live case is a house sit
   * 2026-07-29 → 2026-08-21 (23 nights) with money sent on 2026-08-18 — made WHILE the sitter was
   * in the house, and measured by a start-date-only rule as 20 days late.
   *
   * A single-day service (`EndDate` NULL) is untouched: its interval is its start date, so every
   * number in every test above stays exactly what it was.
   */
  describe('the whole stay, not its start date', () => {
    // 2026-07-29 → 2026-08-21 exclusive checkout — the sitter's own 23-night house sit.
    const houseSit = (outstanding: number) =>
      stay('b_sit', '2026-07-29', '2026-08-21', outstanding);

    it("THE SITTER'S CASE: money sent DURING a 23-night house sit is 0 days from it, not 20", () => {
      expect(nearestCandidateDistance('2026-08-18', [houseSit(400)])).toBe(0);
      expect(proposeAttribution(credit(400, '2026-08-18'), [houseSit(400)])).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_sit', amount: 400 }],
        remainder: 0,
      });
    });

    it('money sent AFTER the stay is measured from its END date — 4 days, not 27', () => {
      expect(nearestCandidateDistance('2026-08-25', [houseSit(400)])).toBe(4);
      expect(proposeAttribution(credit(400, '2026-08-25'), [houseSit(400)]).ok).toBe(true);
    });

    it('money sent BEFORE the stay is still measured from its START date — 9 days, not 32', () => {
      // The prepayment side must NOT move to the end date: 2026-07-20 is 9 days ahead of the
      // house sit's first night and 32 ahead of its checkout, and only the first of those is
      // inside MAX_PREPAYMENT_DAYS. Measuring the near side from the far endpoint would refuse a
      // deposit the sitter obviously took.
      expect(nearestCandidateDistance('2026-07-20', [houseSit(400)])).toBe(9);
      expect(proposeAttribution(credit(400, '2026-07-20'), [houseSit(400)])).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_sit', amount: 400 }],
        remainder: 0,
      });
    });

    it('A SINGLE-DAY SERVICE IS UNCHANGED: a NULL end date still measures from the start alone', () => {
      // Same two dates as the sitter's case, against a walk instead of a stay. If a null end date
      // were read as an open-ended interval — or defaulted to anything but the start — this would
      // collapse to 0 and the whole point-shaped half of the module would be gone.
      expect(nearestCandidateDistance('2026-08-18', [bk('b_walk', '2026-07-29', 40)])).toBe(20);
      expect(nearestCandidateDistance('2026-08-25', [bk('b_walk', '2026-07-29', 40)])).toBe(27);
    });

    it('A LONG STAY NO LONGER LOSES TO A SHORT ONE: 0 days inside it beats a walk 3 days out', () => {
      // The ordering consequence, and the one that actually mis-attributes money. $40 covers
      // either candidate but not both; under a start-date-only rule the house sit measures 20
      // days and the walk 3, so the walk wins and the sitter's stay reads unpaid.
      const out = proposeAttribution(credit(40, '2026-08-18'), [
        houseSit(400),
        bk('b_walk', '2026-08-15', 40),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'b_sit', amount: 40 }],
        remainder: 0,
      });
    });

    it('the LATE window is measured from the END: 90 days past checkout is in, 91 is out', () => {
      const atFloor = addDays('2026-08-21', MAX_LATE_PAYMENT_DAYS);
      const beyond = addDays('2026-08-21', MAX_LATE_PAYMENT_DAYS + 1);
      expect(proposeAttribution(credit(400, atFloor), [houseSit(400)]).ok).toBe(true);
      const out = proposeAttribution(credit(400, beyond), [houseSit(400)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('no-recent-booking');
    });

    it('the PREPAYMENT window is measured from the START: 30 days before it is in, 31 is out', () => {
      const atFloor = addDays('2026-07-29', -MAX_PREPAYMENT_DAYS);
      const beyond = addDays('2026-07-29', -(MAX_PREPAYMENT_DAYS + 1));
      expect(proposeAttribution(credit(400, atFloor), [houseSit(400)]).ok).toBe(true);
      const out = proposeAttribution(credit(400, beyond), [houseSit(400)]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('no-recent-booking');
    });

    it('a payment inside the stay is neither late nor prepaid, and ranks with the LATE side', () => {
      // The work was under way when the money arrived, so it settles rather than anticipates. A
      // walk the same number of days AHEAD of the payment must not outrank it, exactly as a stay
      // behind the payment outranks one ahead of it today.
      const out = proposeAttribution(credit(40, '2026-08-18'), [
        houseSit(40),
        bk('b_ahead', '2026-08-18', 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      // Both are distance 0 on the same (late) side — a genuine tie, refused. Were the stay
      // classified as a prepayment it would sort second and the walk would simply win.
      expect(out.ok === false && out.detail).toContain('b_sit');
      expect(out.ok === false && out.detail).toContain('b_ahead');
    });

    it('two stays that both CONTAIN the payment date tie at 0 and are refused, not ranked by start', () => {
      // The sitter's tenant has exactly this: a house sit 07-29 → 08-21 and a boarding
      // 08-10 → 08-21, both running on 08-18. Under start-date-only they are 20 and 8 days out —
      // an ordering, and a confident wrong answer. They are both 0 days from the money.
      const out = proposeAttribution(credit(400, '2026-08-18'), [
        houseSit(400),
        stay('b_board', '2026-08-10', '2026-08-21', 300),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
    });

    it('the no-recent-booking sentence names the END date when that is what the gap was measured from', () => {
      const out = proposeAttribution(
        credit(400, addDays('2026-08-21', MAX_LATE_PAYMENT_DAYS + 1)),
        [houseSit(400)],
      );
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.detail).toContain('ends 2026-08-21');
      expect(out.ok === false && out.detail).toContain(`${MAX_LATE_PAYMENT_DAYS + 1} days before`);
      // A single-day service has no end to name, so it keeps the sentence it has today.
      const walk = proposeAttribution(credit(40, '2026-07-20'), [
        bk('b_old', addDays('2026-07-20', -200), 40),
      ]);
      expect(walk.ok === false && walk.detail).toContain('starts');
      expect(walk.ok === false && walk.detail).toContain('200 days before');
    });

    it('MAX_SPILL_DAYS is measured to the interval too, so a leftover reaches a long stay it is inside', () => {
      // The spill target's START is 20 days behind the payment — beyond MAX_SPILL_DAYS — but the
      // payment falls inside the stay, so it is 0 days from it.
      const out = proposeAttribution(credit(70, '2026-08-18'), [
        bk('b_walk', '2026-08-18', 40),
        stay('b_sit', '2026-07-29', '2026-08-21', 30),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [
          { bookingId: 'b_walk', amount: 40 },
          { bookingId: 'b_sit', amount: 30 },
        ],
        remainder: 0,
      });
    });

    it('refuses an unreadable END date rather than sorting against an undefined distance', () => {
      const out = proposeAttribution(credit(400, '2026-08-18'), [
        stay('b_broken', '2026-07-29', 'not-a-date', 400),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('invalid-date');
      expect(
        nearestCandidateDistance('2026-08-18', [stay('b_broken', '2026-07-29', 'x', 40)]),
      ).toBe(null);
    });
  });
});

/**
 * THE RANKING NUMBER — `nearestCandidateDistance` answers "how near is the nearest stay this
 * credit could actually be placed on", which is what lets the preview route decide WHICH CREDIT
 * GOES NEXT instead of falling back to oldest-paid-first (the ordering that mis-attributed every
 * stay of a client who pays on the day). It must agree with `proposeAttribution` about what counts
 * as a candidate at all, or a credit is ranked first for a match the proposer then refuses to make.
 */
describe('nearestCandidateDistance', () => {
  it('is 0 for a stay on the paid date — the strongest match there is', () => {
    expect(nearestCandidateDistance('2026-07-23', [bk('b', '2026-07-23', 40)])).toBe(0);
  });

  it('reports the NEAREST eligible stay, not the first or the largest', () => {
    expect(
      nearestCandidateDistance('2026-07-17', [
        bk('b_far', '2026-06-01', 400),
        bk('b_near', '2026-07-16', 40),
        bk('b_mid', '2026-07-01', 40),
      ]),
    ).toBe(1);
  });

  it('ignores a stay with nothing outstanding — an earlier credit already claimed it', () => {
    expect(
      nearestCandidateDistance('2026-07-23', [
        bk('b_claimed', '2026-07-23', 0),
        bk('b_open', '2026-07-16', 40),
      ]),
    ).toBe(7);
  });

  it('applies the same directional windows the proposer does, not one symmetric ceiling', () => {
    // 60 days BEHIND the payment is inside MAX_LATE_PAYMENT_DAYS; 60 days AHEAD is well past
    // MAX_PREPAYMENT_DAYS, so it is not a candidate at all and cannot rank a credit ahead of one
    // with a real match.
    expect(nearestCandidateDistance('2026-07-20', [bk('b', addDays('2026-07-20', -60), 40)])).toBe(
      60,
    );
    expect(
      nearestCandidateDistance('2026-07-20', [bk('b', addDays('2026-07-20', 60), 40)]),
    ).toBeNull();
    expect(
      nearestCandidateDistance('2026-07-20', [
        bk('b_edge', addDays('2026-07-20', MAX_PREPAYMENT_DAYS), 40),
      ]),
    ).toBe(MAX_PREPAYMENT_DAYS);
    expect(
      nearestCandidateDistance('2026-07-20', [
        bk('b_edge', addDays('2026-07-20', -MAX_LATE_PAYMENT_DAYS), 40),
      ]),
    ).toBe(MAX_LATE_PAYMENT_DAYS);
  });

  it('is null when there is nothing to rank: no bookings, none in range, or an unreadable date', () => {
    expect(nearestCandidateDistance('2026-07-23', [])).toBeNull();
    expect(nearestCandidateDistance('2026-07-23', [bk('b', '2020-01-01', 40)])).toBeNull();
    // An unreadable date is the PROPOSER's refusal to make, with its own reason and sentence —
    // here it simply means "cannot be ranked", so the credit sinks to the back of the queue and
    // gets that refusal in its turn.
    expect(nearestCandidateDistance('not-a-date', [bk('b', '2026-07-23', 40)])).toBeNull();
    expect(nearestCandidateDistance('2026-07-23', [bk('b', 'not-a-date', 40)])).toBeNull();
  });
});
