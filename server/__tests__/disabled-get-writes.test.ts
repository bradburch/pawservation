import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { createTestEnv, endUserToken, TENANT_A, TEST_SECRET } from './helpers';
import { mintAdminToken, mintToken } from '../lib/token';
import { calendarSyncKey, calendarWidgetSyncKey } from '../lib/calendar-sync';
import { getProviderConnection } from '../db/repo';
import { signState } from '../lib/oauth-state';
import { premiumNow } from '../lib/premium';

const adminHeaders = async () => ({
  Authorization: `Bearer ${await mintAdminToken('u_admin', TENANT_A, TEST_SECRET)}`,
});
const disable = (raw: import('node:sqlite').DatabaseSync) =>
  raw.exec(`UPDATE Tenants SET DisabledAt='2026-07-24 00:00:00' WHERE Id='${TENANT_A}';`);

afterEach(() => vi.restoreAllMocks());

describe('disabled tenant: GET-side writes are suppressed', () => {
  it('skips reconcileIfStale on the bookings list when disabled', async () => {
    const { env, raw } = createTestEnv();
    disable(raw);
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(200); // read-only view still works
    // reconcileIfStale claims calendarSyncKey before it pulls; skipping means the key is never set.
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBeNull();
  });

  it('runs reconcileIfStale (sets the sync key) for an ACTIVE tenant — control', async () => {
    const { env } = createTestEnv(); // TENANT_A not disabled
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBe('1'); // reconcile ran
  });

  it('skips reconcileIfStale on the analytics dashboard when disabled', async () => {
    const { env, raw } = createTestEnv();
    disable(raw);
    const res = await app.request(
      '/api/sunny-paws/admin/analytics',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(200); // read-only view still works
    // reconcileIfStale claims calendarSyncKey before it pulls; skipping means the key is never set.
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBeNull();
  });

  it('runs reconcileIfStale (sets the sync key) for an ACTIVE tenant on analytics — control', async () => {
    const { env } = createTestEnv(); // TENANT_A not disabled
    const res = await app.request(
      '/api/sunny-paws/admin/analytics',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBe('1'); // reconcile ran
  });

  it('skips the widget-scoped reconcile on the month grid when disabled', async () => {
    const { env, raw } = createTestEnv();
    disable(raw);
    // Minted, not obtained through /identify: the login handshake is a POST, which
    // tenantMiddleware rejects outright for a disabled tenant (and the resolved-tenant cache it
    // would warm would then hide the DisabledAt flag from this GET). A customer already holding
    // a valid token is the case under test.
    const token = await mintToken('eu_sp_jess', TENANT_A, TEST_SECRET);
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=boarding&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200); // read-only view still works
    expect(await env.PAWSERVATION_CACHE.get(calendarWidgetSyncKey(TENANT_A))).toBeNull();
  });

  it('runs the widget-scoped reconcile on the month grid for an ACTIVE tenant — control', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=boarding&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await env.PAWSERVATION_CACHE.get(calendarWidgetSyncKey(TENANT_A))).toBe('1');
  });

  it('blocks GET oauth/start when disabled with account_disabled 403', async () => {
    const { env, raw } = createTestEnv();
    disable(raw);
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/oauth/start',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_disabled' });
  });

  it('does NOT 403 oauth/start for an active tenant — control', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/oauth/start',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).not.toBe(403); // 200 {url} if Google env configured, else 503 — never 403
  });

  it('blocks GET oauth/start for a LAPSED plan with plan_lapsed 402', async () => {
    // The one state-changing GET under /:slug/admin/*, and therefore the one place a method rule
    // cannot reach. The disabled gate has the identical hole and closes it one line above; this
    // mirrors that guard rather than inventing a second mechanism for the same shape of problem.
    const { env } = createTestEnv(); // no grant of any kind, which is every row today
    // Google CONFIGURED, because the 503 for an unconfigured server is answered first (the case
    // below): with no client id this request never reaches the plan guard at all.
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/oauth/start',
      { headers: await adminHeaders() },
      { ...env, PLAN_ENFORCE: 'true', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' } as Env,
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'plan_lapsed' });
  });

  it('answers oauth/start 503 for an unconfigured server BEFORE 402 for a lapsed plan', async () => {
    // The guard order is config first: "this server cannot connect a calendar" is true of every
    // business on it and is the fact worth telling, where a 402 would send a lapsed sitter to buy a
    // plan for a control that will 503 the moment she has one. The disabled 403 stays first of all,
    // because that answer is about her account and not about a control.
    const { env } = createTestEnv(); // no grant, and createTestEnv sets no GOOGLE_* either
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/oauth/start',
      { headers: await adminHeaders() },
      { ...env, PLAN_ENFORCE: 'true' } as Env,
    );
    expect(res.status).toBe(503);
  });

  it('does NOT 402 oauth/start for a business holding a comp — control', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare('UPDATE Tenants SET CompedUntil = ? WHERE Id = ?')
      .run(premiumNow(new Date(Date.now() + 3_600_000)), TENANT_A);
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/oauth/start',
      { headers: await adminHeaders() },
      { ...env, PLAN_ENFORCE: 'true' } as Env,
    );
    expect(res.status).not.toBe(402); // 200 {url} if Google env configured, else 503 — never 402
  });

  it('rejects the OAuth callback for a LAPSED plan under enforcement, writing no tokens', async () => {
    // The 600-second window: a state signed by oauth/start BEFORE the lapse — or before the flip —
    // arrives at a callback that carries no slug and runs outside both gates. Narrow, but the
    // callback's disabled guard exists for exactly this shape, and the lapse guard sits beside it.
    const { env } = createTestEnv(); // no grant of any kind
    const NONCE = 'nonce-lapsed';
    await env.PAWSERVATION_CACHE.put(`gcal:nonce:${NONCE}`, '1');
    const state = await signState(TEST_SECRET, {
      tenantId: TENANT_A,
      nonce: NONCE,
      exp: Date.now() + 600_000,
    });
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await app.request(
      `/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `pawservation_gcal_nonce=${NONCE}` } },
      { ...env, PLAN_ENFORCE: 'true' } as Env,
    );
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled(); // never reaches the token exchange
    const conn = await getProviderConnection(env.PAWSERVATION_DB, TENANT_A, 'calendar');
    expect(conn?.Status).not.toBe('connected');
    expect(conn?.AccessToken).toBeFalsy();
  });

  // Mirrors oauth-callback.test.ts's happy-path setup exactly (state signing, nonce cache seed,
  // pawservation_gcal_nonce cookie) — only the tenant is flipped to disabled.
  it('rejects the OAuth callback for a disabled tenant, writing no ProviderConnections row', async () => {
    const { env, raw } = createTestEnv();
    disable(raw);
    const NONCE = 'nonce-1';
    await env.PAWSERVATION_CACHE.put(`gcal:nonce:${NONCE}`, '1');
    const state = await signState(TEST_SECRET, {
      tenantId: TENANT_A,
      nonce: NONCE,
      exp: Date.now() + 600_000,
    });
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await app.request(
      `/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `pawservation_gcal_nonce=${NONCE}` } },
      env,
    );
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled(); // never reaches the token exchange
    // Seed data already has a disconnected ProviderConnections row for TENANT_A (sql/seed.sql), so
    // assert no tokens were written rather than the row itself being absent.
    const conn = await getProviderConnection(env.PAWSERVATION_DB, TENANT_A, 'calendar');
    expect(conn?.Status).not.toBe('connected');
    expect(conn?.AccessToken).toBeFalsy();
    expect(conn?.RefreshToken).toBeFalsy();
  });
});

/**
 * THE SAME SUPPRESSION FOR A LAPSED PLAN, under enforcement only. A GET-side reconcile is not her
 * write, and the shipped default (`PLAN_ENFORCE` unset) must change nothing — but once the deployment
 * enforces, a business holding no plan is read-only, and the product must not keep writing her
 * calendar on the strength of a dashboard she opened to read. Same shape as the disabled cases
 * above, and the control is the unset var rather than an active tenant.
 */
describe('lapsed plan under enforcement: GET-side calendar writes are suppressed', () => {
  const enforcing = (env: Env): Env => ({ ...env, PLAN_ENFORCE: 'true' }) as Env;

  it('skips reconcileIfStale on the bookings list', async () => {
    const { env } = createTestEnv(); // no grant of any kind
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders() },
      enforcing(env),
    );
    expect(res.status).toBe(200);
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBeNull();
  });

  it('skips reconcileIfStale on the analytics dashboard', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/analytics',
      { headers: await adminHeaders() },
      enforcing(env),
    );
    expect(res.status).toBe(200);
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBeNull();
  });

  it('runs it while the deployment is NOT enforcing — the shipped default changes nothing', async () => {
    const { env } = createTestEnv(); // same rows, var unset
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBe('1');
  });

  it('runs it for a business holding a comp, enforcing or not — control', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare('UPDATE Tenants SET CompedUntil = ? WHERE Id = ?')
      .run(premiumNow(new Date(Date.now() + 3_600_000)), TENANT_A);
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders() },
      enforcing(env),
    );
    expect(res.status).toBe(200);
    expect(await env.PAWSERVATION_CACHE.get(calendarSyncKey(TENANT_A))).toBe('1');
  });
});
