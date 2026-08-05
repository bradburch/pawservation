import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { getProviderConnection } from '../db/repo';
import { decryptToken } from '../lib/token-crypto';
import { signState } from '../lib/oauth-state';
import { adminHeaders, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';

const NONCE = 'nonce-1';
async function primedState(env: Env, over: Partial<{ tenantId: string; exp: number }> = {}) {
  await env.PAWSERVATION_CACHE.put(`gcal:nonce:${NONCE}`, '1');
  return signState(TEST_SECRET, {
    tenantId: over.tenantId ?? TENANT_A,
    nonce: NONCE,
    exp: over.exp ?? Date.now() + 600_000,
  });
}
function call(env: Env, state: string, code = 'auth-code', cookieNonce: string | null = NONCE) {
  const headers: Record<string, string> = {};
  if (cookieNonce !== null) headers.Cookie = `pawbook_gcal_nonce=${cookieNonce}`;
  return app.request(
    `/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
    { headers },
    env,
  );
}

describe('GET /oauth/google/callback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exchanges the code and stores encrypted tokens with connected status', async () => {
    const { env } = createTestEnv();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
        status: 200,
      }),
    );
    const res = await call(env, await primedState(env));
    expect(res.status).toBe(200);
    const conn = await getProviderConnection(env.PAWSERVATION_DB, TENANT_A, 'calendar');
    expect(conn?.Status).toBe('connected');
    expect(conn?.AccessToken).not.toBe('at'); // stored encrypted
    expect(await decryptToken(TEST_SECRET, conn!.AccessToken!)).toBe('at');
    expect(await decryptToken(TEST_SECRET, conn!.RefreshToken!)).toBe('rt');
  });

  it('rejects a tampered state (no token exchange)', async () => {
    const { env } = createTestEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await call(env, (await primedState(env)) + 'x');
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a replayed/used nonce', async () => {
    const { env } = createTestEnv();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), {
        status: 200,
      }),
    );
    const state = await primedState(env);
    expect((await call(env, state)).status).toBe(200); // consumes nonce
    expect((await call(env, state)).status).toBe(400); // replay rejected
  });

  it('rejects an expired state', async () => {
    const { env } = createTestEnv();
    const res = await call(env, await primedState(env, { exp: Date.now() - 1 }));
    expect(res.status).toBe(400);
  });

  it('rejects a missing nonce cookie (login-CSRF defense)', async () => {
    const { env } = createTestEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await call(env, await primedState(env), 'auth-code', null);
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a mismatched nonce cookie (login-CSRF defense)', async () => {
    const { env } = createTestEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await call(env, await primedState(env), 'auth-code', 'wrong-nonce');
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  // Google reports a refusal by redirecting back with `error` and NO `code` (RFC 6749 §4.1.2.1).
  // Before this branch existed, "the sitter pressed Cancel" and "our CSRF cookie went missing"
  // rendered the same sentence and logged nothing at all.
  it('reads Google’s error redirect and says so, without a token exchange', async () => {
    const { env } = createTestEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request(
      '/oauth/google/callback?error=access_denied&error_description=The%20user%20denied',
      {},
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Google did not grant access');
    expect(spy).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      'google oauth callback failed',
      expect.objectContaining({ reason: 'google_denied', googleError: 'access_denied' }),
    );
  });

  // The three sitter-facing sentences must stay distinguishable: a stale attempt is hers to retry
  // immediately, an unreachable Google is not, and Google refusing is a different action again.
  it('tells an expired attempt apart from Google being unreachable', async () => {
    const { env } = createTestEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stale = await (await call(env, await primedState(env), 'auth-code', null)).text();
    expect(stale).toContain('expired');

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'redirect_uri_mismatch' }), { status: 400 }),
    );
    const unreachable = await (await call(env, await primedState(env))).text();
    expect(unreachable).toContain('could not finish the connection with Google');
    expect(unreachable).not.toContain('redirect_uri_mismatch'); // never leaked to the popup
  });

  // Google's token-endpoint failures name their cause in the BODY, not the status. The callback's
  // catch used to swallow the whole error, so a deployment whose Console redirect URI didn't match
  // GOOGLE_OAUTH_REDIRECT_URI was undiagnosable from the logs.
  it('logs Google’s own token-exchange error cause', async () => {
    const { env } = createTestEnv();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'redirect_uri_mismatch', error_description: 'Bad redirect' }),
        { status: 400 },
      ),
    );
    expect((await call(env, await primedState(env))).status).toBe(400);
    expect(logged).toHaveBeenCalledWith(
      'google oauth callback failed',
      expect.objectContaining({
        reason: 'token_exchange_failed',
        error: expect.stringContaining('redirect_uri_mismatch'),
      }),
    );
  });

  // A token set with no refresh token cannot be refreshed, so storing it would report "Connected"
  // and then stop syncing an hour later. Encrypting `undefined` writes the literal "undefined".
  it('refuses a token response with no refresh token instead of storing a dead connection', async () => {
    const { env } = createTestEnv();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 }),
    );
    expect((await call(env, await primedState(env))).status).toBe(400);
    const conn = await getProviderConnection(env.PAWSERVATION_DB, TENANT_A, 'calendar');
    expect(conn?.Status).not.toBe('connected');
    expect(conn?.RefreshToken).toBeFalsy();
  });
});

describe('GET /:slug/admin/providers/calendar/oauth/start', () => {
  afterEach(() => vi.restoreAllMocks());

  // The nonce cookie is host-scoped; GOOGLE_OAUTH_REDIRECT_URI is ONE host. Connecting from any
  // other host this worker answers on (workers.dev, a `wrangler versions upload` preview URL) sets
  // the cookie where the callback can never read it — a guaranteed failure, previously indistinguishable
  // from Google refusing. Refuse at the start with the host she must use instead.
  it('refuses to start when the dashboard host is not the redirect host', async () => {
    const { env } = createTestEnv();
    Object.assign(env, {
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://pawservation.com/oauth/google/callback',
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request(
      'https://pawbook.example.workers.dev/api/sunny-paws/admin/providers/calendar/oauth/start',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toContain('https://pawservation.com');
  });

  it('starts normally when the dashboard host IS the redirect host', async () => {
    const { env } = createTestEnv();
    Object.assign(env, {
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'https://pawservation.com/oauth/google/callback',
    });
    const res = await app.request(
      'https://pawservation.com/api/sunny-paws/admin/providers/calendar/oauth/start',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(200);
    expect((await res.json<{ url: string }>()).url).toContain('accounts.google.com');
    // Over https the nonce cookie must be Secure — derived from the request scheme, not from an
    // ENVIRONMENT var that is unset in .dev.vars.
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('omits Secure on a plain-http dashboard so local dev works in every browser', async () => {
    const { env } = createTestEnv();
    Object.assign(env, {
      GOOGLE_CLIENT_ID: 'cid',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:8787/oauth/google/callback',
    });
    const res = await app.request(
      'http://localhost:8787/api/sunny-paws/admin/providers/calendar/oauth/start',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });
});
