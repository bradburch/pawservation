import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { getProviderConnection } from '../db/repo';
import { decryptToken } from '../lib/token-crypto';
import { signState } from '../lib/oauth-state';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';

const NONCE = 'nonce-1';
async function primedState(env: Env, over: Partial<{ tenantId: string; exp: number }> = {}) {
  await env.PAWBOOK_CACHE.put(`gcal:nonce:${NONCE}`, '1');
  return signState(TEST_SECRET, {
    tenantId: over.tenantId ?? TENANT_A, nonce: NONCE, exp: over.exp ?? Date.now() + 600_000,
  });
}
function call(env: Env, state: string, code = 'auth-code') {
  return app.request(`/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`, {}, env);
}

describe('GET /oauth/google/callback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exchanges the code and stores encrypted tokens with connected status', async () => {
    const { env } = createTestEnv();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
    );
    const res = await call(env, await primedState(env));
    expect(res.status).toBe(200);
    const conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
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
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
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
});
