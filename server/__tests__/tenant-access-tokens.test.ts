import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import app from '../index';
import {
  createTenantAccessToken,
  findLiveTenantAccessToken,
  revokeTenantAccessToken,
} from '../db/repo';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../lib/personal-access-token';
import {
  generateTenantAccessToken,
  LAST_USED_RESOLUTION_MS,
  looksLikeTenantAccessToken,
} from '../lib/personal-access-token';
import { adminAuth, adminSessionOnly, tenantMiddleware } from '../lib/middleware';
import { mintAdminToken, mintOwnerToken, mintToken } from '../lib/token';
import {
  createTestEnv,
  endUserToken,
  OWNER_EMAIL,
  TENANT_A,
  TENANT_B,
  TEST_SECRET,
} from './helpers';
import type { AppEnv } from '../types';

/**
 * Tenant access tokens: the mirror of the end-user personal access token (0012), for the sitter
 * side — the credential that lets `adminAuth` accept a Bearer token wherever it accepts the
 * admin session JWT (Task 2). This file covers only what Task 1 builds: the generator and the
 * repo functions the table sits behind. No route exists yet.
 */

describe('tenant access tokens — generator', () => {
  it('starts with pawsa_ and carries at least 256 bits of CSPRNG entropy', () => {
    const randomSpy = vi.spyOn(Math, 'random');
    const csprngSpy = vi.spyOn(crypto, 'getRandomValues');
    try {
      const token = generateTenantAccessToken();
      expect(token.startsWith('pawsa_')).toBe(true);
      expect(token.length).toBe('pawsa_'.length + 43); // 32 CSPRNG bytes, base64url, no padding
      expect(csprngSpy).toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
      csprngSpy.mockRestore();
    }
  });

  it('mints a distinct secret every time', () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 25; i++) secrets.add(generateTenantAccessToken());
    expect(secrets.size).toBe(25);
  });

  it('looksLikeTenantAccessToken accepts pawsa_ and rejects the end-user pawsv_ prefix', () => {
    expect(looksLikeTenantAccessToken(generateTenantAccessToken())).toBe(true);
    expect(looksLikeTenantAccessToken(generatePersonalAccessToken())).toBe(false);
    expect(looksLikeTenantAccessToken('not-a-token')).toBe(false);
  });
});

describe('tenant access tokens — at rest', () => {
  it('stores only the hash: no pawsa_ token appears anywhere in its row', async () => {
    const { env, raw } = createTestEnv();
    const token = generateTenantAccessToken();
    const tokenHash = await hashPersonalAccessToken(token);
    const created = await createTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, {
      tenantUserId: 'tu_sunny',
      name: 'CI bot',
      tokenHash,
    });
    expect(created.Name).toBe('CI bot');
    expect(created.Id).toBeTruthy();
    expect(created.CreatedAt).toEqual(expect.any(String));

    const row = raw
      .prepare('SELECT * FROM TenantAccessTokens WHERE Id = ?')
      .get(created.Id) as Record<string, unknown>;
    expect(row.TokenHash).toBe(tokenHash);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('finds a live token scoped to its own tenant, and not under a different tenant', async () => {
    const { env } = createTestEnv();
    const token = generateTenantAccessToken();
    const tokenHash = await hashPersonalAccessToken(token);
    const created = await createTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, {
      tenantUserId: 'tu_sunny',
      name: 'Home laptop',
      tokenHash,
    });

    const foundOwnTenant = await findLiveTenantAccessToken(
      env.PAWSERVATION_DB,
      TENANT_A,
      tokenHash,
    );
    expect(foundOwnTenant).toEqual({
      Id: created.Id,
      TenantUserId: 'tu_sunny',
      LastUsedAt: null,
    });

    // Same hash, wrong tenant: the row belongs to TENANT_A and must be invisible from TENANT_B,
    // even though the digest matches exactly — Model A holds by construction (TenantId is bound
    // in the WHERE clause, not filtered afterward in application code).
    const foundOtherTenant = await findLiveTenantAccessToken(
      env.PAWSERVATION_DB,
      TENANT_B,
      tokenHash,
    );
    expect(foundOtherTenant).toBeNull();
  });

  it('revokes a token so it stops resolving, and is idempotent and scoped by owner', async () => {
    const { env } = createTestEnv();
    const token = generateTenantAccessToken();
    const tokenHash = await hashPersonalAccessToken(token);
    const created = await createTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, {
      tenantUserId: 'tu_sunny',
      name: 'Revoke me',
      tokenHash,
    });

    // Another tenant user's id (belongs to a different tenant entirely) can neither revoke nor
    // probe for this token: the 404-shaped false the route above this will report.
    expect(
      await revokeTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, 'tu_dana', created.Id),
    ).toBe(false);
    expect(
      await findLiveTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, tokenHash),
    ).not.toBeNull();

    expect(
      await revokeTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, 'tu_sunny', created.Id),
    ).toBe(true);
    expect(await findLiveTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, tokenHash)).toBeNull();

    // Revoking twice is idempotent: SQLite still counts the row as changed, so the second call
    // reports success rather than a confusing 404 for a token the caller can plainly see is dead.
    expect(
      await revokeTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, 'tu_sunny', created.Id),
    ).toBe(true);
  });
});

/**
 * A tenant access token minted straight through the repo — Task 3 builds the routes that will do
 * this for the sitter, and these tests are about `adminAuth`, not about the route that hands the
 * secret over. `tu_sunny` is the seeded Sunny Paws login (sql/seed.sql).
 */
async function mintTenantToken(
  env: Env,
  opts?: { tenantId?: string; tenantUserId?: string; name?: string },
): Promise<{ token: string; id: string }> {
  const token = generateTenantAccessToken();
  const created = await createTenantAccessToken(env.PAWSERVATION_DB, opts?.tenantId ?? TENANT_A, {
    tenantUserId: opts?.tenantUserId ?? 'tu_sunny',
    name: opts?.name ?? 'CI bot',
    tokenHash: await hashPersonalAccessToken(token),
  });
  return { token, id: created.Id };
}

const settings = (env: Env, credential: string, slug = 'sunny-paws') =>
  app.request(
    `/api/${slug}/admin/settings`,
    { headers: { Authorization: `Bearer ${credential}` } },
    env,
  );

describe('tenant access tokens — authenticating', () => {
  it('is accepted wherever the admin session is, and resolves to the same sitter', async () => {
    const { env } = createTestEnv();
    const { token } = await mintTenantToken(env);
    // The JWT is minted for the SAME TenantUsers row the token belongs to, which is the only way
    // "identical authority" is a claim a test can make: `adminUserId` is the whole of the admin
    // context, and GET /admin/settings publishes the email it resolves to.
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);

    const viaToken = await settings(env, token);
    const viaJwt = await settings(env, jwt);
    expect(viaToken.status).toBe(200);
    const body = (await viaToken.json()) as { adminEmail: string | null };
    expect(body).toEqual(await viaJwt.json());
    expect(body.adminEmail).toBe('admin@sunnypaws.example');
  });

  it('refuses a revoked token immediately — not at some expiry', async () => {
    const { env } = createTestEnv();
    const { token, id } = await mintTenantToken(env);
    expect((await settings(env, token)).status).toBe(200);

    await revokeTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, 'tu_sunny', id);
    // The very next request, with no clock advanced and nothing expiring.
    expect((await settings(env, token)).status).toBe(401);
  });

  it('refuses an unknown token, and one that is a near-miss for a live one', async () => {
    const { env } = createTestEnv();
    const { token } = await mintTenantToken(env);
    const attempt = async (candidate: string) => (await settings(env, candidate)).status;

    expect(await attempt('pawsa_totally-made-up')).toBe(401);
    expect(await attempt('')).toBe(401);
    // 401 is not enough: the token miss must be INDISTINGUISHABLE from every other way of not
    // being signed in, or the refusal itself confirms that a `pawsa_` string was a real token
    // shape. `endUserAuth` deliberately answers its two misses with DIFFERENT strings, so
    // "finish the mirror" is a plausible future edit — this is what would catch it.
    const tokenMiss = await settings(env, 'pawsa_totally-made-up');
    const jwtMiss = await settings(env, 'not-a-jwt-at-all');
    expect(tokenMiss.status).toBe(jwtMiss.status);
    expect(await tokenMiss.json()).toEqual(await jwtMiss.json());
    // A digest is what gets matched, never the plaintext — so a token differing from a live one in
    // a single character shares nothing with it. The substitutes must actually differ from the
    // character they replace, or roughly 1 run in 64 recreates the live token and passes.
    expect(await attempt(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(401);
    expect(await attempt('pawsa_' + (token[6] === 'x' ? 'y' : 'x') + token.slice(7))).toBe(401);
  });

  it('keeps the two token families on their own surfaces', async () => {
    const { env } = createTestEnv();
    const { token } = await mintTenantToken(env);
    const jess = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const minted = await app.request(
      '/api/sunny-paws/tokens',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${jess}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hers' }),
      },
      env,
    );
    // Proven to be a REAL end-user credential before it is used as one: a mint that quietly
    // failed would leave `token` undefined, and "undefined is refused on /admin/*" is a test of
    // nothing at all.
    expect(minted.status).toBe(201);
    const petOwnerToken = (await minted.json()) as { token: string };
    expect(typeof petOwnerToken.token).toBe('string');
    expect(petOwnerToken.token.startsWith('pawsv_')).toBe(true);

    // A pet owner's credential is not a sitter's. It does not even look like one, so it falls
    // through to the JWT verifier and is a plain 401 — and crucially fires NO tenant-token event:
    // the sitter-side signal has to mean "someone is walking SITTER tokens", or it means nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await settings(env, petOwnerToken.token)).status).toBe(401);
    expect(warn.mock.calls.map((c) => JSON.stringify(c)).join('\n')).not.toContain(
      'tenant_access_token_rejected',
    );
    warn.mockRestore();
    // And the sitter's is nothing on the client surface, for the same reason in reverse.
    const mine = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(mine.status).toBe(401);
  });

  it('refuses a widget session token and an owner session token on /admin/*', async () => {
    const { env } = createTestEnv();
    // Both are valid signatures over this same secret; neither is an admin claim shape.
    const widget = await mintToken('eu_someone', TENANT_A, TEST_SECRET);
    const owner = await mintOwnerToken(OWNER_EMAIL, TEST_SECRET);
    expect((await settings(env, widget)).status).toBe(401);
    expect((await settings(env, owner)).status).toBe(401);
  });
});

describe('adminSessionOnly', () => {
  /** A throwaway mount of the middleware under test — Task 3 owns the routes that will use it. */
  function probeApp(): Hono<AppEnv> {
    const probe = new Hono<AppEnv>()
      .use('/:slug/admin/probe', adminAuth, adminSessionOnly)
      .get('/:slug/admin/probe', (c) => c.json({ ok: true }))
      // Deliberately WITHOUT adminAuth: the wiring mistake the middleware must fail closed on.
      .use('/:slug/admin/unwired', adminSessionOnly)
      .get('/:slug/admin/unwired', (c) => c.json({ ok: true }));
    const outer = new Hono<AppEnv>();
    outer.use('/api/:slug/*', tenantMiddleware);
    outer.route('/api', probe);
    return outer;
  }

  const probe = (env: Env, credential: string, path = 'probe') =>
    probeApp().request(
      `/api/sunny-paws/admin/${path}`,
      { headers: { Authorization: `Bearer ${credential}` } },
      env,
    );

  it('lets the password session through and turns the token away', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const { token } = await mintTenantToken(env);

    expect((await probe(env, jwt)).status).toBe(200);
    const refused = await probe(env, token);
    expect(refused.status).toBe(403);
    // The message has to say what to do about it: the sitter is signed in, just not the right way.
    expect(((await refused.json()) as { error: string }).error).toMatch(/password/i);
  });

  it('fails closed when nothing recorded how the caller authenticated', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    expect((await probe(env, jwt, 'unwired')).status).toBe(403);
  });
});

/**
 * Task 3: the routes themselves — mint, list, revoke, and the password-only carve-out.
 * `server/routes/tenant-tokens.ts` is the file under test here.
 */
const adminTokensPath = (slug = 'sunny-paws') => `/api/${slug}/admin/tokens`;

/** POST /admin/tokens with an admin credential, returning the parsed creation response. */
async function mintViaRoute(
  env: Env,
  credential: string,
  name = 'CI bot',
  slug = 'sunny-paws',
): Promise<{ id: string; token: string; name: string }> {
  const res = await app.request(
    adminTokensPath(slug),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string; name: string };
}

const listTokens = (env: Env, credential: string, slug = 'sunny-paws') =>
  app.request(adminTokensPath(slug), { headers: { Authorization: `Bearer ${credential}` } }, env);

const deleteToken = (env: Env, credential: string, id: string, slug = 'sunny-paws') =>
  app.request(
    `${adminTokensPath(slug)}/${id}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${credential}` } },
    env,
  );

describe('tenant access tokens — issuing', () => {
  it('mints a token and returns the secret exactly once', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'My assistant');
    expect(created.name).toBe('My assistant');
    expect(created.id).toBeTruthy();
    expect(created.token.startsWith('pawsa_')).toBe(true);

    // The one and only disclosure. Nothing else ever hands it back.
    const list = await listTokens(env, jwt);
    expect(JSON.stringify(await list.json())).not.toContain(created.token);
  });

  it('lists id, name, createdAt and lastUsedAt — never the secret or its hash', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Listed');

    const res = await listTokens(env, jwt);
    expect(res.status).toBe(200);
    const { tokens } = (await res.json()) as {
      tokens: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
    };
    expect(tokens).toEqual([
      { id: created.id, name: 'Listed', createdAt: expect.any(String), lastUsedAt: null },
    ]);

    const stored = raw
      .prepare(`SELECT TokenHash FROM TenantAccessTokens WHERE Id = ?`)
      .get(created.id) as { TokenHash: string };
    expect(JSON.stringify(tokens)).not.toContain(stored.TokenHash);
  });

  it('requires a signed-in admin', async () => {
    const { env } = createTestEnv();
    const post = await app.request(
      adminTokensPath(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nobody' }),
      },
      env,
    );
    expect(post.status).toBe(401);
    expect((await app.request(adminTokensPath(), {}, env)).status).toBe(401);
  });

  it('requires a name the sitter will recognise later', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    for (const name of ['', '   ', 'x'.repeat(81), 42, undefined]) {
      const res = await app.request(
        adminTokensPath(),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
        env,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        'Name your token (1–80 characters).',
      );
    }
  });

  it('trims the name', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, '  Padded  ');
    expect(created.name).toBe('Padded');
    const { tokens } = (await (await listTokens(env, jwt)).json()) as {
      tokens: { name: string }[];
    };
    expect(tokens[0].name).toBe('Padded');
  });

  it('lists only this admin’s own tokens — another tenant’s token is absent', async () => {
    const { env } = createTestEnv();
    const sunny = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    await mintViaRoute(env, sunny, 'Sunny’s');

    // No second TenantUsers row shares a tenant in the base seed, so isolation is shown across
    // tenants instead: tu_dana must never see a token minted under Sunny Paws.
    const dana = await mintAdminToken('tu_dana', TENANT_B, TEST_SECRET);
    const res = await listTokens(env, dana, 'happy-tails');
    expect(((await res.json()) as { tokens: unknown[] }).tokens).toEqual([]);
  });
});

describe('tenant access tokens — carve-out', () => {
  it('refuses a tenant access token on POST, GET and DELETE of the token routes', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Password-minted');
    const { token } = created;

    const post = await app.request(
      adminTokensPath(),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Self-amplify' }),
      },
      env,
    );
    expect(post.status).toBe(403);
    expect(((await post.json()) as { error: string }).error).toMatch(/password/i);

    const get = await listTokens(env, token);
    expect(get.status).toBe(403);
    expect(((await get.json()) as { error: string }).error).toMatch(/password/i);

    const del = await deleteToken(env, token, created.id);
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: string }).error).toMatch(/password/i);
  });

  it('is the gate, not a dead token — the same token still reaches an ordinary admin route', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const { token } = await mintViaRoute(env, jwt, 'Still works elsewhere');

    const settingsRes = await settings(env, token);
    expect(settingsRes.status).toBe(200);
  });
});

describe('tenant access tokens — revoking', () => {
  it('revokes a token: it drops from the list and 401s on the very next admin request', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Revoke me');

    // Live before revocation.
    expect((await settings(env, created.token)).status).toBe(200);

    const del = await deleteToken(env, jwt, created.id);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ revoked: true });

    const list = await listTokens(env, jwt);
    expect(((await list.json()) as { tokens: unknown[] }).tokens).toEqual([]);

    // The very next request with the revoked token, no clock advanced and nothing expiring.
    expect((await settings(env, created.token)).status).toBe(401);
  });

  it('404s an unknown id and another tenant’s id; a second delete of the same id stays scoped', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Delete twice');

    expect((await deleteToken(env, jwt, created.id)).status).toBe(200);
    // revokeTenantAccessToken COALESCEs RevokedAt (Task 1, pinned by "is idempotent and scoped by
    // owner" above): a second delete of an id that still names a real, already-revoked row of
    // THIS caller's own reports success again rather than a confusing 404 for a token the sitter
    // can plainly see is already dead. It is out of scope for this task to change that contract.
    expect((await deleteToken(env, jwt, created.id)).status).toBe(200);

    expect((await deleteToken(env, jwt, 'nope')).status).toBe(404);

    const dana = await mintAdminToken('tu_dana', TENANT_B, TEST_SECRET);
    const danaCreated = await mintViaRoute(env, dana, 'Dana’s', 'happy-tails');
    // Another tenant's id: 404, indistinguishable from an id that never existed.
    expect((await deleteToken(env, jwt, danaCreated.id)).status).toBe(404);
  });
});

describe('tenant access tokens — last used', () => {
  /** Wraps the env's D1 so a test can see which statements a request actually issued. */
  function recordStatements(env: Env): string[] {
    const seen: string[] = [];
    const real = env.PAWSERVATION_DB;
    (env as { PAWSERVATION_DB: D1Database }).PAWSERVATION_DB = {
      ...real,
      prepare: (sql: string) => {
        seen.push(sql);
        return real.prepare(sql);
      },
      batch: (statements: unknown[]) =>
        (real as unknown as { batch: (s: unknown[]) => unknown }).batch(statements),
    } as unknown as D1Database;
    return seen;
  }

  const lastUsed = (raw: ReturnType<typeof createTestEnv>['raw'], id: string) =>
    (
      raw.prepare(`SELECT LastUsedAt FROM TenantAccessTokens WHERE Id = ?`).get(id) as {
        LastUsedAt: string | null;
      }
    ).LastUsedAt;

  it('stamps the first use, so an unused token is visibly unused', async () => {
    const { env, raw } = createTestEnv();
    const { token, id } = await mintTenantToken(env);
    expect(lastUsed(raw, id)).toBeNull();

    await settings(env, token);
    expect(lastUsed(raw, id)).not.toBeNull();
  });

  it('writes nothing on a second use inside the resolution window', async () => {
    const { env, raw } = createTestEnv();
    const { token, id } = await mintTenantToken(env);
    await settings(env, token); // first use stamps
    const stamped = lastUsed(raw, id);

    // Asserting on the statements ISSUED, not just on the stored value: an UPDATE that happens to
    // be a no-op is still a database round-trip on the request path of a credential built for
    // automated clients, which are precisely the callers that make many requests.
    const statements = recordStatements(env);
    await settings(env, token);
    await settings(env, token);
    // The recorder is proven to be installed before "no UPDATE was issued" is allowed to mean
    // anything: a wrapper that silently failed to take would record nothing and pass forever.
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((s) => s.includes('UPDATE TenantAccessTokens'))).toEqual([]);
    expect(lastUsed(raw, id)).toBe(stamped);
  });

  it('refreshes once the stamp is older than the resolution window', async () => {
    const { env, raw } = createTestEnv();
    const { token, id } = await mintTenantToken(env);
    // Aged past the window rather than mocking the clock — the stamp is a stored string, and this
    // is exactly the state a token in daily use is in when its owner comes back to look at it.
    const stale = new Date(Date.now() - (LAST_USED_RESOLUTION_MS + 60_000))
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    raw.prepare(`UPDATE TenantAccessTokens SET LastUsedAt = ? WHERE Id = ?`).run(stale, id);

    await settings(env, token);
    expect(lastUsed(raw, id)).not.toBe(stale);
  });

  /**
   * Makes the shim's writes genuinely asynchronous, for the one test that asserts on WHEN a write
   * lands rather than on whether it did.
   *
   * `helpers.ts` backs D1 with node:sqlite, which is synchronous: the shim's `run()` is an async
   * function whose body contains no await, so `touchTenantAccessToken(...)` has ALREADY written
   * the row by the time its promise reaches `waitUntil`. Asserting "still unstamped" against that
   * would be asserting about the harness, not about the middleware — and would keep passing if
   * the middleware started awaiting the write. Real D1 is a network round-trip; one real tick
   * before the work restores that, and makes the deferral something a test can see.
   */
  function deferWrites(env: Env): void {
    const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
      ({
        ...stmt,
        bind: (...args: unknown[]) =>
          wrap((stmt.bind as (...a: unknown[]) => D1PreparedStatement)(...args)),
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return await stmt.run();
        },
      }) as unknown as D1PreparedStatement;
    const real = env.PAWSERVATION_DB;
    (env as { PAWSERVATION_DB: D1Database }).PAWSERVATION_DB = {
      ...real,
      prepare: (sql: string) => wrap(real.prepare(sql)),
    } as unknown as D1Database;
  }

  it('defers the write to waitUntil when there is an ExecutionContext', async () => {
    const { env, raw } = createTestEnv();
    const { token, id } = await mintTenantToken(env);
    deferWrites(env);
    const tail: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => tail.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    // Deferred, not awaited, and literally so: the response came back with the stamp still
    // unwritten, and only draining the tail writes it. An implementation that awaited the touch
    // on the request path would have stamped the row before `res` resolved.
    expect(tail).toHaveLength(1);
    expect(lastUsed(raw, id)).toBeNull();
    await Promise.all(tail);
    expect(lastUsed(raw, id)).not.toBeNull();
  });
});
