import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { SIGNUP_NONCE_KEY, signSignupLink } from '../lib/signup-link';
import { RATE_LIMIT_TTL_SECONDS } from '../routes/signup';
import { ALLOWED_EMAIL, createTestEnv, OWNER_EMAIL, TEST_SECRET } from './helpers';

export const start = (env: Env, email: string) =>
  app.request(
    '/api/signup/start',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    },
    env,
  );

function configureEmail(env: Env) {
  env.RESEND_API_KEY = 'test-key';
  env.RESEND_FROM = 'Pawservation <bookings@example.com>';
}

describe('POST /api/signup/start — enumeration neutrality (email configured)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the identical 200 body for allowlisted, claimed, unknown, and owner emails', async () => {
    const { env, raw } = createTestEnv();
    configureEmail(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    raw
      .prepare(
        "INSERT INTO AllowedSitters (Email, ClaimedAt) VALUES ('claimed@x.test', '2026-01-01T00:00:00Z')",
      )
      .run();
    const bodies: string[] = [];
    for (const email of [ALLOWED_EMAIL, 'claimed@x.test', 'nobody@x.test', OWNER_EMAIL]) {
      const res = await start(env, email);
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1); // ONE body for every input
    expect(bodies[0]).toBe(JSON.stringify({ ok: true }));
  });

  it('sends a link only to eligible emails', async () => {
    const { env } = createTestEnv();
    configureEmail(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await start(env, 'nobody@x.test'); // ineligible → no send
    expect(fetchSpy).not.toHaveBeenCalled();
    await start(env, ALLOWED_EMAIL); // unclaimed allowlist row → send
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('https://api.resend.com/emails', expect.anything());
    await start(env, OWNER_EMAIL); // owner without a password yet → send
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('swallows send failures — the neutral 200 already went out', async () => {
    const { env } = createTestEnv();
    configureEmail(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const res = await start(env, ALLOWED_EMAIL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('POST /api/signup/start — dev degrade + fail-closed', () => {
  it('dev + no email provider: prototypeLink ONLY for eligible emails', async () => {
    const { env } = createTestEnv(); // ENVIRONMENT=development, no RESEND_*
    const eligible = (await (await start(env, ALLOWED_EMAIL)).json()) as {
      ok: boolean;
      prototypeLink?: string;
    };
    expect(eligible.ok).toBe(true);
    expect(eligible.prototypeLink).toMatch(/\/setup\?t=/);
    const owner = (await (await start(env, OWNER_EMAIL)).json()) as { prototypeLink?: string };
    expect(owner.prototypeLink).toMatch(/\/setup\?t=/);
    const unknown = (await (await start(env, 'nobody@x.test')).json()) as object;
    expect(unknown).toEqual({ ok: true }); // no link — and no other divergence
  });

  it('unconfigured email OUTSIDE development fails closed: 503 for every input', async () => {
    const { env } = createTestEnv();
    env.ENVIRONMENT = 'production';
    const a = await start(env, ALLOWED_EMAIL);
    const b = await start(env, 'nobody@x.test');
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(await a.text()).toBe(await b.text()); // reveals nothing per-email
  });

  it('rejects an invalid email body with 400', async () => {
    const { env } = createTestEnv();
    expect((await start(env, 'not-an-email')).status).toBe(400);
  });
});

describe('POST /api/signup/start — rate limiting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('caps at 5/hour per email+IP; over-cap returns the same neutral body and skips the send', async () => {
    const { env } = createTestEnv();
    configureEmail(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    for (let i = 0; i < 5; i++) expect((await start(env, ALLOWED_EMAIL)).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const sixth = await start(env, ALLOWED_EMAIL);
    expect(sixth.status).toBe(200);
    expect(await sixth.json()).toEqual({ ok: true }); // limiter is not an oracle
    expect(fetchSpy).toHaveBeenCalledTimes(5); // send skipped
  });

  it('is a true fixed window: a capped requester succeeds again once the window elapses', async () => {
    // Regression test for the TTL-refresh lockout bug: the old implementation refreshed the
    // KV key's expirationTtl on every write — including over-cap ones — so a capped user who
    // kept retrying pushed the expiry out indefinitely and never got unblocked. A fixed window
    // must track its own start time and reset once that start ages past the TTL, independent
    // of how many retries happened in between.
    const { env } = createTestEnv();
    configureEmail(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) expect((await start(env, ALLOWED_EMAIL)).status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(5);

      // Over cap — same neutral body, send skipped — and (this is the bug) a retry here must
      // NOT push the window's expiry back out.
      const sixth = await start(env, ALLOWED_EMAIL);
      expect(await sixth.json()).toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledTimes(5);

      // Advance past the 1-hour window (past, not just up to, its boundary) and retry: this must
      // succeed and send again, proving the cap is "5 per rolling hour", not "5 total, ever".
      vi.advanceTimersByTime(RATE_LIMIT_TTL_SECONDS * 1000 + 1);
      const afterWindow = await start(env, ALLOWED_EMAIL);
      expect(afterWindow.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

async function getSetupToken(env: Env, email: string): Promise<string> {
  // Dev-degrade start (createTestEnv has no RESEND_*, ENVIRONMENT=development) hands the
  // link back inline — the same path a local demo uses.
  const res = await start(env, email);
  const { prototypeLink } = (await res.json()) as { prototypeLink?: string };
  expect(prototypeLink).toBeTruthy();
  return new URL(prototypeLink!).searchParams.get('t')!;
}

const complete = (env: Env, body: unknown) =>
  app.request(
    '/api/signup/complete',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

describe('POST /api/signup/complete — sitter', () => {
  it('provisions tenant + login atomically and returns a working admin token', async () => {
    const { env, raw } = createTestEnv();
    const t = await getSetupToken(env, ALLOWED_EMAIL);
    const res = await complete(env, {
      token: t,
      password: 'hunter22',
      businessName: "Rex's Best Walks!",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      role: string;
      slug: string;
      displayName: string;
    };
    expect(body.role).toBe('admin');
    expect(body.slug).toBe('rex-s-best-walks');
    expect(body.displayName).toBe("Rex's Best Walks!");

    // Allowlist row claimed, no services seeded (wizard owns onboarding).
    const claim = raw
      .prepare('SELECT ClaimedAt, TenantId FROM AllowedSitters WHERE Email = ?')
      .get(ALLOWED_EMAIL) as { ClaimedAt: string | null; TenantId: string | null };
    expect(claim.ClaimedAt).toBeTruthy();
    const services = raw
      .prepare('SELECT COUNT(*) AS n FROM TenantServices WHERE TenantId = ?')
      .get(claim.TenantId) as { n: number };
    expect(services.n).toBe(0);

    // The returned token authenticates the new tenant's admin routes right away…
    const settings = await app.request(
      `/api/${body.slug}/admin/settings`,
      { headers: { Authorization: `Bearer ${body.token}` } },
      env,
    );
    expect(settings.status).toBe(200);

    // …and the new sitter can immediately log in through the REAL login route.
    const login = await app.request(
      '/api/admin/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ALLOWED_EMAIL, password: 'hunter22' }),
      },
      env,
    );
    expect(login.status).toBe(200);
    expect(((await login.json()) as { slug: string }).slug).toBe(body.slug);
  });

  it('uniquifies a taken slug with -2', async () => {
    const { env } = createTestEnv();
    const t = await getSetupToken(env, ALLOWED_EMAIL);
    const res = await complete(env, {
      token: t,
      password: 'hunter22',
      businessName: 'Sunny Paws', // collides with the seeded sunny-paws tenant
    });
    expect(((await res.json()) as { slug: string }).slug).toBe('sunny-paws-2');
  });

  it('skips reserved slugs ("Admin" → admin-2)', async () => {
    const { env } = createTestEnv();
    const t = await getSetupToken(env, ALLOWED_EMAIL);
    const res = await complete(env, { token: t, password: 'hunter22', businessName: 'Admin' });
    expect(((await res.json()) as { slug: string }).slug).toBe('admin-2');
  });

  it('rejects a short password (400) BEFORE consuming the link', async () => {
    const { env } = createTestEnv();
    const t = await getSetupToken(env, ALLOWED_EMAIL);
    expect(
      (await complete(env, { token: t, password: 'seven77', businessName: 'Biz' })).status,
    ).toBe(400);
    // The link survived the rejection and still works.
    expect(
      (await complete(env, { token: t, password: 'eightchr', businessName: 'Biz' })).status,
    ).toBe(200);
  });

  it('rejects a missing/undeliverable business name (400)', async () => {
    const { env } = createTestEnv();
    const t = await getSetupToken(env, ALLOWED_EMAIL);
    expect((await complete(env, { token: t, password: 'hunter22' })).status).toBe(400);
    expect(
      (await complete(env, { token: t, password: 'hunter22', businessName: '!!!' })).status,
    ).toBe(400); // slugifies to '' — no derivable identity
  });

  it('rejects expired and tampered tokens (400)', async () => {
    const { env } = createTestEnv();
    // Expired: live nonce, past exp — ONLY expiry can be the reason for rejection.
    const nonce = crypto.randomUUID();
    await env.PAWBOOK_CACHE.put(SIGNUP_NONCE_KEY(nonce), '1');
    const expired = await signSignupLink(TEST_SECRET, {
      email: ALLOWED_EMAIL,
      kind: 'sitter',
      nonce,
      exp: Date.now() - 1000,
    });
    expect(
      (await complete(env, { token: expired, password: 'hunter22', businessName: 'B' })).status,
    ).toBe(400);
    // Tampered signature.
    const good = await getSetupToken(env, ALLOWED_EMAIL);
    const tampered = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect(
      (await complete(env, { token: tampered, password: 'hunter22', businessName: 'B' })).status,
    ).toBe(400);
  });

  it('is single-use — the nonce is consumed, so the same link cannot complete twice', async () => {
    const { env } = createTestEnv();
    const t = await getSetupToken(env, ALLOWED_EMAIL);
    expect(
      (await complete(env, { token: t, password: 'hunter22', businessName: 'Once Biz' })).status,
    ).toBe(200);
    expect(
      (await complete(env, { token: t, password: 'hunter22', businessName: 'Twice Biz' })).status,
    ).toBe(400); // nonce gone → treated as expired/used
  });

  it('a second live link that beat the nonce race aborts atomically with 409 — no orphan tenant', async () => {
    const { env, raw } = createTestEnv();
    const t1 = await getSetupToken(env, ALLOWED_EMAIL);
    const t2 = await getSetupToken(env, ALLOWED_EMAIL); // second link, its own live nonce
    expect(
      (await complete(env, { token: t1, password: 'hunter22', businessName: 'First Biz' })).status,
    ).toBe(200);
    const before = (raw.prepare('SELECT COUNT(*) AS n FROM Tenants').get() as { n: number }).n;
    const res = await complete(env, {
      token: t2,
      password: 'hunter22',
      businessName: 'Second Biz',
    });
    expect(res.status).toBe(409); // TenantUsers.Email UNIQUE aborted the whole batch
    const after = (raw.prepare('SELECT COUNT(*) AS n FROM Tenants').get() as { n: number }).n;
    expect(after).toBe(before); // no orphan 'second-biz' tenant row
  });

  it('a revoked-mid-flight invite (deleted between link mint and completion) is rejected with no orphan tenant or login row', async () => {
    // The allowlist-claim UPDATE inside createTenantFromSignup guards with
    // `WHERE Email = ? AND ClaimedAt IS NULL`; if an owner revokes the invite (deleting the
    // AllowedSitters row via DELETE /api/owner/allowlist) after the link is minted but before
    // /complete's batch runs, that UPDATE matches zero rows WITHOUT throwing — a plain
    // TenantUsers.Email-UNIQUE catch would miss this and let the tenant stand unclaimed. The
    // route must detect the no-op claim and compensate.
    const { env, raw } = createTestEnv();
    const t = await getSetupToken(env, ALLOWED_EMAIL);
    raw.prepare('DELETE FROM AllowedSitters WHERE Email = ?').run(ALLOWED_EMAIL);
    const tenantsBefore = (raw.prepare('SELECT COUNT(*) AS n FROM Tenants').get() as { n: number })
      .n;
    const usersBefore = (
      raw.prepare('SELECT COUNT(*) AS n FROM TenantUsers').get() as { n: number }
    ).n;
    const res = await complete(env, {
      token: t,
      password: 'hunter22',
      businessName: 'Ghost Biz',
    });
    expect(res.status).toBe(400);
    const tenantsAfter = (raw.prepare('SELECT COUNT(*) AS n FROM Tenants').get() as { n: number })
      .n;
    const usersAfter = (raw.prepare('SELECT COUNT(*) AS n FROM TenantUsers').get() as { n: number })
      .n;
    expect(tenantsAfter).toBe(tenantsBefore); // no orphan 'ghost-biz' tenant
    expect(usersAfter).toBe(usersBefore); // no orphan login either
    expect(raw.prepare('SELECT 1 FROM Tenants WHERE Slug = ?').get('ghost-biz')).toBeFalsy();
    // Nonce was already consumed before the claim check ran — no replay resurrection.
    expect(
      (await complete(env, { token: t, password: 'hunter22', businessName: 'Ghost Biz' })).status,
    ).toBe(400);
  });
});

describe('POST /api/signup/complete — owner', () => {
  it('creates the OwnerUsers row and returns an owner token', async () => {
    const { env, raw } = createTestEnv();
    const t = await getSetupToken(env, OWNER_EMAIL);
    const res = await complete(env, { token: t, password: 'ownerpass1' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; role: string; email: string };
    expect(body.role).toBe('owner');
    expect(body.email).toBe(OWNER_EMAIL);
    const row = raw
      .prepare('SELECT PasswordHash FROM OwnerUsers WHERE Email = ?')
      .get(OWNER_EMAIL) as { PasswordHash: string };
    expect(row.PasswordHash.startsWith('pbkdf2$')).toBe(true);
  });

  it('re-checks OWNER_EMAILS at completion — a removed owner is rejected (400)', async () => {
    const { env } = createTestEnv();
    const t = await getSetupToken(env, OWNER_EMAIL);
    env.OWNER_EMAILS = ''; // secret changed since the link was issued
    expect((await complete(env, { token: t, password: 'ownerpass1' })).status).toBe(400);
  });

  it('a duplicate-owner replay gets 409', async () => {
    const { env } = createTestEnv();
    const t1 = await getSetupToken(env, OWNER_EMAIL);
    const t2 = await getSetupToken(env, OWNER_EMAIL);
    expect((await complete(env, { token: t1, password: 'ownerpass1' })).status).toBe(200);
    expect((await complete(env, { token: t2, password: 'ownerpass1' })).status).toBe(409);
  });
});
