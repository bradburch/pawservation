import { describe, expect, it } from 'vitest';
import { balancedRemainder, sitterPicksFirst } from '../../src/shared/index.js';

/**
 * THE PANEL'S OWN "does not sum to the credit must not be submittable" GUARD (Task 5 of payment
 * attribution) — the client-side mirror of the conservation check `proposeAttribution`
 * (server/lib/payment-attribution.ts) enforces server-side. Pure: given the whole-dollar splits a
 * sitter has typed or accepted against one credit, either hand back the remainder that would stay
 * as account credit, or refuse with `null` — never a rounded or invented number. This is what
 * lets `AttributionPanel.tsx` say so INLINE instead of letting a bad edit round-trip to the server
 * only to come back in `skipped`.
 */
describe('balancedRemainder', () => {
  it('splits that exactly consume the credit leave a zero remainder', () => {
    expect(balancedRemainder(160, [{ amount: 100 }, { amount: 60 }])).toBe(0);
  });

  it('splits that undershoot the credit leave the rest as remainder', () => {
    expect(balancedRemainder(200, [{ amount: 100 }, { amount: 60 }])).toBe(40);
  });

  it('no splits at all leaves the whole credit as remainder', () => {
    expect(balancedRemainder(75, [])).toBe(75);
  });

  it('splits that overshoot the credit are refused, not clamped or negative', () => {
    expect(balancedRemainder(100, [{ amount: 60 }, { amount: 60 }])).toBeNull();
  });

  it('a fractional split is refused — never rounded', () => {
    expect(balancedRemainder(100, [{ amount: 50.5 }])).toBeNull();
  });

  it('a zero or negative split is refused — an included row must be a real amount', () => {
    expect(balancedRemainder(100, [{ amount: 0 }])).toBeNull();
    expect(balancedRemainder(100, [{ amount: -10 }])).toBeNull();
  });

  it('a non-whole-dollar or negative credit amount is refused outright', () => {
    expect(balancedRemainder(99.5, [{ amount: 50 }])).toBeNull();
    expect(balancedRemainder(-5, [])).toBeNull();
  });
});

/**
 * Send ORDER is a decision about which credit gets recorded, not a cosmetic detail: the apply
 * route processes attributions in order and each re-reads live state, so when two approved credits
 * name the same stay the first one wins outright and the second is refused for overpaying. The
 * booking then carries the winner's own PaidDate, Method and Note.
 *
 * The panel pre-ticks the preview's automatic proposals, so without this the sitter would
 * have to untick a box she never ticked just to make her own correction count.
 */
describe('sitterPicksFirst', () => {
  const proposed = (paymentId: string) => ({ paymentId, serverRemainder: 0 });
  const chosen = (paymentId: string) => ({ paymentId, serverRemainder: null });

  it("puts the sitter's own picks ahead of the preview's proposals", () => {
    const ordered = sitterPicksFirst([proposed('a'), chosen('b'), proposed('c'), chosen('d')]);
    expect(ordered.map((c) => c.paymentId)).toEqual(['b', 'd', 'a', 'c']);
  });

  it("is stable within each group, so the preview's own order survives", () => {
    const ordered = sitterPicksFirst([proposed('a'), proposed('b'), chosen('c'), proposed('d')]);
    expect(ordered.map((c) => c.paymentId)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('treats a zero remainder as proposed, not as absent', () => {
    // `serverRemainder: 0` is a real server figure — a credit consumed exactly. Only `null` means
    // "the server proposed nothing for this one", which is what marks the sitter's own pick.
    expect(sitterPicksFirst([proposed('a'), chosen('b')]).map((c) => c.paymentId)).toEqual([
      'b',
      'a',
    ]);
  });

  it('does not mutate its input', () => {
    const input = [proposed('a'), chosen('b')];
    sitterPicksFirst(input);
    expect(input.map((c) => c.paymentId)).toEqual(['a', 'b']);
  });
});
