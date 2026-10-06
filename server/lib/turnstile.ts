import { securityEvent } from './log';

/**
 * Cloudflare Turnstile, verified server-side, on the one public door that can create an
 * allowlist row by itself: POST /signup (routes/signup-page.ts).
 *
 * Configured by two values, both required: `TURNSTILE_SITE_KEY` (public, rendered into the page)
 * and `TURNSTILE_SECRET_KEY` (the Siteverify secret). The posture mirrors email's
 * (`isEmailConfigured`): fully configured → verify every submission; unconfigured in explicit
 * local development (`ENVIRONMENT === 'development'`, which tests also run as) → skip, so a local
 * run needs no widget; unconfigured or HALF-configured anywhere else → 'missing', and the caller
 * answers 503 for every input. A deployment that forgot the secret must not quietly open the
 * door this check guards.
 */
export const TURNSTILE_SCRIPT_ORIGIN = 'https://challenges.cloudflare.com';
const SITEVERIFY_URL = `${TURNSTILE_SCRIPT_ORIGIN}/turnstile/v0/siteverify`;
/** The widget's `data-action`, checked against Siteverify's echo so a token minted for some
 * other form (on any site sharing the widget) cannot be replayed here. */
export const SIGNUP_ACTION = 'signup';
const MAX_TOKEN_LENGTH = 2048;
/** Cloudflare's published dummy secrets: always passes, always fails, token already spent. */
const TEST_SECRETS = new Set([
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
]);

export type TurnstileState = 'on' | 'off-dev' | 'missing';

export function turnstileState(env: Env): TurnstileState {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) return 'on';
  return env.ENVIRONMENT === 'development' ? 'off-dev' : 'missing';
}

/**
 * True only when Siteverify says `success`, for THIS action, on THIS request's own hostname (the
 * page is served by this worker, so the widget's hostname is the request's; the worker answers on
 * several hosts and each must be listed on the widget). Fails closed on everything else: a network
 * error, a non-2xx, an unparseable body. The token and secret never reach a log; the refusal is a
 * `turnstile_rejected` security event carrying Cloudflare's enumerated error codes only.
 */
export async function verifyTurnstile(
  env: Env,
  token: string,
  ctx: { remoteIp: string | undefined; hostname: string },
): Promise<boolean> {
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    securityEvent('turnstile_rejected', { reason: 'malformed_token' });
    return false;
  }
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY ?? '', response: token });
  if (ctx.remoteIp) form.set('remoteip', ctx.remoteIp);
  let result: { success?: unknown; action?: unknown; hostname?: unknown; 'error-codes'?: unknown };
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    result = (await res.json()) as typeof result;
  } catch (err) {
    console.error('turnstile siteverify failed', {
      name: err instanceof Error ? err.name : 'unknown',
      message: err instanceof Error ? err.message.slice(0, 80) : '',
    });
    return false;
  }
  // ponytail: Cloudflare's documented TEST secrets answer with hostname "example.com" and an empty
  // action, so the binding checks below could never pass with them. They are public strings that
  // protect nothing anyway (the always-pass one passes every token), so with one of them `success`
  // alone decides, which is what lets the dev/test keys exercise this path end to end.
  // https://developers.cloudflare.com/turnstile/troubleshooting/testing/
  const testSecret = TEST_SECRETS.has(env.TURNSTILE_SECRET_KEY ?? '');
  if (
    result.success === true &&
    (testSecret || (result.action === SIGNUP_ACTION && result.hostname === ctx.hostname))
  )
    return true;
  const codes = Array.isArray(result['error-codes'])
    ? result['error-codes']
        .filter((c) => typeof c === 'string')
        .join(',')
        .slice(0, 120)
    : '';
  const reason =
    result.success !== true
      ? 'not_success'
      : result.action !== SIGNUP_ACTION
        ? 'action'
        : 'hostname';
  securityEvent('turnstile_rejected', { reason, codes });
  return false;
}
