import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv } from './helpers';

describe('GET /setup', () => {
  it('serves the built page under LOCKED_CSP (never embeddable)', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/setup?t=whatever', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

// Raw .html bundle paths (as Vite emits them into dist/) must get the exact same LOCKED_CSP /
// X-Frame-Options: DENY treatment as their clean-path equivalents — see server/index.ts and the
// run_worker_first list in wrangler.jsonc. This exercises the worker's own routing + header
// middleware via app.request(), which proves the worker-code side of the fix (the route exists
// and the header middleware applies to it). It does NOT exercise Cloudflare's assets layer or the
// run_worker_first glob matching itself — app.request() calls straight into the Hono app, so a
// request here always reaches the worker regardless of wrangler.jsonc. That the *real* asset
// layer actually hands these paths to the worker first (rather than serving dist/*.html directly,
// unheadered) can only be confirmed against a running `wrangler dev`/deployed instance — verified
// manually via curl for /admin, /admin.html, /demo, /demo.html, /setup, /setup.html, all of which
// returned 200 with Content-Security-Policy: ...frame-ancestors 'none' and X-Frame-Options: DENY.
describe('raw .html bundle paths get the same header treatment as their clean paths', () => {
  const rawPages: Array<[path: string, label: string]> = [
    ['/admin.html', 'admin'],
    ['/demo.html', 'demo'],
    ['/setup.html', 'setup'],
  ];

  for (const [path, label] of rawPages) {
    it(`GET ${path} is worker-routed under LOCKED_CSP (never embeddable)`, async () => {
      const { env } = createTestEnv();
      const res = await app.request(path, {}, env);
      expect(res.status, `${label} raw .html path should not 404`).toBe(200);
      expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    });
  }
});
