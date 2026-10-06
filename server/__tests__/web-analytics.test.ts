import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv } from './helpers';

/**
 * Cloudflare Web Analytics on the PUBLIC marketing pages only (founder decision 2026-10-05).
 *
 * Three properties are pinned here, each the failure that would be silent without its test:
 *  - the beacon and the CSP that allows it travel TOGETHER: a beacon under a CSP that refuses it
 *    loads nothing and reports nothing, with no error anywhere a sitter or the owner would see;
 *  - `connect-src` is ONE directive: a browser honours the first of two and ignores the second, so
 *    appending the analytics host beside the premium origin's directive would block the beacon's
 *    report with no error;
 *  - every surface that carries a sitter's or a client's data (the widget, the dashboard, the demo)
 *    is byte-identical whether or not the token is configured.
 */

const TOKEN = '0123456789abcdef0123456789abcdef';
const SCRIPT_HOST = 'https://static.cloudflareinsights.com';
const CONNECT_HOST = 'https://cloudflareinsights.com';

const MARKETING_PATHS = [
  '/',
  '/how-it-works',
  '/getting-started',
  '/about',
  '/contact',
  '/privacy',
  '/terms',
  '/signup',
  '/signup/sent',
];

const DATA_PATHS = ['/embed/sunny-paws', '/admin', '/admin/sunny-paws', '/demo', '/setup'];

function envWith(token: string | undefined, premiumOrigin?: string) {
  const { env } = createTestEnv();
  if (token !== undefined) env.CF_WEB_ANALYTICS_TOKEN = token;
  if (premiumOrigin !== undefined) env.PREMIUM_ORIGIN = premiumOrigin;
  return env;
}

function directives(csp: string | null): string[] {
  return (csp ?? '').split(';').map((d) => d.trim().split(/\s+/)[0]);
}

describe('Cloudflare Web Analytics beacon', () => {
  it.each(MARKETING_PATHS)(
    'renders the beacon on %s when the token is set, under a CSP that allows it',
    async (path) => {
      const env = envWith(TOKEN);
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(
        `<script defer src="${SCRIPT_HOST}/beacon.min.js" data-cf-beacon='{"token":"${TOKEN}"}'></script>`,
      );
      // Exactly one beacon, placed inside the body.
      expect(body.split('beacon.min.js').length - 1).toBe(1);
      expect(body.indexOf('beacon.min.js')).toBeLessThan(body.lastIndexOf('</body>'));
      const csp = res.headers.get('Content-Security-Policy') ?? '';
      // /signup's list also carries Turnstile's host; every other page's carries only the beacon's.
      expect(csp).toMatch(
        /script-src 'self'( https:\/\/challenges\.cloudflare\.com)? https:\/\/static\.cloudflareinsights\.com(;|$)/,
      );
      expect(csp).toContain(`connect-src 'self' ${CONNECT_HOST}`);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    },
  );

  it("adds the beacon as the homepage's ONLY executable script beside its JSON-LD data block", async () => {
    const body = await (await app.request('/', {}, envWith(TOKEN))).text();
    expect(body.match(/<script[^>]*>/g)).toEqual([
      '<script type="application/ld+json">',
      `<script defer src="${SCRIPT_HOST}/beacon.min.js" data-cf-beacon='{"token":"${TOKEN}"}'>`,
    ]);
  });

  it('merges the analytics host into the ONE connect-src the premium origin already needs', async () => {
    const env = envWith(TOKEN, 'https://premium.example');
    const res = await app.request('/', {}, env);
    const csp = res.headers.get('Content-Security-Policy');
    expect(directives(csp).filter((d) => d === 'connect-src')).toHaveLength(1);
    expect(directives(csp).filter((d) => d === 'script-src')).toHaveLength(1);
    expect(csp).toContain(`connect-src 'self' https://premium.example ${CONNECT_HOST}`);
    expect(csp).toContain("frame-src 'self' https://premium.example");
  });

  it.each(MARKETING_PATHS)('renders no beacon on %s when the token is unset', async (path) => {
    const res = await app.request(path, {}, envWith(undefined));
    const body = await res.text();
    expect(body).not.toContain('cloudflareinsights');
    expect(res.headers.get('Content-Security-Policy')).not.toContain('cloudflareinsights');
    // /signup keeps Turnstile's script-src; no other marketing page has one at all.
    if (path !== '/signup') {
      expect(directives(res.headers.get('Content-Security-Policy'))).not.toContain('script-src');
    }
  });

  it.each(['abc', `${TOKEN}"><script>alert(1)</script>`, `${TOKEN}x`, ' ', ''])(
    'renders no beacon and loosens nothing for a malformed token %j',
    async (token) => {
      const res = await app.request('/', {}, envWith(token));
      const body = await res.text();
      expect(body).not.toContain('cloudflareinsights');
      expect(body).not.toContain('alert(1)');
      expect(res.headers.get('Content-Security-Policy')).not.toContain('cloudflareinsights');
    },
  );

  it.each(DATA_PATHS)(
    'leaves %s byte-identical (body and headers) whether or not the token is set',
    async (path) => {
      for (const premium of [undefined, 'https://premium.example']) {
        const without = await app.request(path, {}, envWith(undefined, premium));
        const withToken = await app.request(path, {}, envWith(TOKEN, premium));
        expect(withToken.status).toBe(without.status);
        expect(withToken.headers.get('Content-Security-Policy')).toBe(
          without.headers.get('Content-Security-Policy'),
        );
        const body = await withToken.text();
        expect(body).toBe(await without.text());
        expect(body).not.toContain('cloudflareinsights');
      }
    },
  );

  it('renders no beacon on the markdown representation of the homepage', async () => {
    const res = await app.request('/', { headers: { Accept: 'text/markdown' } }, envWith(TOKEN));
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(await res.text()).not.toContain('cloudflareinsights');
  });

  it('renders no beacon on a POST /signup response, which echoes the typed email', async () => {
    const res = await app.request(
      '/signup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'not-an-email' }).toString(),
      },
      envWith(TOKEN),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('cloudflareinsights');
    expect(res.headers.get('Content-Security-Policy')).not.toContain('cloudflareinsights');
  });

  it('merges the beacon into the ONE script-src /signup already has for Turnstile', async () => {
    const env = envWith(TOKEN, 'https://premium.example');
    env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
    const res = await app.request('/signup', {}, env);
    const body = await res.text();
    expect(body).toContain('class="cf-turnstile"');
    expect(body).toContain('beacon.min.js');
    const csp = res.headers.get('Content-Security-Policy');
    expect(directives(csp).filter((d) => d === 'script-src')).toHaveLength(1);
    expect(directives(csp).filter((d) => d === 'connect-src')).toHaveLength(1);
    expect(directives(csp).filter((d) => d === 'frame-src')).toHaveLength(1);
    expect(csp).toContain(`script-src 'self' https://challenges.cloudflare.com ${SCRIPT_HOST}`);
    expect(csp).toContain(`connect-src 'self' https://premium.example ${CONNECT_HOST}`);
    expect(csp).toContain(
      "frame-src 'self' https://challenges.cloudflare.com https://premium.example",
    );
  });

  it('leaves the Turnstile allowance on /signup exactly as it was when the token is unset', async () => {
    const env = envWith(undefined);
    const res = await app.request('/signup', {}, env);
    expect(res.headers.get('Content-Security-Policy')).toContain(
      "script-src 'self' https://challenges.cloudflare.com;",
    );
    expect(res.headers.get('Content-Security-Policy')).not.toContain('cloudflareinsights');
  });
});
