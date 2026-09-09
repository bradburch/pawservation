import { describe, expect, it } from 'vitest';
import { applyBillingEvent, getTenantById } from '../db/repo';
import { MAX_BILLED_AHEAD_DAYS, normalizeBilledUntil } from '../lib/premium';
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
  replacesSubscription: true,
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
        replacesSubscription: false,
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
      event({ billedUntil: '2026-09-20 00:00:00', eventAt: AT.later, replacesSubscription: false }),
    );
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.PremiumUntil).toBe(
      '2099-01-01 00:00:00',
    );
  });

  it('records the customer id on first sight only, and never overwrites it', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event());
    await applyBillingEvent(
      env.PAWSERVATION_DB,
      TENANT_A,
      event({ stripeCustomerId: 'cus_OTHER', eventAt: AT.later, replacesSubscription: false }),
    );
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.StripeCustomerId).toBe('cus_A');
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
  it('refuses an event created at or before the last one applied', async () => {
    const { env } = createTestEnv();
    await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event({ eventAt: AT.later }));

    // The same event again — the redelivery case (NFR-13).
    expect(
      await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event({ eventAt: AT.later })),
    ).toBe(false);
    // And one genuinely older, which is a delivery that overtook its successor.
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

    expect(await applyBillingEvent(env.PAWSERVATION_DB, TENANT_A, event())).toBe(false);
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
          replacesSubscription: false,
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
          replacesSubscription: true,
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
        replacesSubscription: true,
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
          replacesSubscription: false,
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
        event({ eventAt: AT.later, replacesSubscription: false }),
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

  it('drops the separator that would invert the comparison', () => {
    // The failure this exists to prevent, spelled with the date the entitlement test uses: stored
    // ISO-shaped, '2027-01-01T00:00:00Z' sorts above a space-separated `now` on the 'T' alone.
    expect(normalizeBilledUntil('2027-01-01T00:00:00Z', NOW)).toBe('2027-01-01 00:00:00');
  });

  it('refuses anything that is not a date at all', () => {
    expect(normalizeBilledUntil('next tuesday', NOW)).toBeNull();
    expect(normalizeBilledUntil('', NOW)).toBeNull();
  });

  it('accepts a date in the PAST, because a lapsed tenant is a true thing to record', () => {
    expect(normalizeBilledUntil('2020-01-01T00:00:00Z', NOW)).toBe('2020-01-01 00:00:00');
  });

  it(`refuses a date more than ${MAX_BILLED_AHEAD_DAYS} days out`, () => {
    const inside = new Date(NOW.getTime() + (MAX_BILLED_AHEAD_DAYS - 1) * 86_400_000);
    const outside = new Date(NOW.getTime() + (MAX_BILLED_AHEAD_DAYS + 1) * 86_400_000);
    expect(normalizeBilledUntil(inside.toISOString(), NOW)).not.toBeNull();
    expect(normalizeBilledUntil(outside.toISOString(), NOW)).toBeNull();
  });
});
