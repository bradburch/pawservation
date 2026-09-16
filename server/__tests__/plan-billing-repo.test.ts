import { describe, expect, it } from 'vitest';
import { applyBillingEvent, getTenantById } from '../db/repo';
import {
  isPremiumActive,
  MAX_BILLED_AHEAD_DAYS,
  normalizeBilledUntil,
  normalizePremiumUntil,
  premiumNow,
} from '../lib/premium';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

/**
 * THE WRITER, on its own. Every rule about which billing event wins lives in ONE guarded UPDATE, so
 * that two redeliveries racing each other cannot interleave into a row that says it was billed
 * through a date it never stored. The route above it makes the same two decisions in order to
 * REPORT which rule fired; the statement is what enforces them.
 */

const AT = {
  first: '2026-09-08 12:00:00',
  later: '2026-10-08 12:00:00',
  earlier: '2026-08-08 12:00:00',
};

const event = (over: Partial<Parameters<typeof applyBillingEvent>[2]> = {}) => ({
  plan: 'pro' as const,
  billedUntil: '2026-10-08 00:00:00',
  stripeCustomerId: 'cus_A',
  stripeSubscriptionId: 'sub_A',
  eventAt: AT.first,
  kind: 'checkout' as const,
  ...over,
});

describe('applyBillingEvent — what one event does to a tenant row', () => {
  it('sets the plan, the date and both ids, and advances the event stamp', async () => {
    const { env } = createTestEnv();
    expect(await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event())).toBe(true);

    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.Plan).toBe('pro');
    expect(t.BilledUntil).toBe('2026-10-08 00:00:00');
    expect(t.StripeCustomerId).toBe('cus_A');
    expect(t.StripeSubscriptionId).toBe('sub_A');
    expect(t.LastBillingEventAt).toBe(AT.first);
  });

  it('SETS the date, never extends it — a cancellation lowers what a renewal raised', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({
        billedUntil: '2026-09-20 00:00:00',
        eventAt: AT.later,
        kind: 'ordinary' as const,
      }),
    );
    // Lower than what was there, and it is what is there now. The processor's date is the truth;
    // this column is a copy of it, not a running total.
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil).toBe(
      '2026-09-20 00:00:00',
    );
  });

  it('never names PremiumUntil, so a comp survives a renewal AND a cancellation', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET PremiumUntil = '2099-01-01 00:00:00' WHERE Id = '${TENANT_A}'`);
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({ billedUntil: '2026-09-20 00:00:00', eventAt: AT.later, kind: 'ordinary' as const }),
    );
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.PremiumUntil).toBe(
      '2099-01-01 00:00:00',
    );
  });

  it('coalesces the customer id on an ordinary event, and never overwrites it', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({ stripeCustomerId: 'cus_OTHER', eventAt: AT.later, kind: 'ordinary' as const }),
    );
    // AN INVOICE MERELY SAYS THAT SUBSCRIPTION WAS PAID. It does not say which customer this
    // business now is, and one arriving late for a subscription that has been displaced must not
    // move the id out from under the live one.
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.StripeCustomerId).toBe('cus_A');
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_B))!.StripeCustomerId).toBeNull();
  });

  it('ASSIGNS the customer id when the event establishes identity', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({
        stripeCustomerId: 'cus_NEW',
        stripeSubscriptionId: 'sub_NEW',
        eventAt: AT.later,
        kind: 'checkout' as const,
      }),
    );
    // THE DEAD-CUSTOMER LOOP, CLOSED WITHOUT A NEW ROUTE. A business whose customer record the
    // processor no longer has presses Subscribe, the checkout retries once without the stored id,
    // the processor mints a fresh customer, and the completed checkout that follows now ASSIGNS it
    // — so her Manage-plan button works again with no human in the loop.
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.StripeCustomerId).toBe('cus_NEW');
    expect(t.StripeSubscriptionId).toBe('sub_NEW');
    const b = (await getTenantById(env.PAWSERVATION_DB, TENANT_B))!;
    expect(b.StripeCustomerId).toBeNull();
    expect(b.StripeSubscriptionId).toBeNull();
  });

  it('never names CompedUntil, so a BASIC comp survives a renewal and a cancellation', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET CompedUntil = '2099-01-01 00:00:00' WHERE Id = '${TENANT_A}'`);
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({ billedUntil: '2026-09-20 00:00:00', eventAt: AT.later, kind: 'ordinary' as const }),
    );
    // The same separation `PremiumUntil` has had since 0017, inherited for free by being a second
    // column: two comps, two owner-written columns, and one statement that names neither.
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.CompedUntil).toBe(
      '2099-01-01 00:00:00',
    );
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_B))!.CompedUntil).toBeNull();
  });

  /**
   * A DISABLED tenant is written exactly like any other, and that is the writer's whole opinion on
   * the subject. Refusing her is the ROUTE's job, not this one's: `tenantMiddleware` answers 403 for
   * a disabled tenant before the handler runs, and `isPremiumActive` / `isSoloActive` already return
   * false while `DisabledAt` is set. So there is nothing for a guard here to buy, and one would cost
   * something real — the record of what a sitter actually paid for, which is what re-enabling her
   * restores. `DisabledAt` is not in the statement either, in both directions.
   */
  it('writes a disabled tenant like any other, and leaves DisabledAt alone', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET DisabledAt = '2026-01-01 00:00:00' WHERE Id = '${TENANT_A}'`);
    expect(await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event())).toBe(true);

    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.Plan).toBe('pro');
    expect(t.BilledUntil).toBe('2026-10-08 00:00:00');
    expect(t.DisabledAt).toBe('2026-01-01 00:00:00');
  });
});

describe('applyBillingEvent — the two rules that decide which event wins', () => {
  it('refuses an event created BEFORE the last one applied, and applies an equal-second one', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event({ eventAt: AT.later }));

    // The same second is NOT stale. Stripe emits several events for one action inside one second,
    // and the guard used to throw away every one after the first — including the ones carrying a
    // different payload. Idempotence comes from SET semantics, not from refusing equality.
    expect(
      await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event({ eventAt: AT.later })),
    ).toBe(true);
    // One genuinely older is a delivery that overtook its successor, and still does nothing.
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({ eventAt: AT.earlier, billedUntil: '2020-01-01 00:00:00' }),
      ),
    ).toBe(false);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil).toBe(
      '2026-10-08 00:00:00',
    );
  });

  /**
   * The other half of NFR-13, and the stronger statement: not merely "the second call returns
   * false", but that the row is byte-identical afterwards — `LastBillingEventAt` included. A writer
   * that refused the change but still advanced the stamp would look idempotent from its return value
   * and silently swallow the next genuine event.
   */
  it('leaves every column byte-identical when the identical request arrives twice', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    const after = await getTenantById(env.PAWSERVATION_DB, TENANT_A);

    // The write APPLIES the second time — equality is not staleness — and idempotence is the
    // stronger statement it always was: every column, `LastBillingEventAt` included, is what it
    // was. A writer that extended a date, or that advanced the stamp past a value it declined to
    // store, would fail here and pass a return-value check.
    expect(await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event())).toBe(true);
    expect(await getTenantById(env.PAWSERVATION_DB, TENANT_A)).toEqual(after);
  });

  it('refuses an event for a subscription that is not the current one', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({
          stripeSubscriptionId: 'sub_OLD',
          billedUntil: '2020-01-01 00:00:00',
          eventAt: AT.later,
          kind: 'ordinary' as const,
        }),
      ),
    ).toBe(false);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil).toBe(
      '2026-10-08 00:00:00',
    );
  });

  it('lets a new checkout REPLACE the recorded subscription, which is how a re-subscribe wins', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event()); // sub_A
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({
          stripeSubscriptionId: 'sub_B',
          billedUntil: '2026-11-08 00:00:00',
          eventAt: AT.later,
          kind: 'checkout' as const,
        }),
      ),
    ).toBe(true);
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.StripeSubscriptionId).toBe('sub_B');
    expect(t.BilledUntil).toBe('2026-11-08 00:00:00');
  });

  /**
   * The two rules together, in the order they actually arrive in. A cancellation of the OLD
   * subscription routinely lands after the checkout that replaced it — it is newer, so the stale
   * rule lets it through, and only the subscription clause stands between a live re-subscribe and a
   * date from the plan it replaced.
   */
  it('ignores a cancellation for the replaced subscription, leaving the new one standing', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event()); // checkout, sub_A
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({
        stripeSubscriptionId: 'sub_B',
        billedUntil: '2026-11-08 00:00:00',
        eventAt: AT.later,
        kind: 'checkout' as const,
      }),
    );
    // `customer.subscription.deleted` for sub_A, and genuinely newer than everything applied.
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({
          stripeSubscriptionId: 'sub_A',
          billedUntil: '2026-10-09 00:00:00',
          eventAt: '2026-11-08 12:00:00',
          kind: 'ordinary' as const,
        }),
      ),
    ).toBe(false);
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.StripeSubscriptionId).toBe('sub_B');
    expect(t.BilledUntil).toBe('2026-11-08 00:00:00');
    expect(t.LastBillingEventAt).toBe(AT.later);
  });

  /**
   * WHY THE GUARDS ARE IN THE STATEMENT rather than in the caller, demonstrated. The route reads the
   * row, finds both rules satisfied, and writes — but another delivery lands in between. The write
   * matches zero rows, and that `false` is what the route reports as `concurrent_event`: both of its
   * own checks passed, so the statement is the only thing that could have refused it. Move either
   * rule up into the caller and this interleaving writes a lower date over a higher one instead.
   */
  it('declines a write whose read said it should apply, when a later event got there first', async () => {
    const { env } = createTestEnv();
    // The read the caller would have made: nothing applied yet, so its event is neither stale nor
    // for some other subscription.
    const read = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(read.LastBillingEventAt).toBeNull();
    expect(read.StripeSubscriptionId).toBeNull();

    // A concurrent delivery of a LATER event, applied between that read and the write below.
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({ billedUntil: '2026-11-08 00:00:00', eventAt: AT.later }),
    );

    expect(await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event())).toBe(false);
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.BilledUntil).toBe('2026-11-08 00:00:00');
    expect(t.LastBillingEventAt).toBe(AT.later);
  });

  it('writes the same value again when a LATER event carries the same date', async () => {
    // The other half of idempotence: a repeat is refused by the stale rule, but a genuinely new
    // event that happens to say the same thing must still land, or the stamp stops advancing.
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({ eventAt: AT.later, kind: 'ordinary' as const }),
      ),
    ).toBe(true);
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.BilledUntil).toBe('2026-10-08 00:00:00');
    expect(t.LastBillingEventAt).toBe(AT.later);
  });

  it('moves one tenant and no other', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    const b = (await getTenantById(env.PAWSERVATION_DB, TENANT_B))!;
    expect(b.Plan).toBeNull();
    expect(b.BilledUntil).toBeNull();
    expect(b.StripeCustomerId).toBeNull();
    expect(b.PremiumUntil).toBeNull();
  });

  /**
   * THE RESYNC RULES (Story 10.4 fix round). A resync's `eventAt` is the subscription's period
   * start, not a wall clock, so it can legitimately be OLDER than the last webhook applied — and
   * the frozen row it exists to repair is exactly the row whose stamp is newer than that. So a
   * resync is exempt from the stale rule. A CHECKOUT IS NOT: its stamp is the processor's own
   * `created`, honest to order by, and exempting it would let a redelivered old checkout regress a
   * row to the subscription a newer checkout replaced (the next case).
   */
  it('applies a RESYNC older than the stamp, and leaves the stamp where it was', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event({ eventAt: AT.later }));
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({
          plan: 'solo',
          billedUntil: '2026-12-08 00:00:00',
          eventAt: AT.earlier,
          kind: 'resync',
        }),
      ),
    ).toBe(true);
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    // The payload landed — SET semantics, the current period from the processor's own mouth…
    expect(t.Plan).toBe('solo');
    expect(t.BilledUntil).toBe('2026-12-08 00:00:00');
    // …and the stamp is MONOTONIC: it is the high-water mark of applied stamps, not the last one
    // written. Rewinding it to the resync's payment-derived stamp would re-open the door to every
    // ordinary webhook redelivered from between the two, and the stale rule is the only thing that
    // closes it.
    expect(t.LastBillingEventAt).toBe(AT.later);
    // Proof of that: an ORDINARY event from between the two is still stale.
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({ billedUntil: '2020-01-01 00:00:00', eventAt: AT.first, kind: 'ordinary' }),
      ),
    ).toBe(false);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil).toBe(
      '2026-12-08 00:00:00',
    );
  });

  it('refuses a CHECKOUT older than the stamp, so a redelivered old one cannot regress the row', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event()); // sub_A at AT.first
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({
        stripeSubscriptionId: 'sub_B',
        billedUntil: '2026-11-08 00:00:00',
        eventAt: AT.later,
      }),
    ); // sub_B, newer
    // The first checkout, delivered again: establishing, and still refused as stale.
    expect(await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event())).toBe(false);
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.StripeSubscriptionId).toBe('sub_B');
    expect(t.BilledUntil).toBe('2026-11-08 00:00:00');
    expect(t.LastBillingEventAt).toBe(AT.later);
  });

  it('lets a RESYNC replace the subscription only for the SAME customer', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event()); // cus_A / sub_A
    // Same customer, new subscription: the repair a resync exists for.
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({ stripeSubscriptionId: 'sub_B', eventAt: AT.later, kind: 'resync' }),
      ),
    ).toBe(true);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.StripeSubscriptionId).toBe(
      'sub_B',
    );
    // A DIFFERENT customer: declined, whatever the subscription says. A resync says "this is what
    // the processor says about THIS customer"; one naming another customer is talking about
    // somebody else's subscription, and the shared secret alone must not be enough to move a
    // business onto it. A CHECKOUT may still assign the customer over — that is the dead-customer
    // loop, and it is the case above this describe.
    expect(
      await applyBillingEvent(
        env.PAWSERVATION_DB,
        TENANT_A,
        event({
          stripeCustomerId: 'cus_OTHER',
          stripeSubscriptionId: 'sub_C',
          billedUntil: '2026-12-08 00:00:00',
          eventAt: '2026-11-08 12:00:00',
          kind: 'resync',
        }),
      ),
    ).toBe(false);
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.StripeCustomerId).toBe('cus_A');
    expect(t.StripeSubscriptionId).toBe('sub_B');
    expect(t.BilledUntil).toBe('2026-10-08 00:00:00');
    // A row with NO customer yet is filled by a resync — nothing to disagree with.
    const { env: fresh } = createTestEnv();
    expect(
      await applyBillingEvent(fresh.PAWSERVATION_DB, TENANT_A, event({ kind: 'resync' })),
    ).toBe(true);
    expect((await getTenantById(fresh.PAWSERVATION_DB, TENANT_A))!.StripeCustomerId).toBe('cus_A');
  });

  it('reports false for a tenant that does not exist', async () => {
    const { env } = createTestEnv();
    expect(await applyBillingEvent(env.PAWSERVATION_DB, 'tnt_nope', event())).toBe(false);
  });
});

describe('normalizeBilledUntil — one shape in, and a ceiling on what a leaked secret can buy', () => {
  const NOW = new Date('2026-09-08T12:00:00Z');

  it('stores an ISO instant in the shape the comparison can read', () => {
    expect(normalizeBilledUntil('2026-10-08T00:00:00Z', NOW)).toBe('2026-10-08 00:00:00');
  });

  it('drops the separator that would invert the comparison, and the reader agrees', () => {
    // Its sibling above already asserts the returned shape, so asserting it again with a second
    // date kills no mutant the first does not. What this one states is the CONSEQUENCE, on the
    // instant where the separator is the whole of the difference: earlier the same day as `now`.
    const past = normalizeBilledUntil('2026-09-08T00:00:00Z', NOW)!;
    expect(past).toBe('2026-09-08 00:00:00');
    const facts = (billedUntil: string) => ({
      DisabledAt: null,
      PremiumUntil: null,
      Plan: 'pro' as const,
      BilledUntil: billedUntil,
      CompedUntil: null,
    });
    expect(isPremiumActive(facts(past), NOW)).toBe(false);
    // The same instant left in the shape it arrived in sorts the OPPOSITE way on the bare compare:
    // 'T' sorts above the space in a space-separated `now`, so a tenant paid through this morning
    // would read as premium — which is why the reader now refuses the shape outright (`isAhead`,
    // server/lib/premium.ts) rather than trusting the compare on it. This line used to assert
    // `true` through the predicate as the demonstration; the demonstration is the compare, and the
    // predicate's answer is the fail-closed one.
    expect('2026-09-08T00:00:00Z' > premiumNow(NOW)).toBe(true);
    expect(isPremiumActive(facts('2026-09-08T00:00:00Z'), NOW)).toBe(false);
  });

  it('refuses an expanded-year instant, which walks straight past the ceiling', () => {
    // `'+275760-09-13T00:00:00.000Z'` is a legal `Date` and normalises to the 19-character
    // '+275760-09-13 00:00' — which sorts BELOW the ceiling on its leading '+', is stored, and then
    // sorts below `now` for the same reason. Fail-closed, but a value in the one column whose
    // homogeneity `premium.ts`'s docblock calls load-bearing.
    expect(normalizeBilledUntil('+275760-09-13T00:00:00.000Z', NOW)).toBeNull();
    expect(normalizePremiumUntil('+275760-09-13T00:00:00.000Z')).toBeNull();
    expect(normalizePremiumUntil('-000001-01-01T00:00:00.000Z')).toBeNull();
    // The shapes it does accept are unchanged.
    expect(normalizePremiumUntil('2027-01-01')).toBe('2027-01-01 00:00:00');
    expect(normalizePremiumUntil('2027-01-01T00:00:00Z')).toBe('2027-01-01 00:00:00');
  });

  it('refuses anything that is not a date at all', () => {
    expect(normalizeBilledUntil('next tuesday', NOW)).toBeNull();
    expect(normalizeBilledUntil('', NOW)).toBeNull();
  });

  it('accepts a date in the PAST, because a lapsed tenant is a true thing to record', () => {
    expect(normalizeBilledUntil('2020-01-01T00:00:00Z', NOW)).toBe('2020-01-01 00:00:00');
  });

  it('is a ceiling of exactly 400 days (NFR-14)', () => {
    // Stated as a literal, separately from the boundary test below. `MAX_BILLED_AHEAD_DAYS ± 1`
    // moves with the constant, so a mutation that widened the ceiling to a decade passed a test
    // written in terms of it.
    expect(MAX_BILLED_AHEAD_DAYS).toBe(400);
  });

  it('accepts 399 and 400 days out, and refuses 401', () => {
    const daysOut = (days: number) => {
      const iso = new Date(NOW.getTime() + days * 86_400_000).toISOString();
      return normalizeBilledUntil(iso, NOW);
    };
    expect(daysOut(399)).not.toBeNull();
    expect(daysOut(400)).not.toBeNull();
    expect(daysOut(401)).toBeNull();
  });
});
