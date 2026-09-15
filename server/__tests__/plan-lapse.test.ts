import { describe, expect, it } from 'vitest';
import { applyBillingEvent, getTenantById } from '../db/repo';
import { isPlanCurrent, isPremiumActive, isSoloActive, premiumNow } from '../lib/premium';
import type { Tenant } from '../types';
import { createTestEnv, TENANT_A } from './helpers';

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

/** The FIVE columns plan state is decided from (`EntitlementFacts`, server/lib/premium.ts), with
 *  everything absent by default. An object literal whose overrides are checked against
 *  `Partial<Tenant>` rather than a cast, so a column renamed out from under this helper fails to
 *  compile here; a SIXTH grant would fail at the call sites instead, which is the honest limit. */
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
    // And the basic comp buys NEITHER of the other two things, which is the whole reason it is a
    // second column rather than a hand-set date on an existing one. She is not paying — the state
    // the owner console creates, and the panel must still offer her Subscribe — and she is not on
    // the PAID tier either, so nothing premium attaches to a comp of this product's own plan.
    // Three predicates answering three questions; `isPremiumActive` reads `PremiumUntil`, and a
    // later hand that widened it into this column would grant a paid surface for free.
    expect(isSoloActive(comped)).toBe(false);
    expect(isPremiumActive(comped)).toBe(false);
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
  it('keeps both comps byte-identical across a checkout, a renewal, a redelivery and a cancellation', async () => {
    // AGAINST THE WRITER, not against a literal. The claim the AC makes is that BILLING never
    // touches either comp — and the only thing that can falsify that is `applyBillingEvent`, which
    // is the one statement in the product that writes a plan. Asserted against a seeded row and a
    // real sequence of events, because a version of this case built from object literals re-read
    // the property the line above it had just set: it could not fail, whatever the writer did.
    const { env, raw } = createTestEnv();
    const comped = '2028-01-01 00:00:00';
    const premium = '2029-01-01 00:00:00';
    raw
      .prepare('UPDATE Tenants SET CompedUntil = ?, PremiumUntil = ? WHERE Id = ?')
      .run(comped, premium, TENANT_A);

    const event = (over: Partial<Parameters<typeof applyBillingEvent>[2]> = {}) => ({
      plan: 'solo' as const,
      billedUntil: '2026-10-08 00:00:00',
      stripeCustomerId: 'cus_A',
      stripeSubscriptionId: 'sub_A',
      eventAt: '2026-09-08 12:00:00',
      establishes: true,
      ...over,
    });
    const db = env.PAWSERVATION_DB;
    const comps = async () => {
      const t = (await getTenantById(db, TENANT_A))!;
      // …and she is current at every step, which is the consequence the two columns exist for.
      expect(isPlanCurrent(t)).toBe(true);
      return {
        CompedUntil: t.CompedUntil,
        PremiumUntil: t.PremiumUntil,
        BilledUntil: t.BilledUntil,
      };
    };

    // The checkout.
    expect(await applyBillingEvent(db, TENANT_A, event())).toBe(true);
    expect(await comps()).toEqual({
      CompedUntil: comped,
      PremiumUntil: premium,
      BilledUntil: '2026-10-08 00:00:00',
    });

    // The renewal — a later invoice.paid, paid further ahead.
    const renewal = event({ billedUntil: '2026-11-08 00:00:00', eventAt: '2026-10-08 12:00:00' });
    expect(await applyBillingEvent(db, TENANT_A, renewal)).toBe(true);
    expect(await comps()).toEqual({
      CompedUntil: comped,
      PremiumUntil: premium,
      BilledUntil: '2026-11-08 00:00:00',
    });

    // The SAME event redelivered. Equality of second is not staleness, so this one applies again
    // and has to be inert by SET semantics rather than by refusal.
    expect(await applyBillingEvent(db, TENANT_A, renewal)).toBe(true);
    expect(await comps()).toEqual({
      CompedUntil: comped,
      PremiumUntil: premium,
      BilledUntil: '2026-11-08 00:00:00',
    });

    // And the cancellation, which LOWERS the paid-through date into the past. The hardest step for
    // the comps: a writer that treated a plan as one date would have to clear or lower something
    // here, and both comps are still what the owner set.
    expect(
      await applyBillingEvent(
        db,
        TENANT_A,
        event({ billedUntil: '2026-09-09 00:00:00', eventAt: '2026-11-08 12:00:00' }),
      ),
    ).toBe(true);
    expect(await comps()).toEqual({
      CompedUntil: comped,
      PremiumUntil: premium,
      BilledUntil: '2026-09-09 00:00:00',
    });
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
