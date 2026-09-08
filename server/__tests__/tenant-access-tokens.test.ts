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
import { invalidateTenantCache } from '../lib/tenant-resolve';
import { mintAdminToken, mintOwnerToken, mintToken } from '../lib/token';
import { MAX_LIVE_TOKENS_PER_USER } from '../routes/tenant-tokens';
import {
  ADMIN_EMAIL_A,
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

/**
 * `createTenantAccessToken` at the real cap, unwrapped. It returns `null` when the sitter is
 * already at `maxLive` (the cap lives in the INSERT), and every caller here is minting the first
 * few tokens of an empty account — so a `null` means the statement stopped writing for a reason
 * this fixture did not intend, and asserting that here is better than an `!` at each call site.
 */
async function createRow(
  env: Env,
  tenantId: string,
  tenantUserId: string,
  name: string,
  tokenHash: string,
): Promise<{ Id: string; Name: string; CreatedAt: string }> {
  const created = await createTenantAccessToken(env.PAWSERVATION_DB, tenantId, {
    tenantUserId,
    name,
    tokenHash,
    maxLive: MAX_LIVE_TOKENS_PER_USER,
  });
  expect(created).not.toBeNull();
  return created!;
}

describe('tenant access tokens — at rest', () => {
  it('stores only the hash: no pawsa_ token appears anywhere in its row', async () => {
    const { env, raw } = createTestEnv();
    const token = generateTenantAccessToken();
    const tokenHash = await hashPersonalAccessToken(token);
    const created = await createRow(env, TENANT_A, 'tu_sunny', 'CI bot', tokenHash);
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
    const created = await createRow(env, TENANT_A, 'tu_sunny', 'Home laptop', tokenHash);

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
    const created = await createRow(env, TENANT_A, 'tu_sunny', 'Revoke me', tokenHash);

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
  const created = await createRow(
    env,
    opts?.tenantId ?? TENANT_A,
    opts?.tenantUserId ?? 'tu_sunny',
    opts?.name ?? 'CI bot',
    await hashPersonalAccessToken(token),
  );
  return { token, id: created.Id };
}

/**
 * A SECOND sitter login under Sunny Paws — `TENANT_A`'s own colleague, not another tenant's admin.
 *
 * `sql/seed.sql` gives every tenant exactly one `TenantUsers` row, so every isolation assertion in
 * this file was otherwise a CROSS-TENANT one, and a cross-tenant assertion passes against a query
 * scoped by `TenantId` alone — the per-user half is the half it cannot see. Seeded here rather than
 * in the shared seed because it exists for these tests: a second login under one sitter is not part
 * of the demo the seed describes.
 *
 * The hash is deliberately not a real one. Nothing here signs in with a password — the JWTs are
 * minted directly — so the column only has to be non-null.
 */
const ADMIN_TWO = { id: 'tu_sunny_second', email: 'second@sunnypaws.example' };

function seedSecondSunnyAdmin(raw: ReturnType<typeof createTestEnv>['raw']): void {
  raw
    .prepare('INSERT INTO TenantUsers (Id, TenantId, Email, PasswordHash) VALUES (?, ?, ?, ?)')
    .run(ADMIN_TWO.id, TENANT_A, ADMIN_TWO.email, 'pbkdf2$100000$00$00');
}

const settings = (env: Env, credential: string, slug = 'sunny-paws') =>
  app.request(
    `/api/${slug}/admin/settings`,
    { headers: { Authorization: `Bearer ${credential}` } },
    env,
  );

describe('tenant access tokens — authenticating', () => {
  it('is accepted wherever the admin session is, and resolves to the same sitter', async () => {
    const { env, raw } = createTestEnv();
    // A colleague under the SAME sitter, so "resolves to the right TenantUsers row" has a wrong
    // answer available inside this tenant. Without it the assertion below is satisfied by any
    // lookup that gets the tenant right and the user wrong.
    seedSecondSunnyAdmin(raw);
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
    // The MINTING user, and specifically not the other login under this same sitter.
    expect(body.adminEmail).not.toBe(ADMIN_TWO.email);
  });

  it('refuses a token once the owner has disabled the sitter, reads included', async () => {
    const { env, raw } = createTestEnv();
    const { token } = await mintTenantToken(env);
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    expect((await settings(env, token)).status).toBe(200);

    raw.prepare(`UPDATE Tenants SET DisabledAt = datetime('now') WHERE Id = ?`).run(TENANT_A);
    // The owner console's PATCH does this for itself; the direct UPDATE above does not, and the
    // request just made warmed a 60-second entry holding `DisabledAt: null`.
    await invalidateTenantCache('sunny-paws', env);

    // `tenantMiddleware` leaves GETs alone for a disabled sitter so she can still read her own
    // book while the owner sorts it out — that reasoning is about a session someone is sitting in
    // front of. A token keeps working with nobody watching, so disabling the account has to stop
    // it, and the same 401 body as every other miss says so without confirming the string was a
    // real token.
    const refused = await settings(env, token);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'Please sign in.' });
    // The password session still reads, which is what makes this a statement about the CREDENTIAL
    // rather than about the account having gone away entirely.
    expect((await settings(env, jwt)).status).toBe(200);
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

/** POST /admin/tokens without asserting on the outcome — for the paths that are NOT a 201. */
const postToken = (env: Env, credential: string, name: unknown, slug = 'sunny-paws') =>
  app.request(
    adminTokensPath(slug),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    env,
  );

const listTokens = (env: Env, credential: string, slug = 'sunny-paws') =>
  app.request(adminTokensPath(slug), { headers: { Authorization: `Bearer ${credential}` } }, env);

const deleteToken = (env: Env, credential: string, id: string, slug = 'sunny-paws') =>
  app.request(
    `${adminTokensPath(slug)}/${id}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${credential}` } },
    env,
  );

/**
 * DELETE …/admin/tokens/self — the alias route. Spelled out rather than routed through
 * `deleteToken(env, cred, 'self')` so the tests below read as being about the WORD `self` and not
 * about an id that happens to be four characters long.
 */
const deleteSelf = (env: Env, credential: string, slug = 'sunny-paws') =>
  app.request(
    `${adminTokensPath(slug)}/self`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${credential}` } },
    env,
  );

/** The stored revocation stamp, or `undefined` when no such row exists. */
function revokedAt(raw: ReturnType<typeof createTestEnv>['raw'], id: string): string | null {
  const row = raw.prepare('SELECT RevokedAt FROM TenantAccessTokens WHERE Id = ?').get(id) as
    { RevokedAt: string | null } | undefined;
  expect(row).toBeDefined();
  return row!.RevokedAt;
}

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
        'Name your token (letters, numbers, spaces and punctuation, 1–80 characters).',
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

  it('lists only this admin’s own tokens — a colleague under the SAME sitter sees none of them', async () => {
    const { env, raw } = createTestEnv();
    seedSecondSunnyAdmin(raw);
    const sunny = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    await mintViaRoute(env, sunny, 'Sunny’s');

    // Same tenant, different TenantUsers row. A cross-tenant version of this assertion passes
    // against a query scoped by TenantId alone, which is the half that is not the point: the list
    // is per-ADMIN, and two logins under one sitter are where that can actually go wrong.
    const colleague = await mintAdminToken(ADMIN_TWO.id, TENANT_A, TEST_SECRET);
    const res = await listTokens(env, colleague);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tokens: unknown[] }).tokens).toEqual([]);

    // And another tenant's admin sees nothing either, which is the outer boundary.
    const dana = await mintAdminToken('tu_dana', TENANT_B, TEST_SECRET);
    const other = await listTokens(env, dana, 'happy-tails');
    expect(((await other.json()) as { tokens: unknown[] }).tokens).toEqual([]);
  });

  it('caps a sitter at 25 live tokens, and revoking one makes room again', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    for (let i = 0; i < MAX_LIVE_TOKENS_PER_USER; i++) await mintViaRoute(env, jwt, `Bot ${i}`);

    const over = await postToken(env, jwt, 'One too many');
    expect(over.status).toBe(409);
    expect(((await over.json()) as { error: string }).error).toBe(
      'Revoke one first: you already have 25 access tokens.',
    );

    // The cap counts LIVE tokens, not rows ever minted: a revoked one must not hold a slot
    // forever, or a sitter who has cycled 25 credentials could never mint another.
    const { tokens } = (await (await listTokens(env, jwt)).json()) as { tokens: { id: string }[] };
    expect((await deleteToken(env, jwt, tokens[0].id)).status).toBe(200);
    await mintViaRoute(env, jwt, 'Room again');
  });

  it('holds the cap when two mints race for the last slot', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    for (let i = 0; i < MAX_LIVE_TOKENS_PER_USER - 1; i++) await mintViaRoute(env, jwt, `Bot ${i}`);

    // Both requests read "24 live, there is room" before either writes, which is the whole of the
    // race. The cap is inside the INSERT for exactly this: a count in the route followed by an
    // insert leaves a window as wide as the round trip between them, and both mints land.
    const [a, b] = await Promise.all([
      postToken(env, jwt, 'Racer A'),
      postToken(env, jwt, 'Racer B'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    const { n } = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM TenantAccessTokens
          WHERE TenantId = ? AND TenantUserId = ? AND RevokedAt IS NULL`,
      )
      .get(TENANT_A, 'tu_sunny') as { n: number };
    expect(n).toBe(MAX_LIVE_TOKENS_PER_USER);
  });

  it('refuses control and bidi characters in a name, but not the ones emoji are spelled with', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const post = (name: unknown) =>
      app.request(
        adminTokensPath(),
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
        env,
      );

    // A newline, a NUL, a bidi override (U+202E, which can print the rest of the list backwards)
    // and a private-use character that renders as whatever the reader's font decides. Written as
    // escapes, not as literal bytes: a NUL pasted into this file makes the file itself binary to
    // grep, which is a real cost for a test asserting on one character.
    for (const name of ['CI\nbot', 'CI\u0000bot', 'CI \u202Ebot', 'CI\uE000bot']) {
      const res = await post(name);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        'Name your token (letters, numbers, spaces and punctuation, 1–80 characters).',
      );
    }

    // U+200D (zero-width joiner) and U+FE0F (variation selector-16) are how ordinary emoji are
    // SPELLED — "👩‍💻" is two emoji joined by a ZWJ, and "❤️" is a heart plus a selector. Both are
    // format characters, so a blanket \p{C} rule refuses them and tells the sitter her name is the
    // wrong LENGTH, which is neither true nor fixable. Accented letters and punctuation are
    // ordinary names too: the rule is about characters that display as something other than
    // themselves, not about non-ASCII.
    expect((await mintViaRoute(env, jwt, 'CI bot \u{1F469}\u200D\u{1F4BB}')).name).toBe(
      'CI bot \u{1F469}\u200D\u{1F4BB}',
    );
    expect((await mintViaRoute(env, jwt, 'Home \u2764\uFE0F laptop')).name).toBe(
      'Home \u2764\uFE0F laptop',
    );
    expect((await mintViaRoute(env, jwt, 'Café résumé — laptop')).name).toBe(
      'Café résumé — laptop',
    );
  });

  it('tells caches not to keep the one response that carries a live secret', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const res = await app.request(
      adminTokensPath(),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Cacheable?' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    // The list carries no secret and is deliberately NOT given the header, so this is a statement
    // about the mint response specifically rather than about the route file.
    expect((await listTokens(env, jwt)).headers.get('Cache-Control')).toBeNull();
  });
});

describe('tenant access tokens — carve-out', () => {
  it('refuses a tenant access token on POST and GET, and on a DELETE of a SIBLING token', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Password-minted');
    const sibling = await mintViaRoute(env, jwt, 'Another of hers');
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

    // A SIBLING's id: same sitter, same tenant, but not the presented credential's own row. One
    // token turning another off is amplification, not the de-amplifying self-revoke below, and it
    // is refused with the same message the mint and list refusals use.
    const del = await deleteToken(env, token, sibling.id);
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: string }).error).toMatch(/password/i);
    // And it really did nothing: the sibling still authenticates.
    expect((await settings(env, sibling.token)).status).toBe(200);
  });

  it('defaults every path under /tokens/ to password-only, not just the ones that exist', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Prober');

    // No route is mounted at either of these. That is the point: the gate is on the SUBTREE, so
    // whatever is added under /tokens/ next is refused for a token by DEFAULT and has to be
    // deliberately relaxed. A gate mounted per-route would answer 404 here today and whatever the
    // next route does tomorrow.
    for (const path of [
      `/api/sunny-paws/admin/tokens/${created.id}/rename`,
      '/api/sunny-paws/admin/tokens/anything/at/all',
    ]) {
      const res = await app.request(
        path,
        { method: 'POST', headers: { Authorization: `Bearer ${created.token}` } },
        env,
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/password/i);
    }

    // Its OWN id plus one more segment is not its own row either — the exception is exactly one
    // segment wide, so it cannot be widened by appending to the path.
    const passwordReaches404 = await app.request(
      `/api/sunny-paws/admin/tokens/${created.id}/rename`,
      { method: 'POST', headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    // The password session passes the gate and finds nothing there, which is what proves the 403
    // above came from the gate rather than from the route simply not existing.
    expect(passwordReaches404.status).toBe(404);
  });

  it('lets a token revoke ITSELF, and stops working immediately afterwards', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Disconnect me');
    expect((await settings(env, created.token)).status).toBe(200);

    // The one hole in the carve-out, and it only ever points inward: a client that is
    // disconnecting hands its own credential back rather than leaving a live row behind for the
    // sitter to notice later.
    const del = await deleteToken(env, created.token, created.id);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ revoked: true });

    // The very next request, with no clock advanced and nothing expiring.
    expect((await settings(env, created.token)).status).toBe(401);
    // And the sitter's own list agrees it is gone.
    const { tokens } = (await (await listTokens(env, jwt)).json()) as { tokens: unknown[] };
    expect(tokens).toEqual([]);
  });

  /**
   * The reason `…/tokens/self` exists at all: the self-revoke above needs an id, and the only
   * route that reports one is `adminSessionOnly`. A client holding nothing but the secret could
   * never name its own row, so the one hole in the carve-out was unreachable by exactly the caller
   * it was cut for.
   */
  it('lets a token revoke itself by name, without ever learning its own id', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Knows only its secret');
    expect((await settings(env, created.token)).status).toBe(200);
    // The id the route resolves for itself is the one the mint handed the sitter — asserted here
    // so the alias is pinned to THAT row and not merely to "some row of hers".
    expect(revokedAt(raw, created.id)).toBeNull();

    const del = await deleteSelf(env, created.token);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ revoked: true });
    expect(revokedAt(raw, created.id)).toEqual(expect.any(String));

    // Gone from the sitter's list, and dead on the very next request — no clock advanced.
    const { tokens } = (await (await listTokens(env, jwt)).json()) as { tokens: unknown[] };
    expect(tokens).toEqual([]);
    expect((await settings(env, created.token)).status).toBe(401);
  });

  it('is idempotent the only way it can be: the second call is a 401, because the caller is dead', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Twice');
    expect((await deleteSelf(env, created.token)).status).toBe(200);
    const first = revokedAt(raw, created.id);

    // `adminAuth` answers before the route runs, so a client that retries gets a refusal rather
    // than a second success — and the first revocation's timestamp is not rewritten by the retry.
    const second = await deleteSelf(env, created.token);
    expect(second.status).toBe(401);
    expect(revokedAt(raw, created.id)).toBe(first);
  });

  it('turns a PASSWORD session away with a 400: a session has no token to hand back', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Still live');

    // Not a 403: nothing was refused. The password session is allowed here and simply does not
    // name a thing that exists for it — its route is the list, which it can already read.
    const res = await deleteSelf(env, jwt);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/list/i);
    // And it revoked nothing on the way past.
    expect((await settings(env, created.token)).status).toBe(200);
  });

  it('does not exist for another tenant’s token: 401 under the wrong slug, live under its own', async () => {
    const { env } = createTestEnv();
    const dana = await mintAdminToken('tu_dana', TENANT_B, TEST_SECRET);
    const danaToken = await mintViaRoute(env, dana, 'Dana’s bot', 'happy-tails');

    // `findLiveTenantAccessToken` binds TenantId, so under Sunny Paws this token does not exist
    // rather than existing elsewhere — 401, the same answer an unknown string gets, and not a 403
    // that would confirm it is real somewhere.
    expect((await deleteSelf(env, danaToken.token)).status).toBe(401);
    // Nothing was revoked: it still works where it belongs.
    expect((await settings(env, danaToken.token, 'happy-tails')).status).toBe(200);
    expect((await deleteSelf(env, danaToken.token, 'happy-tails')).status).toBe(200);
  });

  it('never writes the presented secret into a log line, on the way through or on the refusal', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Quiet');
    const lines: unknown[][] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...args) => void lines.push(args));
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => void lines.push(args));
    try {
      expect((await deleteSelf(env, created.token)).status).toBe(200);
      // The refusal path too: this one DOES log (`tenant_access_token_rejected`), which is the
      // line worth checking — a route whose whole subject is a credential is the easiest place in
      // the product to spill one.
      expect((await deleteSelf(env, created.token)).status).toBe(401);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    const written = JSON.stringify(lines);
    expect(written).not.toContain(created.token);
    // Not even a prefix of it: eight "safe" characters of a token are eight characters of a token.
    expect(written).not.toContain(created.token.slice(0, 12));
    expect(written).not.toContain('pawsa_');
    // The line that was written is the ordinary one, naming the sitter and the route and nothing
    // else — so the assertions above passed because there is a line to inspect, not because the
    // route stayed silent.
    expect(written).toContain('tenant_access_token_rejected');
    expect(written).toContain('/api/sunny-paws/admin/tokens/self');
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

  it('404s an unknown id, a colleague’s id and another tenant’s id; a second delete stays scoped', async () => {
    const { env, raw } = createTestEnv();
    seedSecondSunnyAdmin(raw);
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Delete twice');

    // The OTHER login under this same sitter, holding a real id of a real live token that is not
    // hers: 404, indistinguishable from an id that never existed, and the token stays live. This
    // is the assertion the cross-tenant one below cannot make — a revoke scoped by TenantId alone
    // would pass that and fail this.
    const colleague = await mintAdminToken(ADMIN_TWO.id, TENANT_A, TEST_SECRET);
    expect((await deleteToken(env, colleague, created.id)).status).toBe(404);
    expect((await settings(env, created.token)).status).toBe(200);

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

  it('stamps nothing when the credential was not ALLOWED to do the thing', async () => {
    const { env, raw } = createTestEnv();
    const { token, id } = await mintTenantToken(env);

    // The carve-out's 403: authentication succeeded, the authorization did not. `LastUsedAt` is
    // what the sitter reads to decide a token is idle and safe to revoke, so it has to mean "this
    // credential did something", not "someone waved it at a route it has no business on" —
    // otherwise a token being probed looks busier than one doing real work.
    const refused = await listTokens(env, token);
    expect(refused.status).toBe(403);
    expect(lastUsed(raw, id)).toBeNull();

    // The same token on a route it may use does stamp, so this is about AUTHORIZATION and not
    // about the touch having been dropped altogether.
    expect((await settings(env, token)).status).toBe(200);
    expect(lastUsed(raw, id)).not.toBeNull();
  });

  /**
   * Two routes `adminAuth` has to keep stamping for, mounted here because the real app has no
   * admin GET that 404s and none that throws on purpose. Both are ordinary USES of the credential:
   * the gate said yes and the handler ran.
   */
  function outcomeProbeApp(): Hono<AppEnv> {
    const probe = new Hono<AppEnv>()
      .use('/:slug/admin/*', adminAuth)
      .get('/:slug/admin/gone', (c) => c.json({ error: 'Not found.' }, 404))
      .get('/:slug/admin/boom', () => {
        throw new Error('handler exploded');
      });
    const outer = new Hono<AppEnv>();
    outer.use('/api/:slug/*', tenantMiddleware);
    outer.route('/api', probe);
    return outer;
  }

  it('stamps a use whose handler answered 404 or threw', async () => {
    const { env, raw } = createTestEnv();

    // A 404 is the credential working exactly as intended — a client asking after a customer who
    // has been deleted. Gating the stamp on `status < 400` called that idle.
    const gone = await mintTenantToken(env, { name: 'Asks for missing things' });
    const notFound = await outcomeProbeApp().request(
      '/api/sunny-paws/admin/gone',
      { headers: { Authorization: `Bearer ${gone.token}` } },
      env,
    );
    expect(notFound.status).toBe(404);
    expect(lastUsed(raw, gone.id)).not.toBeNull();

    // And a handler that throws is a token that was in use the whole time and hitting a bug. The
    // touch is in a `finally` so the report does not read "idle all week" about it.
    const boom = await mintTenantToken(env, { name: 'Finds bugs' });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = await outcomeProbeApp().request(
      '/api/sunny-paws/admin/boom',
      { headers: { Authorization: `Bearer ${boom.token}` } },
      env,
    );
    warn.mockRestore();
    expect(thrown.status).toBe(500);
    expect(lastUsed(raw, boom.id)).not.toBeNull();
  });

  it('stamps nothing on the request in which a token revoked itself', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const created = await mintViaRoute(env, jwt, 'Self-revoker');

    // A 200, so the status check above lets the touch through — and the touch still must not
    // land, because the row it names was revoked by the very request that authenticated it.
    // A revoked credential appearing to have been USED after it was cut off is the one thing this
    // column must never say.
    expect((await deleteToken(env, created.token, created.id)).status).toBe(200);
    expect(lastUsed(raw, created.id)).toBeNull();
  });

  it('authenticates ONCE on a route where two apps both mount adminAuth', async () => {
    const { env } = createTestEnv();
    const { token } = await mintTenantToken(env);
    const statements = recordStatements(env);

    // Hono flattens `.use()` across every app mounted at /api, so /admin/tokens matches both
    // admin.ts's `.use('/:slug/admin/*', adminAuth)` and tenant-tokens.ts's own — the middleware
    // runs twice for one request. Asserting on the statements ISSUED is the only way to see that:
    // both runs reach the same answer, so nothing about the RESPONSE would ever look wrong.
    const res = await listTokens(env, token);
    expect(res.status).toBe(403);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((s) => s.includes('TokenHash'))).toHaveLength(1);
  });
});

describe('tenant access tokens — password reset', () => {
  const resetLink = async (env: Env): Promise<string> => {
    const res = await app.request(
      '/api/password-reset/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL_A }),
      },
      env,
    );
    const { prototypeLink } = (await res.json()) as { prototypeLink?: string };
    expect(prototypeLink).toBeTruthy();
    return new URL(prototypeLink!).searchParams.get('t')!;
  };

  it('revokes every one of the sitter’s tokens when she resets her password', async () => {
    const { env, raw } = createTestEnv();
    seedSecondSunnyAdmin(raw);
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const first = await mintViaRoute(env, jwt, 'Laptop');
    const second = await mintViaRoute(env, jwt, 'CI');
    // The colleague's token, minted under the same sitter by a DIFFERENT login. A reset is one
    // person's, so it must not reach into anyone else's credentials.
    const colleague = await mintTenantToken(env, { tenantUserId: ADMIN_TWO.id, name: 'Theirs' });
    expect((await settings(env, first.token)).status).toBe(200);

    const complete = await app.request(
      '/api/password-reset/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: await resetLink(env), password: 'RiverStone2026' }),
      },
      env,
    );
    expect(complete.status).toBe(200);

    // A reset is what someone does when they believe their access is compromised. The password
    // JWTs expire in eight hours on their own; these never expire, so a reset that left them live
    // would settle nothing — whoever took the account keeps the whole book, and the sitter has no
    // reason to suspect it.
    expect((await settings(env, first.token)).status).toBe(401);
    expect((await settings(env, second.token)).status).toBe(401);
    expect((await settings(env, colleague.token)).status).toBe(200);
  });

  it('still completes the reset when the revoke fails, and says so in the log', async () => {
    const { env } = createTestEnv();
    const jwt = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    await mintViaRoute(env, jwt, 'Survivor');
    const link = await resetLink(env);

    // The password is ALREADY changed and the link's nonce already spent by the time the revoke
    // runs, so a D1 hiccup there must not answer 500: that tells someone mid-recovery the reset
    // failed when it did not, and their only move — ask for another link — cannot work either,
    // because the old password they would need is gone.
    const real = env.PAWSERVATION_DB;
    (env as { PAWSERVATION_DB: D1Database }).PAWSERVATION_DB = {
      ...real,
      prepare: (sql: string) => {
        if (sql.includes('SET RevokedAt')) throw new Error('D1_ERROR: simulated');
        return real.prepare(sql);
      },
    } as unknown as D1Database;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const complete = await app.request(
      '/api/password-reset/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: link, password: 'RiverStone2026' }),
      },
      env,
    );
    expect(complete.status).toBe(200);
    expect((await complete.json()) as { role: string }).toMatchObject({ role: 'admin' });

    // Not silent, though: the tokens are still live and only the log says so. The line names the
    // failure and nothing about the person — no email, no token, no id.
    const logged = errors.mock.calls.map((call) => String(call[0]));
    expect(logged).toContain('tenant access token revoke on password reset failed');
    errors.mockRestore();
  });
});
