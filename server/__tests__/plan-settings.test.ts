import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTenantAccessToken } from '../db/repo';
import { generateTenantAccessToken, hashPersonalAccessToken } from '../lib/personal-access-token';
import { premiumNow } from '../lib/premium';
import { MAX_LIVE_TOKENS_PER_USER } from '../routes/tenant-tokens';
import { adminToken, createTestEnv, TENANT_A, TENANT_B } from './helpers';

/**
 * PLAN STATE ON THE READ THE DASHBOARD ALREADY MAKES (Story 10.3).
 *
 * Five fields on `GET /:slug/admin/settings` and no new route: this one is already authenticated,
 * already tenant-scoped by the slug in its path, and already fetched once per dashboard load. A
 * second route for two fields is a second thing to authenticate, rate-limit, cache and contract.
 *
 * Every claim below is about the PAYLOAD, never about the derivation: `planActive` is
 * `isSoloActive`'s answer and this file asserts the route publishes what that helper says, not
 * that some comparison came out a particular way. AD-13's scanner walks this file too.
 */

type PlanFields = {
  plan: 'solo' | 'pro' | null;
  billedUntil: string | null;
  planActive: boolean;
  hasBillingAccount: boolean;
  stripeCustomerId?: string | null;
};

const SLUG = { [TENANT_A]: 'sunny-paws', [TENANT_B]: 'happy-tails' } as const;

/**
 * A stored instant `minutes` from now, in the column's own shape. A MINUTE either side rather
 * than the second the design names: the suite seeds a row, mints a token and dispatches a request
 * between reading the clock here and the route reading it again, and a one-second margin turns a
 * slow machine into a flaky test. The exact `>` boundary — is `BilledUntil === now` live? — is
 * probed separately below by seeding `now` itself, which cannot flake in the other direction: a
 * stamp equal to now only gets further into the past while the test runs.
 */
const minutesFromNow = (minutes: number): string =>
  premiumNow(new Date(Date.now() + minutes * 60_000));

/** Plan state written straight onto the row, the way the billing endpoint would have. Synchronous
 *  on the raw handle so a test can seed before its first request — which also means no tenant
 *  cache entry exists yet, and none has to be invalidated. */
function seedPlan(
  raw: ReturnType<typeof createTestEnv>['raw'],
  tenantId: string,
  row: { plan: 'solo' | 'pro'; billedUntil: string; customerId: string },
): void {
  raw
    .prepare('UPDATE Tenants SET Plan = ?, BilledUntil = ?, StripeCustomerId = ? WHERE Id = ?')
    .run(row.plan, row.billedUntil, row.customerId, tenantId);
}

const settings = (env: Env, slug: string, credential: string) =>
  app.request(
    `/api/${slug}/admin/settings`,
    { headers: { Authorization: `Bearer ${credential}` } },
    env,
  );

/** The body, asserted to be a 200 first — a shape assertion against a 401 body passes vacuously. */
async function read(env: Env, slug: string, credential: string): Promise<PlanFields> {
  const res = await settings(env, slug, credential);
  expect(res.status).toBe(200);
  return (await res.json()) as PlanFields;
}

/** A live `pawsa_` credential for one sitter, minted straight through the repo. */
async function mintTenantToken(env: Env, tenantId: string, tenantUserId: string): Promise<string> {
  const token = generateTenantAccessToken();
  const created = await createTenantAccessToken(env.PAWSERVATION_DB, tenantId, {
    tenantUserId,
    name: 'CI bot',
    tokenHash: await hashPersonalAccessToken(token),
    maxLive: MAX_LIVE_TOKENS_PER_USER,
  });
  expect(created).not.toBeNull();
  return token;
}

describe('the settings read publishes the sitter’s own plan', () => {
  it('states the plan, the paid-through instant and both booleans, verbatim', async () => {
    const { env, raw } = createTestEnv();
    const paidThrough = minutesFromNow(60);
    seedPlan(raw, TENANT_A, { plan: 'pro', billedUntil: paidThrough, customerId: 'cus_sunny' });

    const body = await read(env, SLUG[TENANT_A], await adminToken(TENANT_A));
    expect(body.plan).toBe('pro');
    // VERBATIM. The route must not invent a second format: the dashboard renders this string and
    // the paid surface reads it, and two formats is one of them being wrong somewhere.
    expect(body.billedUntil).toBe(paidThrough);
    expect(body.planActive).toBe(true);
    expect(body.hasBillingAccount).toBe(true);
    expect(body.stripeCustomerId).toBe('cus_sunny');
  });

  it('answers null and false for a sitter who has never subscribed, and not a 404', async () => {
    const { env } = createTestEnv();
    const body = await read(env, SLUG[TENANT_A], await adminToken(TENANT_A));
    expect(body.plan).toBeNull();
    expect(body.billedUntil).toBeNull();
    expect(body.planActive).toBe(false);
    expect(body.hasBillingAccount).toBe(false);
    // PRESENT and null, which is a different fact from withheld — see the pawsa_ case below.
    expect('stripeCustomerId' in body).toBe(true);
    expect(body.stripeCustomerId).toBeNull();
  });

  it('still answers a plan for a sitter who paid once and lapsed', async () => {
    const { env, raw } = createTestEnv();
    const lapsed = minutesFromNow(-60);
    seedPlan(raw, TENANT_A, { plan: 'solo', billedUntil: lapsed, customerId: 'cus_sunny' });

    const body = await read(env, SLUG[TENANT_A], await adminToken(TENANT_A));
    // This is the sitter for whom the Manage-plan control must render: her card died, her plan
    // lapsed, and the portal is what fixes it. `hasBillingAccount` is what stays true for her.
    expect(body.plan).toBe('solo');
    expect(body.billedUntil).toBe(lapsed);
    expect(body.planActive).toBe(false);
    expect(body.hasBillingAccount).toBe(true);
  });

  it('reports a billing account for a sitter the processor knows but no plan yet', async () => {
    const { env, raw } = createTestEnv();
    // A checkout that reached the processor and stopped: she has a customer record and no
    // subscription. This is the ONE row that tells `hasBillingAccount`'s derivation apart from
    // the plan's — every other case here seeds `Plan` and `StripeCustomerId` together or neither,
    // so a `Plan != null` reading would satisfy all of them.
    raw.prepare('UPDATE Tenants SET StripeCustomerId = ? WHERE Id = ?').run('cus_sunny', TENANT_A);

    const body = await read(env, SLUG[TENANT_A], await adminToken(TENANT_A));
    expect(body.plan).toBeNull();
    expect(body.billedUntil).toBeNull();
    expect(body.planActive).toBe(false);
    // TRUE with no plan at all. The Manage-plan control gates on this field ALONE, so a derivation
    // that read the plan instead would hide the portal from the sitter who most needs to reach it.
    expect(body.hasBillingAccount).toBe(true);
    expect(body.stripeCustomerId).toBe('cus_sunny');
  });

  it('answers planActive TRUE for a live SOLO plan, which is not premium', async () => {
    // `isSoloActive` against `isPremiumActive`: the second requires `Plan === 'pro'`, so swapping
    // this route's call for it survived every case in this file — every LIVE row seeded `pro`, and
    // the only `solo` row was a lapsed one, where both helpers answer false for the same reason. A
    // Solo subscriber is paying; her plan line has to say so, and what she is entitled to is a
    // different question this repo has no opinion about.
    const { env, raw } = createTestEnv();
    const paidThrough = minutesFromNow(60);
    seedPlan(raw, TENANT_A, { plan: 'solo', billedUntil: paidThrough, customerId: 'cus_sunny' });

    const body = await read(env, SLUG[TENANT_A], await adminToken(TENANT_A));
    expect(body.plan).toBe('solo');
    expect(body.billedUntil).toBe(paidThrough);
    expect(body.planActive).toBe(true);
    expect(body.hasBillingAccount).toBe(true);
  });

  it('reports NO billing account for an empty-string customer id', async () => {
    const { env, raw } = createTestEnv();
    // `''` is not a customer record. It is what a caller writing the column from an empty form
    // field, a trimmed header or a `?? ''` default leaves behind, and `!= null` reads it as a
    // sitter the processor knows — which under the panel's gate would offer her a portal session
    // against a customer that does not exist. A non-empty STRING is the question being asked.
    raw.prepare('UPDATE Tenants SET StripeCustomerId = ? WHERE Id = ?').run('', TENANT_A);

    const body = await read(env, SLUG[TENANT_A], await adminToken(TENANT_A));
    expect(body.hasBillingAccount).toBe(false);
    // Still PUBLISHED verbatim, because the field is the column and the route invents nothing: the
    // derivation is what this case is about, not the echo.
    expect(body.stripeCustomerId).toBe('');
  });

  it('follows isSoloActive across the boundary, on a plan that is not premium', async () => {
    // `solo` ON BOTH ARMS, deliberately: seeded `pro`, this case follows `isPremiumActive` exactly as
    // well as the helper it is named for, and so cannot tell them apart. It is `isSoloActive` that
    // this route publishes.
    const { env: ahead, raw: rawAhead } = createTestEnv();
    seedPlan(rawAhead, TENANT_A, {
      plan: 'solo',
      billedUntil: minutesFromNow(1),
      customerId: 'cus_sunny',
    });
    expect((await read(ahead, SLUG[TENANT_A], await adminToken(TENANT_A))).planActive).toBe(true);

    const { env: behind, raw: rawBehind } = createTestEnv();
    seedPlan(rawBehind, TENANT_A, {
      plan: 'solo',
      billedUntil: minutesFromNow(-1),
      customerId: 'cus_sunny',
    });
    expect((await read(behind, SLUG[TENANT_A], await adminToken(TENANT_A))).planActive).toBe(false);

    // The boundary itself, and THIS ARM CLAIMS NOTHING ABOUT THE OPERATOR. A stamp equal to now can
    // only get further into the past while the test runs, so the assertion is stable — but it kills a
    // `>` loosened to `>=` only when the route happens to re-read the clock inside the same
    // wall-clock second, which is a coin toss on a slow box. The deterministic kill is at the unit
    // level, where `now` is an argument: see `premium-entitlement.test.ts`, "a STRICT `>` at the
    // boundary". Kept here because "paid through an instant already gone is not live" is still the
    // route's own answer to assert.
    const { env: exact, raw: rawExact } = createTestEnv();
    seedPlan(rawExact, TENANT_A, {
      plan: 'solo',
      billedUntil: premiumNow(),
      customerId: 'cus_sunny',
    });
    expect((await read(exact, SLUG[TENANT_A], await adminToken(TENANT_A))).planActive).toBe(false);
  });

  it('answers planActive false for a disabled sitter, however far ahead the date is', async () => {
    const { env, raw } = createTestEnv();
    seedPlan(raw, TENANT_A, {
      plan: 'pro',
      billedUntil: minutesFromNow(60 * 24 * 365),
      customerId: 'cus_sunny',
    });
    raw.prepare(`UPDATE Tenants SET DisabledAt = datetime('now') WHERE Id = ?`).run(TENANT_A);

    // `isSoloActive` refuses a DisabledAt before it looks at the date, and this route publishes
    // its answer rather than re-deciding. A GET still reads for a disabled sitter — that is
    // `tenantMiddleware`'s deliberate allowance — so this is a 200 with a false, not a refusal.
    const body = await read(env, SLUG[TENANT_A], await adminToken(TENANT_A));
    expect(body.planActive).toBe(false);
    expect(body.plan).toBe('pro');
    expect(body.hasBillingAccount).toBe(true);
  });
});

describe('the settings PUT cannot write plan state', () => {
  it('ignores all five plan fields in the body and leaves every column untouched', async () => {
    // THE FIVE FIELDS ARE READ-ONLY ON THE WIRE, and that is a property of the WRITE path rather
    // than of the client that happens to build its body field by field today. The settings PUT is
    // the one authenticated write a sitter's own dashboard makes against her tenant row, so if it
    // honoured these keys a sitter could grant herself a plan — or a paid-through date — with one
    // `curl` and her own admin token. Nothing in `SettingsBody` names them; this case is what keeps
    // it that way.
    const { env, raw } = createTestEnv();
    const paidThrough = minutesFromNow(60);
    seedPlan(raw, TENANT_A, { plan: 'solo', billedUntil: paidThrough, customerId: 'cus_sunny' });

    const res = await app.request(
      `/api/${SLUG[TENANT_A]}/admin/settings`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${await adminToken(TENANT_A)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          plan: 'pro',
          billedUntil: minutesFromNow(60 * 24 * 365 * 50),
          planActive: true,
          hasBillingAccount: true,
          stripeCustomerId: 'cus_attacker',
        }),
      },
      env,
    );
    // Not a 400: the keys are not rejected, they are simply not read — the route resolves every
    // column it writes from a field it knows, so an unknown key is inert rather than refused.
    expect(res.status).toBe(204);

    const row = raw
      .prepare('SELECT Plan, BilledUntil, StripeCustomerId FROM Tenants WHERE Id = ?')
      .get(TENANT_A) as {
      Plan: string | null;
      BilledUntil: string | null;
      StripeCustomerId: string | null;
    };
    expect(row).toEqual({ Plan: 'solo', BilledUntil: paidThrough, StripeCustomerId: 'cus_sunny' });

    // And the read still answers the seeded plan, not the one the body asked for.
    const body = await read(env, SLUG[TENANT_A], await adminToken(TENANT_A));
    expect(body.plan).toBe('solo');
    expect(body.billedUntil).toBe(paidThrough);
    expect(body.stripeCustomerId).toBe('cus_sunny');
  });
});

describe('the customer id goes only to a password session', () => {
  it('withholds it from a pawsa_ token — ABSENT, not null — and publishes the other four', async () => {
    const { env, raw } = createTestEnv();
    const paidThrough = minutesFromNow(60);
    seedPlan(raw, TENANT_A, { plan: 'pro', billedUntil: paidThrough, customerId: 'cus_sunny' });
    const token = await mintTenantToken(env, TENANT_A, 'tu_sunny');

    const body = await read(env, SLUG[TENANT_A], token);
    // ABSENT, so a consumer can tell "withheld by policy" from "no customer yet". A null here
    // would be the route answering a question it is declining to answer.
    expect('stripeCustomerId' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('cus_');
    // The other four are the tenant's own plan, told to the tenant's own admin.
    expect(body.plan).toBe('pro');
    expect(body.billedUntil).toBe(paidThrough);
    expect(body.planActive).toBe(true);
    expect(body.hasBillingAccount).toBe(true);
  });
});

describe('two tenants, because a cross-tenant read looks completely ordinary doing it', () => {
  it('answers each sitter her own customer id, and never the other’s, anywhere', async () => {
    const { env, raw } = createTestEnv();
    // DIFFERENT ids AND different dates, deliberately. Two tenants seeded with the same value on
    // either field would satisfy every assertion below against a handler that read the wrong row.
    const sunnyBilledUntil = minutesFromNow(60);
    const happyBilledUntil = minutesFromNow(120);
    seedPlan(raw, TENANT_A, {
      plan: 'pro',
      billedUntil: sunnyBilledUntil,
      customerId: 'cus_sunny_only',
    });
    seedPlan(raw, TENANT_B, {
      plan: 'solo',
      billedUntil: happyBilledUntil,
      customerId: 'cus_happy_only',
    });

    const credential = await adminToken(TENANT_A);
    const own = await settings(env, SLUG[TENANT_A], credential);
    expect(own.status).toBe(200);
    const ownBody = await own.text();
    expect(JSON.parse(ownBody).stripeCustomerId).toBe('cus_sunny_only');
    expect(JSON.parse(ownBody).billedUntil).toBe(sunnyBilledUntil);
    // Not "not equal to B's" — B's id must appear NOWHERE in the bytes A can obtain. The whole
    // payload is searched, not the one field, because a leak that mattered would be a leak into
    // some other field nobody thought to name.
    expect(ownBody).not.toContain('cus_happy_only');
    expect(ownBody).not.toContain(happyBilledUntil);

    // Her own valid credential, at the other business's path. `tenantMiddleware` resolves the slug
    // before any auth and `adminAuth` binds the credential to that tenant, so this is the existing
    // chain's refusal and not a new check.
    const crossed = await settings(env, SLUG[TENANT_B], credential);
    expect(crossed.status).toBe(403);
    const crossedBody = await crossed.text();
    expect(crossedBody).not.toContain('cus_happy_only');
    expect(crossedBody).not.toContain(happyBilledUntil);

    // And the other direction, so "A can't read B" is not satisfied by a handler that simply
    // always answers A. B's own admin gets B's id and date and never A's.
    const hers = await settings(env, SLUG[TENANT_B], await adminToken(TENANT_B));
    expect(hers.status).toBe(200);
    const hersBody = await hers.text();
    expect(JSON.parse(hersBody).stripeCustomerId).toBe('cus_happy_only');
    expect(JSON.parse(hersBody).billedUntil).toBe(happyBilledUntil);
    expect(hersBody).not.toContain('cus_sunny_only');
    expect(hersBody).not.toContain(sunnyBilledUntil);
  });
});
