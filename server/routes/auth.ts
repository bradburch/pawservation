import { Hono } from 'hono';
import { consumeLoginCode, createLoginCode, upsertEndUser } from '../db/repo';
import { mintToken } from '../lib/token';
import type { AppEnv } from '../types';

const CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, '0');
}

export const authRoutes = new Hono<AppEnv>()
  .post('/:slug/identify', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);

    const user = await upsertEndUser(c.env.EMBED_PROTO_DB, tenant.Id, email);
    const code = generateCode();
    const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
    const codeId = await createLoginCode(c.env.EMBED_PROTO_DB, tenant.Id, user.Id, code, expiresAt);

    // PROTOTYPE ONLY: the code is returned to the client and displayed on screen instead of
    // being emailed (PRD FR9). Real email delivery is a graduation task.
    return c.json({ codeId, prototypeCode: code });
  })

  .post('/:slug/verify', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ codeId?: unknown; code?: unknown }>()
      .catch(() => ({}) as { codeId?: unknown; code?: unknown });
    if (typeof body.codeId !== 'string' || typeof body.code !== 'string')
      return c.json({ error: 'Code required.' }, 400);

    const endUserId = await consumeLoginCode(
      c.env.EMBED_PROTO_DB,
      tenant.Id,
      body.codeId,
      body.code.trim(),
      new Date().toISOString(),
    );
    if (!endUserId) return c.json({ error: 'That code is wrong or expired — try again.' }, 401);

    const token = await mintToken(endUserId, tenant.Id, c.env.TOKEN_SECRET);
    return c.json({ token });
  });
