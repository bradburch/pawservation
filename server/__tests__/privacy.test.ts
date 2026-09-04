import { describe, expect, it } from 'vitest';
import app from '../index';
import { SUPPORT_EMAIL } from '../lib/email';
import { createTestEnv } from './helpers';

describe('GET /privacy', () => {
  it('serves an HTML page under the locked CSP, script-free', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/privacy', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const body = await res.text();
    expect(body).not.toContain('<script');
    expect(body).toContain('Privacy Policy');
    expect(body).toContain('Pawservation');
  });

  it('covers what data is collected, third parties, cookies, retention, children, tracking, and location', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/privacy', {}, env);
    const body = await res.text();
    expect(body).toMatch(/never collect card numbers/i);
    expect(body).toContain('Resend');
    expect(body).toContain('Google');
    expect(body).toContain('Cloudflare');
    expect(body).toMatch(/one cookie/i);
    expect(body).not.toMatch(/we use cookies to (track|personalize)/i);
    expect(body).toMatch(/not directed at children/i);
    expect(body).toMatch(/no (analytics|tracking|ad pixels|fingerprinting)/i);
    // The published address is SUPPORT_EMAIL, the one constant /contact and the Organization
    // graph already state; the page no longer hardcodes a second copy of it.
    expect(body).toContain(SUPPORT_EMAIL);
  });
});
