import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv, OWNER_EMAIL, TENANT_A, TEST_SECRET } from './helpers';
import { mintAdminToken, mintOwnerToken } from '../lib/token';
import { getTenantById } from '../db/repo';

const ownerHeaders = async () => ({
  Authorization: `Bearer ${await mintOwnerToken(OWNER_EMAIL, TEST_SECRET)}`,
  'Content-Type': 'application/json',
});

describe('owner disable/enable/remove routes', () => {
  it('PATCH toggles DisabledAt and 404s an unknown tenant', async () => {
    const { env } = createTestEnv();
    const off = await app.request(
      `/api/owner/sitters/${TENANT_A}`,
      { method: 'PATCH', headers: await ownerHeaders(), body: '{"disabled":true}' },
      env,
    );
    expect(off.status).toBe(200);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))?.DisabledAt).not.toBeNull();

    const on = await app.request(
      `/api/owner/sitters/${TENANT_A}`,
      { method: 'PATCH', headers: await ownerHeaders(), body: '{"disabled":false}' },
      env,
    );
    expect(on.status).toBe(200);
    expect((await getTenantById(env.PAWSERVATION_DB, TENANT_A))?.DisabledAt).toBeNull();

    const missing = await app.request(
      '/api/owner/sitters/nope',
      { method: 'PATCH', headers: await ownerHeaders(), body: '{"disabled":true}' },
      env,
    );
    expect(missing.status).toBe(404);
  });

  it('DELETE removes the tenant (204) and 404s an unknown tenant', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      `/api/owner/sitters/${TENANT_A}`,
      { method: 'DELETE', headers: await ownerHeaders() },
      env,
    );
    expect(res.status).toBe(204);
    expect(await getTenantById(env.PAWSERVATION_DB, TENANT_A)).toBeNull();

    const missing = await app.request(
      '/api/owner/sitters/nope',
      { method: 'DELETE', headers: await ownerHeaders() },
      env,
    );
    expect(missing.status).toBe(404);
  });

  it('rejects a non-owner (admin) token on both routes', async () => {
    const { env } = createTestEnv();
    const adminAuth = {
      Authorization: `Bearer ${await mintAdminToken('u', TENANT_A, TEST_SECRET)}`,
      'Content-Type': 'application/json',
    };
    const patch = await app.request(
      `/api/owner/sitters/${TENANT_A}`,
      { method: 'PATCH', headers: adminAuth, body: '{"disabled":true}' },
      env,
    );
    expect(patch.status).toBe(401);
    const del = await app.request(
      `/api/owner/sitters/${TENANT_A}`,
      { method: 'DELETE', headers: adminAuth },
      env,
    );
    expect(del.status).toBe(401);
  });

  it('roster includes disabled status', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET DisabledAt='2026-07-23 00:00:00' WHERE Id='${TENANT_A}';`);
    const res = await app.request('/api/owner/sitters', { headers: await ownerHeaders() }, env);
    const body = (await res.json()) as { sitters: { tenantId: string; disabled: boolean }[] };
    expect(body.sitters.find((s) => s.tenantId === TENANT_A)?.disabled).toBe(true);
  });
});
