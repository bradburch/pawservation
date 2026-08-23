import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { BRAND_ORIGIN } from '../lib/email';
import { createTestEnv } from './helpers';

const PUBLIC_DIR = join(import.meta.dirname, '..', '..', 'public');
const readPublic = (name: string) => readFileSync(join(PUBLIC_DIR, name), 'utf8');

/** Every path in sitemap.xml, as declared — absolute, so a wrong host fails here too. */
function sitemapLocs(): string[] {
  return [...readPublic('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

describe('SEO surface', () => {
  it('lists only live routes in the sitemap, all under the canonical host', async () => {
    const { env } = createTestEnv();
    const locs = sitemapLocs();
    expect(locs.length).toBeGreaterThan(0);
    for (const loc of locs) {
      expect(loc.startsWith(`${BRAND_ORIGIN}/`), loc).toBe(true);
      // A sitemap entry for a path this worker does not serve is worse than no sitemap: it
      // teaches a crawler that the site 404s.
      const res = await app.request(new URL(loc).pathname, {}, env);
      expect(res.status, loc).toBe(200);
    }
  });

  it('points robots.txt at that sitemap and keeps only the JSON API out', () => {
    const robots = readPublic('robots.txt');
    expect(robots).toContain(`Sitemap: ${BRAND_ORIGIN}/sitemap.xml`);
    expect(robots).toContain('Disallow: /api/');
    // The app surfaces are de-indexed by their own meta tag, which a crawler can only read if it
    // is allowed to fetch the page. Disallowing them here would silently undo that.
    expect(robots).not.toContain('Disallow: /admin');
    expect(robots).not.toContain('Disallow: /setup');
  });

  it('keeps the signed-in-only pages out of search with a noindex they can actually read', () => {
    for (const file of ['admin.html', 'setup.html']) {
      const html = readFileSync(join(PUBLIC_DIR, '..', file), 'utf8');
      expect(html, file).toContain('<meta name="robots" content="noindex" />');
    }
    // The per-tenant widget is the opposite case: it carries LocalBusiness JSON-LD precisely so a
    // crawler reads it, and must never pick up a noindex.
    expect(readFileSync(join(PUBLIC_DIR, '..', 'embed.html'), 'utf8')).not.toContain('noindex');
  });

  it.each([
    ['/', 'Pet Sitting &amp; Dog Walking Software'],
    ['/how-it-works', 'pet sitting &amp; dog walking software'],
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms &amp; Conditions'],
  ])(
    'gives %s a self-referencing canonical, a description, and a findable title',
    async (path, titleFragment) => {
      const { env } = createTestEnv();
      const body = await (await app.request(path, {}, env)).text();
      expect(body).toContain(`<link rel="canonical" href="${BRAND_ORIGIN}${path}" />`);
      expect(body).toMatch(/<meta name="description" content="[^"]{50,}" \/>/);
      expect(body).toContain(`<title>`);
      expect(body).toContain(titleFragment);
      // Social preview: title/description/url must all be present or the card renders blank.
      expect(body).toContain(`<meta property="og:url" content="${BRAND_ORIGIN}${path}" />`);
    },
  );

  it('names the services people search for on the landing page itself', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/', {}, env)).text();
    // A title tag alone does not rank a page it contradicts: the body has to say it too.
    expect(body.toLowerCase()).toContain('dog walking');
    expect(body.toLowerCase()).toContain('pet sitting');
  });
});
