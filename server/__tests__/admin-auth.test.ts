import { describe, expect, it } from 'vitest';
import app from '../index';
import { DUMMY_PASSWORD_HASH, hashPassword, ITERATIONS, verifyPassword } from '../lib/password';
import { ADMIN_EMAIL_A, ADMIN_EMAIL_B, ADMIN_PASSWORD, createTestEnv } from './helpers';

describe('password hashing', () => {
  it('round-trips a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('hunter2');
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    expect(await verifyPassword('hunter2', stored)).toBe(true);
    expect(await verifyPassword('Hunter2', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('produces a different hash each time (random salt) but both verify', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same', a)).toBe(true);
    expect(await verifyPassword('same', b)).toBe(true);
  });

  it('rejects malformed stored values without throwing', async () => {
    expect(await verifyPassword('x', 'garbage')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$notanumber$aa$bb')).toBe(false);
  });

  it('DUMMY_PASSWORD_HASH uses the current iteration count (login timing parity)', () => {
    // The miss-path dummy verify only costs the same as a real verify if its iterations match.
    const [scheme, iterations] = DUMMY_PASSWORD_HASH.split('$');
    expect(scheme).toBe('pbkdf2');
    expect(Number(iterations)).toBe(ITERATIONS);
  });
});

describe('sitter login', () => {
  const login = (env: Env, email: string, password: string) =>
    app.request(
      '/api/admin/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
      env,
    );

  it('logs in a seeded sitter and returns a token scoped to their tenant', async () => {
    const { env } = createTestEnv();
    const res = await login(env, ADMIN_EMAIL_A, ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      role: string;
      slug: string;
      displayName: string;
    };
    expect(body.role).toBe('admin');
    expect(body.slug).toBe('sunny-paws');
    expect(body.displayName).toBe('Sunny Paws');

    // The returned token authenticates that tenant's admin routes…
    const ok = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${body.token}` } },
      env,
    );
    expect(ok.status).toBe(200);

    // …but NOT the other tenant's (403).
    const cross = await app.request(
      '/api/happy-tails/admin/settings',
      { headers: { Authorization: `Bearer ${body.token}` } },
      env,
    );
    expect(cross.status).toBe(403);
  });

  it('resolves the right tenant from the login email', async () => {
    const { env } = createTestEnv();
    const res = await login(env, ADMIN_EMAIL_B, ADMIN_PASSWORD);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe('happy-tails');
  });

  it('rejects a wrong password and an unknown email with 401', async () => {
    const { env } = createTestEnv();
    expect((await login(env, ADMIN_EMAIL_A, 'wrong')).status).toBe(401);
    expect((await login(env, 'nobody@example.test', ADMIN_PASSWORD)).status).toBe(401);
  });

  it('rejects missing fields and non-string fields with 400', async () => {
    const { env } = createTestEnv();
    expect((await login(env, '', '')).status).toBe(400);
    const nonString = await app.request(
      '/api/admin/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 5, password: true }),
      },
      env,
    );
    expect(nonString.status).toBe(400);
  });

  it('restores a session via GET /api/admin/session', async () => {
    const { env } = createTestEnv();
    const { token } = (await (await login(env, ADMIN_EMAIL_A, ADMIN_PASSWORD)).json()) as {
      token: string;
    };
    const session = await app.request(
      '/api/admin/session',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(session.status).toBe(200);
    expect(((await session.json()) as { slug: string }).slug).toBe('sunny-paws');

    const noToken = await app.request('/api/admin/session', {}, env);
    expect(noToken.status).toBe(401);
  });
});
