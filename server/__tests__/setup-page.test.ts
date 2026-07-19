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
