import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getTenantById, setProviderTokens } from '../db/repo';
import { backfillCalendarEvents } from '../lib/calendar-sync';
import { exchangeCode } from '../lib/google-calendar';
import { verifyState } from '../lib/oauth-state';
import { encryptToken } from '../lib/token-crypto';
import type { AppEnv } from '../types';

export const NONCE_KEY = (nonce: string) => `gcal:nonce:${nonce}`;

/**
 * What the SITTER is told, in the only three shapes she can act on. Several distinct server-side
 * branches deliberately collapse into one sentence — which branch actually fired is recovered from
 * the log line `fail()` writes, never from the page, because the page is rendered to whoever
 * followed the redirect and must not describe our CSRF machinery.
 */
type FailureKind = 'session' | 'google' | 'unavailable';

const FAILURE_TEXT: Record<FailureKind, string> = {
  session:
    'That connection attempt expired, or it was started in a different browser window. Close this window, click “Connect Google Calendar” again, and finish within a few minutes.',
  google:
    'Google did not grant access. Close this window, click “Connect Google Calendar” again, and choose Allow on Google’s permission screen.',
  unavailable:
    'We could not finish the connection with Google just now. Close this window and try again in a minute.',
};

/**
 * Script-free result page. This route is NOT under /embed, so index.ts applies the LOCKED_CSP
 * (`default-src 'self'` with no script-src) — an inline <script> would be blocked. So the page is
 * plain HTML and the admin dashboard (opener) detects the popup closing and refreshes itself.
 */
function resultPage(ok: true): Response;
function resultPage(ok: false, kind: FailureKind): Response;
function resultPage(ok: boolean, kind?: FailureKind): Response {
  const body = ok
    ? 'Google Calendar connected. You can close this window and return to Pawservation.'
    : FAILURE_TEXT[kind ?? 'unavailable'];
  const html = `<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Error'}</title>
<body style="font:14px system-ui;padding:2rem">${body}</body>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/**
 * Every failure branch answers through here, so a connect that "just doesn't work" is diagnosable
 * from `wrangler tail` alone. `reason` names the exact branch; the page shows only `kind`'s
 * sentence. This is not optional decoration: the sitter-facing text is deliberately vague and this
 * log line is the ONLY place the nine failure branches are told apart.
 */
function fail(kind: FailureKind, reason: string, detail?: Record<string, unknown>): Response {
  console.error('google oauth callback failed', { reason, ...detail });
  return resultPage(false, kind);
}

export const oauthRoutes = new Hono<AppEnv>().get('/oauth/google/callback', async (c) => {
  // A refusal is reported by REDIRECTING back with `error` and no `code` (RFC 6749 §4.1.2.1) —
  // the sitter pressed Cancel, or Google itself blocked her (`access_denied` for a non-test user
  // while the OAuth app is in Testing, `admin_policy_enforced` on a Workspace account). Read it
  // BEFORE the missing-`code` branch, or every one of those becomes an indistinguishable
  // "connection failed" with nothing in the logs.
  const oauthError = c.req.query('error');
  if (oauthError)
    return fail('google', 'google_denied', {
      googleError: oauthError,
      googleErrorDescription: c.req.query('error_description') ?? null,
    });

  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state)
    return fail('session', 'missing_params', { hasCode: Boolean(code), hasState: Boolean(state) });

  const payload = await verifyState(c.env.TOKEN_SECRET, state, Date.now());
  if (!payload) return fail('session', 'bad_or_expired_state');

  // Login-CSRF defense: the cookie set at /start must carry the same nonce as the signed state.
  // The host is logged with a MISSING cookie specifically because the cookie is host-scoped while
  // GOOGLE_OAUTH_REDIRECT_URI names ONE host: a dashboard opened on workers.dev (or a preview URL)
  // while the redirect points at pawservation.com sets the cookie somewhere this request can never
  // read it. `/admin/providers/calendar/oauth/start` now refuses that combination up front, so a
  // hit here means the mismatch arose some other way — and the host is what says which.
  const cookieNonce = getCookie(c, 'pawbook_gcal_nonce');
  if (!cookieNonce)
    return fail('session', 'nonce_cookie_missing', {
      tenantId: payload.tenantId,
      callbackHost: new URL(c.req.url).host,
    });
  if (cookieNonce !== payload.nonce)
    return fail('session', 'nonce_cookie_mismatch', { tenantId: payload.tenantId });

  // Single-use nonce: must exist, and is deleted on use so the callback can't be replayed.
  // Absent means either a genuine replay or a KV read that didn't see the /start write (KV is
  // eventually consistent) — the log line is what distinguishes them, since a replay is preceded
  // by a 200 for the same tenant and a lost write is not.
  const seen = await c.env.PAWSERVATION_CACHE.get(NONCE_KEY(payload.nonce));
  if (!seen) return fail('session', 'nonce_not_found_or_replayed', { tenantId: payload.tenantId });
  await c.env.PAWSERVATION_CACHE.delete(NONCE_KEY(payload.nonce));

  const tenant = await getTenantById(c.env.PAWSERVATION_DB, payload.tenantId);
  if (!tenant) return fail('unavailable', 'tenant_not_found', { tenantId: payload.tenantId });
  // The callback bypasses tenantMiddleware (fixed /oauth path carries no slug), so re-apply the
  // disabled check here: a disabled tenant must not connect a calendar even if start slipped through.
  if (tenant.DisabledAt) return fail('unavailable', 'tenant_disabled', { tenant: tenant.Slug });

  try {
    const tokens = await exchangeCode(c.env, code);
    await setProviderTokens(c.env.PAWSERVATION_DB, tenant.Id, 'calendar', 'google-calendar', {
      access: await encryptToken(c.env.TOKEN_SECRET, tokens.accessToken),
      refresh: await encryptToken(c.env.TOKEN_SECRET, tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      calendarId: 'primary',
    });
  } catch (err) {
    // `exchangeCode` folds Google's own `error`/`error_description` into its message, which is the
    // whole diagnostic: `redirect_uri_mismatch` (the Console entry doesn't match
    // GOOGLE_OAUTH_REDIRECT_URI byte for byte), `invalid_client` (wrong id/secret pair),
    // `invalid_grant` (code already spent or expired). Swallowing it — as this catch used to —
    // left a genuinely broken deployment indistinguishable from a stale cookie.
    return fail('unavailable', 'token_exchange_failed', {
      tenant: tenant.Slug,
      error: String(err),
    });
  }

  // Catch-up: create events for bookings taken before the calendar was connected. Best-effort and
  // never blocks the callback response (waitUntil in production; awaited in tests with no
  // ExecutionContext — same dance as routes/bookings.ts).
  const backfill = backfillCalendarEvents(c.env, tenant).catch((err) => {
    console.error('calendar backfill failed', err);
  });
  try {
    c.executionCtx.waitUntil(backfill);
  } catch {
    await backfill;
  }

  return resultPage(true);
});
