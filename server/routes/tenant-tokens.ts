/**
 * Tenant access tokens: the sitter's own credential management (0016) — the mirror of
 * `routes/tokens.ts` for the admin side, not a variant of it. See that file's docblock for the
 * general shape; this one only calls out what differs.
 *
 * Minting and listing are gated by `adminSessionOnly`: a tenant access token can do everything the
 * password session can EXCEPT mint or list tokens (the carve-out — see `lib/middleware.ts`'s
 * `adminSessionOnly`). A credential that could issue its own replacement would make the revoke
 * list advisory.
 *
 * REVOKE is the one exception, and it is an exception in the safe direction: a token may revoke
 * ITSELF, and nothing else (`adminSessionOrOwnToken`). Self-revocation is de-amplifying — it can
 * only ever reduce what the holder can do — and the holder can already achieve most of it by
 * throwing the secret away, except that throwing it away leaves the row live on the server and the
 * name sitting in the sitter's list. A client disconnecting should be able to hand the credential
 * back rather than leave it lying about waiting to be noticed. A SIBLING token is still a 403:
 * revoking someone else's credential is not de-amplifying, and one token turning off another is
 * exactly the amplification the carve-out exists to prevent.
 */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import * as v from 'valibot';
import {
  countLiveTenantAccessTokens,
  createTenantAccessToken,
  listTenantAccessTokens,
  revokeTenantAccessToken,
} from '../db/repo';
import { adminAuth, adminSessionOnly } from '../lib/middleware';
import { generateTenantAccessToken, hashPersonalAccessToken } from '../lib/personal-access-token';
import { MAX_TOKEN_NAME_LENGTH } from './tokens';
import type { AppEnv } from '../types';

/**
 * Same shape and same cap as the pet owner's token name — IMPORTED from `routes/tokens.ts` rather
 * than redeclared, so the two cannot drift apart while both error messages go on claiming the same
 * number.
 *
 * The regex rejects Unicode control and format characters: `\p{C}` covers the C0/C1 controls, the
 * bidirectional overrides, and the zero-width formatting characters. The name is the ONLY thing
 * distinguishing one live credential from another in the revoke list, so a name that can reorder
 * or hide what is printed around it makes that list say something other than what is stored, and
 * a list nobody can trust is a list nobody can safely revoke from.
 */
const CreateBody = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(MAX_TOKEN_NAME_LENGTH),
    v.regex(/^[^\p{C}]+$/u),
  ),
});

/**
 * How many live tokens one sitter may hold at once. Not a security boundary — 25 credentials are
 * no worse than 24 — but the revoke list is only useful while it is short enough to read, and a
 * script looping on the mint route should stop at a number rather than at the table's size.
 */
export const MAX_LIVE_TOKENS_PER_USER = 25;

/**
 * Password session, OR a token revoking its OWN row. Runs after `adminAuth` and reads what it
 * recorded, exactly as `adminSessionOnly` does; the second clause is the whole of the exception.
 *
 * `adminTokenId` is set only on the token branch, so a password session cannot accidentally match
 * it, and a token can only ever match the one id whose secret it already holds — which is why this
 * cannot be turned into "a token may revoke any of its owner's tokens" by a smaller edit than it
 * looks. Refusal reuses `adminSessionOnly`'s message, because from a sibling token's point of view
 * nothing about the rule has changed.
 */
const adminSessionOrOwnToken = createMiddleware<AppEnv>(async (c, next) => {
  const credential = c.get('adminCredential');
  const isOwnToken = credential === 'token' && c.get('adminTokenId') === c.req.param('id');
  if (credential !== 'password' && !isOwnToken) {
    return c.json({ error: 'Sign in with your password to manage your access tokens.' }, 403);
  }
  await next();
});

export const tenantTokenRoutes = new Hono<AppEnv>()
  // Scoped tightly to the token paths so this never guards another sub-app's routes (Hono
  // flattens .use() patterns across every app mounted at /api — the accounts.ts pattern). The pair
  // is ordered: sign the caller in, then insist it was the PASSWORD that signed them in. The
  // per-id path carries `adminAuth` alone and gets its gate on the DELETE route itself, because
  // the exception that gate makes is a question about the route's `:id`.
  .use('/:slug/admin/tokens', adminAuth, adminSessionOnly)
  .use('/:slug/admin/tokens/*', adminAuth)

  /**
   * Mint one. The plaintext is in this response and nowhere else, ever: it is hashed on the way to
   * the database and the digest has no read path back out. A sitter who loses the value creates
   * another and revokes the old one.
   */
  .post('/:slug/admin/tokens', async (c) => {
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(CreateBody, raw);
    if (!parsed.success) {
      return c.json({ error: `Name your token (1–${MAX_TOKEN_NAME_LENGTH} characters).` }, 400);
    }
    const { name } = parsed.output;
    const live = await countLiveTenantAccessTokens(
      c.env.PAWSERVATION_DB,
      c.get('tenant').Id,
      c.get('adminUserId'),
    );
    if (live >= MAX_LIVE_TOKENS_PER_USER) {
      return c.json(
        { error: `Revoke one first: you already have ${MAX_LIVE_TOKENS_PER_USER} access tokens.` },
        409,
      );
    }
    const token = generateTenantAccessToken();
    const created = await createTenantAccessToken(c.env.PAWSERVATION_DB, c.get('tenant').Id, {
      tenantUserId: c.get('adminUserId'),
      name,
      tokenHash: await hashPersonalAccessToken(token),
    });
    // The only response in the product whose body IS a live credential. `no-store` keeps it out of
    // any shared cache and out of the browser's own back/forward cache, so navigating back cannot
    // re-paint a secret the sitter has already been told she will not see again — the CSV export's
    // reasoning (routes/admin.ts), applied to a body worth rather more than a spreadsheet.
    return c.json({ id: created.Id, token, name: created.Name }, 201, {
      'Cache-Control': 'no-store',
    });
  })

  /** The revoke list: what exists, what to call it, and whether it is still being used. */
  .get('/:slug/admin/tokens', async (c) => {
    const rows = await listTenantAccessTokens(
      c.env.PAWSERVATION_DB,
      c.get('tenant').Id,
      c.get('adminUserId'),
    );
    return c.json({
      tokens: rows.map((r) => ({
        id: r.Id,
        name: r.Name,
        createdAt: r.CreatedAt,
        lastUsedAt: r.LastUsedAt,
      })),
    });
  })

  /**
   * Revoke. Effective on the very next request, because the auth lookup filters on `RevokedAt`
   * rather than waiting for an expiry. 404 covers both "no such token" and "not yours": the caller
   * learns nothing about tokens that are not theirs.
   */
  .delete('/:slug/admin/tokens/:id', adminSessionOrOwnToken, async (c) => {
    const revoked = await revokeTenantAccessToken(
      c.env.PAWSERVATION_DB,
      c.get('tenant').Id,
      c.get('adminUserId'),
      c.req.param('id'),
    );
    if (!revoked) return c.json({ error: 'No such token.' }, 404);
    return c.json({ revoked: true });
  });
