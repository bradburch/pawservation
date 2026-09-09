import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { getTenantById } from '../db/repo';
import { normalizeBilledUntil } from '../lib/premium';
import { mintOwnerToken } from '../lib/token';
import { resolveTenant } from '../lib/tenant-resolve';
import { createTestEnv, OWNER_EMAIL, TENANT_A, TENANT_B, TEST_SECRET } from './helpers';

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
    const SOURCE = readFileSync(join(import.meta.dirname, '..', 'routes', 'billing.ts'), 'utf8');
    expect(SOURCE).toContain("import { constantTimeEqual } from '../lib/timing'");
    expect(SOURCE).toContain('accepted = constantTimeEqual(presented, candidate) || accepted;');
    expect(SOURCE).not.toMatch(/presented ===/);
  });

  it('imports no payment-processor SDK: it takes a date, not a processor object', () => {
    const SOURCE = readFileSync(join(import.meta.dirname, '..', 'routes', 'billing.ts'), 'utf8');
    expect(SOURCE).not.toMatch(/^import .*['"]stripe/im);
    expect(SOURCE).not.toMatch(/constructEvent|verifyHeader|webhooks\./);
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
  it('ignores a repeat of the same event, and changes nothing (NFR-13)', async () => {
    const { env } = createTestEnv();
    await post(withSecrets(env), 'sunny-paws', event());
    const first = (await getTenantById(env.PAWSERVATION_DB, TENANT_A))!;

    const res = await post(withSecrets(env), 'sunny-paws', event());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: false, reason: 'stale_event' });
    expect(await getTenantById(env.PAWSERVATION_DB, TENANT_A)).toEqual(first);
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
