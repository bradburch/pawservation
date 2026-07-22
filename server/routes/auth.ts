import { Hono } from 'hono';
import * as v from 'valibot';
import {
  consumeLoginCode,
  createLoginCode,
  getEndUserByEmail,
  promoteCustomerActive,
} from '../db/repo';
import { isEmailConfigured, sendLoginCode } from '../lib/email';
import { mintToken } from '../lib/token';
import { EMAIL_RE } from '../lib/validation';
import type { AppEnv } from '../types';

const CODE_TTL_MS = 10 * 60 * 1000;

// The public /demo page (demo.html) embeds these two tenants for anyone to try, with no
// real inbox behind their seeded EndUsers — so they always get the on-screen code, the same
// path local dev uses, regardless of ENVIRONMENT.
const DEMO_TENANT_SLUGS = new Set(['sunny-paws', 'happy-tails']);

// --- Reference valibot pattern ---
// This file is the reference for validating request bodies with valibot: declare a schema, then
// `safeParse` once to both validate and narrow types (replacing hand-rolled `typeof` guards + casts).
// Other routes should follow this shape. Keep schemas small and inline — no shared factory.
//
// The email schema reuses the repo's EMAIL_RE via a regex pipe (not valibot's own email heuristic)
// so validation stays byte-for-byte identical to the previous hand-check. It also trims + lowercases
// before the regex, matching the old `body.email.trim().toLowerCase()` normalization.
const IdentifyBody = v.object({
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(EMAIL_RE)),
});
// codeId is intentionally NOT trimmed (matches prior behavior); code is trimmed before consuming.
const VerifyBody = v.object({
  codeId: v.string(),
  code: v.pipe(v.string(), v.trim()),
});

function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, '0');
}

export const authRoutes = new Hono<AppEnv>()
  .post('/:slug/identify', async (c) => {
    const tenant = c.get('tenant');
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(IdentifyBody, raw);
    if (!parsed.success) return c.json({ error: 'Enter a valid email.' }, 400);
    const { email } = parsed.output;

    // Invite-only: only customers the provider has added may receive a code. Do NOT auto-create.
    const user = await getEndUserByEmail(c.env.PAWBOOK_DB, tenant.Id, email);
    if (!user) return c.json({ error: 'This provider books by invitation only.' }, 403);
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    const codeId = await createLoginCode(c.env.PAWBOOK_DB, tenant.Id, user.Id, code, expiresAt);

    // When email is configured, send the code and NEVER return it — returning it would be an
    // unauthenticated account-takeover (anyone knowing the email could read the code).
    if (isEmailConfigured(c.env)) {
      try {
        await sendLoginCode(c.env, email, code);
      } catch {
        return c.json({ error: 'Could not send your code. Try again shortly.' }, 502);
      }
      return c.json({ codeId });
    }
    // No email provider configured. Only show the code on screen in explicit local development,
    // or for the two public demo tenants — gating on an env signal (not merely on the secrets
    // being absent) so a production deploy that forgot to set RESEND_* fails CLOSED instead of
    // silently leaking codes for real tenants.
    if (c.env.ENVIRONMENT === 'development' || DEMO_TENANT_SLUGS.has(tenant.Slug)) {
      return c.json({ codeId, prototypeCode: code });
    }
    return c.json({ error: 'Login is temporarily unavailable.' }, 503);
  })

  .post('/:slug/verify', async (c) => {
    const tenant = c.get('tenant');
    const raw = await c.req.json<unknown>().catch(() => ({}));
    const parsed = v.safeParse(VerifyBody, raw);
    if (!parsed.success) return c.json({ error: 'Code required.' }, 400);
    const { codeId, code } = parsed.output;

    const endUserId = await consumeLoginCode(
      c.env.PAWBOOK_DB,
      tenant.Id,
      codeId,
      code,
      new Date().toISOString(),
    );
    if (!endUserId) return c.json({ error: 'That code is wrong or expired — try again.' }, 401);

    // First successful sign-in promotes an invited customer to active.
    await promoteCustomerActive(c.env.PAWBOOK_DB, tenant.Id, endUserId);

    const token = await mintToken(endUserId, tenant.Id, c.env.TOKEN_SECRET);
    return c.json({ token });
  });
