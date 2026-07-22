import { Hono } from 'hono';
import * as v from 'valibot';
import {
  getOwnerUserByEmail,
  getTenantUserByEmail,
  updateOwnerPasswordHash,
  updateTenantUserPasswordHash,
} from '../db/repo';
import { isEmailConfigured, sendResetLink } from '../lib/email';
import { hashPassword } from '../lib/password';
import { checkAndBumpRateLimit } from '../lib/rate-limit';
import {
  RESET_LINK_TTL_SECONDS,
  RESET_NONCE_KEY,
  signResetLink,
  verifyResetLink,
} from '../lib/reset-link';
import { mintAdminToken, mintOwnerToken } from '../lib/token';
import { EMAIL_RE } from '../lib/validation';
import { EXPIRED_ERROR, MIN_PASSWORD_LENGTH } from './signup';
import type { AppEnv } from '../types';

/**
 * Password recovery for both auth systems (owner console, sitter dashboard). Non-slug-scoped
 * ('password-reset' is in RESERVED_SLUGS, so tenantMiddleware passes /api/password-reset/*
 * through), mirroring signup.ts's shape exactly: /start is enumeration-neutral, /complete
 * consumes a single-use link and logs the caller in directly. See reset-link.ts for why reset
 * links are a distinct signed-link type from signup links rather than a variant of the same one.
 */

const StartBody = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(EMAIL_RE)),
});

const CompleteBody = v.object({
  token: v.string(),
  password: v.string(),
});

const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_TTL_SECONDS = 3600;
const RATE_KEY = (email: string, ip: string) => `pwreset:rl:${email}:${ip}`;

/** Owner checked first — an owner email's account, if it exists, is always the OwnerUsers row. */
async function resettableKind(env: Env, email: string): Promise<'sitter' | 'owner' | null> {
  if (await getOwnerUserByEmail(env.PAWBOOK_DB, email)) return 'owner';
  if (await getTenantUserByEmail(env.PAWBOOK_DB, email)) return 'sitter';
  return null;
}

/** Mint a link and register its single-use nonce in KV (same expiry as the link). The `reset=1`
 *  marker tells /setup which endpoint/copy to use — it is NOT part of the signed payload, since
 *  a signup token and a reset token already carry that distinction via which module verifies
 *  them; this is purely a client-side routing hint the server fully controls. */
async function mintResetLink(
  env: Env,
  origin: string,
  email: string,
  kind: 'sitter' | 'owner',
): Promise<string> {
  const nonce = crypto.randomUUID();
  await env.PAWBOOK_CACHE.put(RESET_NONCE_KEY(nonce), '1', {
    expirationTtl: RESET_LINK_TTL_SECONDS,
  });
  const token = await signResetLink(env.TOKEN_SECRET, {
    email,
    kind,
    nonce,
    exp: Date.now() + RESET_LINK_TTL_SECONDS * 1000,
  });
  return `${origin}/setup?t=${token}&reset=1`;
}

export const passwordResetRoutes = new Hono<AppEnv>()
  .post('/password-reset/start', async (c) => {
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(StartBody, raw);
    if (!parsed.success) return c.json({ error: 'Enter a valid email.' }, 400);
    const { email } = parsed.output;
    const origin = new URL(c.req.url).origin;

    const rateKey = RATE_KEY(email, c.req.header('CF-Connecting-IP') ?? 'unknown');
    const overCap = await checkAndBumpRateLimit(
      c.env.PAWBOOK_CACHE,
      rateKey,
      RATE_LIMIT_MAX,
      RATE_LIMIT_TTL_SECONDS,
    );

    if (!isEmailConfigured(c.env)) {
      if (c.env.ENVIRONMENT !== 'development') {
        return c.json({ error: 'Password reset is temporarily unavailable.' }, 503);
      }
      if (overCap) return c.json({ ok: true });
      const kind = await resettableKind(c.env, email);
      if (!kind) return c.json({ ok: true });
      return c.json({ ok: true, prototypeLink: await mintResetLink(c.env, origin, email, kind) });
    }

    const work = (async () => {
      if (overCap) return;
      const kind = await resettableKind(c.env, email);
      if (!kind) return;
      await sendResetLink(c.env, email, await mintResetLink(c.env, origin, email, kind));
    })().catch((err) => console.error('password reset link send failed', err));
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work;
    }
    return c.json({ ok: true });
  })
  .post('/password-reset/complete', async (c) => {
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(CompleteBody, raw);
    if (!parsed.success) return c.json({ error: 'Invalid request.' }, 400);
    const { token, password } = parsed.output;

    if (password.length < MIN_PASSWORD_LENGTH)
      return c.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);

    const payload = await verifyResetLink(c.env.TOKEN_SECRET, token, Date.now());
    if (!payload) return c.json({ error: EXPIRED_ERROR }, 400);

    const seen = await c.env.PAWBOOK_CACHE.get(RESET_NONCE_KEY(payload.nonce));
    if (!seen) return c.json({ error: EXPIRED_ERROR }, 400);
    await c.env.PAWBOOK_CACHE.delete(RESET_NONCE_KEY(payload.nonce));

    const passwordHash = await hashPassword(password);

    if (payload.kind === 'owner') {
      const changed = await updateOwnerPasswordHash(c.env.PAWBOOK_DB, payload.email, passwordHash);
      if (!changed) return c.json({ error: EXPIRED_ERROR }, 400);
      const ownerToken = await mintOwnerToken(payload.email, c.env.TOKEN_SECRET);
      return c.json({ token: ownerToken, role: 'owner', email: payload.email });
    }

    const user = await getTenantUserByEmail(c.env.PAWBOOK_DB, payload.email);
    if (!user) return c.json({ error: EXPIRED_ERROR }, 400);
    const changed = await updateTenantUserPasswordHash(
      c.env.PAWBOOK_DB,
      payload.email,
      passwordHash,
    );
    if (!changed) return c.json({ error: EXPIRED_ERROR }, 400);
    const adminToken = await mintAdminToken(user.Id, user.TenantId, c.env.TOKEN_SECRET);
    return c.json({ token: adminToken, role: 'admin', email: payload.email });
  });
