import { Hono } from 'hono';
import * as v from 'valibot';
import { applyBillingEvent, getTenantById } from '../db/repo';
import { requestContext, securityEvent } from '../lib/log';
import { normalizeBilledUntil, normalizePremiumUntil } from '../lib/premium';
import { invalidateTenantCache } from '../lib/tenant-resolve';
import { constantTimeEqual } from '../lib/timing';
import type { AppEnv } from '../types';

/**
 * THE FREE PRODUCT'S BILLING EAR (0017, spine AD-12 item 5).
 *
 * One route. It takes a DATE, not a processor object: it calls no processor, verifies no signature,
 * holds no API key, and learns nothing about what a plan entitles beyond the two columns it writes.
 * Whatever is on the other end of the shared secret does the talking to a payment processor; this
 * endpoint's whole job is to record the outcome on a tenant row and drop the tenant cache.
 *
 * MOUNTED BEFORE `adminRoutes` in server/index.ts, and that ordering is load-bearing — see the
 * comment there. `adminAuth` guards `/:slug/admin/*` and Hono flattens `.use()` patterns across
 * every app mounted at `/api`, so this path is inside its pattern; registering this app first means
 * the handler below returns a Response before `adminAuth` ever runs. `tenantMiddleware` still runs,
 * which is wanted: it produces the 404 this route's own refusal has to be indistinguishable from,
 * and it keeps a disabled tenant's 403 exactly where every other mutation gets one.
 */

/** The header. Deliberately NOT `Authorization`: every `Authorization` in this repo is a session or
 *  an access token, and reusing it is how a billing secret ends up presented, by accident, to
 *  `adminAuth`. A bare value with no scheme, because it is not a scheme. */
const SECRET_HEADER = 'X-Billing-Secret';

/** Byte-for-byte what `tenantMiddleware` answers for a slug it cannot resolve — see `refuse`. */
const UNKNOWN_TENANT = { error: 'Unknown tenant' } as const;

const BillingEvent = v.object({
  /**
   * WHICH event this is. A four-value closed set, so it cannot become a free-text channel, and the
   * minimum needed to express the one exception to the subscription rule: a completed checkout
   * REPLACES the recorded subscription id, and nothing else may.
   */
  eventType: v.picklist([
    'checkout.session.completed',
    'invoice.paid',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ]),
  /** The picklist is what makes "a plan outside the two is refused" a parse failure rather than a
   *  hand-written branch that someone can forget to write. */
  plan: v.picklist(['solo', 'pro']),
  billedUntil: v.string(),
  stripeCustomerId: v.string(),
  stripeSubscriptionId: v.string(),
  /** LOGGING ONLY. There is no seen-set here — idempotence is the event-ordering rule (NFR-13), not
   *  a table of ids — but this is the handle that ties a line in this worker's log to a line in the
   *  caller's, and it names no person. */
  eventId: v.string(),
  /** The processor's own unit: whole seconds since the epoch. Bounded at both ends so the `Date`
   *  built from it below is always valid and `toISOString()` cannot throw. The upper bound is
   *  2100-01-01. */
  eventCreated: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4_102_444_800)),
});

/** What an UNSET slot is compared against. A NUL-delimited string is not a legal HTTP header value,
 *  so no caller can present it — and `configured` below makes it unmatchable even if one could. */
const UNSET_SLOT = '\u0000unset\u0000';

/**
 * Is the presented secret one of the live values? Constant-time, over BOTH SLOTS, fail-closed.
 *
 * The `|| accepted` ordering is the point: `accepted || constantTimeEqual(…)` would short-circuit
 * once the first value matched and leak, by timing, WHICH of the two matched — i.e. whether the
 * caller is on the old secret or the new one, during exactly the window when that is interesting.
 * Every slot is compared, every time.
 *
 * TWO SLOTS ALWAYS, configured or not, which is why there is no `.filter()` here: a candidate list
 * built by dropping the unset slot is one comparison in steady state and two mid-rotation, so the
 * response time answers "is a rotation in progress" to anyone who cares to ask. An unset slot is
 * compared against `UNSET_SLOT` instead, and `&& configured` — evaluated AFTER the compare has
 * already run, so it costs no time — keeps it from ever counting as a match.
 *
 * Neither value set ⇒ false. A deployment that sells nothing refuses everything rather than
 * accepting anything.
 */
export function billingSecretAccepted(presented: string | undefined, env: Env): boolean {
  if (!presented) return false;
  let accepted = false;
  for (const slot of [env.BILLING_SHARED_SECRET, env.BILLING_SHARED_SECRET_PREVIOUS]) {
    const configured = typeof slot === 'string' && slot.length > 0;
    const candidate = configured ? slot : UNSET_SLOT;
    accepted = (constantTimeEqual(presented, candidate) && configured) || accepted;
  }
  return accepted;
}

export const billingRoutes = new Hono<AppEnv>().post('/:slug/admin/billing/events', async (c) => {
  /**
   * NO TENANT RESOLVED, and it is reachable: `billing` is in `RESERVED_SLUGS`, so `tenantMiddleware`
   * calls `next()` for `/api/billing/...` without setting one — the same hole `adminAuth` guards
   * against (`lib/middleware.ts`), and for the same reason: the alternative is a TypeError on
   * `tenant.Slug` below, which surfaces as a 500 and tells a prober that the word is special.
   *
   * BEFORE the secret comparison, deliberately. A reserved path is refused as a PATH, not as a
   * credential: it is answered identically to an unknown slug whatever secret was presented, and it
   * fires no `billing_secret_rejected` — that event carries a slug, and here there is no tenant to
   * put in it. A line naming the wrong thing is worse than no line.
   */
  const tenant = c.get('tenant');
  if (!tenant) return c.json(UNKNOWN_TENANT, 404);

  const presented = c.req.header(SECRET_HEADER);
  if (!billingSecretAccepted(presented, c.env)) {
    /**
     * REFUSED AS AN UNKNOWN TENANT, byte for byte — status, body and all (`tenantMiddleware`'s
     * `{ error: 'Unknown tenant' }`, 404). A caller who guesses the secret learns nothing about
     * which slugs exist; a caller who guesses a slug learns nothing about the secret.
     *
     * Two honest caveats, in the house style of `middleware.ts`'s own token comment. TIMING is not
     * indistinguishable: the unknown-tenant 404 is a KV read plus a D1 read, this one additionally
     * pays the constant-time compare — which confirms only the slug the caller typed, and the slug
     * is public. And ORDERING: `tenantMiddleware` resolves the tenant before this handler runs, so
     * an unknown slug never reaches the secret check at all. Both answers are the same 404.
     *
     * This log line is the ONLY place the two cases are distinguishable, which is why it exists.
     */
    securityEvent('billing_secret_rejected', {
      tenant: tenant.Slug,
      ...requestContext(c.req),
    });
    return c.json(UNKNOWN_TENANT, 404);
  }

  const raw = await c.req.json<unknown>().catch(() => ({}));
  const parsed = v.safeParse(BillingEvent, raw);
  if (!parsed.success) {
    return c.json(
      {
        error:
          'Expected { eventType, plan: "solo"|"pro", billedUntil, stripeCustomerId, stripeSubscriptionId, eventId, eventCreated }.',
      },
      400,
    );
  }
  const body = parsed.output;

  // Normalise BEFORE anything is read or written, the `owner.ts` PATCH's discipline: a date this
  // endpoint cannot store must not leave a half-applied event behind.
  const billedUntil = normalizeBilledUntil(body.billedUntil);
  if (billedUntil === null) {
    return c.json(
      { error: 'billedUntil must be a date, and no more than 400 days from now.' },
      400,
    );
  }
  // TOTAL, so there is no null branch to write: the schema above has already bounded
  // `eventCreated` to an integer in [0, 4_102_444_800], so the `Date` is valid, `toISOString()`
  // cannot throw and `Date.parse` of what it returns cannot be NaN. An unreachable 400 is a branch
  // no test can cover and no reader can check.
  const eventAt = normalizePremiumUntil(new Date(body.eventCreated * 1000).toISOString())!;

  /**
   * Read the row FRESH rather than using the cached one `tenantMiddleware` resolved. The two
   * ordering rules below compare against columns that this very endpoint writes, and a cached row
   * is up to a TTL behind its own last write — which would report a redelivery as new.
   */
  const row = await getTenantById(c.env.PAWSERVATION_DB, tenant.Id);
  if (!row) return c.json(UNKNOWN_TENANT, 404); // deleted between the middleware and here

  /** A completed checkout is the one event allowed to REPLACE the recorded subscription. */
  const replacesSubscription = body.eventType === 'checkout.session.completed';

  /**
   * The two ignore rules, answered 200 with the reason named. A silent 200 would make an ignored
   * event indistinguishable from an applied one in the caller's own logs, and these two reasons are
   * the difference between "we are in sync" and "we are talking about different subscriptions". The
   * reason names no person and no secret.
   */
  if (row.LastBillingEventAt != null && eventAt <= row.LastBillingEventAt) {
    return c.json({ applied: false, reason: 'stale_event' });
  }
  if (
    !replacesSubscription &&
    row.StripeSubscriptionId != null &&
    row.StripeSubscriptionId !== body.stripeSubscriptionId
  ) {
    return c.json({ applied: false, reason: 'not_current_subscription' });
  }

  const applied = await applyBillingEvent(c.env.PAWSERVATION_DB, tenant.Id, {
    plan: body.plan,
    billedUntil,
    stripeCustomerId: body.stripeCustomerId,
    stripeSubscriptionId: body.stripeSubscriptionId,
    eventAt,
    replacesSubscription,
  });
  // Both checks above passed and the statement still declined: another delivery of a LATER event
  // landed in between. Its answer is the right one, and this one is reported as what it now is.
  if (!applied) return c.json({ applied: false, reason: 'concurrent_event' });

  // Entitlement is derived on every read, so the new plan is live the moment the cached row goes.
  await invalidateTenantCache(tenant.Slug, c.env);
  return c.json({ applied: true });
});
