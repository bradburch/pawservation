import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { insertInvitedCustomer } from '../db/repo';
import { LAST_USED_RESOLUTION_MS } from '../lib/personal-access-token';
import { mintToken } from '../lib/token';
import { createTestEnv, endUserToken, TENANT_A, TEST_SECRET } from './helpers';

/**
 * Personal access tokens: the long-lived credential that makes the public booking API usable by
 * something other than the widget. Every endpoint `lib/llms.ts` advertises needs auth, and the
 * widget JWT dies after 24h — so without these, that document describes an API nobody can call.
 */

const JESS = 'jess@example.com';

/** POST /tokens with a widget JWT, returning the parsed creation response. */
async function createToken(
  env: Env,
  jwt: string,
  name = 'Test client',
): Promise<{ id: string; token: string; name: string }> {
  const res = await app.request(
    '/api/sunny-paws/tokens',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    },
    env,
  );
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string; name: string };
}

/** A widget JWT for a SECOND customer of the same tenant (the base seed has only Jess). */
async function otherCustomerToken(env: Env): Promise<string> {
  const other = await insertInvitedCustomer(
    env.PAWSERVATION_DB,
    TENANT_A,
    'marco@example.com',
    null,
  );
  return await mintToken(other.Id, TENANT_A, TEST_SECRET);
}

describe('personal access tokens — issuing', () => {
  it('creates a token and returns the secret exactly once', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt, 'My assistant');
    expect(created.name).toBe('My assistant');
    expect(created.id).toBeTruthy();
    expect(created.token).toBeTruthy();

    // The one and only disclosure. Nothing else ever hands it back.
    const list = await app.request(
      '/api/sunny-paws/tokens',
      { headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    expect(JSON.stringify(await list.json())).not.toContain(created.token);
  });

  it('lists a token by id, name, createdAt and lastUsedAt — never the secret or its hash', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt, 'Listed');

    const res = await app.request(
      '/api/sunny-paws/tokens',
      { headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    expect(res.status).toBe(200);
    const { tokens } = (await res.json()) as {
      tokens: { id: string; name: string; createdAt: string; lastUsedAt: string | null }[];
    };
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      id: created.id,
      name: 'Listed',
      createdAt: expect.any(String),
      lastUsedAt: null,
    });

    // Not merely "the listed fields are these" — the stored hash must not travel either, under
    // any key. A hash is not the secret, but it is the only thing standing between a leaked
    // database row and an offline guess, so it stays server-side.
    const stored = raw
      .prepare(`SELECT TokenHash FROM PersonalAccessTokens WHERE TenantId = ?`)
      .get(TENANT_A) as { TokenHash: string };
    expect(JSON.stringify(tokens)).not.toContain(stored.TokenHash);
  });

  it('stores only a hash — the plaintext appears nowhere in the database', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt);

    // Sweep EVERY column of EVERY table rather than asserting about the one we wrote: the point
    // is that the secret is not recoverable from the database at all, not that one column is clean.
    const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[];
    let scanned = 0;
    for (const { name } of tables) {
      const rows = raw.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
      for (const row of rows) {
        for (const value of Object.values(row)) {
          scanned++;
          if (typeof value === 'string') expect(value).not.toContain(created.token);
        }
      }
    }
    expect(scanned).toBeGreaterThan(0); // the sweep actually looked at something
  });

  it('draws the secret from the CSPRNG, never Math.random', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const randomSpy = vi.spyOn(Math, 'random');
    const csprngSpy = vi.spyOn(crypto, 'getRandomValues');
    try {
      const created = await createToken(env, jwt);
      expect(csprngSpy).toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
      // ≥128 bits of entropy, and enough characters that the encoding cannot be hiding less.
      expect(created.token.length).toBeGreaterThanOrEqual(32);
    } finally {
      randomSpy.mockRestore();
      csprngSpy.mockRestore();
    }
  });

  it('mints a distinct secret every time', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const secrets = new Set<string>();
    for (let i = 0; i < 25; i++) secrets.add((await createToken(env, jwt, `t${i}`)).token);
    expect(secrets.size).toBe(25);
  });

  it('requires a signed-in end user', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/tokens',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nobody' }),
      },
      env,
    );
    expect(res.status).toBe(401);
    expect((await app.request('/api/sunny-paws/tokens', {}, env)).status).toBe(401);
  });

  it('requires a name the owner will recognise later', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    for (const name of ['', '   ', 'x'.repeat(81), 42, undefined]) {
      const res = await app.request(
        '/api/sunny-paws/tokens',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        },
        env,
      );
      expect(res.status).toBe(400);
    }
  });

  it('lists only this end user’s own tokens', async () => {
    const { env } = createTestEnv();
    const jess = await endUserToken(env, 'sunny-paws', JESS);
    await createToken(env, jess, 'Jess only');
    // A second customer of the SAME tenant sees an empty list, not Jess's.
    const marco = await otherCustomerToken(env);
    const res = await app.request(
      '/api/sunny-paws/tokens',
      { headers: { Authorization: `Bearer ${marco}` } },
      env,
    );
    expect(((await res.json()) as { tokens: unknown[] }).tokens).toEqual([]);
  });
});

describe('personal access tokens — authenticating', () => {
  it('is accepted wherever a widget session is, and resolves to the same end user', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const { token } = await createToken(env, jwt);

    // /me is the identity endpoint: if the two credentials disagree about who is calling, this is
    // where it shows. Compared whole, so a token that resolved to a different person's pets fails.
    const viaJwt = await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    const viaPat = await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(viaPat.status).toBe(200);
    expect(await viaPat.json()).toEqual(await viaJwt.json());

    // …and on a route that is not merely a read of the caller's own record.
    const mine = await app.request(
      '/api/sunny-paws/bookings/mine',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(mine.status).toBe(200);
  });

  it('refuses a revoked token immediately — not at some expiry', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt);
    const use = () =>
      app.request(
        '/api/sunny-paws/me',
        { headers: { Authorization: `Bearer ${created.token}` } },
        env,
      );

    expect((await use()).status).toBe(200);
    await app.request(
      `/api/sunny-paws/tokens/${created.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    // The very next request, with no clock advanced and nothing expiring.
    expect((await use()).status).toBe(401);
  });

  it('refuses an unknown token, and one that is a near-miss for a live one', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const { token } = await createToken(env, jwt);

    const attempt = async (candidate: string) =>
      (
        await app.request(
          '/api/sunny-paws/me',
          { headers: { Authorization: `Bearer ${candidate}` } },
          env,
        )
      ).status;

    expect(await attempt('pawsv_totally-made-up')).toBe(401);
    expect(await attempt('')).toBe(401);
    // A digest is what gets matched, never the plaintext — so a token differing from a live one
    // in a single character at either end shares nothing with it and is refused outright. There
    // is no prefix any attacker can walk towards a match.
    expect(await attempt(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(401);
    // token[6] is the first char after PAT_PREFIX; the substitute must actually differ from it,
    // not just avoid the literal 'x' — the same hazard as the line above, which conditionally
    // avoids re-matching token's own last character. base64url has 64 symbols, so a literal 'x'
    // here recreates the live token (and passes) on roughly 1 run in 64.
    expect(await attempt('pawsv_' + (token[6] === 'x' ? 'y' : 'x') + token.slice(7))).toBe(401);
  });

  it('cannot be used to manage tokens — a leaked token cannot mint its replacement', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const first = await createToken(env, jwt, 'First');
    const asToken = { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' };

    const minted = await app.request(
      '/api/sunny-paws/tokens',
      { method: 'POST', headers: asToken, body: JSON.stringify({ name: 'Replacement' }) },
      env,
    );
    expect(minted.status).toBe(403);
    // Nor may it read or revoke the list it belongs to: revocation is the owner's, from the
    // session only they can start.
    expect((await app.request('/api/sunny-paws/tokens', { headers: asToken }, env)).status).toBe(
      403,
    );
    expect(
      (
        await app.request(
          `/api/sunny-paws/tokens/${first.id}`,
          { method: 'DELETE', headers: asToken },
          env,
        )
      ).status,
    ).toBe(403);

    // Still exactly one token, and still the original.
    const list = await app.request(
      '/api/sunny-paws/tokens',
      { headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    const { tokens } = (await list.json()) as { tokens: { name: string }[] };
    expect(tokens.map((t) => t.name)).toEqual(['First']);
  });

  it('does not authenticate against another sitter, for the same email address', async () => {
    const { env } = createTestEnv();
    // The seeded case: jess@example.com is a customer of BOTH tenants and two unrelated people.
    const jwtA = await endUserToken(env, 'sunny-paws', JESS);
    const { token } = await createToken(env, jwtA);

    const res = await app.request(
      '/api/happy-tails/me',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(401);
    // …and no booking can be made under the other sitter with it either.
    const write = await app.request(
      '/api/happy-tails/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-08-01',
          endDate: '2028-08-03',
          petIds: ['pet_ht_otis'],
        }),
      },
      env,
    );
    expect(write.status).toBe(401);
  });
});

describe('personal access tokens — last used', () => {
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
      raw.prepare(`SELECT LastUsedAt FROM PersonalAccessTokens WHERE Id = ?`).get(id) as {
        LastUsedAt: string | null;
      }
    ).LastUsedAt;

  it('stamps the first use, so an unused token is visibly unused', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt);
    expect(lastUsed(raw, created.id)).toBeNull();

    await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: `Bearer ${created.token}` } },
      env,
    );
    expect(lastUsed(raw, created.id)).not.toBeNull();
  });

  it('writes nothing on a second use inside the resolution window', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt);
    const use = () =>
      app.request(
        '/api/sunny-paws/me',
        { headers: { Authorization: `Bearer ${created.token}` } },
        env,
      );

    await use(); // first use stamps
    const stamped = lastUsed(raw, created.id);

    // The credential built for automated clients must not turn every read into a write. Asserting
    // on the statements ISSUED, not just on the stored value: an UPDATE that happens to be a
    // no-op is still a database round-trip on the request path.
    const statements = recordStatements(env);
    await use();
    await use();
    expect(statements.filter((s) => s.includes('UPDATE PersonalAccessTokens'))).toEqual([]);
    expect(lastUsed(raw, created.id)).toBe(stamped);
  });

  it('refreshes once the stamp is older than the resolution window', async () => {
    const { env, raw } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt);
    // Aged past the window rather than mocking the clock — the stamp is a stored string, and this
    // is exactly the state a token in daily use is in when its owner comes back to look at it.
    const stale = new Date(Date.now() - (LAST_USED_RESOLUTION_MS + 60_000))
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    raw
      .prepare(`UPDATE PersonalAccessTokens SET LastUsedAt = ? WHERE Id = ?`)
      .run(stale, created.id);

    await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: `Bearer ${created.token}` } },
      env,
    );
    expect(lastUsed(raw, created.id)).not.toBe(stale);
  });

  it('reports the stamp to the owner in their own list', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt);
    await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: `Bearer ${created.token}` } },
      env,
    );
    const res = await app.request(
      '/api/sunny-paws/tokens',
      { headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    const { tokens } = (await res.json()) as { tokens: { lastUsedAt: string | null }[] };
    expect(tokens[0].lastUsedAt).toEqual(expect.any(String));
  });
});

describe('personal access tokens — revoking', () => {
  it('revokes a token and drops it from the list', async () => {
    const { env } = createTestEnv();
    const jwt = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jwt);

    const res = await app.request(
      `/api/sunny-paws/tokens/${created.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    expect(res.status).toBe(200);
    const list = await app.request(
      '/api/sunny-paws/tokens',
      { headers: { Authorization: `Bearer ${jwt}` } },
      env,
    );
    expect(((await list.json()) as { tokens: unknown[] }).tokens).toEqual([]);
  });

  it('404s an unknown token id, and another customer’s token id', async () => {
    const { env } = createTestEnv();
    const jess = await endUserToken(env, 'sunny-paws', JESS);
    const created = await createToken(env, jess);
    const marco = await otherCustomerToken(env);

    const stranger = await app.request(
      `/api/sunny-paws/tokens/${created.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${marco}` } },
      env,
    );
    expect(stranger.status).toBe(404);
    const missing = await app.request(
      '/api/sunny-paws/tokens/nope',
      { method: 'DELETE', headers: { Authorization: `Bearer ${jess}` } },
      env,
    );
    expect(missing.status).toBe(404);
  });
});
