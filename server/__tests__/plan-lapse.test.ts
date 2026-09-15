import { describe, expect, it } from 'vitest';
import { isPlanCurrent, isPremiumActive, isSoloActive, premiumNow } from '../lib/premium';
import type { Tenant } from '../types';

/**
 * "DOES THIS BUSINESS HOLD A CURRENT PLAN?" — the third one-expression predicate, and the one the
 * lapse gate refuses on (Story 10.4).
 *
 * THREE GRANTS, OR-ed, and `PremiumUntil` is in the list rather than being decoration. A business
 * comped on the PAID tier but holding no subscription is `isPremiumActive === true` and
 * `isSoloActive === false`. If the gate were `!isSoloActive` alone, her paid assistant would hold
 * write access — through her own forwarded credential — to a dashboard this product had just made
 * read-only. Folding `PremiumUntil` in is what stops two products disagreeing about whether she may
 * write, and it is why the predicate is TIER-BLIND: the thing that lapsed is the plan, not a tier.
 *
 * Dates are a MINUTE either side of now rather than a second: nothing here is sensitive to how far
 * away the boundary is, only to which side of it a stored instant falls, and a one-second margin
 * turns a slow machine into a flaky test. The exact `>` boundary is probed separately by seeding
 * `premiumNow()` itself, which cannot flake in the other direction — a stamp equal to now only gets
 * further into the past while the test runs.
 */

const minutesFromNow = (minutes: number): string =>
  premiumNow(new Date(Date.now() + minutes * 60_000));

/** The four columns entitlement is decided from, with everything absent by default. Built as a
 *  `Tenant`-shaped `Pick` rather than a cast so a sixth grant added later fails to compile here. */
const facts = (over: Partial<Tenant> = {}) => ({
  DisabledAt: null,
  PremiumUntil: null,
  Plan: null,
  BilledUntil: null,
  CompedUntil: null,
  ...over,
});

describe('isPlanCurrent — each grant alone makes her current', () => {
  it('is current on a live BilledUntil, whichever tier it is', () => {
    expect(isPlanCurrent(facts({ Plan: 'solo', BilledUntil: minutesFromNow(60) }))).toBe(true);
    expect(isPlanCurrent(facts({ Plan: 'pro', BilledUntil: minutesFromNow(60) }))).toBe(true);
  });

  it('is current on a live CompedUntil with no subscription at all', () => {
    const comped = facts({ CompedUntil: minutesFromNow(60) });
    expect(isPlanCurrent(comped)).toBe(true);
    // And she is NOT paying, which is the state the owner console creates and the panel must still
    // offer Subscribe to. Two predicates answering two questions.
    expect(isSoloActive(comped)).toBe(false);
  });

  it('is current on a live PremiumUntil alone, which is why the gate is tier-blind', () => {
    // The business comped on the PAID tier. `isSoloActive` says false for her, so a gate written as
    // its negation would have made her dashboard read-only while her paid assistant kept writing to
    // it through her own credential.
    const premium = facts({ PremiumUntil: minutesFromNow(60) });
    expect(isPremiumActive(premium)).toBe(true);
    expect(isSoloActive(premium)).toBe(false);
    expect(isPlanCurrent(premium)).toBe(true);
  });

  it('is not current on three nulls, nor on three past instants', () => {
    // Three nulls is every row in the book on the day 0018 is applied, which is exactly why the
    // enforcement ships behind a deployment var and the owner sweeps first.
    expect(isPlanCurrent(facts())).toBe(false);
    expect(
      isPlanCurrent(
        facts({
          Plan: 'pro',
          BilledUntil: minutesFromNow(-60),
          CompedUntil: minutesFromNow(-60),
          PremiumUntil: minutesFromNow(-60),
        }),
      ),
    ).toBe(false);
  });

  it('follows a strict > across the boundary, including the instant itself', () => {
    expect(isPlanCurrent(facts({ CompedUntil: minutesFromNow(1) }))).toBe(true);
    expect(isPlanCurrent(facts({ CompedUntil: minutesFromNow(-1) }))).toBe(false);
    // "Comped through this very instant" is not current, and by the time this line runs the stamp
    // is already in the past — so this is the assertion that can be made about the boundary without
    // racing the clock in the flaky direction.
    expect(isPlanCurrent(facts({ CompedUntil: premiumNow() }))).toBe(false);
  });

  it('is never current for a disabled business, however far ahead all three dates are', () => {
    // The shared early return, which is what makes the ordering claim true by construction: a
    // disabled business is refused 403 account_disabled by tenantMiddleware long before the lapse
    // gate runs, and this predicate says false for her anyway, so the two can never contradict.
    const off = facts({
      DisabledAt: '2026-07-23 00:00:00',
      Plan: 'pro',
      BilledUntil: minutesFromNow(60 * 24 * 365),
      CompedUntil: minutesFromNow(60 * 24 * 365),
      PremiumUntil: minutesFromNow(60 * 24 * 365),
    });
    expect(isPlanCurrent(off)).toBe(false);
  });
});

describe('a comp and a subscription do not interfere — the story’s own AC', () => {
  it('keeps a LONGER comp standing across a cancellation, a renewal and a redelivery', () => {
    // The columns are separate and billing names neither comp column, so "survives" is a property
    // of the schema rather than of a sequence. Asserted as a sequence anyway, because that is the
    // claim the AC makes and a structural guarantee nobody checked is a guarantee nobody has.
    const comp = minutesFromNow(60 * 24 * 400);
    const premium = minutesFromNow(60 * 24 * 500);
    const sequence = [
      minutesFromNow(60), // a renewal, paid ahead
      minutesFromNow(-60), // a cancellation, lowering the date
      minutesFromNow(-60), // the same event redelivered
    ];
    for (const billedUntil of sequence) {
      const row = facts({ Plan: 'solo', BilledUntil: billedUntil, CompedUntil: comp });
      expect(isPlanCurrent(row)).toBe(true);
      // Byte-identical throughout: nothing in this rule reads or rewrites either comp.
      expect(row.CompedUntil).toBe(comp);
      const withPremium = facts({ Plan: 'pro', BilledUntil: billedUntil, PremiumUntil: premium });
      expect(isPlanCurrent(withPremium)).toBe(true);
      expect(withPremium.PremiumUntil).toBe(premium);
    }
  });

  it('lets an EARLIER comp take nothing away from a paying business', () => {
    // The rule is a MAXIMUM, not a precedence. This is the clause that can only be proven where
    // both are real dated columns: a comp that ran out last March is not a reason to refuse a
    // business who is paid up through next month.
    const row = facts({
      Plan: 'pro',
      BilledUntil: minutesFromNow(60 * 24 * 30),
      CompedUntil: minutesFromNow(-60 * 24 * 180),
      PremiumUntil: minutesFromNow(-60 * 24 * 180),
    });
    expect(isPlanCurrent(row)).toBe(true);
  });
});
