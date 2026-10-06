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
    expect(body).toMatch(/never collect or store card numbers/i);
    expect(body).toContain('Resend');
    expect(body).toContain('Google');
    expect(body).toContain('Cloudflare');
    expect(body).toMatch(/one cookie/i);
    expect(body).not.toMatch(/we use cookies to (track|personalize)/i);
    expect(body).toMatch(/not directed at children/i);
    expect(body).toMatch(/no ad pixels/i);
    // The published address is SUPPORT_EMAIL, the one constant /contact and the Organization
    // graph already state; the page no longer hardcodes a second copy of it.
    expect(body).toContain(SUPPORT_EMAIL);
  });

  it('names every processor the code calls, and what each one sees', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/privacy', {}, env)).text();
    for (const name of ['Cloudflare', 'Resend', 'Google', 'Stripe', 'Anthropic', 'Meta']) {
      expect(body).toContain(`<strong>${name}</strong>`);
    }
    expect(body).toMatch(/Turnstile on the sign-up page/);
    expect(body).toMatch(/under the sitter&rsquo;s own Stripe account/);
    expect(body).toMatch(/sent to Anthropic&rsquo;s model/);
    expect(body).toMatch(/only if a sitter on Pro connects WhatsApp/);
    // The payment methods a sitter logs match the tour's list.
    expect(body).toContain('(cash, Venmo, Zelle, PayPal, check or card)');
  });

  it('says exactly what is measured, where, and that a sign-up records its source', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/privacy', {}, env)).text();
    // The old absolute claims are gone: they stopped being true on 2026-10-05.
    expect(body).not.toMatch(/we run no analytics/i);
    expect(body).not.toMatch(/blocks third-party scripts from loading at all/i);
    expect(body).not.toContain('<h2>No tracking</h2>');
    // Sign-up is self-serve now; the copy (not the shared nav's `#invite-h` anchor) says so.
    const main = body.slice(body.indexOf('<main>'), body.indexOf('</main>'));
    expect(main.replace(/#invite-h/g, '')).not.toMatch(/invite/i);
    expect(body).toContain('<h2>What we measure</h2>');
    expect(body).toContain('Cloudflare Web Analytics');
    expect(body).toMatch(/sets no cookies/i);
    expect(body).toMatch(/does not fingerprint you/i);
    expect(body).toMatch(
      /never on a sitter&rsquo;s booking page, the booking widget, the dashboard, or any page you sign in to/i,
    );
    expect(body).toMatch(/only third-party scripts our security policy lets any of our pages load/);
    expect(body).toMatch(/When a sitter signs up, we also record where the sign-up came from/);
    expect(body).toMatch(/only the site, such as reddit\.com, never the page/);
  });
});
