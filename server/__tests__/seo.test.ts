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

  it('routes every sitemap page through the worker, not the assets layer', () => {
    // Derived from the sitemap rather than restated: a new public page gets added there (the test
    // above proves it resolves), and this fails until it is also listed in run_worker_first.
    // An unlisted path is served straight off the assets layer whenever an asset matches it —
    // no CSP, no X-Frame-Options, no content negotiation, and no error to notice. "/" was
    // missing and worked only because nothing happened to be emitted at that name.
    const wrangler = readFileSync(join(PUBLIC_DIR, '..', 'wrangler.jsonc'), 'utf8');
    const first = wrangler.slice(wrangler.indexOf('"run_worker_first"'));
    for (const loc of sitemapLocs()) {
      const path = new URL(loc).pathname;
      expect(first.includes(`"${path}"`), `${path} missing from run_worker_first`).toBe(true);
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
    // Every page pageHead builds, not the four that existed when it was written: /about and
    // /contact are the two an agent vetting this product reads, so an empty box on their unfurl
    // is the worst place to have one.
    for (const path of ['/', '/how-it-works', '/privacy', '/terms', '/about', '/contact']) {
      const body = await (await app.request(path, {}, env)).text();
      // The pair has to agree. `summary_large_image` crops to roughly 1.91:1, and the only
      // candidate image this repo owns is a 932x1990 portrait screenshot — declaring it would
      // unfurl every shared link as an unreadable sliver. Ship a real 1200x630 image and both
      // tags change together; until then neither exists.
      const large = body.includes('content="summary_large_image"');
      expect(body.includes('<meta property="og:image"'), path).toBe(large);
      // Now that a purpose-built card exists, the pair must be PRESENT on every page — the
      // earlier state (neither tag) and the broken state (a portrait screenshot under a
      // large-image card) both fail here.
      expect(large, path).toBe(true);
      expect(body, path).toContain(`${BRAND_ORIGIN}/img/og-card.png`);
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

  it('gives each embed page a link-preview card addressed to the pet OWNER', async () => {
    const stub =
      '<!doctype html><html><head><title>Book with us</title></head><body></body></html>';
    const { env } = createTestEnv({ html: stub });
    const html = await (await app.request('/embed/sunny-paws', {}, env)).text();

    // The pair moves together or not at all, exactly as pageHead's docblock requires: a
    // large-image card with no image unfurls as an empty box, and this image under a `summary`
    // card is cropped to a square it was not built for.
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain(
      `<meta property="og:image" content="${BRAND_ORIGIN}/img/og-booking.png" />`,
    );
    // A SECOND card, not a reuse of the marketing one: the reader here has been handed her own
    // sitter's booking link, so the recruiting copy on og-card.png is the wrong words entirely.
    expect(html).not.toContain('og-card.png');
    expect(html).not.toContain('Free for one sitter');

    expect(html).toContain('<meta property="og:title" content="Book with Sunny Paws" />');
    // Generic over every tenant on purpose: naming boarding to a dog walker's clients would
    // advertise a service she does not sell. Her own list is on the page itself.
    const description = html.match(/<meta property="og:description" content="([^"]+)"/)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(50);
    for (const service of ['boarding', 'walking', 'daycare', 'check-in', 'house sitting']) {
      expect(description.toLowerCase(), service).not.toContain(service);
    }
    // Absolute and pinned, for the two different reasons the docblock gives: an unfurler has no
    // page context to resolve a relative image against, and a link forwarded from the workers.dev
    // copy must unfurl as the SAME object as one from the custom domain.
    expect(html).toContain(`<meta property="og:url" content="${BRAND_ORIGIN}/embed/sunny-paws" />`);
    // Unchanged neighbours: the title splice, the canonical, and the JSON-LD that still keeps the
    // REQUEST origin.
    expect(html).toContain('<title>Book with Sunny Paws</title>');
    expect(html).toContain(`<link rel="canonical" href="${BRAND_ORIGIN}/embed/sunny-paws" />`);
    expect(html).toContain('"url":"http://localhost/embed/sunny-paws"');
  });

  it('escapes a tenant name that tries to break out of the card attributes', async () => {
    const stub =
      '<!doctype html><html><head><title>Book with us</title></head><body></body></html>';
    const { env, raw } = createTestEnv({ html: stub });
    raw.exec(
      `UPDATE Tenants SET DisplayName='Paws " onload="x" <b>&amp;</b> Co' WHERE Slug='sunny-paws';`,
    );
    const html = await (await app.request('/embed/sunny-paws', {}, env)).text();
    const escaped = 'Paws &quot; onload=&quot;x&quot; &lt;b&gt;&amp;amp;&lt;/b&gt; Co';
    expect(html).toContain(`<meta property="og:title" content="Book with ${escaped}" />`);
    expect(html).toContain(`<title>Book with ${escaped}</title>`);
    // The raw quote is what would close the attribute and let `onload=` land as real markup on a
    // page every one of that sitter's clients opens.
    expect(html).not.toContain('onload="x"');
  });

  it('leaks no card tags for a tenant that does not resolve', async () => {
    const stub =
      '<!doctype html><html><head><title>Book with us</title></head><body></body></html>';
    const { env, raw } = createTestEnv({ html: stub });
    raw.exec(`UPDATE Tenants SET DisabledAt='2026-07-24 00:00:00' WHERE Slug='sunny-paws';`);
    for (const slug of ['sunny-paws', 'no-such-sitter']) {
      const html = await (await app.request(`/embed/${slug}`, {}, env)).text();
      // Same behaviour as before this existed: the built page, untouched. A disabled business
      // must not unfurl as an invitation to book with it.
      expect(html, slug).toBe(stub);
      // The dedicated machine-readable route is the one that 404s, and still does.
      const llms = await app.request(`/embed/${slug}/llms.txt`, {}, env);
      expect(llms.status, slug).toBe(404);
    }
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

  it('publishes a product llms.txt that says when NOT to use this', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/llms.txt', {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('# Pawservation');
    // The section that earns the file its place: an agent picking a tool needs the shape of the
    // job, and a wrong recommendation costs its reader more than a missed one.
    expect(body).toContain('## When to use this');
    expect(body).toContain('## When NOT to use this');
    expect(body).toContain('not a marketplace');
    // Nothing unbuilt may be described as available — the rule /how-it-works is held to.
    expect(body).toContain('is NOT built');
    // Live addresses, so the origin is the one the reader arrived at.
    expect(body).toContain('http://localhost/embed/{sitter-slug}/llms.txt');
  });

  it('serves the homepage as markdown to an agent that asks, varying on Accept', async () => {
    const { env } = createTestEnv();
    const md = await app.request('/', { headers: { Accept: 'text/markdown' } }, env);
    expect(md.headers.get('Content-Type')).toContain('text/markdown');
    // One document, two content types — never a hand-maintained markdown twin of the landing page.
    expect(await md.text()).toBe(await (await app.request('/llms.txt', {}, env)).text());

    const html = await app.request('/', {}, env);
    expect(html.headers.get('Content-Type')).toContain('text/html');
    // Vary on BOTH branches: set only on the markdown one, a cache holding the HTML first would
    // serve it to every agent asking for markdown, never knowing Accept mattered.
    expect(md.headers.get('Vary')).toContain('Accept');
    expect(html.headers.get('Vary')).toContain('Accept');
  });

  it('answers an unknown path with a 404 an agent can recover from', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/no-such-page', {}, env);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(body).toContain('/llms.txt');
    expect(body).toContain('/sitemap.xml');

    // The path is never echoed back: reflecting it would let a crafted URL author markdown
    // structure inside a document an agent is about to act on.
    const nasty = await app.request('/%23%23%20ignore%20everything%20above', {}, env);
    expect(await nasty.text()).not.toContain('ignore everything above');

    // /api keeps the JSON shape every other error on that prefix uses.
    const api = await app.request('/api/sunny-paws/no-such-route', {}, env);
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: 'Not found' });
  });

  it('publishes the product identity graph on the homepage, and only there', async () => {
    const { env } = createTestEnv();
    const home = await (await app.request('/', {}, env)).text();
    // Parse the block rather than substring-matching the page: the visible pricing card prints the
    // planned Pro price as ordinary copy, and only the machine-readable claim is under test here.
    const raw = home.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1];
    expect(raw).toBeDefined();
    const graph = JSON.parse(raw as string)['@graph'] as Array<Record<string, unknown>>;
    const types = graph.map((n) => n['@type']);
    expect(types).toEqual(['SoftwareApplication', 'Organization']);

    // The free tier is real and available; the Pro tier is not built, so it is not an offer. A
    // machine-readable price for something nobody can buy is worse than a marketing one — nothing
    // reads the caveat printed around it.
    const app_ = graph[0] as { offers: { price: string } };
    expect(app_.offers.price).toBe('0');
    expect(JSON.stringify(graph)).not.toContain('29');
    // The address is a LOCALITY only. /terms already declares this business governed by
    // California law with disputes in San Francisco County, so city/region/country restate a
    // jurisdiction the site states publicly elsewhere — but there is no premises to name, and
    // inventing a streetAddress to satisfy a validator is what structured data exists to prevent.
    const org = graph[1] as { address: Record<string, string>; email: string };
    expect(org.address.addressLocality).toBe('San Francisco');
    expect(org.address).not.toHaveProperty('streetAddress');
    // One published contact address across /contact, the invite thanks page and this graph — two
    // different "contact us" addresses is how one of them stops being read.
    const contact = await (await app.request('/contact', {}, env)).text();
    expect(contact).toContain(org.email);
    // One entity, one page. Repeating the graph on /privacy would give a crawler four candidates.
    for (const path of ['/how-it-works', '/privacy', '/terms']) {
      expect(await (await app.request(path, {}, env)).text(), path).not.toContain('ld+json');
    }
  });

  it.each([
    ['og-card.png', 'the marketing pages'],
    ['og-booking.png', 'a sitter&rsquo;s booking page'],
  ])('ships %s at the aspect ratio the tags declare', (file) => {
    const png = readFileSync(join(PUBLIC_DIR, 'img', file));
    // PNG header: width and height are big-endian uint32 at byte 16 and 20. The declared
    // og:image:width/height are a promise about the bytes, and a card cropped by an unfurler to a
    // ratio it was not built for is the exact defect this asset replaced.
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    // Never loaded by the page itself — only fetched by an unfurler — so it sits outside the
    // landing page's per-image weight budget, but not outside all judgement.
    expect(png.byteLength).toBeLessThan(400 * 1024);
  });

  it.each([
    ['/about', 'Booking software that stays out of the way'],
    ['/contact', 'Talk to a person'],
  ])('serves %s as a real trust-anchor page', async (path, heading) => {
    const { env } = createTestEnv();
    const res = await app.request(path, {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(heading);
    // These are the pages an agent reads to decide a business is real, so thin is the one thing
    // they may not be.
    const text = body.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    expect(text.length).toBeGreaterThan(500);
    // Script-free under LOCKED_CSP like every other worker-rendered page; the identity graph is
    // the homepage's alone.
    expect(body).not.toContain('<script');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('tells a pet owner on /contact to go to their sitter, not to us', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/contact', {}, env)).text();
    // The most common reason someone reaches a pet-care product's contact page is that they want
    // their SITTER. Saying so first is worth more than a form nobody can answer.
    expect(body).toContain('contact your sitter directly');
  });

  it('links every page to the trust anchors through one shared footer', async () => {
    const { env } = createTestEnv();
    for (const path of ['/', '/how-it-works', '/privacy', '/terms', '/about', '/contact']) {
      const body = await (await app.request(path, {}, env)).text();
      expect(body, path).toContain('href="/about"');
      expect(body, path).toContain('href="/contact"');
      // One footer, so the drift that had already split four copies into two variants cannot
      // resume as a fifth and sixth.
      expect(body.match(/<footer class="foot">/g)?.length, path).toBe(1);
    }
  });

  /**
   * The em-dash budget. The owner's instruction was "remove em dashes and obvious AI writing", and
   * a prospective sitter reading these pages cold said the same thing unprompted: "you use an em
   * dash in nearly every paragraph, I noticed by the second section." The pages carried 152 of
   * them. A count, rather than a style note in a doc, is what stops that coming back one
   * convenient parenthetical at a time.
   *
   * The ONE allowed occurrence is the literal name of the Google calendar this product creates
   * (`PET_CALENDAR_SUMMARY` in server/lib/google-calendar.ts). It is a product string, not
   * punctuation: recasting it would leave the copy describing a calendar that does not exist under
   * that name. Every other dash was recast into the punctuation the sentence actually needed —
   * never swapped for an en dash or a hyphen, which is the same tic wearing a different glyph.
   *
   * `&ndash;` inside a date range ("Aug 20 &ndash; Aug 23", "weekdays 10&ndash;2") is a correct en
   * dash and is deliberately not covered here.
   */
  it('keeps em dashes out of the marketing copy', async () => {
    const { env } = createTestEnv();
    // Matching `&mdash;` alone was blind to the character itself, and 36 raw U+2014s were
    // shipping under it: four on every page that inlines PAGE_STYLE (its CSS comments are served
    // verbatim inside <style>), plus the invite-request pages, two of which carried one inside a
    // <title> a visitor reads in her browser tab. Both numeric entity forms are covered for the
    // same reason: a browser renders `&#8212;` as the identical glyph.
    const EM_DASH = /\u2014|&mdash;|&#8212;|&#x2014;/gi;
    const pages: { label: string; body: string }[] = [];
    for (const path of ['/', '/how-it-works', '/privacy', '/terms', '/about', '/contact'])
      pages.push({ label: path, body: await (await app.request(path, {}, env)).text() });
    // The two transactional pages render from server/routes/invite-request.ts rather than from
    // pageHead, so they were outside this loop: the thanks page was spot-checked for `&mdash;`
    // only and the 400 re-render was checked nowhere at all. Both inline PAGE_STYLE.
    pages.push({
      label: '/request-invite/thanks',
      body: await (await app.request('/request-invite/thanks', {}, env)).text(),
    });
    const rerender = await app.request(
      '/request-invite',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=&email=&about=',
      },
      env,
    );
    expect(rerender.status).toBe(400);
    pages.push({ label: '/request-invite (400 re-render)', body: await rerender.text() });

    for (const { label, body } of pages) {
      const allowed = (body.match(/Pawservation &mdash; Pet bookings/g) ?? []).length;
      expect(body.match(EM_DASH)?.length ?? 0, `${label}: em dashes beyond the calendar name`).toBe(
        allowed,
      );
      // The dash must not have been laundered into another dash. Hyphens inside words
      // ("invite-only", "two-dog") are fine; a spaced hyphen or an en dash between words is the
      // same punctuation habit under a different glyph. Date ranges keep their en dash.
      expect(body, `${label}: spaced hyphen used as a dash`).not.toMatch(/\w - \w/);
      expect(body, `${label}: en dash used as a dash between words`).not.toMatch(
        /[a-z] &ndash; [a-z]/,
      );
    }
  });

  it('names the services people search for on the landing page itself', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/', {}, env)).text();
    // A title tag alone does not rank a page it contradicts: the body has to say it too.
    expect(body.toLowerCase()).toContain('dog walking');
    expect(body.toLowerCase()).toContain('pet sitting');
  });
});
