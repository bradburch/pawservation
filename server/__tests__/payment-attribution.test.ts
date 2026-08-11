import { describe, expect, it } from 'vitest';
import { proposeAttribution } from '../lib/payment-attribution';

const credit = (amount: number, paidDate = '2026-07-10') => ({ paymentId: 'p1', amount, paidDate });
const bk = (bookingId: string, startDate: string, outstanding: number) => ({
  bookingId,
  startDate,
  outstanding,
});

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

  it('splits one payment across several bookings', () => {
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
      { bookingId: 'b3', amount: 20 },
    ]);
    expect(out.remainder).toBe(0);
  });

  it('leaves the excess as account credit', () => {
    const out = proposeAttribution(credit(100), [bk('b1', '2026-07-09', 40)]);
    expect(out.ok && out.splits).toEqual([{ bookingId: 'b1', amount: 40 }]);
    expect(out.ok && out.remainder).toBe(60);
  });

  it('conserves the amount in every case', () => {
    let resolvedAtLeastOnce = false;
    for (const amount of [1, 39, 40, 41, 1000]) {
      const out = proposeAttribution(credit(amount), [
        bk('b1', '2026-07-09', 40),
        bk('b2', '2026-07-12', 25),
      ]);
      if (!out.ok) continue;
      resolvedAtLeastOnce = true;
      const total = out.splits.reduce((sum, s) => sum + s.amount, 0) + out.remainder;
      expect(total).toBe(amount);
    }
    // This pair of bookings is never tied (distances 1 and 2 from '2026-07-10'), so every one of
    // these amounts must resolve — an implementation that always refused would pass the loop
    // above vacuously without this assertion.
    expect(resolvedAtLeastOnce).toBe(true);
  });

  it('REFUSES a tie it cannot cover rather than picking by id order', () => {
    // Both one day away, on opposite sides. $40 covers exactly one of them — choosing is the
    // sitter's call, not ours.
    const out = proposeAttribution(credit(40), [
      bk('b_before', '2026-07-09', 40),
      bk('b_after', '2026-07-11', 40),
    ]);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe('ambiguous');
    expect(out.ok === false && out.detail).toContain('b_before');
    expect(out.ok === false && out.detail).toContain('b_after');
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
    // Both exactly 1 day away, but $80 is enough to fully cover both — nothing to choose between.
    const out = proposeAttribution(credit(80), [
      bk('b_before', '2026-07-09', 40),
      bk('b_after', '2026-07-11', 40),
    ]);
    expect(out).toEqual({
      ok: true,
      paymentId: 'p1',
      splits: [
        { bookingId: 'b_before', amount: 40 },
        { bookingId: 'b_after', amount: 40 },
      ],
      remainder: 0,
    });
  });

  it('refuses a tie even when the tied bookings have different outstanding amounts', () => {
    const out = proposeAttribution(credit(10), [
      bk('b_small', '2026-07-09', 100),
      bk('b_big', '2026-07-11', 5),
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
        bk('b_before', '2026-07-09', 40),
        bk('b_after', '2026-07-11', 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      expect(out.ok === false && out.detail).toContain('b_before');
      expect(out.ok === false && out.detail).toContain('b_after');
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
      const out = proposeAttribution(credit(50), [
        bk('a', '2026-07-09', 40),
        bk('b', '2026-07-11', 40),
        bk('c', '2026-07-11', 40),
      ]);
      // a and b and c: a is 1 day away (07-09), b and c are also 1 day away (07-11) — all three tie.
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      expect(out.ok === false && out.detail).toContain('a');
      expect(out.ok === false && out.detail).toContain('b');
      expect(out.ok === false && out.detail).toContain('c');
    });

    it('names every member of a 4-way tie the credit cannot fully cover', () => {
      const out = proposeAttribution(credit(100), [
        bk('w', '2026-07-11', 40),
        bk('x', '2026-07-09', 40),
        bk('y', '2026-07-11', 40),
        bk('z', '2026-07-09', 40),
      ]);
      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe('ambiguous');
      for (const id of ['w', 'x', 'y', 'z']) {
        expect(out.ok === false && out.detail).toContain(id);
      }
    });

    it('does not refuse a tie the credit could never have reached, and still keeps the unambiguous split it already made', () => {
      // N is uniquely nearest (same day) and gets paid in full first. What's left ($1) can't
      // fully fund either A or B (both $40, tied 1 day out on opposite sides) — nothing to
      // decide between them, so it becomes remainder instead of voiding the whole proposal.
      const out = proposeAttribution(credit(31), [
        bk('N', '2026-07-10', 30),
        bk('A', '2026-07-09', 40),
        bk('B', '2026-07-11', 40),
      ]);
      expect(out).toEqual({
        ok: true,
        paymentId: 'p1',
        splits: [{ bookingId: 'N', amount: 30 }],
        remainder: 1,
      });
    });
  });
});
