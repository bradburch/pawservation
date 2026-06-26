import { describe, expect, it } from 'vitest';
import app from '../index';
import { mintToken, verifyToken } from '../lib/token';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';

describe('widget token', () => {
  it('round-trips valid claims', async () => {
    const token = await mintToken('user-1', TENANT_A, TEST_SECRET);
    const claims = await verifyToken(token, TEST_SECRET);
    expect(claims).toMatchObject({ sub: 'user-1', tid: TENANT_A });
    expect(claims!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects an expired token', async () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
    const token = await mintToken('user-1', TENANT_A, TEST_SECRET, twoHoursAgo);
    expect(await verifyToken(token, TEST_SECRET)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await mintToken('user-1', TENANT_A, TEST_SECRET);
    const tampered = token.slice(0, -4) + 'AAAA';
    expect(await verifyToken(tampered, TEST_SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintToken('user-1', TENANT_A, 'some-other-secret');
    expect(await verifyToken(token, TEST_SECRET)).toBeNull();
  });

  it('rejects a tenant-A token on tenant-B routes with 403 (middleware isolation)', async () => {
    const { env } = createTestEnv();
    const tokenForA = await mintToken('user-1', TENANT_A, TEST_SECRET);
    const res = await app.request(
      '/api/happy-tails/bookings/mine',
      { headers: { Authorization: `Bearer ${tokenForA}` } },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('rejects a missing token with 401 so the widget re-identifies', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/brad-paws/bookings/mine', {}, env);
    expect(res.status).toBe(401);
  });

  it('does not let booking middleware guard public routes', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/brad-paws/config', {}, env);
    expect(res.status).toBe(200);
  });
});
