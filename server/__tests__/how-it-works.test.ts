import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv } from './helpers';

async function howItWorksBody(): Promise<string> {
  const { env } = createTestEnv();
  const res = await app.request('/how-it-works', {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

describe('GET /how-it-works — the in-depth tour page', () => {
  it('serves an HTML page', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/how-it-works', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('How it works');
    expect(body).toContain('Pawservation');
    // Case-sensitive: the pre-rebrand name must not reappear on a new marketing page.
    expect(body).not.toContain('Pawbook');
  });

  it('is script-free and served under the locked CSP (no framing)', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/how-it-works', {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The embed snippet is displayed as escaped text, so the served body has no real script tag.
    expect(body).not.toContain('<script');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('shows the embed snippet as escaped text only', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('&lt;script');
    expect(body).toContain('data-pawservation-tenant');
    // The iframe fallback for hosts that strip scripts is escaped the same way.
    expect(body).toContain('&lt;iframe');
  });

  it('covers the five service templates with their billing units', async () => {
    const body = await howItWorksBody();
    for (const label of ['Boarding', 'House sitting', 'Day care', 'Walks', 'Check-ins']) {
      expect(body, label).toContain(label);
    }
    for (const unit of ['per night', 'per day', 'per visit']) {
      expect(body, unit).toContain(unit);
    }
  });

  it('states the confirm-first promise and server-computed pricing', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('pending until you confirm');
    expect(body).toContain('never processes');
  });

  it('is truthful about multi-pet pricing — not yet available, never auto-multiplied', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('being built');
    expect(body).toContain('never auto-multiplied');
  });

  it('never claims an unbuilt capability as available', async () => {
    const body = await howItWorksBody();
    // Forbidden nouns: nothing on this page may promise invoicing, AI, or SMS features.
    for (const banned of [/\bAI\b/, /invoice/i, /statement/i, /\bSMS\b/, /text message/i]) {
      expect(body, String(banned)).not.toMatch(banned);
    }
  });

  it('links back to the landing sections, the demo, and pricing', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('href="/#pricing"');
    expect(body).toContain('href="/#faq"');
    expect(body).toContain('href="/demo"');
    expect(body).toContain('href="/admin"');
  });

  it('carries no images (no new weight budget to police)', async () => {
    const body = await howItWorksBody();
    expect(body).not.toContain('<img');
  });
});

describe('the landing page points at /how-it-works', () => {
  it('links the tour from the nav and the footer', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    const body = await res.text();
    expect(body).toContain('href="/how-it-works"');
    // Nav link + footer Product column entry.
    expect(body.match(/href="\/how-it-works"/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
