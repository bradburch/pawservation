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
 *
 * WHICH LEFT THAT EXCEPTION UNREACHABLE BY THE ONLY CALLER IT WAS CUT FOR, and `SELF` is the fix.
 * Revoking by id requires knowing the id, and the one route that reports ids is the list — which
 * is `adminSessionOnly`, deliberately, because a credential that can enumerate the revoke list is
 * most of the way to managing it. So a script holding nothing but its secret could never name its
 * own row. `DELETE …/admin/tokens/self` names it by role instead: the id comes from
 * `adminTokenId`, which `adminAuth` already resolved on the way in, so the alias costs no second
 * lookup and widens nothing — the caller can still address exactly one row, its own.
 */
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import * as v from 'valibot';
import {
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
 * The regex rejects the control and format characters a name must not be able to smuggle: `Cc`
 * (C0/C1 controls, so no newlines and no NUL), `Cf` (the bidirectional overrides and the other
 * invisible formatting characters), `Co` (private use, which renders as whatever the reader's font
 * decides) and `Cs` (lone surrogates). The name is the ONLY thing distinguishing one live
 * credential from another in the revoke list, so a name that can reorder or hide what is printed
 * around it makes that list say something other than what is stored, and a list nobody can trust
 * is a list nobody can safely revoke from.
 *
 * TWO CHARACTERS ARE LET BACK IN, and they are the reason this is not simply `\p{C}`: U+200D
 * (zero-width joiner) and U+FE0F (variation selector-16) are how ordinary emoji are SPELLED —
 * "👩‍💻" is two emoji joined by a ZWJ. Rejecting `\p{C}` wholesale turned "CI bot 👩‍💻" into a
 * length error, which is both wrong and unexplainable to the sitter who typed it. Neither
 * character can reorder or hide neighbouring text; they only bind what is already adjacent.
 */
const NAME_RE = /^(?:[^\p{Cc}\p{Cf}\p{Co}\p{Cs}]|\u200D|\uFE0F)+$/u;
const NAME_ERROR = `Name your token (letters, numbers, spaces and punctuation, 1–${MAX_TOKEN_NAME_LENGTH} characters).`;
const CreateBody = v.object({
  name: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(MAX_TOKEN_NAME_LENGTH),
    v.regex(NAME_RE),
  ),
});

/**
 * How many live tokens one sitter may hold at once. Not a security boundary — 25 credentials are
 * no worse than 24 — but the revoke list is only useful while it is short enough to read, and a
 * script looping on the mint route should stop at a number rather than at the table's size.
 *
 * Passed into the INSERT rather than checked here: see `createTenantAccessToken` for why counting
 * in this file and inserting in the next call cannot hold the cap under two concurrent mints.
 */
export const MAX_LIVE_TOKENS_PER_USER = 25;

/**
 * The path segment that means "whichever token is presenting this request".
 *
 * It can never collide with a real id: `createTenantAccessToken` writes `crypto.randomUUID()` and
 * no route sets `Id` from caller input, so every stored id is 36 characters of fixed shape and
 * this is four. The `self` route is still registered BEFORE `/:id` below, so reading the file
 * tells you which handler wins without having to know how Hono ranks a static segment against a
 * parameter.
 */
const SELF = 'self';

/**
 * Password session, OR a token revoking its OWN row — by id, or by the `SELF` alias. Runs after
 * `adminAuth` and reads what it recorded, exactly as `adminSessionOnly` does; the second clause is
 * the whole of the exception.
 *
 * `adminTokenId` is set only on the token branch, so a password session cannot accidentally match
 * it, and a token can only ever match the one id whose secret it already holds — which is why this
 * cannot be turned into "a token may revoke any of its owner's tokens" by a smaller edit than it
 * looks. The `SELF` clause is the same authority spelled differently, not more of it: the handler
 * resolves it to `adminTokenId` and to nothing else, so a token addressing `self` reaches exactly
 * the row it would have reached by typing its own id. Refusal reuses `adminSessionOnly`'s message,
 * because from a sibling token's point of view nothing about the rule has changed.
 */
const adminSessionOrOwnToken = createMiddleware<AppEnv>(async (c, next) => {
  const credential = c.get('adminCredential');
  const addressed = addressedTokenId(c.req.path);
  const isOwnToken =
    credential === 'token' &&
    addressed !== null &&
    (addressed === SELF || c.get('adminTokenId') === addressed);
  if (credential !== 'password' && !isOwnToken) {
    return c.json({ error: 'Sign in with your password to manage your access tokens.' }, 403);
  }
  await next();
});

/**
 * The token id this request addresses, read from the PATH and not from `c.req.param('id')`.
 *
 * Hono resolves a route param against the pattern of the handler currently executing, and this
 * gate is mounted on the SUBTREE (`/:slug/admin/tokens/*`), which has no `:id` — `param('id')` is
 * null there. The subtree is where the gate has to live: mounted per-route it would default every
 * path added under `/tokens/` later to token-reachable, and "whoever adds the next route remembers
 * to gate it" is exactly the assumption a default is for.
 *
 * Anything that is not EXACTLY one segment under `/tokens/` has no id at all, so a token cannot
 * match it and is refused — `/tokens/<id>/anything` included. The segment is compared raw, never
 * decoded: token ids are UUIDs, so a percent-encoded spelling of one is a caller going out of
 * their way, and failing that comparison is the safe answer rather than a puzzle to solve.
 */
function addressedTokenId(path: string): string | null {
  const rest = path.split('/admin/tokens/')[1];
  return rest && !rest.includes('/') ? rest : null;
}

export const tenantTokenRoutes = new Hono<AppEnv>()
  // Scoped tightly to the token paths so this never guards another sub-app's routes (Hono
  // flattens .use() patterns across every app mounted at /api — the accounts.ts pattern). Each
  // pair is ordered: sign the caller in, then insist on the credential the path requires.
  //
  // BOTH lines carry a gate, and the SUBTREE one is the important half: whatever route is added
  // under `/tokens/` next is password-only by default, and has to be deliberately relaxed rather
  // than deliberately protected. The subtree's gate is the looser of the two only because the
  // DELETE below needs the self-revoke exception; every other path under it inherits a rule that
  // no token can satisfy, because no other path names a token id.
  .use('/:slug/admin/tokens', adminAuth, adminSessionOnly)
  .use('/:slug/admin/tokens/*', adminAuth, adminSessionOrOwnToken)

  /**
   * Mint one. The plaintext is in this response and nowhere else, ever: it is hashed on the way to
   * the database and the digest has no read path back out. A sitter who loses the value creates
   * another and revokes the old one.
   */
  .post('/:slug/admin/tokens', async (c) => {
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(CreateBody, raw);
    if (!parsed.success) return c.json({ error: NAME_ERROR }, 400);
    const { name } = parsed.output;
    const token = generateTenantAccessToken();
    // The cap lives inside the INSERT (see `createTenantAccessToken`), so it is checked against
    // the state the write applies to rather than against a count read a round trip earlier. `null`
    // means the statement declined to write because the sitter is already at the cap.
    const created = await createTenantAccessToken(c.env.PAWSERVATION_DB, c.get('tenant').Id, {
      tenantUserId: c.get('adminUserId'),
      name,
      tokenHash: await hashPersonalAccessToken(token),
      maxLive: MAX_LIVE_TOKENS_PER_USER,
    });
    if (!created) {
      return c.json(
        { error: `Revoke one first: you already have ${MAX_LIVE_TOKENS_PER_USER} access tokens.` },
        409,
      );
    }
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
   * Revoke WHICHEVER token is presenting this request — the route a disconnecting script can
   * actually call, because it needs to know nothing but the secret it is already sending.
   *
   * Registered before `/:id` so the ordering is a property of this file rather than of the
   * router's ranking rules. The id is read from `adminTokenId`, which `adminAuth` set when it
   * authenticated the caller: no second hash, no second read, and no way for the request body or
   * path to influence which row is revoked.
   *
   * A PASSWORD SESSION GETS 400, not 403. Nothing is being refused — the gate above lets it
   * through on purpose — it is that a session has no token of its own to hand back, so the
   * request names a thing that does not exist for this caller. The list is what it wants, and the
   * message says so.
   *
   * Idempotence needs no `COALESCE` here the way `/:id` does: a second call cannot reach this
   * handler at all, because `adminAuth` no longer resolves the credential and answers 401 first.
   */
  .delete(`/:slug/admin/tokens/${SELF}`, async (c) => {
    if (c.get('adminCredential') === 'password') {
      return c.json(
        { error: 'You are signed in with your password; revoke a token from the list instead.' },
        400,
      );
    }
    // Reachable only on the token branch, which always sets `adminTokenId` — but read defensively
    // rather than with a `!`, so a future credential kind that skipped it would be refused here
    // instead of revoking `undefined`.
    const id = c.get('adminTokenId');
    const revoked =
      id !== undefined &&
      (await revokeTenantAccessToken(
        c.env.PAWSERVATION_DB,
        c.get('tenant').Id,
        c.get('adminUserId'),
        id,
      ));
    if (!revoked) return c.json({ error: 'No such token.' }, 404);
    return c.json({ revoked: true });
  })

  /**
   * Revoke by id. Effective on the very next request, because the auth lookup filters on
   * `RevokedAt` rather than waiting for an expiry. 404 covers both "no such token" and "not
   * yours": the caller learns nothing about tokens that are not theirs.
   *
   * No gate of its own: `adminSessionOrOwnToken` on the subtree above already covers this route
   * and every other path under `/tokens/`. Adding one here as well would read as though the
   * subtree's were optional.
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
