import { Hono } from 'hono';
import type { Context } from 'hono';
import * as v from 'valibot';
import { applyBillingEvent, getTenantById } from '../db/repo';
import { requestContext, securityEvent } from '../lib/log';
import { UNKNOWN_TENANT } from '../lib/middleware';
import { normalizeBilledUntil, normalizePremiumUntil } from '../lib/premium';
import { checkAndBumpRateLimit } from '../lib/rate-limit';
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

/**
 * The refusal-path cap, mirroring `routes/signup.ts` — this is an unauthenticated surface, and the
 * other three in this repo are all limited. Higher than theirs on purpose: one caller legitimately
 * delivers many events, and only its FAILURES are counted.
 *
 * Bumped when the secret is rejected and never when an event is accepted, so a legitimate retry
 * storm is unaffected. Over the cap the answer is the same 404 — the limiter must not become the
 * oracle the byte-identical refusal exists to deny — and what stops is the LOG LINE: a rejection
 * per attempt hands an unauthenticated caller a dial on how much log to generate.
 *
 * Keyed on the caller's IP alone. There is no email here, and the slug is already in the line the
 * cap protects, so this key is the one in this repo that is not itself PII — but it is still never
 * logged, because `checkAndBumpRateLimit` never logs a key.
 */
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_TTL_SECONDS = 600;
const RATE_KEY = (ip: string) => `billing:rl:${ip}`;

/** Every string field is bounded. Comfortably past a processor's own id lengths, and short enough
 *  that no single request can push a megabyte into a `Tenants` column or into a log line. */
const MAX_FIELD = 255;

/** How far ahead of THIS worker's clock an event may claim to have been created. Two workers' clocks
 *  disagree by seconds, never by hours — and a stamp accepted from the future is written to
 *  `LastBillingEventAt`, after which every real event is older than it and the row is frozen with no
 *  recovery short of hand-written SQL. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

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
  billedUntil: v.pipe(v.string(), v.maxLength(MAX_FIELD)),
  /**
   * BOTH IDS NON-EMPTY. `''` is a string to valibot and stored as one, and each empty id is
   * permanent: an empty `StripeSubscriptionId` matches no incoming subscription, so every later
   * non-checkout event is `not_current_subscription` forever, and an empty `StripeCustomerId`
   * survives the writer's `COALESCE` and can never be replaced. Neither is reachable again without
   * hand-written SQL, which is a high price for a field the caller can simply be required to fill.
   */
  stripeCustomerId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_FIELD)),
  stripeSubscriptionId: v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_FIELD)),
  /** LOGGING ONLY. There is no seen-set here — idempotence is the event-ordering rule (NFR-13), not
   *  a table of ids — but this is the handle that ties a line in this worker's log to a line in the
   *  caller's, and it names no person. */
  eventId: v.pipe(v.string(), v.maxLength(MAX_FIELD)),
  /** The processor's own unit: whole seconds since the epoch. Bounded at both ends so the `Date`
   *  built from it below is always valid and `toISOString()` cannot throw. The upper bound is
   *  2100-01-01. */
  eventCreated: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4_102_444_800)),
});

/**
 * What an UNSET slot is compared against: NULs, AS MANY AS WERE PRESENTED.
 *
 * The length is the point. `constantTimeEqual` returns on a length mismatch before comparing a
 * single character, so a fixed-length sentinel makes an unset slot cheaper than a real secret —
 * which is the very question ("is a rotation in progress") that comparing a fixed PAIR of slots
 * exists to refuse to answer. Built from `presented.length`, both slots cost the same either way.
 *
 * A NUL is not a legal HTTP header value, so no caller can present a run of them; and `configured`
 * at the call site makes the filler unmatchable even for a caller who could.
 */
const unsetSlotFor = (presented: string): string => '\u0000'.repeat(presented.length);

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
 * compared against an equal-length filler instead (`unsetSlotFor`), so the compare cannot return
 * early on a length mismatch and cost less than a real one; `&& configured` — evaluated AFTER the
 * compare has already run, so it costs no time — keeps it from ever counting as a match.
 *
 * Neither value set ⇒ false. A deployment that sells nothing refuses everything rather than
 * accepting anything.
 */
export function billingSecretAccepted(presented: string | undefined, env: Env): boolean {
  if (!presented) return false;
  let accepted = false;
  for (const slot of [env.BILLING_SHARED_SECRET, env.BILLING_SHARED_SECRET_PREVIOUS]) {
    const configured = typeof slot === 'string' && slot.length > 0;
    const candidate = configured ? slot : unsetSlotFor(presented);
    accepted = (constantTimeEqual(presented, candidate) && configured) || accepted;
  }
  return accepted;
}

type BillingContext = Context<AppEnv>;

/**
 * The caller's own correlation id, lifted off a body that has just FAILED to parse — which is the
 * only reason it is read by hand rather than off the parsed output. Bounded to the same length the
 * schema bounds it to, and `'none'` when it is missing or is not a string, so the line always
 * carries the field. It names no person: it is the processor's event id and nothing else.
 */
function eventIdOf(raw: unknown): string {
  const id = (raw as { eventId?: unknown } | null)?.eventId;
  return typeof id === 'string' && id.length > 0 ? id.slice(0, MAX_FIELD) : 'none';
}

/** A refused body, reported. Slug, event id, why, and the request context — the whole vocabulary. */
function logRejected(c: BillingContext, slug: string, eventId: string, reason: string): void {
  securityEvent('billing_event_rejected', {
    tenant: slug,
    eventId,
    reason,
    ...requestContext(c.req),
  });
}

/**
 * Drop the tenant's cached row, and NEVER fail the request over it.
 *
 * On the applied path the write has already committed. A throw here would 500 a caller whose event
 * landed, and the redelivery it provokes is answered by the ordering rules and returns before
 * reaching this line — so nothing would ever drop the row, and the tenant would sit on the
 * pre-write copy until its TTL, because of a failure that happened AFTER the thing it was
 * reporting succeeded. The cache failure is logged as itself; the caller is told the truth about
 * the write.
 */
async function dropCachedRow(slug: string, c: BillingContext): Promise<void> {
  try {
    await invalidateTenantCache(slug, c.env);
  } catch (e) {
    console.error('billing cache invalidate failed', {
      tenant: slug,
      error: e instanceof Error ? e.name : 'unknown',
      ...requestContext(c.req),
    });
  }
}

/**
 * An event this endpoint declines to apply: reported, cached row dropped, answered 200 with the
 * reason named. The cache is dropped on this path TOO — the row it holds may predate the write that
 * made this event stale, and a redelivery is exactly the request that would otherwise be the last
 * chance to notice.
 */
async function declined(c: BillingContext, slug: string, eventId: string, reason: string) {
  securityEvent('billing_event_ignored', {
    tenant: slug,
    eventId,
    reason,
    ...requestContext(c.req),
  });
  await dropCachedRow(slug, c);
  return c.json({ applied: false, reason });
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
    const overCap = await checkAndBumpRateLimit(
      c.env.PAWSERVATION_CACHE,
      RATE_KEY(c.req.header('CF-Connecting-IP') ?? 'unknown'),
      RATE_LIMIT_MAX,
      RATE_LIMIT_TTL_SECONDS,
      'billing',
    );
    if (!overCap)
      securityEvent('billing_secret_rejected', {
        tenant: tenant.Slug,
        ...requestContext(c.req),
      });
    return c.json(UNKNOWN_TENANT, 404);
  }

  const raw = await c.req.json<unknown>().catch(() => ({}));
  const parsed = v.safeParse(BillingEvent, raw);
  if (!parsed.success) {
    /**
     * REPORTED, because a systematic billing failure otherwise presents as silence on this side —
     * the caller sees 400s and this worker's log says nothing at all. `eventId` is the whole point
     * of the field: it is the handle that ties this line to a line in the caller's own log, and it
     * names no person. Lifted straight off the unparsed body (bounded, and only when it is a
     * string) precisely because the parse is what failed. No other field is echoed: the reason a
     * body was refused is a schema fact, not a payload to reprint.
     */
    logRejected(c, tenant.Slug, eventIdOf(raw), 'schema');
    return c.json(
      {
        error:
          'Expected { eventType, plan: "solo"|"pro", billedUntil, stripeCustomerId, stripeSubscriptionId, eventId, eventCreated }.',
      },
      400,
    );
  }
  const body = parsed.output;

  // A stamp from the future freezes the row: it is written to `LastBillingEventAt`, and every real
  // event afterwards is older than it. The schema's 2100 ceiling only keeps the `Date` valid.
  if (body.eventCreated * 1000 > Date.now() + MAX_FUTURE_SKEW_MS) {
    logRejected(c, tenant.Slug, body.eventId, 'event_created_in_future');
    return c.json({ error: 'eventCreated must not be more than 5 minutes in the future.' }, 400);
  }

  // Normalise BEFORE anything is read or written, the `owner.ts` PATCH's discipline: a date this
  // endpoint cannot store must not leave a half-applied event behind.
  const billedUntil = normalizeBilledUntil(body.billedUntil);
  if (billedUntil === null) {
    logRejected(c, tenant.Slug, body.eventId, 'billed_until');
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
  if (row.LastBillingEventAt != null && eventAt < row.LastBillingEventAt) {
    // STRICTLY older. An event created in the SAME SECOND as the last one applies: a processor
    // emits `checkout.session.completed` and `customer.subscription.updated` for one action inside
    // one second, and refusing the ties threw away whichever arrived second along with its payload.
    // NFR-13 is bought by the writer's SET semantics instead — the identical request twice leaves a
    // byte-identical row — and this comparison agrees with the `WHERE` clause that enforces it.
    return await declined(c, row.Slug, body.eventId, 'stale_event');
  }
  if (
    !replacesSubscription &&
    row.StripeSubscriptionId != null &&
    row.StripeSubscriptionId !== body.stripeSubscriptionId
  ) {
    return await declined(c, row.Slug, body.eventId, 'not_current_subscription');
  }

  /**
   * WHAT THIS EVENT DISPLACES, established before the write so it can be reported afterwards.
   *
   * A completed checkout is allowed to assign a new subscription id over a live one, and the
   * writer `COALESCE`s the customer id rather than assigning it — so a re-subscribe under a
   * different customer leaves the row naming subscription B against customer A, which is the
   * portal opening for the wrong person (FR-60). The customer divergence is logged rather than
   * written, because "a sitter is one customer forever" is the assumption this endpoint is not
   * entitled to overturn on a single event; the displaced subscription is reported to the caller,
   * which is the only party that can tell whether it meant to.
   */
  const replaced =
    row.StripeSubscriptionId != null && row.StripeSubscriptionId !== body.stripeSubscriptionId
      ? row.StripeSubscriptionId
      : null;
  if (row.StripeCustomerId != null && row.StripeCustomerId !== body.stripeCustomerId) {
    securityEvent('billing_customer_changed', {
      tenant: row.Slug,
      eventId: body.eventId,
      ...requestContext(c.req),
    });
  }

  const applied = await applyBillingEvent(c.env.PAWSERVATION_DB, row.Id, {
    plan: body.plan,
    billedUntil,
    stripeCustomerId: body.stripeCustomerId,
    stripeSubscriptionId: body.stripeSubscriptionId,
    eventAt,
    replacesSubscription,
  });
  // Both checks above passed and the statement still declined: another delivery of a LATER event
  // landed in between. Its answer is the right one, and this one is reported as what it now is.
  if (!applied) return await declined(c, row.Slug, body.eventId, 'concurrent_event');

  // Entitlement is derived on every read, so dropping the cached row is what puts the new plan in
  // front of the sitter. Not "the moment" it goes, though: `resolveTenant` is read-through, so a
  // concurrent resolve that missed the cache before this write can `put()` the pre-write row after
  // the `delete()` — the honest worst case is the cache's own TTL, and the invalidate is what makes
  // that a worst case rather than the norm.
  await dropCachedRow(row.Slug, c);
  return c.json(replaced === null ? { applied: true } : { applied: true, replaced });
});
