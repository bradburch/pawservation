import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { getTenantById, getTenantBySlug } from '../db/repo';
import { mintAdminToken, mintOwnerToken } from '../lib/token';
import { isPremiumActive, isSoloActive, type EntitlementFacts } from '../lib/premium';
import { resolveTenant } from '../lib/tenant-resolve';
import { createTestEnv, OWNER_EMAIL, TENANT_A, TENANT_B, TEST_SECRET } from './helpers';

/**
 * `Tenants.PremiumUntil` (0010) — the OWNER'S MANUAL GRANT, which since 0017 is one of the two
 * things entitlement is decided from rather than the whole of it. A nullable timestamp the platform
 * owner sets and clears, and one derived boolean published on the tenant's public config. There is
 * no enforcement here and there is deliberately nothing for it to enforce: the free product does not
 * know what "premium" buys, only whether this tenant is entitled right now. The combined expression
 * — comp OR paid Pro plan — is exercised at the foot of this file, beside the scan that keeps it the
 * only place the question is answered.
 *
 * Dates are deliberately absurd (2099 / 2000) rather than `now ± an hour`: a fixture that straddles
 * the clock is a fixture that fails on a slow CI box, and nothing in this feature is sensitive to
 * HOW far away the boundary is — only to which side of it the stored instant falls.
 */

const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

const ownerHeaders = async () => ({
  Authorization: `Bearer ${await mintOwnerToken(OWNER_EMAIL, TEST_SECRET)}`,
  'Content-Type': 'application/json',
});

const adminHeadersFor = async (tenantId: string) => ({
  Authorization: `Bearer ${await mintAdminToken('u', tenantId, TEST_SECRET)}`,
  'Content-Type': 'application/json',
});

type PremiumBlock = { assistant: boolean; chat: boolean; mcp: boolean; origin: string };

async function configOf(
  env: Env,
  slug: string,
): Promise<{ disabled: boolean; premium: PremiumBlock }> {
  const res = await app.request(`/api/${slug}/config`, {}, env);
  expect(res.status).toBe(200);
  return (await res.json()) as { disabled: boolean; premium: PremiumBlock };
}

const patchPremium = (
  env: Env,
  tenantId: string,
  premiumUntil: string | null,
  headers: Record<string, string>,
) =>
  app.request(
    `/api/owner/sitters/${tenantId}`,
    { method: 'PATCH', headers, body: JSON.stringify({ premiumUntil }) },
    env,
  );

describe('Tenants.PremiumUntil — the column', () => {
  it('exists on every tenant and starts NULL, which is what "free" is', async () => {
    const { env, raw } = createTestEnv();
    // Every seeded tenant stands in for every tenant that existed before the migration: the
    // migration adds a bare nullable column with no DEFAULT, so SQLite stamps existing rows NULL
    // and nobody silently becomes a paying customer on deploy.
    const rows = raw.prepare('SELECT Id, PremiumUntil FROM Tenants').all() as {
      Id: string;
      PremiumUntil: string | null;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.PremiumUntil).toBeNull();

    // And it rides in the Tenant object, because the request path reads it off the cached row
    // rather than issuing a second query.
    expect((await getTenantBySlug(env.PAWSERVATION_DB, 'sunny-paws'))?.PremiumUntil).toBeNull();
  });
});

describe('the tenant KV cache key is versioned for exactly this', () => {
  it('caches under v6, so no entry from an earlier worker is ever read back', async () => {
    const { env } = createTestEnv();

    // Each older key is what some PREVIOUS worker left behind: the same row, minus the column its
    // migration added. Read either one and the field it lacks comes back `undefined` — a paying
    // sitter demoted to free (v2/0010), a sitter who chose per-night billed at a third of her
    // rate (v3/0013), a monthly invoicer whose payments reach back 14 days instead of the 45 she
    // chose (v4/0014), or a sitter who paid a minute ago reported free (v5/0017) — for a whole TTL,
    // with the type insisting none of them can happen.
    for (const key of [
      'tenant:sunny-paws:config:v2',
      'tenant:sunny-paws:config:v3',
      'tenant:sunny-paws:config:v4',
      'tenant:sunny-paws:config:v5',
    ]) {
      await env.PAWSERVATION_CACHE.put(
        key,
        JSON.stringify({
          Id: TENANT_A,
          Slug: 'sunny-paws',
          DisplayName: 'Stale',
          DisabledAt: null,
        }),
      );
    }

    const tenant = await resolveTenant('sunny-paws', env);
    expect(tenant?.DisplayName).not.toBe('Stale'); // no stale shape was consulted
    expect(tenant?.PremiumUntil).toBeNull(); // null, never undefined
    expect('PremiumUntil' in tenant!).toBe(true);
    expect(tenant?.CalendarCostBasis).toBe('total'); // the real column, never undefined
    // 14, never undefined — and `undefined` is the dangerous shape here, because
    // `proposeAttribution`'s window is an OPTIONAL argument, so a missing value is not an error
    // there but silently the default.
    expect(tenant?.AttributionSpillDays).toBe(14);

    // The new entry lands under the new key.
    expect(await env.PAWSERVATION_CACHE.get('tenant:sunny-paws:config:v6')).not.toBeNull();
  });
});

describe('the platform owner sets and clears premium', () => {
  it('sets a future expiry, and the tenant is premium from that moment', async () => {
    const { env } = createTestEnv();
    const res = await patchPremium(env, TENANT_A, FUTURE, await ownerHeaders());
    expect(res.status).toBe(200);
    expect((await res.json()) as { premiumUntil: string | null }).toMatchObject({
      premiumUntil: '2099-01-01 00:00:00',
    });
    // Stored in SQLite's own datetime shape, the one CreatedAt/DisabledAt already use.
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))?.PremiumUntil).toBe(
      '2099-01-01 00:00:00',
    );
    expect((await configOf(env, 'sunny-paws')).premium.assistant).toBe(true);
  });

  it('clears it back to NULL, and the tenant is free from that moment', async () => {
    const { env } = createTestEnv();
    await patchPremium(env, TENANT_A, FUTURE, await ownerHeaders());
    expect((await configOf(env, 'sunny-paws')).premium.assistant).toBe(true);

    const res = await patchPremium(env, TENANT_A, null, await ownerHeaders());
    expect(res.status).toBe(200);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))?.PremiumUntil).toBeNull();
    // Not merely stored: VISIBLE immediately. The PATCH invalidates the tenant cache, so a
    // revocation does not sit behind a 60-second TTL.
    expect((await configOf(env, 'sunny-paws')).premium.assistant).toBe(false);
  });

  it('leaves DisabledAt alone, and a disable leaves PremiumUntil alone', async () => {
    // The two owner controls share one PATCH; neither may be a hidden side effect of the other.
    const { env } = createTestEnv();
    await patchPremium(env, TENANT_A, FUTURE, await ownerHeaders());
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))?.DisabledAt).toBeNull();

    await app.request(
      `/api/owner/sitters/${TENANT_A}`,
      { method: 'PATCH', headers: await ownerHeaders(), body: '{"disabled":true}' },
      env,
    );
    const after = await getTenantById(env.PAWSERVATION_DB, TENANT_A);
    expect(after?.PremiumUntil).toBe('2099-01-01 00:00:00');
    expect(after?.DisabledAt).not.toBeNull();
  });

  it('refuses a body that names neither knob, and an unparseable date', async () => {
    const { env } = createTestEnv();
    const empty = await app.request(
      `/api/owner/sitters/${TENANT_A}`,
      { method: 'PATCH', headers: await ownerHeaders(), body: '{}' },
      env,
    );
    expect(empty.status).toBe(400);
    const nonsense = await patchPremium(env, TENANT_A, 'next tuesday', await ownerHeaders());
    expect(nonsense.status).toBe(400);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))?.PremiumUntil).toBeNull();
  });

  it('404s an unknown tenant without writing anything', async () => {
    const { env } = createTestEnv();
    expect((await patchPremium(env, 'nope', FUTURE, await ownerHeaders())).status).toBe(404);
  });
});

describe('a sitter cannot grant herself premium', () => {
  it('refuses her own admin token and changes nothing', async () => {
    const { env } = createTestEnv();
    const res = await patchPremium(env, TENANT_A, FUTURE, await adminHeadersFor(TENANT_A));
    expect(res.status).toBe(401);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))?.PremiumUntil).toBeNull();
    expect((await configOf(env, 'sunny-paws')).premium.assistant).toBe(false);
  });

  it('refuses an admin token aimed at ANOTHER tenant just the same', async () => {
    // Not a tenant-mismatch refusal — an admin token is not an owner token at all, so which
    // tenant it names is irrelevant. Asserted so a future "…unless it's your own tenant"
    // shortcut fails here.
    const { env } = createTestEnv();
    const res = await patchPremium(env, TENANT_B, FUTURE, await adminHeadersFor(TENANT_A));
    expect(res.status).toBe(401);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_B))?.PremiumUntil).toBeNull();
  });
});

describe('GET /api/:slug/config publishes the derived premium block', () => {
  it('reports every flag true for a tenant paid through a future instant', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET PremiumUntil='2099-01-01 00:00:00' WHERE Id='${TENANT_A}';`);
    const { premium } = await configOf(env, 'sunny-paws');
    expect(premium.assistant).toBe(true);
    expect(premium.chat).toBe(true);
    expect(premium.mcp).toBe(true);
  });

  it('reports every flag false for a free tenant', async () => {
    const { env } = createTestEnv();
    const { premium } = await configOf(env, 'sunny-paws');
    expect(premium).toMatchObject({ assistant: false, chat: false, mcp: false });
  });

  it('reports every flag false once the paid-through instant has passed', async () => {
    // Set through the owner route, not raw SQL: a lapsed date is a legitimate thing for an owner
    // to record ("paid through last March"), so the route must STORE it and the read must decline
    // it. A route that rejected a past date would hide the lapse rather than represent it.
    const { env } = createTestEnv();
    const res = await patchPremium(env, TENANT_A, PAST, await ownerHeaders());
    expect(res.status).toBe(200);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))?.PremiumUntil).toBe(
      '2000-01-01 00:00:00',
    );
    const { premium } = await configOf(env, 'sunny-paws');
    expect(premium).toMatchObject({ assistant: false, chat: false, mcp: false });
  });

  it('reports every flag false for a DISABLED tenant even while it is paid up', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE Tenants SET PremiumUntil='2099-01-01 00:00:00', DisabledAt='2026-07-23 00:00:00' WHERE Id='${TENANT_A}';`,
    );
    const config = await configOf(env, 'sunny-paws');
    expect(config.disabled).toBe(true);
    expect(config.premium).toMatchObject({ assistant: false, chat: false, mcp: false });
  });

  it('publishes an ABSOLUTE origin, because a workers.dev embed cannot assume a relative path', async () => {
    const { env } = createTestEnv();
    const configured = { ...env, PREMIUM_ORIGIN: 'https://premium.example' } as Env;
    const { premium } = await configOf(configured, 'sunny-paws');
    expect(premium.origin).toMatch(/^https:\/\//);
    // Published for a FREE tenant too: the origin is a property of the deployment, not of an
    // entitlement.
    expect(premium.assistant).toBe(false);
  });

  it('takes the origin from PREMIUM_ORIGIN when the deployment sets one', async () => {
    const { env } = createTestEnv();
    const configured = { ...env, PREMIUM_ORIGIN: 'https://premium.example' } as Env;
    expect((await configOf(configured, 'sunny-paws')).premium.origin).toBe(
      'https://premium.example',
    );
  });

  /**
   * THE ORIGIN IS THE DEPLOYMENT'S OWN SETTING, NOT A CONSTANT OF THIS REPO. It used to fall back
   * to the commercial deployment's domain, baked into a public, free codebase — so any deployment
   * that did not configure one advertised somebody else's host to its own customers' widgets, and
   * this repo named a product it deliberately does not contain. Unset now publishes `null`: "this
   * deployment has no premium surface", which every consumer already copes with, because it is
   * what an unentitled tenant renders anyway.
   */
  it('publishes NULL when the deployment sets no origin, naming no domain of its own', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/sunny-paws/config', {}, env);
    const body = (await res.json()) as { premium: { origin: string | null } };
    expect(body.premium.origin).toBeNull();
    // And no fallback domain is hiding anywhere else in the payload.
    expect(JSON.stringify(body)).not.toMatch(/pawservation\.com/);
  });

  it('refuses a value that is not an absolute origin rather than publishing an unusable one', async () => {
    const { env } = createTestEnv();
    for (const bad of ['/premium', 'premium.example', 'https://premium.example/app', '   ']) {
      const configured = { ...env, PREMIUM_ORIGIN: bad } as Env;
      const { premium } = await configOf(configured, 'sunny-paws');
      expect(premium.origin, `PREMIUM_ORIGIN=${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('tolerates a trailing slash, which is the same origin written differently', async () => {
    const { env } = createTestEnv();
    const configured = { ...env, PREMIUM_ORIGIN: 'https://premium.example/' } as Env;
    expect((await configOf(configured, 'sunny-paws')).premium.origin).toBe(
      'https://premium.example',
    );
  });
});

describe('premium is per tenant, like everything else', () => {
  it('granting tenant A premium leaves tenant B free', async () => {
    const { env } = createTestEnv();
    await patchPremium(env, TENANT_A, FUTURE, await ownerHeaders());
    expect((await configOf(env, 'sunny-paws')).premium.assistant).toBe(true);
    expect((await configOf(env, 'happy-tails')).premium.assistant).toBe(false);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_B))?.PremiumUntil).toBeNull();
  });
});

/**
 * THE ONE EXPRESSION (0017, spine AD-13). Two ways to be premium — the platform owner's comp, or a
 * paid Pro plan — and one way to be Solo, which is a paid subscription and nothing to do with the
 * comp. They share exactly one condition, the disable, so it is written once as a single early
 * return: two tiers that can drift on the one thing they agree about is the failure this shape
 * exists to prevent.
 */
const facts = (over: Partial<EntitlementFacts>): EntitlementFacts => ({
  DisabledAt: null,
  PremiumUntil: null,
  Plan: null,
  BilledUntil: null,
  ...over,
});

const FUTURE_STORED = '2099-01-01 00:00:00';
const PAST_STORED = '2000-01-01 00:00:00';

describe('entitlement combines the comp and the plan in one expression', () => {
  it('a Pro plan paid into the future is premium with no comp at all', () => {
    const t = facts({ Plan: 'pro', BilledUntil: FUTURE_STORED });
    expect(isPremiumActive(t)).toBe(true);
    expect(isSoloActive(t)).toBe(true); // she has a live paid subscription; Pro is one
  });

  it('an owner comp into the future is premium with BilledUntil null or past', () => {
    expect(isPremiumActive(facts({ PremiumUntil: FUTURE_STORED }))).toBe(true);
    expect(isPremiumActive(facts({ PremiumUntil: FUTURE_STORED, BilledUntil: PAST_STORED }))).toBe(
      true,
    );
    // A comp is a PREMIUM grant. It confers no Solo subscription, because there isn't one.
    expect(isSoloActive(facts({ PremiumUntil: FUTURE_STORED }))).toBe(false);
  });

  it('a disabled tenant is premium under neither, however much either has left', () => {
    const t = facts({
      DisabledAt: '2026-07-23 00:00:00',
      PremiumUntil: FUTURE_STORED,
      Plan: 'pro',
      BilledUntil: FUTURE_STORED,
    });
    expect(isPremiumActive(t)).toBe(false);
    expect(isSoloActive(t)).toBe(false);
  });

  it('SOLO IS NOT PREMIUM — a paid Solo plan buys the free product, and nothing else', () => {
    const t = facts({ Plan: 'solo', BilledUntil: FUTURE_STORED });
    expect(isSoloActive(t)).toBe(true);
    expect(isPremiumActive(t)).toBe(false);
  });

  it('reads a missing column as "not that" rather than throwing — a stale cache entry fails closed', () => {
    // What a v5 KV entry deserialises to: the field the type insists exists is simply absent.
    const stale = { DisabledAt: null, PremiumUntil: null } as unknown as EntitlementFacts;
    expect(isPremiumActive(stale)).toBe(false);
    expect(isSoloActive(stale)).toBe(false);
  });

  /**
   * WHY `normalizeBilledUntil` EXISTS, demonstrated rather than asserted in prose. The comparison is
   * a plain string `>`; an ISO instant sorts above a space-separated `now` on the separator alone
   * ('T' is 84, ' ' is 32). Both values below name the same instant, twelve hours in the past.
   */
  it('would grant a lapsed Pro plan a free day if a date were stored ISO-shaped', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    expect(isPremiumActive(facts({ Plan: 'pro', BilledUntil: '2026-09-08T00:00:00Z' }), now)).toBe(
      true,
    );
    expect(isPremiumActive(facts({ Plan: 'pro', BilledUntil: '2026-09-08 00:00:00' }), now)).toBe(
      false,
    );
  });
});

/**
 * ONE EXPRESSION MEANS ONE EXPRESSION, and this is the assertion that keeps it that way. AD-13's
 * requirement is not "a helper exists" — it is that nowhere else answers the same question. A second
 * copy does not announce itself: it is a `>` in a component that was right the day it was written
 * and silently wrong the day a second grant existed, which is exactly what the owner console's
 * browser-side chip did.
 *
 * Comments are stripped before scanning, because the prose in `repo.ts`, `public.ts` and this file
 * legitimately QUOTES the comparison while describing where it lives. Only executable text counts.
 */
describe('nothing outside server/lib/premium.ts compares PremiumUntil itself', () => {
  const ROOT = join(import.meta.dirname, '..', '..');
  const EXEMPT = join(ROOT, 'server', 'lib', 'premium.ts');

  /** Block comments, JSX braces-and-slash-star comments included, and line comments. A `://` in
   *  a URL is not the start of one. */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /** `PremiumUntil > x` and `x < PremiumUntil`, through any accessor chain. */
  const COMPARISON = /(premiumuntil\s*[<>]|[<>]=?\s*[\w.?!]*premiumuntil)/i;

  const sourcesUnder = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourcesUnder(path);
      return /\.tsx?$/.test(path) && path !== EXEMPT ? [path] : [];
    });

  it('finds the comparison in no other module, test files included', () => {
    const offenders = ['server', 'app']
      .flatMap((top) => sourcesUnder(join(ROOT, top)))
      .filter((path) => COMPARISON.test(stripComments(readFileSync(path, 'utf8'))))
      .map((path) => path.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  // The controls name the column through a variable rather than spelling it beside a `>`, so that
  // the scanner does not report its own fixtures — a scan that has to exempt the file it lives in
  // stops covering that file.
  const COLUMN = 'PremiumUntil';

  it('would catch one — the scanner is not vacuously green', () => {
    expect(COMPARISON.test(`s.${COLUMN} > new Date().toISOString()`)).toBe(true);
    expect(COMPARISON.test(`now < tenant.${COLUMN}`)).toBe(true);
    expect(COMPARISON.test(stripComments(`// ${COLUMN} > now, merely described`))).toBe(false);
  });
});
