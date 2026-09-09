import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { getTenantById } from '../db/repo';
import { normalizeBilledUntil } from '../lib/premium';
import { mintOwnerToken } from '../lib/token';
import { resolveTenant } from '../lib/tenant-resolve';
import { billingSecretAccepted } from '../routes/billing';
import { RESERVED_SLUGS } from '../lib/middleware';
import { createTestEnv, OWNER_EMAIL, TENANT_A, TENANT_B, TEST_SECRET } from './helpers';
import { liveSource } from './helpers/live-source';

/**
 * `POST /api/:slug/admin/billing/events` — the free product's own billing ear. It takes a DATE, not
 * a processor object: it calls nothing, verifies no signature, and knows nothing about what a plan
 * entitles beyond the two columns it writes.
 *
 * Two structural facts are asserted before any behaviour, because both are invisible when they
 * break. The route sits inside `adminAuth`'s flattened `.use('/:slug/admin/*')` pattern, and stays
 * out of it only by being REGISTERED FIRST in server/index.ts — reorder those two lines and every
 * request here 401s. And a refused secret answers byte-for-byte what an unknown slug answers, which
 * is a property of two responses and cannot be read off either one alone.
 */

const BILLING_SOURCE = readFileSync(
  join(import.meta.dirname, '..', 'routes', 'billing.ts'),
  'utf8',
);

const SECRET = 'billing-secret-current-0123456789';
const PREVIOUS = 'billing-secret-previous-9876543210';

const withSecrets = (env: Env, over: Partial<Env> = {}): Env =>
  ({ ...env, BILLING_SHARED_SECRET: SECRET, ...over }) as Env;

/** Dates relative to now, so a fixture cannot age past the 400-day ceiling or out of the future. */
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const T0 = Math.floor(Date.now() / 1000);
/** Captured once: `event()` must rebuild the SAME date every time, to the millisecond. */
const BILLED = daysFromNow(31);

const event = (over: Record<string, unknown> = {}) => ({
  eventType: 'checkout.session.completed',
  plan: 'pro',
  billedUntil: BILLED,
  stripeCustomerId: 'cus_A',
  stripeSubscriptionId: 'sub_A',
  eventId: 'evt_1',
  eventCreated: T0,
  ...over,
});

const post = (
  env: Env,
  slug: string,
  body: unknown,
  headers: Record<string, string> = { 'X-Billing-Secret': SECRET },
) =>
  app.request(
    `/api/${slug}/admin/billing/events`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
  );

describe('the endpoint is reached at all', () => {
  it('answers the BILLING refusal with no Authorization header, not adminAuth’s', async () => {
    // THE MOUNT-ORDER PIN. `adminAuth` guards `/:slug/admin/*` and Hono flattens that pattern
    // across every app mounted at /api, so this request is inside it. If `billingRoutes` is
    // registered after `adminRoutes`, the answer is 401 {"error":"Please sign in."} instead.
    const { env } = createTestEnv();
    const res = await post(withSecrets(env), 'sunny-paws', event(), {});
    const text = await res.text();
    expect(res.status).toBe(404);
    expect(text).toBe('{"error":"Unknown tenant"}');
    expect(text).not.toContain('Please sign in');
  });

  it('reaches the handler with a valid secret and NO admin session at all', async () => {
    // The other half of the same pin, stated positively: the success path must not require a
    // session, because the caller has none to present.
    const { env } = createTestEnv();
    const res = await post(withSecrets(env), 'sunny-paws', event());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
  });
});

describe('a bad secret is indistinguishable from an unknown tenant', () => {
  it('answers the same status and the same bytes for both', async () => {
    const { env } = createTestEnv();
    const bad = await post(withSecrets(env), 'sunny-paws', event(), {
      'X-Billing-Secret': 'not-the-secret',
    });
    const unknown = await post(withSecrets(env), 'no-such-sitter', event());
    expect(bad.status).toBe(unknown.status);
    expect(bad.status).toBe(404);
    expect(await bad.text()).toBe(await unknown.text());
  });

  it('refuses a missing header, an empty one, and every request when no secret is configured', async () => {
    const { env } = createTestEnv();
    for (const [label, headers, over] of [
      ['missing', {}, {}],
      ['empty', { 'X-Billing-Secret': '' }, {}],
      ['unset on the deployment', { 'X-Billing-Secret': SECRET }, { BILLING_SHARED_SECRET: '' }],
    ] as const) {
      const res = await post(withSecrets(env, over), 'sunny-paws', event(), headers);
      expect(res.status, label).toBe(404);
      expect(await res.text(), label).toBe('{"error":"Unknown tenant"}');
    }
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.Plan).toBeNull();
  });

  it('accepts the PREVIOUS value too, so a rotation is an ordered pair of deploys', async () => {
    const { env } = createTestEnv();
    const rotating = withSecrets(env, { BILLING_SHARED_SECRET_PREVIOUS: PREVIOUS });
    expect(
      (await post(rotating, 'sunny-paws', event(), { 'X-Billing-Secret': PREVIOUS })).status,
    ).toBe(200);
    expect(
      (
        await post(rotating, 'sunny-paws', event({ eventId: 'evt_2', eventCreated: T0 + 60 }), {
          'X-Billing-Secret': SECRET,
        })
      ).status,
    ).toBe(200);
    // And a third value is still nobody's.
    expect(
      (await post(rotating, 'sunny-paws', event(), { 'X-Billing-Secret': 'third' })).status,
    ).toBe(404);
  });

  it('is ignored by adminAuth and by ownerAuth, which check their own credentials', async () => {
    const { env } = createTestEnv();
    const configured = withSecrets(env);
    const asAdmin = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${SECRET}`, 'X-Billing-Secret': SECRET } },
      configured,
    );
    expect(asAdmin.status).toBe(401);
    const asOwner = await app.request(
      '/api/owner/sitters',
      { headers: { Authorization: `Bearer ${SECRET}`, 'X-Billing-Secret': SECRET } },
      configured,
    );
    expect(asOwner.status).toBe(401);
    // And a real owner token does not open the billing endpoint either.
    const owner = await mintOwnerToken(OWNER_EMAIL, TEST_SECRET);
    expect(
      (await post(configured, 'sunny-paws', event(), { Authorization: `Bearer ${owner}` })).status,
    ).toBe(404);
  });

  it('compares in constant time, over both live values, without short-circuiting', () => {
    // Not measurable in vitest, so it is pinned at the source: a timing assertion that passes on a
    // loaded CI box would prove nothing, and the property is a property of the code.
    // Comments stripped: the docblock beside the loop legitimately quotes the very lines this
    // pins, and a probe that deleted the loop and left the docblock survived this assertion.
    const CODE = liveSource(BILLING_SOURCE, { keepLiterals: true });
    expect(CODE).toContain("import { constantTimeEqual } from '../lib/timing'");
    expect(CODE).toContain(
      'accepted = (constantTimeEqual(presented, candidate) && configured) || accepted;',
    );
    expect(CODE).not.toMatch(/presented ===/);
  });

  it('compares a FIXED pair of slots, so the time does not reveal a rotation in progress', () => {
    // A candidate list built by filtering out the unset slot is one comparison when one secret is
    // configured and two when two are — i.e. the response time says whether a rotation is under
    // way, which is exactly the window in which that is worth knowing. Both slots are always
    // compared; an unset one is compared against a sentinel that no caller can present and that
    // `configured` makes unmatchable anyway.
    // Executable text only — the docblock beside the loop legitimately names the `.filter()` this
    // forbids, through the one shared stripper the rest of the suite's source pins now use.
    const CODE = liveSource(BILLING_SOURCE, { keepLiterals: true });
    expect(CODE).toContain(
      'for (const slot of [env.BILLING_SHARED_SECRET, env.BILLING_SHARED_SECRET_PREVIOUS])',
    );
    expect(CODE).not.toContain('.filter(');
    expect(CODE).not.toContain('live.length === 0');
  });

  it('compares an unset slot at the PRESENTED length, so it cannot early-return', () => {
    // `constantTimeEqual` returns false on a length mismatch before comparing a single character,
    // so a fixed-length sentinel makes the unset slot cheaper than a real secret — and the response
    // time answers "is a rotation in progress" after all, which is the exact property the fixed
    // pair above exists to buy. The filler is built from the presented value's own length.
    const CODE = liveSource(BILLING_SOURCE);
    expect(CODE).toContain('presented.length');
    expect(CODE).toContain('configured ? slot : ');
  });

  it('never matches an unset slot, whatever is presented against it', () => {
    // The sentinel is a NUL-delimited string, which is not a legal HTTP header value — but the
    // function is exported, so the property is asserted directly rather than through a request.
    const SENTINEL = '\u0000unset\u0000';
    expect(billingSecretAccepted(SENTINEL, {} as Env)).toBe(false);
    expect(billingSecretAccepted(SENTINEL, { BILLING_SHARED_SECRET: SECRET } as Env)).toBe(false);
    expect(billingSecretAccepted(SECRET, { BILLING_SHARED_SECRET: SECRET } as Env)).toBe(true);
    expect(
      billingSecretAccepted(PREVIOUS, {
        BILLING_SHARED_SECRET: SECRET,
        BILLING_SHARED_SECRET_PREVIOUS: PREVIOUS,
      } as Env),
    ).toBe(true);
    expect(billingSecretAccepted(undefined, { BILLING_SHARED_SECRET: SECRET } as Env)).toBe(false);
    expect(billingSecretAccepted('', { BILLING_SHARED_SECRET: '' } as Env)).toBe(false);
  });

  it('refuses when the binding is ABSENT, not merely empty', async () => {
    // `''` and a genuinely missing binding are different values and were not the same test. A
    // deployment that sells nothing has no key at all.
    const { env } = createTestEnv();
    expect('BILLING_SHARED_SECRET' in env).toBe(false);
    const absent = await post(env, 'sunny-paws', event());
    expect(absent.status).toBe(404);
    expect(await absent.text()).toBe('{"error":"Unknown tenant"}');
    // And the explicitly-undefined shape a spread of a missing key produces.
    const undef = await post(
      { ...env, BILLING_SHARED_SECRET: undefined } as Env,
      'sunny-paws',
      event(),
    );
    expect(undef.status).toBe(404);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.Plan).toBeNull();
  });

  it('imports no payment-processor SDK, and this repo depends on none', () => {
    // The source half of this could never go red on its own — nothing in the diff approaches an
    // import of `stripe`. What CAN change is the dependency list, which is where a processor SDK
    // actually arrives, so the manifest is scanned beside the module.
    expect(BILLING_SOURCE).not.toMatch(/^import .*['"]stripe/im);
    expect(BILLING_SOURCE).not.toMatch(/constructEvent|verifyHeader|webhooks\./);
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const named = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(named.filter((n) => /stripe|braintree|adyen|square/i.test(n))).toEqual([]);
  });
});

describe('its own reserved slug is not a tenant', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * `billing` is in `RESERVED_SLUGS`, so `tenantMiddleware` calls `next()` for
   * `/api/billing/...` WITHOUT resolving a tenant — the same hole `adminAuth` guards against at
   * lib/middleware.ts. Dereferencing the unset tenant is a TypeError, which surfaces as a 500 and
   * tells a prober that the word is special. The guard is the same shape and the same answer.
   */
  it('answers the unknown-tenant refusal, good secret or bad, and never 500s', async () => {
    const { env } = createTestEnv();
    for (const [label, slug, headers] of [
      ['valid secret', 'billing', { 'X-Billing-Secret': SECRET }],
      ['bad secret', 'billing', { 'X-Billing-Secret': 'not-the-secret' }],
      ['no secret', 'billing', {}],
      ['another reserved word', 'owner', { 'X-Billing-Secret': SECRET }],
    ] as const) {
      const res = await post(withSecrets(env), slug, event(), headers);
      expect(res.status, label).toBe(404);
      expect(await res.text(), label).toBe('{"error":"Unknown tenant"}');
    }
  });

  it('fires no security event for it: there is no tenant to attribute one to', async () => {
    // The guard sits BEFORE the secret comparison, so a reserved path is refused as a path and not
    // as a credential — `securityEvent`'s detail has no slug to carry, and a line naming the
    // wrong thing is worse than no line.
    const { env } = createTestEnv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await post(withSecrets(env), 'billing', event(), { 'X-Billing-Secret': 'not-the-secret' });
    await post(withSecrets(env), 'billing', event());
    expect(warn.mock.calls.map((call) => JSON.stringify(call)).join('\n')).not.toContain(
      'billing_secret_rejected',
    );
  });
});

describe('a valid event records what the subscription paid for', () => {
  it('sets the plan and the date, records both ids, advances the stamp', async () => {
    const { env } = createTestEnv();
    const res = await post(withSecrets(env), 'sunny-paws', event());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });

    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.Plan).toBe('pro');
    expect(t.StripeCustomerId).toBe('cus_A');
    expect(t.StripeSubscriptionId).toBe('sub_A');
    expect(t.LastBillingEventAt).not.toBeNull();
  });

  it('stores the date in the shape the comparison can read, never as sent', async () => {
    const { env } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event({ billedUntil: '2026-10-08T00:00:00Z' }));
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil).toBe(
      '2026-10-08 00:00:00',
    );
  });

  it('makes the new plan visible at once, past the tenant cache', async () => {
    const { env } = createTestEnv();
    // Warm the cache with the free row first, so a stale entry would be there to read.
    expect((await resolveTenant('sunny-paws', env))!.Plan).toBeNull();
    await post(withSecrets(env), 'sunny-paws', event());
    expect((await resolveTenant('sunny-paws', env))!.Plan).toBe('pro');
  });

  it('leaves PremiumUntil byte-identical, including on a cancellation after a comp', async () => {
    // THE NAMED TEST. A comp is the platform owner's grant; a subscription is the sitter's own
    // money. Neither is allowed to move the other, and a cancellation is where a careless
    // implementation would clear both.
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET PremiumUntil = '2099-01-01 00:00:00' WHERE Id = '${TENANT_A}'`);
    const before = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.PremiumUntil;
    const lapsed = daysFromNow(-1);

    await post(withSecrets(env), 'sunny-paws', event());
    await post(
      withSecrets(env),
      'sunny-paws',
      event({
        eventType: 'customer.subscription.deleted',
        billedUntil: lapsed,
        eventId: 'evt_del',
        eventCreated: T0 + 60,
      }),
    );

    const after = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(after.PremiumUntil).toBe(before);
    // The plan lapsed and the comp did not — asserted as the two stored VALUES rather than as a
    // comparison between the two columns, because `premium-entitlement.test.ts`'s AD-13 scanner
    // refuses that comparison in any module but server/lib/premium.ts, test files included.
    expect(after.BilledUntil).toBe(normalizeBilledUntil(lapsed));
    expect(after.PremiumUntil).toBe('2099-01-01 00:00:00');
  });

  it('moves one tenant and no other', async () => {
    const { env } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event());
    const b = (await getTenantById(env.PAWSERVATION_DB, TENANT_B))!;
    expect(b.Plan).toBeNull();
    expect(b.BilledUntil).toBeNull();
    expect(b.PremiumUntil).toBeNull();
  });
});

describe('which event wins', () => {
  it('APPLIES a repeat of the same event and leaves the row byte-identical (NFR-13)', async () => {
    // Equality is not staleness. Stripe emits `checkout.session.completed` and
    // `customer.subscription.updated` for one action inside the same second, and the old `<=` threw
    // the second one away with a different payload. Idempotence is bought by SET semantics instead,
    // which is the stronger statement: the row after the repeat is byte-identical, column for
    // column, `LastBillingEventAt` included.
    const { env } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event());
    const first = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;

    const res = await post(withSecrets(env), 'sunny-paws', event());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    expect(await getTenantById(env.PAWSERVATION_DB, TENANT_A)).toEqual(first);
  });

  it('applies a DIFFERENT event created in the same second as the last one', async () => {
    // The case the old rule actually lost: one action, two events, one second.
    const { env } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event());
    const res = await post(
      withSecrets(env),
      'sunny-paws',
      event({
        eventType: 'customer.subscription.updated',
        billedUntil: daysFromNow(62),
        eventId: 'evt_same_second',
        eventCreated: T0,
      }),
    );
    expect(await res.json()).toEqual({ applied: true });
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil).toBe(
      normalizeBilledUntil(daysFromNow(62)),
    );
  });

  it('ignores an event older than the last one applied', async () => {
    const { env } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event({ eventCreated: T0 }));
    const res = await post(
      withSecrets(env),
      'sunny-paws',
      event({ eventCreated: T0 - 3600, billedUntil: daysFromNow(-1), eventId: 'evt_old' }),
    );
    expect(await res.json()).toEqual({ applied: false, reason: 'stale_event' });
    // The first event's own date, unchanged by the older one.
    const stored = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil;
    expect(stored).toBe(normalizeBilledUntil(BILLED));
  });

  it('ignores an event for a subscription that is not the current one', async () => {
    const { env } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event()); // sub_A
    const kept = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil;
    const res = await post(
      withSecrets(env),
      'sunny-paws',
      event({
        eventType: 'invoice.paid',
        stripeSubscriptionId: 'sub_OTHER',
        billedUntil: daysFromNow(200),
        eventId: 'evt_other',
        eventCreated: T0 + 60,
      }),
    );
    expect(await res.json()).toEqual({ applied: false, reason: 'not_current_subscription' });
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil).toBe(kept);
  });

  it('lets a new checkout replace the subscription, so a late cancellation cannot lower it', async () => {
    // THE NAMED TEST. She cancelled, then subscribed again; the cancellation for the OLD
    // subscription arrives afterwards and must not take the new plan down with it.
    const { env } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event()); // checkout, sub_A
    await post(
      withSecrets(env),
      'sunny-paws',
      event({
        stripeSubscriptionId: 'sub_B',
        billedUntil: daysFromNow(60),
        eventId: 'evt_checkout_b',
        eventCreated: T0 + 60,
      }),
    ); // checkout, sub_B
    const afterB = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil;

    const late = await post(
      withSecrets(env),
      'sunny-paws',
      event({
        eventType: 'customer.subscription.deleted',
        stripeSubscriptionId: 'sub_A',
        billedUntil: daysFromNow(-1),
        eventId: 'evt_del_a',
        eventCreated: T0 + 120,
      }),
    );
    expect(await late.json()).toEqual({ applied: false, reason: 'not_current_subscription' });
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.StripeSubscriptionId).toBe('sub_B');
    expect(t.BilledUntil).toBe(afterB);
  });
});

describe('what it refuses on its content', () => {
  it('refuses a plan outside the two, a bad date, a date past the ceiling, and a missing field', async () => {
    const { env } = createTestEnv();
    const configured = withSecrets(env);
    for (const [label, body] of [
      ['unknown plan', event({ plan: 'enterprise' })],
      ['unknown event type', event({ eventType: 'invoice.voided' })],
      ['unparseable date', event({ billedUntil: 'next tuesday' })],
      ['past the ceiling', event({ billedUntil: daysFromNow(401) })],
      ['missing field', { plan: 'pro', billedUntil: daysFromNow(31) }],
      ['not an object', 'nope'],
    ] as const) {
      const res = await post(configured, 'sunny-paws', body);
      expect(res.status, label).toBe(400);
    }
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.Plan).toBeNull();
    expect(t.BilledUntil).toBeNull();
    expect(t.LastBillingEventAt).toBeNull();
  });

  it('accepts EXACTLY the ceiling and refuses one day past it', async () => {
    // The boundary itself, both sides. `MAX_BILLED_AHEAD_DAYS` is 400 and the comparison is `>`,
    // so 400 days out is the longest thing this endpoint will store — an annual plan billed to the
    // day must not be refused by the containment that exists for a leaked secret.
    const { env } = createTestEnv();
    expect(
      (await post(withSecrets(env), 'sunny-paws', event({ billedUntil: daysFromNow(399) }))).status,
    ).toBe(200);
    const { env: env400 } = createTestEnv();
    expect(
      (await post(withSecrets(env400), 'sunny-paws', event({ billedUntil: daysFromNow(400) })))
        .status,
    ).toBe(200);
    expect((await getTenantById(env400.PAWSERVATION_DB, TENANT_A))!.BilledUntil).not.toBeNull();
    const { env: env401 } = createTestEnv();
    expect(
      (await post(withSecrets(env401), 'sunny-paws', event({ billedUntil: daysFromNow(401) })))
        .status,
    ).toBe(400);
    expect((await getTenantById(env401.PAWSERVATION_DB, TENANT_A))!.BilledUntil).toBeNull();
  });

  it('accepts a date in the PAST, because a lapsed subscription is a fact worth recording', async () => {
    const { env } = createTestEnv();
    const res = await post(
      withSecrets(env),
      'sunny-paws',
      event({ eventType: 'customer.subscription.deleted', billedUntil: daysFromNow(-30) }),
    );
    expect(res.status).toBe(200);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.BilledUntil).not.toBeNull();
  });

  it('keeps tenantMiddleware’s 403 for a disabled tenant, gate and all', async () => {
    // Not carved out. A disabled sitter's mutations are refused at the one chokepoint the whole
    // /api/:slug/* surface flows through, and billing is a mutation. Entitlement is unaffected
    // either way — a disabled tenant is premium under neither clause — so what goes stale is the
    // bookkeeping, and the caller treats the 403 as an orphaned event rather than retrying.
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET DisabledAt = '2026-07-23 00:00:00' WHERE Id = '${TENANT_A}'`);
    const res = await post(withSecrets(env), 'sunny-paws', event());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('{"error":"account_disabled"}');
  });
});

describe('what it refuses on its shape', () => {
  it('refuses an empty processor id, which would brick the row permanently', async () => {
    // `''` is not a missing field to valibot, so it stored: an empty `StripeSubscriptionId` then
    // matches no incoming subscription and every later non-checkout event is
    // `not_current_subscription` forever, and an empty `StripeCustomerId` survives the `COALESCE`
    // and can never be corrected. Both are unreachable without hand-written SQL.
    const { env } = createTestEnv();
    for (const [label, body] of [
      ['empty customer', event({ stripeCustomerId: '' })],
      ['empty subscription', event({ stripeSubscriptionId: '' })],
    ] as const) {
      const res = await post(withSecrets(env), 'sunny-paws', body);
      expect(res.status, label).toBe(400);
    }
    const t = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;
    expect(t.Plan).toBeNull();
    expect(t.StripeCustomerId).toBeNull();
  });

  it('bounds every string field, so one request cannot write a megabyte into a column', async () => {
    const { env } = createTestEnv();
    const long = 'x'.repeat(256);
    for (const [label, body] of [
      ['customer id', event({ stripeCustomerId: long })],
      ['subscription id', event({ stripeSubscriptionId: long })],
      ['event id', event({ eventId: long })],
      ['billedUntil', event({ billedUntil: long })],
    ] as const) {
      expect((await post(withSecrets(env), 'sunny-paws', body)).status, label).toBe(400);
    }
    // And the boundary itself is usable: 255 is accepted where the value is otherwise valid.
    expect(
      (await post(withSecrets(env), 'sunny-paws', event({ eventId: 'e'.repeat(255) }))).status,
    ).toBe(200);
  });

  it('refuses an eventCreated more than five minutes in the future', async () => {
    // A stamp jumped to 2100 — or to next week — is stored as `LastBillingEventAt`, after which
    // every real event is older than it and the row is frozen with no recovery but hand-written
    // SQL. Five minutes is clock skew between two workers, which is the only future this endpoint
    // has a reason to accept.
    const { env } = createTestEnv();
    expect(
      (await post(withSecrets(env), 'sunny-paws', event({ eventCreated: T0 + 3600 }))).status,
    ).toBe(400);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.LastBillingEventAt).toBeNull();
    // Inside the skew window, accepted.
    expect(
      (await post(withSecrets(env), 'sunny-paws', event({ eventCreated: T0 + 240 }))).status,
    ).toBe(200);
  });

  it('refuses a malformed body under a BAD secret as an unknown tenant, never a 400', async () => {
    // The ordering is the property: a 400 here would tell an unauthenticated caller that both the
    // endpoint and the slug are real, which is exactly what the byte-identical 404 exists to hide.
    const { env } = createTestEnv();
    const res = await post(
      withSecrets(env),
      'sunny-paws',
      { nonsense: true },
      {
        'X-Billing-Secret': 'not-the-secret',
      },
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"Unknown tenant"}');
    // And the same malformed body WITH the secret is the 400 it deserves, so the pin is not
    // vacuously green on a body that happens to be fine.
    const good = await post(withSecrets(env), 'sunny-paws', { nonsense: true });
    expect(good.status).toBe(400);
  });
});

describe('the reserved slug is reserved, and no sitter holds one', () => {
  it("has 'billing' in RESERVED_SLUGS, beside the four that were already there", () => {
    // Asserted directly. The reserved-slug block above answers 404 for `billing` whether or not the
    // word is reserved — an unseeded slug produces the same 404 — so removing the reservation left
    // that test green.
    expect(RESERVED_SLUGS.has('billing')).toBe(true);
    for (const word of ['admin', 'signup', 'owner', 'password-reset']) {
      expect(RESERVED_SLUGS.has(word), word).toBe(true);
    }
  });

  it('refuses a SEEDED tenant whose slug is the reserved word', async () => {
    // The collision a pre-0017 tenant could already be in: `tenantMiddleware` `next()`s a reserved
    // slug without resolving a tenant, so the row exists and its whole `/api/billing/*` surface
    // resolves nothing. The answer must still be the unknown-tenant 404 and never a 500.
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET Slug = 'billing' WHERE Id = '${TENANT_B}'`);
    const res = await post(withSecrets(env), 'billing', event());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('{"error":"Unknown tenant"}');
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_B))!.Plan).toBeNull();
  });

  it('holds no seeded tenant on a reserved word', () => {
    // The check the migration's comment tells an operator to run against production before applying
    // 0017, run here against the seed so the fixture can never drift into the collision it warns
    // about.
    const { raw } = createTestEnv();
    const slugs = (raw.prepare('SELECT Slug FROM Tenants').all() as { Slug: string }[]).map(
      (t) => t.Slug,
    );
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs.filter((slug) => RESERVED_SLUGS.has(slug))).toEqual([]);
  });
});

describe('a refused secret cannot be ground at line rate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stops writing a rejection line once the cap for that caller is reached', async () => {
    // This repo owns `checkAndBumpRateLimit` and applies it to its three other unauthenticated
    // surfaces. Bumped on the REFUSAL path only: a legitimate caller retrying a delivery storm is
    // never counted, and the answer over the cap is the same 404, so the limiter is not an oracle.
    const { env } = createTestEnv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 40; i++) {
      const res = await post(withSecrets(env), 'sunny-paws', event(), {
        'X-Billing-Secret': 'not-the-secret',
        'CF-Connecting-IP': '203.0.113.9',
      });
      expect(res.status).toBe(404);
    }
    const lines = warn.mock.calls
      .map((call) => JSON.stringify(call))
      .filter((line) => line.includes('billing_secret_rejected'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(40);
  });

  it('never counts an ACCEPTED event against the cap', async () => {
    const { env } = createTestEnv();
    for (let i = 0; i < 40; i++) {
      const res = await post(withSecrets(env), 'sunny-paws', event({ eventCreated: T0 + i }), {
        'X-Billing-Secret': SECRET,
        'CF-Connecting-IP': '203.0.113.9',
      });
      expect(res.status).toBe(200);
    }
  });
});

describe('what it says in the log when it declines', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the eventId and the request on a refusal and on both ignore reasons', async () => {
    // `eventId` is documented as "the handle that ties a line in this worker's log to a line in the
    // caller's" and reached no log line at all, so a systematic billing failure presented as
    // silence on this side.
    const { env } = createTestEnv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ray = { 'CF-Ray': '9a9a9a9a9a9a9a9a-LHR' };

    // A 400 on the schema.
    await post(withSecrets(env), 'sunny-paws', event({ plan: 'enterprise', eventId: 'evt_bad' }), {
      'X-Billing-Secret': SECRET,
      ...ray,
    });
    // A 400 on the date.
    await post(
      withSecrets(env),
      'sunny-paws',
      event({ billedUntil: 'next tuesday', eventId: 'evt_date' }),
      { 'X-Billing-Secret': SECRET, ...ray },
    );
    // Both ignore reasons.
    await post(withSecrets(env), 'sunny-paws', event({ eventCreated: T0 }));
    await post(
      withSecrets(env),
      'sunny-paws',
      event({ eventCreated: T0 - 3600, eventId: 'evt_stale' }),
      { 'X-Billing-Secret': SECRET, ...ray },
    );
    await post(
      withSecrets(env),
      'sunny-paws',
      event({
        eventType: 'invoice.paid',
        stripeSubscriptionId: 'sub_OTHER',
        eventId: 'evt_other',
        eventCreated: T0 + 60,
      }),
      { 'X-Billing-Secret': SECRET, ...ray },
    );

    const log = warn.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    for (const id of ['evt_bad', 'evt_date', 'evt_stale', 'evt_other']) {
      expect(log, id).toContain(id);
    }
    expect(log).toContain('stale_event');
    expect(log).toContain('not_current_subscription');
    expect(log).toContain('9a9a9a9a9a9a9a9a-LHR');
    // And still no secret, and no slug it does not own.
    expect(log).not.toContain(SECRET);
  });

  it('records what a displacing checkout replaced, in the answer and in the log', async () => {
    // A re-subscribe assigns a new subscription id over a live one and `COALESCE`s the customer, so
    // the row can name subscription B against customer A. Silence made that invisible on both
    // sides; the caller now learns what its checkout displaced.
    const { env } = createTestEnv();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await post(withSecrets(env), 'sunny-paws', event());
    const res = await post(
      withSecrets(env),
      'sunny-paws',
      event({
        stripeCustomerId: 'cus_OTHER',
        stripeSubscriptionId: 'sub_B',
        eventId: 'evt_checkout_b',
        eventCreated: T0 + 60,
      }),
    );
    expect(await res.json()).toEqual({ applied: true, replaced: 'sub_A' });
    const log = warn.mock.calls.map((call) => JSON.stringify(call)).join('\n');
    expect(log).toContain('billing_customer_changed');
    // The first checkout displaced nothing, so it says nothing.
    const { env: fresh } = createTestEnv();
    expect(await (await post(withSecrets(fresh), 'sunny-paws', event())).json()).toEqual({
      applied: true,
    });
  });

  it('answers the caller even when dropping the tenant cache throws', async () => {
    // The write has already landed. A 500 here makes the caller retry, the retry is answered from
    // its own ordering rules and returns before the invalidate — so the tenant stays on the stale
    // cached row until the TTL, for a failure that happened AFTER the thing it was reporting
    // succeeded.
    const { env } = createTestEnv();
    const exploding = {
      ...env,
      PAWSERVATION_CACHE: {
        ...env.PAWSERVATION_CACHE,
        get: env.PAWSERVATION_CACHE.get.bind(env.PAWSERVATION_CACHE),
        put: env.PAWSERVATION_CACHE.put.bind(env.PAWSERVATION_CACHE),
        delete: () => Promise.reject(new Error('KV is having a day')),
      },
    } as unknown as Env;
    const res = await post(withSecrets(exploding), 'sunny-paws', event());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))!.Plan).toBe('pro');
  });

  it('drops the cached row on an ignored event too, so a retry is not served a stale one', async () => {
    // The retry path the invalidate-after-commit failure leaves behind: the write landed, the
    // cache was not dropped, and the redelivery is answered `stale_event` and returns — so nothing
    // ever drops it. A cached row written behind this endpoint's back stands in for that.
    const { env, raw } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event());
    expect((await resolveTenant('sunny-paws', env))!.Plan).toBe('pro');
    raw.exec(`UPDATE Tenants SET Plan = 'solo' WHERE Id = '${TENANT_A}'`);
    expect((await resolveTenant('sunny-paws', env))!.Plan).toBe('pro'); // still the cached row

    const res = await post(
      withSecrets(env),
      'sunny-paws',
      event({ eventCreated: T0 - 3600, eventId: 'evt_stale' }),
    );
    expect(await res.json()).toEqual({ applied: false, reason: 'stale_event' });
    expect((await resolveTenant('sunny-paws', env))!.Plan).toBe('solo');
  });

  it('writes and invalidates against the FRESHLY read row, not the cached one', () => {
    // The route re-reads the row because "a cached row is up to a TTL behind its own last write",
    // then used that same cached row's `Id` to write and its `Slug` to invalidate. Distrusting it
    // for ordering and trusting it for identity is one or the other.
    const CODE = liveSource(BILLING_SOURCE);
    expect(CODE).toContain('row.Id');
    expect(CODE).toContain('row.Slug');
    expect(CODE).not.toContain('tenant.Id,');
    expect(CODE).not.toContain('invalidateTenantCache(tenant.Slug');
  });
});
