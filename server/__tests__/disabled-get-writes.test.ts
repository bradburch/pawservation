import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import { mintAdminToken } from '../lib/token';
import { calendarSyncKey } from '../lib/calendar-sync';
import { getProviderConnection } from '../db/repo';
import { signState } from '../lib/oauth-state';

const adminHeaders = async () => ({
  Authorization: `Bearer ${await mintAdminToken('u_admin', TENANT_A, TEST_SECRET)}`,
});
const disable = (raw: import('node:sqlite').DatabaseSync) =>
  raw.exec(`UPDATE Tenants SET DisabledAt='2026-07-24 00:00:00' WHERE Id='${TENANT_A}';`);

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
    // reconcileIfStale writes calendarSyncKey in its finally; skipping means the key is never set.
    expect(await env.PAWBOOK_CACHE.get(calendarSyncKey(TENANT_A))).toBeNull();
  });

  it('runs reconcileIfStale (sets the sync key) for an ACTIVE tenant — control', async () => {
    const { env } = createTestEnv(); // TENANT_A not disabled
    const res = await app.request(
      '/api/sunny-paws/admin/bookings',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    expect(await env.PAWBOOK_CACHE.get(calendarSyncKey(TENANT_A))).toBe('1'); // reconcile ran
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
    // reconcileIfStale writes calendarSyncKey in its finally; skipping means the key is never set.
    expect(await env.PAWBOOK_CACHE.get(calendarSyncKey(TENANT_A))).toBeNull();
  });

  it('runs reconcileIfStale (sets the sync key) for an ACTIVE tenant on analytics — control', async () => {
    const { env } = createTestEnv(); // TENANT_A not disabled
    const res = await app.request(
      '/api/sunny-paws/admin/analytics',
      { headers: await adminHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    expect(await env.PAWBOOK_CACHE.get(calendarSyncKey(TENANT_A))).toBe('1'); // reconcile ran
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

  // Mirrors oauth-callback.test.ts's happy-path setup exactly (state signing, nonce cache seed,
  // pawbook_gcal_nonce cookie) — only the tenant is flipped to disabled.
  it('rejects the OAuth callback for a disabled tenant, writing no ProviderConnections row', async () => {
    const { env, raw } = createTestEnv();
    disable(raw);
    const NONCE = 'nonce-1';
    await env.PAWBOOK_CACHE.put(`gcal:nonce:${NONCE}`, '1');
    const state = await signState(TEST_SECRET, {
      tenantId: TENANT_A,
      nonce: NONCE,
      exp: Date.now() + 600_000,
    });
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await app.request(
      `/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: `pawbook_gcal_nonce=${NONCE}` } },
      env,
    );
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled(); // never reaches the token exchange
    // Seed data already has a disconnected ProviderConnections row for TENANT_A (sql/seed.sql), so
    // assert no tokens were written rather than the row itself being absent.
    const conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(conn?.Status).not.toBe('connected');
    expect(conn?.AccessToken).toBeFalsy();
    expect(conn?.RefreshToken).toBeFalsy();
  });
});
