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
function call(
  env: Env,
  state: string,
  code = 'auth-code',
  cookieNonce: string | null = NONCE,
  origin = '',
) {
  const headers: Record<string, string> = {};
  if (cookieNonce !== null) headers.Cookie = `pawservation_gcal_nonce=${cookieNonce}`;
  return app.request(
    `${origin}/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
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
  // catch used to swallow the whole error, so a deployment serving a host nobody registered in the
  // Cloud Console was undiagnosable from the logs.
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

  // The other half of the pairing pinned in the /oauth/start block below: Google compares the
  // exchange's redirect_uri against the authorize request's byte for byte, so both must be derived
  // from the request's own origin. If start and callback ever drift apart, EVERY connect dies at
  // Google with `redirect_uri_mismatch` — a failure no unit test of either half alone would catch.
  // it.each over the same three origins the /start block below exercises, rather than one fixed
  // string: asserting a single hardcoded origin here would still pass against a callback route that
  // hardcoded that same literal instead of actually deriving it from the request.
  it.each([
    'https://pawservation.com',
    'https://pawservation.example.workers.dev',
    'https://another.host.example',
  ])('exchanges with ITS OWN origin (%s) as the redirect_uri', async (origin) => {
    const { env } = createTestEnv();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
          { status: 200 },
        ),
      );
    const res = await call(env, await primedState(env), 'auth-code', NONCE, origin);
    expect(res.status).toBe(200);
    const tokenCall = spy.mock.calls.find(
      ([url]) => String(url) === 'https://oauth2.googleapis.com/token',
    );
    const body = new URLSearchParams(String(tokenCall![1]!.body));
    expect(body.get('redirect_uri')).toBe(`${origin}/oauth/google/callback`);
  });
});

describe('GET /:slug/admin/providers/calendar/oauth/start', () => {
  afterEach(() => vi.restoreAllMocks());

  function googleConfigured(env: Env): Env {
    Object.assign(env, { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret' });
    return env;
  }
  const start = async (env: Env, origin: string) =>
    app.request(
      `${origin}/api/sunny-paws/admin/providers/calendar/oauth/start`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );

  // The redirect URI is derived from the dashboard's OWN origin, so the host-scoped nonce cookie
  // and the callback share a host by construction. This used to 409 whenever the dashboard host
  // differed from a configured GOOGLE_OAUTH_REDIRECT_URI, which permanently broke the button on
  // every host but that one — including the production custom domain.
  it.each([
    'https://pawservation.com',
    'https://pawservation.example.workers.dev',
    'https://another.host.example',
  ])('starts from %s and sends Google back to that same host', async (origin) => {
    const { env } = createTestEnv();
    const res = await start(googleConfigured(env), origin);
    expect(res.status).toBe(200);
    const url = new URL((await res.json<{ url: string }>()).url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/oauth/google/callback`);
  });

  it('sets the nonce cookie Secure over https', async () => {
    const { env } = createTestEnv();
    const res = await start(googleConfigured(env), 'https://pawservation.com');
    expect(res.status).toBe(200);
    // Over https the nonce cookie must be Secure — derived from the request scheme, not from an
    // ENVIRONMENT var that is unset in .dev.vars.
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });

  it('omits Secure on a plain-http dashboard so local dev works in every browser', async () => {
    const { env } = createTestEnv();
    const res = await start(googleConfigured(env), 'http://localhost:8787');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
    // http in, http out — the two halves agree on scheme as well as host.
    const url = new URL((await res.json<{ url: string }>()).url);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8787/oauth/google/callback',
    );
  });

  // The client credentials are the whole of "is Google configured" now; the redirect URI is
  // derived, not configuration, so it can no longer be the thing that is missing.
  it('503s when the Google client credentials are unset', async () => {
    const { env } = createTestEnv();
    expect((await start(env, 'https://pawservation.com')).status).toBe(503);
  });
});
