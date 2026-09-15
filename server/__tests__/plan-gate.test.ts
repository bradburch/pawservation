import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminToken, createTestEnv, TENANT_A, TENANT_B } from './helpers';
import { premiumNow } from '../lib/premium';

/**
 * A LAPSED PLAN IS A READ-ONLY DASHBOARD (Story 10.4), in `disabled-guard.test.ts`'s shape.
 *
 * The gate is ONE `.use()` line declared immediately after `adminAuth`, so its scope is exactly
 * `adminAuth`'s flattened scope and not a list anybody maintains. What this file pins is the three
 * things that scope means: every non-GET under `/:slug/admin/*` is covered including the two files
 * that declare their admin routes elsewhere; every GET is not; and the two paths that must NEVER be
 * covered — the billing endpoint she un-lapses through, and the whole booking surface — are not.
 *
 * IT SHIPS DARK. `PLAN_ENFORCE` unset refuses nothing, which is the only safe shape on the day this
 * merges: migration 0017 seeded nothing and tenant creation writes no plan, so every business in
 * the book reads as holding none until the owner sweeps. The var is the whole of that safety and
 * this file asserts both of its positions.
 */

const enforcing = (env: Env): Env => ({ ...env, PLAN_ENFORCE: 'true' }) as Env;

const minutesFromNow = (minutes: number): string =>
  premiumNow(new Date(Date.now() + minutes * 60_000));

const headers = async (tenantId: string) => ({
  Authorization: `Bearer ${await adminToken(tenantId)}`,
  'Content-Type': 'application/json',
});

/** The settings PUT — the same route `disabled-guard.test.ts` uses for the disabled refusal, so the
 *  two guards are compared on identical ground. */
const putSettings = async (env: Env, slug: string, tenantId: string) =>
  app.request(
    `/api/${slug}/admin/settings`,
    { method: 'PUT', headers: await headers(tenantId), body: '{}' },
    env,
  );

const comp = (raw: ReturnType<typeof createTestEnv>['raw'], tenantId: string, until: string) =>
  raw.prepare('UPDATE Tenants SET CompedUntil = ? WHERE Id = ?').run(until, tenantId);

const LAPSED = { error: 'plan_lapsed' };

describe('the lapse gate refuses writes and never reads', () => {
  it('answers 402 plan_lapsed on a write and 200 on the read that renders the notice', async () => {
    const { env } = createTestEnv(); // every seeded row holds no grant at all
    const put = await putSettings(enforcing(env), 'sunny-paws', TENANT_A);
    expect(put.status).toBe(402);
    expect(await put.json()).toEqual(LAPSED);

    // THE READ MUST PASS. It is the request that renders the banner and the Subscribe control, so
    // gating it would make the lapse unfixable from the UI — which is why the rule is on the
    // METHOD and not on a path list.
    const get = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await headers(TENANT_A) },
      enforcing(env),
    );
    expect(get.status).toBe(200);
    expect(((await get.json()) as { planCurrent: boolean }).planCurrent).toBe(false);
  });

  it('lets the same business write once she holds a live comp', async () => {
    const { env, raw } = createTestEnv();
    comp(raw, TENANT_A, minutesFromNow(60));
    const put = await putSettings(enforcing(env), 'sunny-paws', TENANT_A);
    expect(put.status).not.toBe(402);
  });

  it('refuses nothing while PLAN_ENFORCE is unset, though the read still says false', async () => {
    const { env } = createTestEnv();
    expect('PLAN_ENFORCE' in env).toBe(false); // the state every fork and this repo's own config is in
    const put = await putSettings(env, 'sunny-paws', TENANT_A);
    expect(put.status).not.toBe(402);

    // `planCurrent` is the TENANT's state and not the gate's answer, so it answers false either
    // way. That is the honest consequence of publishing one field that means one thing: between
    // this deploy and the owner finishing the comp sweep, the banner is early rather than wrong.
    const get = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await headers(TENANT_A) },
      env,
    );
    expect(((await get.json()) as { planCurrent: boolean }).planCurrent).toBe(false);
  });

  it('is off for every truthy-looking value that is not exactly true', async () => {
    const { env } = createTestEnv();
    for (const value of ['1', 'yes', 'TRUE!', '', ' ']) {
      const put = await putSettings({ ...env, PLAN_ENFORCE: value } as Env, 'sunny-paws', TENANT_A);
      expect(put.status, value).not.toBe(402);
    }
    // …and on for the string itself, however it is cased or padded.
    for (const value of ['true', ' TRUE ', 'True']) {
      const put = await putSettings({ ...env, PLAN_ENFORCE: value } as Env, 'sunny-paws', TENANT_A);
      expect(put.status, value).toBe(402);
    }
  });

  it('answers a disabled AND lapsed business account_disabled, never plan_lapsed', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET DisabledAt = '2026-07-23 00:00:00' WHERE Id = '${TENANT_A}';`);
    const put = await putSettings(enforcing(env), 'sunny-paws', TENANT_A);
    // `tenantMiddleware` runs at server/index.ts:103, long before adminRoutes at :118, so a
    // switched-off account is always refused first — which is correct, because it is the stronger
    // fact — and `isPlanCurrent` is false for her anyway, so the two can never contradict.
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: 'account_disabled' });
  });

  it('answers an unauthenticated write 401, and says nothing about her plan', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      enforcing(env),
    );
    // Declared AFTER adminAuth, deliberately: a caller with no credential learns nothing about
    // whether a business exists, is paid up, or is switched off.
    expect(put.status).toBe(401);
    expect(await put.text()).not.toContain('plan_lapsed');
  });
});

describe('what the gate must never reach', () => {
  it('never refuses the billing endpoint, which is how she un-lapses', async () => {
    // Registered at server/index.ts:117, BEFORE adminRoutes at :118 — so `adminAuth` never reaches
    // it and neither does this gate. THE EXCLUSION IS LOAD-BEARING, and this is the case that fails
    // the day someone "tidies" the mount order.
    //
    // Driven with a VALID secret on a LAPSED business, all the way to `{ applied: true }`, because
    // the exemption's whole point is that the event LANDS: a case that posts no secret and asserts
    // only `!== 402` is satisfied by the route's own 404 and holds under either mount order, which
    // is to say it holds on the day the gate starts refusing her only way back.
    const { env } = createTestEnv(); // every seeded row holds no grant at all
    const BILLING_SECRET = 'plan-gate-billing-secret-0123456789';
    const billing = { ...enforcing(env), BILLING_SHARED_SECRET: BILLING_SECRET } as Env;

    // She is lapsed before the event, stated rather than assumed — without this the 200 below
    // proves only that the endpoint works, not that it works for somebody the gate refuses.
    expect((await putSettings(billing, 'sunny-paws', TENANT_A)).status).toBe(402);

    const res = await app.request(
      '/api/sunny-paws/admin/billing/events',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Billing-Secret': BILLING_SECRET },
        body: JSON.stringify({
          eventType: 'checkout.session.completed',
          plan: 'pro',
          billedUntil: new Date(Date.now() + 31 * 86_400_000).toISOString(),
          stripeCustomerId: 'cus_A',
          stripeSubscriptionId: 'sub_A',
          eventId: 'evt_plan_gate',
          eventCreated: Math.floor(Date.now() / 1000),
        }),
      },
      billing,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: true });

    // …and she is un-lapsed: the very write refused above now passes, and TENANT_B is untouched.
    expect((await putSettings(billing, 'sunny-paws', TENANT_A)).status).not.toBe(402);
    expect((await putSettings(billing, 'happy-tails', TENANT_B)).status).toBe(402);
  });

  it('never refuses the booking surface — A-17, satisfied by scope rather than by a clause', async () => {
    const { env } = createTestEnv();
    // Her clients keep booking when her plan lapses. The gate is mounted in `adminRoutes` and not
    // in `tenantMiddleware` precisely so this is true by prefix: this is the case that fails the
    // day the gate migrates into the middleware that covers the whole /api/:slug/* surface.
    const identify = await app.request(
      '/api/sunny-paws/identify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"email":"jess@example.com"}',
      },
      enforcing(env),
    );
    expect(identify.status).not.toBe(402);

    const booking = await app.request(
      '/api/sunny-paws/bookings',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      enforcing(env),
    );
    expect(booking.status).not.toBe(402);
  });

  it('covers the admin writes declared in OTHER files, by inheriting the flattened scope', async () => {
    const { env } = createTestEnv();
    // `adminAuth`'s pattern is flattened across every app mounted at /api, so it already reaches
    // routes declared in accounts.ts and tenant-tokens.ts — and so does this gate, for free. Pinned
    // rather than assumed: "it inherits the scope" is the design, and an inheritance nobody checked
    // is an inheritance nobody has.
    const payment = await app.request(
      '/api/sunny-paws/admin/accounts/pet_1/payments',
      { method: 'POST', headers: await headers(TENANT_A), body: '{}' },
      enforcing(env),
    );
    expect(payment.status).toBe(402);
    expect(await payment.json()).toEqual(LAPSED);

    const token = await app.request(
      '/api/sunny-paws/admin/tokens',
      { method: 'POST', headers: await headers(TENANT_A), body: '{"name":"CI bot"}' },
      enforcing(env),
    );
    expect(token.status).toBe(402);
    expect(await token.json()).toEqual(LAPSED);
  });
});

describe('two businesses, because a cross-tenant lapse looks completely ordinary doing it', () => {
  it('refuses A and leaves B untouched, and tells A nothing about B', async () => {
    const { env, raw } = createTestEnv();
    comp(raw, TENANT_B, minutesFromNow(60)); // B is current; A holds nothing

    const a = await putSettings(enforcing(env), 'sunny-paws', TENANT_A);
    expect(a.status).toBe(402);
    const b = await putSettings(enforcing(env), 'happy-tails', TENANT_B);
    expect(b.status).not.toBe(402);

    // Asserting the refusal's STATUS alone would pass against a handler that read the wrong row and
    // refused afterwards, so assert that A's own read carries no field of B's plan state either.
    const read = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await headers(TENANT_A) },
      enforcing(env),
    );
    const body = (await read.json()) as { planCurrent: boolean; billedUntil: string | null };
    expect(body.planCurrent).toBe(false);
    expect(body.billedUntil).toBeNull();

    // And A's credential against B's path is still refused by the chain that already existed.
    const across = await app.request(
      '/api/happy-tails/admin/settings',
      { method: 'PUT', headers: await headers(TENANT_A), body: '{}' },
      enforcing(env),
    );
    expect([401, 403]).toContain(across.status);
  });
});
