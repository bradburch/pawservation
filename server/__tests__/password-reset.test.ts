import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { verifyPassword } from '../lib/password';
import { RESET_NONCE_KEY, signResetLink } from '../lib/reset-link';
import { RATE_LIMIT_TTL_SECONDS } from '../routes/password-reset';
import { ADMIN_EMAIL_A, ADMIN_PASSWORD, OWNER_EMAIL, TEST_SECRET, createTestEnv } from './helpers';

const start = (env: Env, email: string) =>
  app.request(
    '/api/password-reset/start',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    },
    env,
  );

const complete = (env: Env, body: unknown) =>
  app.request(
    '/api/password-reset/complete',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );

function configureEmail(env: Env) {
  env.RESEND_API_KEY = 'test-key';
  env.RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
  env.RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
}

// Creates a real OwnerUsers row via the actual signup flow (no direct-insert shortcut), so the
// owner exists exactly the way production owners come to exist.
async function makeOwner(env: Env, password: string): Promise<void> {
  const startRes = await app.request(
    '/api/signup/start',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OWNER_EMAIL }),
    },
    env,
  );
  const { prototypeLink } = (await startRes.json()) as { prototypeLink: string };
  const token = new URL(prototypeLink).searchParams.get('t')!;
  const res = await app.request(
    '/api/signup/complete',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    },
    env,
  );
  expect(res.status).toBe(200);
}

describe('POST /api/password-reset/start — enumeration neutrality', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the identical 200 body for an owner, a sitter, and an unknown email', async () => {
    const { env } = createTestEnv();
    await makeOwner(env, 'ownerpass1');
    configureEmail(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const bodies: string[] = [];
    for (const email of [OWNER_EMAIL, ADMIN_EMAIL_A, 'nobody@x.test']) {
      const res = await start(env, email);
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toBe(JSON.stringify({ ok: true }));
  });

  it('sends a link only for emails with an actual account', async () => {
    const { env } = createTestEnv();
    await makeOwner(env, 'ownerpass1');
    configureEmail(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await start(env, 'nobody@x.test');
    expect(fetchSpy).not.toHaveBeenCalled();
    await start(env, ADMIN_EMAIL_A);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await start(env, OWNER_EMAIL);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Account-access mail (reset links) goes out from the no-reply sender, not the booking one.
    const sentBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(sentBody.from).toBe(env.RESEND_FROM_NOREPLY);
  });

  it('dev + no email provider: prototypeLink ONLY for emails with an account', async () => {
    const { env } = createTestEnv();
    await makeOwner(env, 'ownerpass1');
    const sitter = (await (await start(env, ADMIN_EMAIL_A)).json()) as { prototypeLink?: string };
    expect(sitter.prototypeLink).toMatch(/\/setup\?t=.*&reset=1/);
    const owner = (await (await start(env, OWNER_EMAIL)).json()) as { prototypeLink?: string };
    expect(owner.prototypeLink).toMatch(/\/setup\?t=.*&reset=1/);
    const unknown = (await (await start(env, 'nobody@x.test')).json()) as object;
    expect(unknown).toEqual({ ok: true });
  });

  it('rejects an invalid email body with 400', async () => {
    const { env } = createTestEnv();
    expect((await start(env, 'not-an-email')).status).toBe(400);
  });

  it('caps at 5/hour per email+IP, in its own counter namespace from signup', async () => {
    const { env } = createTestEnv();
    configureEmail(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    for (let i = 0; i < 5; i++) expect((await start(env, ADMIN_EMAIL_A)).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const sixth = await start(env, ADMIN_EMAIL_A);
    expect(await sixth.json()).toEqual({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(RATE_LIMIT_TTL_SECONDS).toBe(3600);
  });
});

async function getResetToken(env: Env, email: string): Promise<string> {
  const res = await start(env, email);
  const { prototypeLink } = (await res.json()) as { prototypeLink?: string };
  expect(prototypeLink).toBeTruthy();
  return new URL(prototypeLink!).searchParams.get('t')!;
}

describe('POST /api/password-reset/complete — sitter', () => {
  it('updates the password and returns a working admin token; old password no longer works', async () => {
    const { env } = createTestEnv();
    const t = await getResetToken(env, ADMIN_EMAIL_A);
    const res = await complete(env, { token: t, password: 'newpass99' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; role: string };
    expect(body.role).toBe('admin');

    const settings = await app.request(
      '/api/admin/session',
      { headers: { Authorization: `Bearer ${body.token}` } },
      env,
    );
    expect(settings.status).toBe(200);

    const oldLogin = await app.request(
      '/api/admin/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL_A, password: ADMIN_PASSWORD }),
      },
      env,
    );
    expect(oldLogin.status).toBe(401);

    const newLogin = await app.request(
      '/api/admin/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL_A, password: 'newpass99' }),
      },
      env,
    );
    expect(newLogin.status).toBe(200);
  });

  it('rejects a short password (400) BEFORE consuming the link', async () => {
    const { env } = createTestEnv();
    const t = await getResetToken(env, ADMIN_EMAIL_A);
    expect((await complete(env, { token: t, password: 'seven77' })).status).toBe(400);
    expect((await complete(env, { token: t, password: 'eightchr' })).status).toBe(200);
  });

  it('rejects expired and tampered tokens (400)', async () => {
    const { env } = createTestEnv();
    const nonce = crypto.randomUUID();
    await env.PAWBOOK_CACHE.put(RESET_NONCE_KEY(nonce), '1');
    const expired = await signResetLink(TEST_SECRET, {
      email: ADMIN_EMAIL_A,
      kind: 'sitter',
      nonce,
      exp: Date.now() - 1000,
    });
    expect((await complete(env, { token: expired, password: 'newpass99' })).status).toBe(400);
    const good = await getResetToken(env, ADMIN_EMAIL_A);
    const tampered = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect((await complete(env, { token: tampered, password: 'newpass99' })).status).toBe(400);
  });

  it('is single-use — the nonce is consumed, so the same link cannot complete twice', async () => {
    const { env } = createTestEnv();
    const t = await getResetToken(env, ADMIN_EMAIL_A);
    expect((await complete(env, { token: t, password: 'newpass99' })).status).toBe(200);
    expect((await complete(env, { token: t, password: 'again12345' })).status).toBe(400);
  });
});

describe('POST /api/password-reset/complete — owner', () => {
  it('updates the OwnerUsers password and returns a working owner token', async () => {
    const { env, raw } = createTestEnv();
    await makeOwner(env, 'ownerpass1');
    const t = await getResetToken(env, OWNER_EMAIL);
    const res = await complete(env, { token: t, password: 'newownerpass' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; role: string; email: string };
    expect(body.role).toBe('owner');
    expect(body.email).toBe(OWNER_EMAIL);
    const row = raw
      .prepare('SELECT PasswordHash FROM OwnerUsers WHERE Email = ?')
      .get(OWNER_EMAIL) as { PasswordHash: string };
    expect(await verifyPassword('newownerpass', row.PasswordHash)).toBe(true);
    expect(await verifyPassword('ownerpass1', row.PasswordHash)).toBe(false);
  });

  it('re-checks OWNER_EMAILS at completion — a removed owner is rejected (400)', async () => {
    const { env } = createTestEnv();
    await makeOwner(env, 'ownerpass1');
    const t = await getResetToken(env, OWNER_EMAIL);
    env.OWNER_EMAILS = ''; // secret changed since the link was issued
    expect((await complete(env, { token: t, password: 'newownerpass' })).status).toBe(400);
  });

  it('does not mint a reset link for a deprovisioned owner even though the OwnerUsers row persists', async () => {
    const { env } = createTestEnv();
    await makeOwner(env, 'ownerpass1');
    env.OWNER_EMAILS = ''; // owner removed from the allowlist secret; row still exists
    const res = await start(env, OWNER_EMAIL);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; prototypeLink?: string };
    expect(body).toEqual({ ok: true });
    expect(body.prototypeLink).toBeUndefined();
  });
});

describe('POST /api/password-reset/complete — vanished account', () => {
  it('rejects with the expired-link copy if the account no longer exists (0 rows changed)', async () => {
    const { env } = createTestEnv();
    const nonce = crypto.randomUUID();
    await env.PAWBOOK_CACHE.put(RESET_NONCE_KEY(nonce), '1');
    const token = await signResetLink(TEST_SECRET, {
      email: 'ghost@x.test',
      kind: 'sitter',
      nonce,
      exp: Date.now() + 1000,
    });
    const res = await complete(env, { token, password: 'newpass99' });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error:
        'This link has expired or was already used — enter your email on the sign-in page to get a fresh one.',
    });
  });
});
