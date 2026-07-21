import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv } from './helpers';

const IMG_DIR = join(import.meta.dirname, '..', '..', 'public', 'img', 'landing');

// Per-file byte budgets from the landing-marketing-redesign spec — the weight budget is a
// failing test, not a convention. Regeneration recipe lives in
// docs/superpowers/specs/2026-07-19-landing-marketing-redesign.md.
const IMG_BUDGETS_KB: Record<string, number> = {
  'widget-hero.webp': 90,
  'step-services.webp': 40,
  'step-calendar.webp': 40,
  'step-request.webp': 40,
  'admin-bookings.webp': 80,
};
const TOTAL_BUDGET_KB = 300;

async function landingBody(): Promise<string> {
  const { env } = createTestEnv();
  const res = await app.request('/', {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

describe('GET / — landing page', () => {
  it('serves an HTML page linking the admin dashboard and the demo', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('href="/admin"');
    expect(body).toContain('href="/demo"');
    expect(body).toContain('Pawservation');
    // Case-sensitive on purpose: no "Pawbook" string should remain anywhere on the landing
    // page, including the repo URLs (swept after the Phase 2 repo rename).
    expect(body).not.toContain('Pawbook');
  });

  it('is script-free (safe under the locked CSP) and refuses framing', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    const body = await res.text();
    expect(body).not.toContain('<script');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('shows the embed snippet as escaped text only', async () => {
    const body = await landingBody();
    expect(body).toContain('&lt;script');
    expect(body).toContain('data-pawservation-tenant');
  });

  it('has a mailto invite link (invite-only story, no signup flow)', async () => {
    const body = await landingBody();
    expect(body).toMatch(/href="mailto:[^"]+"/);
  });

  it('every image is a same-origin landing screenshot with informative alt text', async () => {
    const body = await landingBody();
    const imgTags = body.match(/<img\b[^>]*>/g) ?? [];
    expect(imgTags.length).toBeGreaterThanOrEqual(5);
    for (const tag of imgTags) {
      const src = /src="([^"]+)"/.exec(tag)?.[1];
      const alt = /alt="([^"]*)"/.exec(tag)?.[1];
      expect(src, tag).toMatch(/^\/img\/landing\/[a-z-]+\.webp$/);
      // Informative, not decorative: a real sentence, not "" or "screenshot".
      expect(alt, tag).toBeTruthy();
      expect(alt!.length, tag).toBeGreaterThan(20);
    }
  });

  it('every referenced screenshot exists in public/img/landing under budget (total ≤300KB)', async () => {
    const body = await landingBody();
    const referenced = new Set(
      [...body.matchAll(/src="\/img\/landing\/([^"]+)"/g)].map((m) => m[1]),
    );
    // The page must use exactly the five budgeted shots — no unbudgeted strays.
    expect([...referenced].sort()).toEqual(Object.keys(IMG_BUDGETS_KB).sort());
    let total = 0;
    for (const [file, kb] of Object.entries(IMG_BUDGETS_KB)) {
      const size = statSync(join(IMG_DIR, file)).size; // throws if missing — that IS the test
      total += size;
      expect(size, `${file} over its ${kb}KB budget`).toBeLessThanOrEqual(kb * 1024);
    }
    expect(total, 'total image weight').toBeLessThanOrEqual(TOTAL_BUDGET_KB * 1024);
  });
});
