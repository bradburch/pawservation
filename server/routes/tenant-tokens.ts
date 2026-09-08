/**
 * Tenant access tokens: the sitter's own credential management (0016) — the mirror of
 * `routes/tokens.ts` for the admin side, not a variant of it. See that file's docblock for the
 * general shape; this one only calls out what differs.
 *
 * Every route here is additionally gated by `adminSessionOnly`: a tenant access token can do
 * everything the password session can EXCEPT mint, list, or revoke tokens (the carve-out — see
 * `lib/middleware.ts`'s `adminSessionOnly`). A credential that could issue its own replacement
 * would make the revoke list advisory.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import {
  createTenantAccessToken,
  listTenantAccessTokens,
  revokeTenantAccessToken,
} from '../db/repo';
import { adminAuth, adminSessionOnly } from '../lib/middleware';
import { generateTenantAccessToken, hashPersonalAccessToken } from '../lib/personal-access-token';
import type { AppEnv } from '../types';

/** Same shape and same cap as the pet owner's token name — see `routes/tokens.ts`. */
export const MAX_TOKEN_NAME_LENGTH = 80;
const CreateBody = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_TOKEN_NAME_LENGTH)),
});

export const tenantTokenRoutes = new Hono<AppEnv>()
  // Scoped tightly to the token paths so this never guards another sub-app's routes (Hono
  // flattens .use() patterns across every app mounted at /api — the accounts.ts pattern). The pair
  // is ordered: sign the caller in, then insist it was the PASSWORD that signed them in.
  .use('/:slug/admin/tokens', adminAuth, adminSessionOnly)
  .use('/:slug/admin/tokens/*', adminAuth, adminSessionOnly)

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
    const token = generateTenantAccessToken();
    const created = await createTenantAccessToken(c.env.PAWSERVATION_DB, c.get('tenant').Id, {
      tenantUserId: c.get('adminUserId'),
      name,
      tokenHash: await hashPersonalAccessToken(token),
    });
    return c.json({ id: created.Id, token, name: created.Name }, 201);
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
  .delete('/:slug/admin/tokens/:id', async (c) => {
    const revoked = await revokeTenantAccessToken(
      c.env.PAWSERVATION_DB,
      c.get('tenant').Id,
      c.get('adminUserId'),
      c.req.param('id'),
    );
    if (!revoked) return c.json({ error: 'No such token.' }, 404);
    return c.json({ revoked: true });
  });
