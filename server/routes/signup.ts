import { Hono } from 'hono';
import * as v from 'valibot';
import {
  createTenantFromSignup,
  getAllowedSitter,
  getOwnerUserByEmail,
  getTenantBySlug,
  insertOwnerUser,
  rollbackUnclaimedTenant,
} from '../db/repo';
import { isEmailConfigured, sendSignupLink } from '../lib/email';
import { RESERVED_SLUGS } from '../lib/middleware';
import { isOwnerEmail } from '../lib/owners';
import { hashPassword } from '../lib/password';
import { checkAndBumpRateLimit } from '../lib/rate-limit';
import { slugifyServiceLabel } from '../lib/services';
import {
  SIGNUP_LINK_TTL_SECONDS,
  SIGNUP_NONCE_KEY,
  signSignupLink,
  verifySignupLink,
} from '../lib/signup-link';
import { mintAdminToken, mintOwnerToken } from '../lib/token';
import { EMAIL_RE } from '../lib/validation';
import type { AppEnv } from '../types';

/**
 * Invite-only signup. Non-slug-scoped ('signup' is in RESERVED_SLUGS, so tenantMiddleware
 * passes /api/signup/* through). /start is enumeration-neutral: ONE body for every input,
 * with all allowlist-dependent work deferred behind the response.
 */

const StartBody = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(EMAIL_RE)),
});

export const MIN_PASSWORD_LENGTH = 8;

const CompleteBody = v.object({
  token: v.string(),
  password: v.string(),
  businessName: v.optional(v.pipe(v.string(), v.trim())),
});

export const EXPIRED_ERROR =
  'This link has expired or was already used — enter your email on the sign-in page to get a fresh one.';
export const ALREADY_SET_UP_ERROR = 'This email is already set up — sign in instead.';
export const RETRYABLE_ERROR = 'Something went wrong — please try again.';

/**
 * Only a genuine SQLite UNIQUE-constraint violation means "already set up" (a replay that beat
 * the nonce consume, dying on OwnerUsers.Email / TenantUsers.Email UNIQUE). Any other throw —
 * e.g. "no such table" from an unapplied migration — must NOT be relabeled "already set up", or
 * an outage masquerades as a benign message (the owner-lockout incident). D1 sometimes wraps the
 * driver error in a cause, so inspect that too.
 */
function isUniqueViolation(err: unknown): boolean {
  const hit = (e: unknown) => e instanceof Error && e.message.includes('UNIQUE constraint failed');
  return hit(err) || (err instanceof Error && hit(err.cause));
}

const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_TTL_SECONDS = 3600;
const RATE_KEY = (email: string, ip: string) => `signup:rl:${email}:${ip}`;

/**
 * 'owner' for an OWNER_EMAILS member with no password yet, 'sitter' for an unclaimed
 * allowlist row, null for everyone else. Owner check first: an email in the secret is an
 * owner, full stop — it must never claim a sitter tenant.
 */
async function eligibleKind(env: Env, email: string): Promise<'sitter' | 'owner' | null> {
  if (isOwnerEmail(env, email)) {
    return (await getOwnerUserByEmail(env.PAWBOOK_DB, email)) ? null : 'owner';
  }
  const row = await getAllowedSitter(env.PAWBOOK_DB, email);
  return row && !row.ClaimedAt ? 'sitter' : null;
}

/** Mint a link and register its single-use nonce in KV (same expiry as the link). */
async function mintLink(
  env: Env,
  origin: string,
  email: string,
  kind: 'sitter' | 'owner',
): Promise<string> {
  const nonce = crypto.randomUUID();
  await env.PAWBOOK_CACHE.put(SIGNUP_NONCE_KEY(nonce), '1', {
    expirationTtl: SIGNUP_LINK_TTL_SECONDS,
  });
  const token = await signSignupLink(env.TOKEN_SECRET, {
    email,
    kind,
    nonce,
    exp: Date.now() + SIGNUP_LINK_TTL_SECONDS * 1000,
  });
  return `${origin}/setup?t=${token}`;
}

export const signupRoutes = new Hono<AppEnv>()
  .post('/signup/start', async (c) => {
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(StartBody, raw);
    if (!parsed.success) return c.json({ error: 'Enter a valid email.' }, 400);
    const { email } = parsed.output;
    const origin = new URL(c.req.url).origin;

    // Soft per-email+IP limiter (KV counter; increments aren't atomic — fine for a soft cap).
    // Over the cap → the SAME neutral 200 with the send skipped, so the limiter isn't an oracle.
    const rateKey = RATE_KEY(email, c.req.header('CF-Connecting-IP') ?? 'unknown');
    const overCap = await checkAndBumpRateLimit(
      c.env.PAWBOOK_CACHE,
      rateKey,
      RATE_LIMIT_MAX,
      RATE_LIMIT_TTL_SECONDS,
    );

    if (!isEmailConfigured(c.env)) {
      // No provider outside explicit local development fails CLOSED (same posture as /identify);
      // the 503 is identical for every input, so it reveals nothing per-email.
      if (c.env.ENVIRONMENT !== 'development') {
        return c.json({ error: 'Signup is temporarily unavailable.' }, 503);
      }
      // Local-dev degrade (mirrors routes/auth.ts prototypeCode): run the check inline and
      // render the link on screen so demos work with a blanked RESEND_API_KEY.
      if (overCap) return c.json({ ok: true });
      const kind = await eligibleKind(c.env, email);
      if (!kind) return c.json({ ok: true });
      return c.json({ ok: true, prototypeLink: await mintLink(c.env, origin, email, kind) });
    }

    // Enumeration neutrality is structural: the 200 goes out NOW; everything whose duration
    // could depend on allowlist state runs after the response (the calendar-sync waitUntil
    // precedent). Send failures are logged and swallowed — the invitee simply retries.
    const work = (async () => {
      if (overCap) return;
      const kind = await eligibleKind(c.env, email);
      if (!kind) return;
      await sendSignupLink(c.env, email, await mintLink(c.env, origin, email, kind));
    })().catch((err) => console.error('signup link send failed', err));
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work; // tests have no ExecutionContext — await for determinism (bookings.ts pattern)
    }
    return c.json({ ok: true });
  })
  .post('/signup/complete', async (c) => {
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(CompleteBody, raw);
    if (!parsed.success) return c.json({ error: 'Invalid request.' }, 400);
    const { token, password, businessName } = parsed.output;

    // Password floor first — a policy rejection must not burn the single-use link.
    if (password.length < MIN_PASSWORD_LENGTH)
      return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);

    const payload = await verifySignupLink(c.env.TOKEN_SECRET, token, Date.now());
    if (!payload) return c.json({ error: EXPIRED_ERROR }, 400);

    // Sitter-only input validation BEFORE the nonce is consumed, for the same reason.
    let displayName = '';
    let slugBase = '';
    if (payload.kind === 'sitter') {
      displayName = businessName ?? '';
      if (!displayName) return c.json({ error: 'Business name is required.' }, 400);
      slugBase = slugifyServiceLabel(displayName);
      if (!slugBase) return c.json({ error: 'Business name needs letters or numbers.' }, 400);
    }

    // Single-use: consume the nonce before provisioning (missing ⇒ expired/used ⇒ reject) —
    // the OAuth-callback consume-on-use pattern.
    const seen = await c.env.PAWBOOK_CACHE.get(SIGNUP_NONCE_KEY(payload.nonce));
    if (!seen) return c.json({ error: EXPIRED_ERROR }, 400);
    await c.env.PAWBOOK_CACHE.delete(SIGNUP_NONCE_KEY(payload.nonce));

    if (payload.kind === 'owner') {
      // The secret may have changed since issue — re-check membership.
      if (!isOwnerEmail(c.env, payload.email)) return c.json({ error: EXPIRED_ERROR }, 400);
      try {
        // OwnerUsers.Email UNIQUE guards the replay that beat the nonce consume.
        await insertOwnerUser(
          c.env.PAWBOOK_DB,
          crypto.randomUUID(),
          payload.email,
          await hashPassword(password),
        );
      } catch (err) {
        console.error('owner signup insert failed', err);
        if (isUniqueViolation(err)) return c.json({ error: ALREADY_SET_UP_ERROR }, 409);
        return c.json({ error: RETRYABLE_ERROR }, 500);
      }
      const ownerToken = await mintOwnerToken(payload.email, c.env.TOKEN_SECRET);
      return c.json({ token: ownerToken, role: 'owner', email: payload.email });
    }

    // Sitter: uniquify the slug past reserved words and existing tenants.
    let slug = slugBase;
    for (
      let n = 2;
      RESERVED_SLUGS.has(slug) || (await getTenantBySlug(c.env.PAWBOOK_DB, slug));
      n++
    )
      slug = `${slugBase}-${n}`;

    const tenantId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    let claimed: boolean;
    try {
      // One atomic batch — a replay dies on TenantUsers.Email UNIQUE, aborting the whole
      // batch: no orphan tenant (see createTenantFromSignup).
      claimed = await createTenantFromSignup(c.env.PAWBOOK_DB, {
        tenantId,
        slug,
        displayName,
        userId,
        email: payload.email,
        passwordHash: await hashPassword(password),
      });
    } catch (err) {
      console.error('sitter signup insert failed', err);
      if (isUniqueViolation(err)) return c.json({ error: ALREADY_SET_UP_ERROR }, 409);
      return c.json({ error: RETRYABLE_ERROR }, 500);
    }
    if (!claimed) {
      // The invite was revoked (or its allowlist row otherwise vanished/was already claimed)
      // between our checks and the batch, without tripping TenantUsers.Email UNIQUE — the
      // Tenants/TenantUsers rows landed anyway. A tenant must never stand without a valid
      // claim, so compensate before telling the caller the link is dead.
      await rollbackUnclaimedTenant(c.env.PAWBOOK_DB, tenantId, userId).catch((err) =>
        console.error('signup rollback failed', err),
      );
      return c.json({ error: EXPIRED_ERROR }, 400);
    }
    const adminToken = await mintAdminToken(userId, tenantId, c.env.TOKEN_SECRET);
    return c.json({ token: adminToken, role: 'admin', slug, displayName });
  });
