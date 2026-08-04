/**
 * Personal access tokens: the customer's own credential management.
 *
 * Three routes, all for the signed-in customer acting on their OWN tokens. There is no admin
 * surface here on purpose — a sitter must not be able to mint a credential that acts as one of
 * her clients, and nothing about these tokens is hers to manage.
 *
 * WHY THE PRODUCT NEEDS THIS AT ALL: `lib/llms.ts` publishes, for every tenant, exactly how to
 * check availability, quote, book, change and cancel — and each of those endpoints requires
 * `endUserAuth`. Until now the only credential that satisfied it was a 24-hour widget JWT minted
 * by the widget's own email-code flow, so that published document described an API no client
 * other than the widget could keep using. These routes are what close that gap.
 *
 * @see server/lib/personal-access-token.ts for the entropy/hashing/comparison decisions.
 */
import { Hono } from 'hono';
import * as v from 'valibot';
import {
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
} from '../db/repo';
import { endUserAuth, widgetSessionOnly } from '../lib/middleware';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../lib/personal-access-token';
import type { AppEnv } from '../types';

/**
 * The owner's own label for the client they are issuing to ("my laptop", "my assistant"). Required
 * and non-blank because it is the ONLY thing distinguishing two entries in the revoke list, and a
 * list of indistinguishable secrets is a list nobody can safely act on. Capped so it stays readable in
 * that list — the same trimmed-then-validated shape `routes/auth.ts` establishes for request
 * bodies.
 */
export const MAX_TOKEN_NAME_LENGTH = 80;
const CreateBody = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(MAX_TOKEN_NAME_LENGTH)),
});

export const tokenRoutes = new Hono<AppEnv>()
  // Scoped tightly to the token paths so this never guards another sub-app's routes (Hono
  // flattens .use() patterns across every app mounted at /api). The pair is ordered: sign the
  // caller in, then insist it was the WIDGET that signed them in — a token must not be able to
  // mint its own replacement, or revoking one would settle nothing.
  .use('/:slug/tokens', endUserAuth, widgetSessionOnly)
  .use('/:slug/tokens/*', endUserAuth, widgetSessionOnly)

  /**
   * Mint one. The plaintext is in this response and nowhere else, ever: it is hashed on the way to
   * the database and the digest has no read path back out (`PersonalAccessTokenRow` does not carry
   * it). A customer who loses the value creates another and revokes the old one — which is the
   * behaviour that makes "we cannot show it to you again" a true statement rather than a policy.
   */
  .post('/:slug/tokens', async (c) => {
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(CreateBody, raw);
    if (!parsed.success) {
      return c.json({ error: `Name your token (1–${MAX_TOKEN_NAME_LENGTH} characters).` }, 400);
    }
    const { name } = parsed.output;
    const token = generatePersonalAccessToken();
    const id = await createPersonalAccessToken(
      c.env.PAWBOOK_DB,
      c.get('tenant').Id,
      c.get('endUserId'),
      name,
      await hashPersonalAccessToken(token),
    );
    return c.json({ id, token, name }, 201);
  })

  /** The revoke list: what exists, what to call it, and whether it is still being used. */
  .get('/:slug/tokens', async (c) => {
    const rows = await listPersonalAccessTokens(
      c.env.PAWBOOK_DB,
      c.get('tenant').Id,
      c.get('endUserId'),
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
   * rather than waiting for an expiry — these tokens deliberately have no expiry to wait for.
   * 404 covers both "no such token" and "not yours": the caller learns nothing about tokens that
   * are not theirs.
   */
  .delete('/:slug/tokens/:id', async (c) => {
    const revoked = await revokePersonalAccessToken(
      c.env.PAWBOOK_DB,
      c.get('tenant').Id,
      c.get('endUserId'),
      c.req.param('id'),
    );
    if (!revoked) return c.json({ error: 'No such token.' }, 404);
    return c.json({ revoked: true });
  });
