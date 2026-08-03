import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import { mintAdminToken } from '../lib/token';

const disable = (raw: import('node:sqlite').DatabaseSync) =>
  raw.exec(`UPDATE Tenants SET DisabledAt='2026-07-23 00:00:00' WHERE Id='${TENANT_A}';`);

const adminHeaders = async () => ({
  Authorization: `Bearer ${await mintAdminToken('u_admin', TENANT_A, TEST_SECRET)}`,
});

describe('disabled tenant guard', () => {
  it('blocks non-GET but allows GET for a disabled tenant', async () => {
    const { env, raw } = createTestEnv();
    disable(raw);

    // Widget config GET: allowed, flagged disabled.
    const cfg = await app.request('/api/sunny-paws/config', {}, env);
    expect(cfg.status).toBe(200);
    expect(((await cfg.json()) as { disabled: boolean }).disabled).toBe(true);

    // Customer login POST: blocked before the handler.
    const identify = await app.request(
      '/api/sunny-paws/identify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"email":"x@y.test"}',
      },
      env,
    );
    expect(identify.status).toBe(403);
    expect(await identify.json()).toEqual({ error: 'account_disabled' });

    // Sitter admin GET: read-only dashboard still works.
    const settings = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await adminHeaders() },
      env,
    );
    expect(settings.status).toBe(200);
    expect(((await settings.json()) as { disabled: boolean }).disabled).toBe(true);

    // Sitter admin mutation: blocked by the guard even with a valid token.
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders()), 'Content-Type': 'application/json' },
        body: '{}',
      },
      env,
    );
    expect(put.status).toBe(403);
    expect(await put.json()).toEqual({ error: 'account_disabled' });

    // Time-off (blocked) create/delete are mutations too — same guard, no route-specific code.
    const blockedPost = await app.request(
      '/api/sunny-paws/admin/blocked',
      {
        method: 'POST',
        headers: { ...(await adminHeaders()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: '2028-01-01', endDate: '2028-01-02' }),
      },
      env,
    );
    expect(blockedPost.status).toBe(403);
    expect(await blockedPost.json()).toEqual({ error: 'account_disabled' });

    const blockedDelete = await app.request(
      '/api/sunny-paws/admin/blocked/some-id',
      { method: 'DELETE', headers: await adminHeaders() },
      env,
    );
    expect(blockedDelete.status).toBe(403);
    expect(await blockedDelete.json()).toEqual({ error: 'account_disabled' });
  });

  it('does not affect an active tenant', async () => {
    const { env } = createTestEnv(); // TENANT_A not disabled
    const cfg = await app.request('/api/sunny-paws/config', {}, env);
    expect(cfg.status).toBe(200);
    expect(((await cfg.json()) as { disabled: boolean }).disabled).toBe(false);
  });
});
