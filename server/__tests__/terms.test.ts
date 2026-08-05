import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv } from './helpers';

describe('GET /terms', () => {
  it('serves an HTML page under the locked CSP, script-free', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/terms', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const body = await res.text();
    expect(body).not.toContain('<script');
    expect(body).toContain('Terms');
    expect(body).toContain('Pawservation');
  });

  it('states the platform is a booking tool, not a payment processor or party to the sitting arrangement', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/terms', {}, env);
    const body = await res.text();
    expect(body).toMatch(/not a payment processor/i);
    expect(body).toMatch(/not a party to/i);
    expect(body).toContain('California');
    expect(body).toContain('San Francisco');
  });
});
