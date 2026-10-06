import type { Context } from 'hono';
import type { AppEnv } from '../types';

/**
 * Cloudflare Web Analytics on the PUBLIC marketing pages, and nowhere else (founder decision
 * 2026-10-05, reversing the earlier "no analytics anywhere" stance so the owner can see which
 * outreach brings visitors). Cookieless, no fingerprinting, served by the platform this worker
 * already runs on.
 *
 * NOT on the booking widget (`/embed/*`, which runs inside sitters' own sites and shows their
 * clients' data), the dashboard, the demo, or any signed-in page — none of those routes ever calls
 * `marketingHtml`, and the CSP below is loosened only for a response that did.
 *
 * The beacon and the CSP that admits it are ONE decision: `marketingHtml` both injects the tag and
 * sets the `webAnalytics` context flag the header middleware in `server/index.ts` reads. A beacon
 * under a CSP that refuses it loads nothing and reports nothing, with no error anybody would see;
 * a CSP loosened on a page without a beacon is a hole with no purpose. Neither can happen alone.
 *
 * The token is published in the page by design (it identifies the site, it authorises nothing),
 * but it is still interpolated into an attribute, so it must have the exact shape Cloudflare issues
 * — 32 hex characters — or no beacon is rendered at all. Unset (local dev, tests, a fork) renders
 * nothing, so those stay script-free.
 */

export const WEB_ANALYTICS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
export const WEB_ANALYTICS_CONNECT_ORIGIN = 'https://cloudflareinsights.com';

const TOKEN_RE = /^[0-9a-f]{32}$/i;

function webAnalyticsToken(env: Env): string | null {
  const token = env.CF_WEB_ANALYTICS_TOKEN;
  return typeof token === 'string' && TOKEN_RE.test(token) ? token : null;
}

/** Serve a marketing page: with the beacon (and the CSP flag) when a valid token is configured,
 * byte-identical to the plain page when it is not. */
export function marketingHtml(c: Context<AppEnv>, html: string) {
  const token = webAnalyticsToken(c.env);
  const end = html.lastIndexOf('</body>');
  if (!token || end === -1) return c.html(html);
  c.set('webAnalytics', true);
  const beacon = `<script defer src="${WEB_ANALYTICS_SCRIPT_ORIGIN}/beacon.min.js" data-cf-beacon='{"token":"${token}"}'></script>\n  `;
  return c.html(html.slice(0, end) + beacon + html.slice(end));
}
