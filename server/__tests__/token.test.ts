import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  mintAdminToken,
  mintOwnerToken,
  mintToken,
  TOKEN_TTL_SECONDS,
  verifyAdminToken,
  verifyOwnerToken,
  verifyToken,
} from '../lib/token';
import { adminToken, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';

describe('widget token', () => {
  it('round-trips valid claims', async () => {
    const token = await mintToken('user-1', TENANT_A, TEST_SECRET);
    const claims = await verifyToken(token, TEST_SECRET);
    expect(claims).toMatchObject({ sub: 'user-1', tid: TENANT_A });
    expect(claims!.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects an expired token', async () => {
    // Minted one full TTL (plus slack) in the past, so this stays expired if the TTL changes.
    const beforeTtl = Math.floor(Date.now() / 1000) - (TOKEN_TTL_SECONDS + 60);
    const token = await mintToken('user-1', TENANT_A, TEST_SECRET, beforeTtl);
    expect(await verifyToken(token, TEST_SECRET)).toBeNull();
  });

  it('mints tokens that live for the full TTL', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await mintToken('user-1', TENANT_A, TEST_SECRET, now);
    const claims = await verifyToken(token, TEST_SECRET);
    expect(claims!.exp).toBe(now + TOKEN_TTL_SECONDS);
    expect(TOKEN_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('rejects a tampered signature', async () => {
    const token = await mintToken('user-1', TENANT_A, TEST_SECRET);
    const tampered = token.slice(0, -4) + 'AAAA';
    expect(await verifyToken(tampered, TEST_SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await mintToken('user-1', TENANT_A, 'some-other-secret-0123456789');
    expect(await verifyToken(token, TEST_SECRET)).toBeNull();
  });

  it('rejects an admin (role-bearing) token so it cannot authenticate widget routes', async () => {
    const admin = await mintAdminToken('tu_1', TENANT_A, TEST_SECRET);
    expect(await verifyToken(admin, TEST_SECRET)).toBeNull();
  });

  it('rejects an admin token on a widget endpoint with 401', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { Authorization: `Bearer ${await adminToken(TENANT_A)}` } },
      env,
    );
    expect(res.status).toBe(401);
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
    const res = await app.request('/api/sunny-paws/bookings/mine', {}, env);
    expect(res.status).toBe(401);
  });

  it('does not let booking middleware guard public routes', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/sunny-paws/config', {}, env);
    expect(res.status).toBe(200);
  });
});

describe('TOKEN_SECRET guard', () => {
  it.each(['', 'short', 'local-dev-secret-change-me', 'embed-proto-dev-secret-not-for-production'])(
    'returns 503 for missing/weak secret %j',
    async (secret) => {
      const { env } = createTestEnv();
      env.TOKEN_SECRET = secret;
      const res = await app.request('/api/sunny-paws/config', {}, env);
      expect(res.status).toBe(503);
    },
  );
});

describe('owner tokens', () => {
  const SECRET = 'test-secret-0123456789';

  it('round-trips owner claims with email as sub and no tid', async () => {
    const token = await mintOwnerToken('owner@pawservation.test', SECRET);
    const claims = await verifyOwnerToken(token, SECRET);
    expect(claims?.sub).toBe('owner@pawservation.test');
    expect(claims?.role).toBe('owner');
    expect(claims && 'tid' in claims).toBe(false);
  });

  it('is rejected by the widget and admin verifiers (and rejects theirs)', async () => {
    const owner = await mintOwnerToken('owner@pawservation.test', SECRET);
    expect(await verifyToken(owner, SECRET)).toBeNull(); // widget verifier rejects any role
    expect(await verifyAdminToken(owner, SECRET)).toBeNull(); // requires role 'admin' + tid
    const admin = await mintAdminToken('tu_1', 'tnt_1', SECRET);
    expect(await verifyOwnerToken(admin, SECRET)).toBeNull(); // requires role 'owner'
    const widget = await mintToken('eu_1', 'tnt_1', SECRET);
    expect(await verifyOwnerToken(widget, SECRET)).toBeNull(); // no role at all
  });

  it('expires with the admin TTL (8h)', async () => {
    const token = await mintOwnerToken('owner@pawservation.test', SECRET, 1_000);
    // exp = 1_000 + 8h; hono/jwt checks exp against real time, so a token minted in the
    // deep past is already expired.
    expect(await verifyOwnerToken(token, SECRET)).toBeNull();
  });
});
