import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getTenantById, setProviderTokens } from '../db/repo';
import { exchangeCode } from '../lib/google-calendar';
import { verifyState } from '../lib/oauth-state';
import { encryptToken } from '../lib/token-crypto';
import type { AppEnv } from '../types';

export const NONCE_KEY = (nonce: string) => `gcal:nonce:${nonce}`;

/**
 * Script-free result page. This route is NOT under /embed, so index.ts applies the LOCKED_CSP
 * (`default-src 'self'` with no script-src) — an inline <script> would be blocked. So the page is
 * plain HTML and the admin dashboard (opener) detects the popup closing and refreshes itself.
 */
function resultPage(ok: boolean): Response {
  const body = ok
    ? 'Google Calendar connected. You can close this window and return to Pawservation.'
    : 'Connection failed. Please close this window and try again.';
  const html = `<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Error'}</title>
<body style="font:14px system-ui;padding:2rem">${body}</body>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export const oauthRoutes = new Hono<AppEnv>().get('/oauth/google/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return resultPage(false);

  const payload = await verifyState(c.env.TOKEN_SECRET, state, Date.now());
  if (!payload) return resultPage(false);

  // Login-CSRF defense: the cookie set at /start must carry the same nonce as the signed state.
  const cookieNonce = getCookie(c, 'pawbook_gcal_nonce');
  if (!cookieNonce || cookieNonce !== payload.nonce) return resultPage(false);

  // Single-use nonce: must exist, and is deleted on use so the callback can't be replayed.
  const seen = await c.env.PAWBOOK_CACHE.get(NONCE_KEY(payload.nonce));
  if (!seen) return resultPage(false);
  await c.env.PAWBOOK_CACHE.delete(NONCE_KEY(payload.nonce));

  const tenant = await getTenantById(c.env.PAWBOOK_DB, payload.tenantId);
  if (!tenant) return resultPage(false);

  try {
    const tokens = await exchangeCode(c.env, code);
    await setProviderTokens(c.env.PAWBOOK_DB, tenant.Id, 'calendar', 'google-calendar', {
      access: await encryptToken(c.env.TOKEN_SECRET, tokens.accessToken),
      refresh: await encryptToken(c.env.TOKEN_SECRET, tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      calendarId: 'primary',
    });
  } catch {
    return resultPage(false);
  }
  return resultPage(true);
});
