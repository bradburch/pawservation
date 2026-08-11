import { describe, expect, it } from 'vitest';
import { balancedRemainder } from '../../src/shared/index.js';

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
