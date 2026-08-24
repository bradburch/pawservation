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

  it('points robots.txt at the sitemap and disallows nothing', () => {
    const robots = readPublic('robots.txt');
    expect(robots).toContain(`Sitemap: ${BRAND_ORIGIN}/sitemap.xml`);
    // Every exclusion on this site is a noindex the crawler has to FETCH the resource to read —
    // a meta tag for the app pages, an X-Robots-Tag header for the API. A Disallow directive
    // (matched here as a directive line, not as the word in the prose above it) would stop that
    // fetch and so defeat the very tag it looks like it is reinforcing.
    expect(robots).not.toMatch(/^\s*Disallow:\s*\S/m);
    expect(robots).toMatch(/^User-agent: \*$/m);
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

  it('never declares a large-image card without an image to fill it', async () => {
    const { env } = createTestEnv();
    for (const path of ['/', '/how-it-works', '/privacy', '/terms']) {
      const body = await (await app.request(path, {}, env)).text();
      // The pair has to agree. `summary_large_image` crops to roughly 1.91:1, and the only
      // candidate image this repo owns is a 932x1990 portrait screenshot — declaring it would
      // unfurl every shared link as an unreadable sliver. Ship a real 1200x630 image and both
      // tags change together; until then neither exists.
      const large = body.includes('content="summary_large_image"');
      expect(body.includes('<meta property="og:image"'), path).toBe(large);
    }
  });

  it('keeps the transactional invite pages out of search', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/request-invite/thanks', {}, env)).text();
    expect(body).toContain('<meta name="robots" content="noindex" />');
    // GET /request-invite is a redirect into the homepage form, not a second copy of it.
    const redirect = await app.request('/request-invite', {}, env);
    expect(redirect.status).toBe(302);
  });

  it('pins the built embed title the per-tenant rewrite is anchored on', () => {
    // The rewrite below matches this exact string. If a Vite-side edit changes it the rewrite
    // silently stops firing and every tenant page reverts to the shared generic title — with a
    // green suite, because the rewrite test feeds its own stub HTML. This is the only assertion
    // that reads the real file.
    const embed = readFileSync(join(PUBLIC_DIR, '..', 'embed.html'), 'utf8');
    expect(embed).toContain('<title>Book with us</title>');
  });

  it('gives the demo page the same card the worker-rendered pages get', () => {
    // /demo is in the sitemap and is the landing page's primary CTA, but it is a Vite-built static
    // file that cannot call pageHead — so its head is hand-written and drifts silently.
    const demo = readFileSync(join(PUBLIC_DIR, '..', 'demo.html'), 'utf8');
    expect(demo).toContain('<link rel="canonical" href="https://pawservation.com/demo" />');
    expect(demo).toContain('<meta property="og:url" content="https://pawservation.com/demo" />');
    expect(demo).toContain('og:title');
    expect(demo).toContain('og:description');
    expect(demo.includes('<meta property="og:image"')).toBe(
      demo.includes('content="summary_large_image"'),
    );
  });

  it('titles each embed page with its own business, escaping the name', async () => {
    const { env } = createTestEnv({
      html: '<!doctype html><html><head><title>Book with us</title></head><body></body></html>',
    });
    const plain = await (await app.request('/embed/sunny-paws', {}, env)).text();
    // The built page ships a generic "Book with us" for every tenant — the one string a crawler
    // and a browser tab show, on the page that already carries LocalBusiness JSON-LD.
    expect(plain).toContain('<title>Book with Sunny Paws</title>');
    expect(plain).not.toContain('<title>Book with us</title>');

    // A second env, because the first request cached the tenant row in KV — the rename has to be
    // in place before anything resolves that slug.
    const renamed = createTestEnv({
      html: '<!doctype html><html><head><title>Book with us</title></head><body></body></html>',
    });
    renamed.raw.exec(
      `UPDATE Tenants SET DisplayName='Paws <b>&amp; </b>Co' WHERE Slug='sunny-paws';`,
    );
    const nasty = await (await app.request('/embed/sunny-paws', {}, renamed.env)).text();
    // Tenant-controlled: it may not open a tag or close the title early.
    expect(nasty).toContain('<title>Book with Paws &lt;b&gt;&amp;amp; &lt;/b&gt;Co</title>');
  });

  it('leaves the API crawlable but unindexable, so the embed widget can still render', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/sunny-paws/config', {}, env);
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex');
    // A Disallow instead would stop Googlebot fetching this while rendering /embed/:slug, and
    // app/embed/App.tsx draws `Loading…` until it arrives — so every tenant page would index as
    // that one word. The header must therefore be the ONLY thing keeping the API out of search.
    expect(readPublic('robots.txt')).not.toMatch(/^\s*Disallow:\s*\S/m);
    // A page still gets no such header — that is what makes the distinction load-bearing.
    const page = await app.request('/', {}, env);
    expect(page.headers.get('X-Robots-Tag')).toBeNull();
  });

  it('canonicalises each embed page to the one host it should be found under', async () => {
    const { env } = createTestEnv({
      html: '<!doctype html><html><head><title>Book with us</title></head><body></body></html>',
    });
    const html = await (await app.request('/embed/sunny-paws', {}, env)).text();
    expect(html).toContain(`<link rel="canonical" href="${BRAND_ORIGIN}/embed/sunny-paws" />`);
    // The JSON-LD keeps the REQUEST origin on purpose: it is an address an agent will call, not a
    // statement about which copy to index. The two must not be collapsed into one.
    expect(html).toContain('"url":"http://localhost/embed/sunny-paws"');
  });

  it('names the services people search for on the landing page itself', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/', {}, env)).text();
    // A title tag alone does not rank a page it contradicts: the body has to say it too.
    expect(body.toLowerCase()).toContain('dog walking');
    expect(body.toLowerCase()).toContain('pet sitting');
  });
});
