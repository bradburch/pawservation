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
    // The owner repriced on 2026-09-04: the Status section states both tiers, and the two limits
    // above are scoped to Solo rather than to the product.
    expect(body).toContain('Solo is $15 per sitter per month and starts with a 30-day free trial');
    expect(body).toContain('Pro is $29 per sitter per month, or $290 per sitter per year');
    expect(body).toContain('Staffing a team on Solo');
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
    // Parse the block rather than substring-matching the page: the visible pricing card prints both
    // prices as ordinary copy, and only the machine-readable claim is under test here.
    const raw = home.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1];
    expect(raw).toBeDefined();
    const graph = JSON.parse(raw as string)['@graph'] as Array<Record<string, unknown>>;
    const types = graph.map((n) => n['@type']);
    expect(types).toEqual(['SoftwareApplication', 'Organization']);

    // The owner repriced on 2026-09-04: both tiers are sold, so both are offers. A graph that
    // published one price while the page printed two would be a machine-readable claim nothing
    // reads the surrounding copy for.
    const app_ = graph[0] as {
      offers: Array<{
        name: string;
        price: string;
        priceCurrency: string;
        priceSpecification: { price: string; referenceQuantity: Record<string, unknown> };
      }>;
    };
    expect(app_.offers.map((o) => [o.name, o.price, o.priceCurrency])).toEqual([
      ['Solo', '15', 'USD'],
      ['Pro', '29', 'USD'],
    ]);
    // …and each price says what period it is FOR. A bare `price` is a number with no unit, so a
    // reader comparing $29 against a yearly figure elsewhere has nothing in the data to tell it
    // these are months. 'MON' is UN/CEFACT for a month, the vocabulary referenceQuantity expects.
    for (const offer of app_.offers) {
      expect(offer.priceSpecification.referenceQuantity).toEqual({
        '@type': 'QuantitativeValue',
        value: 1,
        unitCode: 'MON',
      });
      expect(offer.priceSpecification.price).toBe(offer.price);
    }
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
    // The owner moved /about to a first-person founder story on 2026-09-09; the landing page's
    // product voice is unchanged, and this is the one page that speaks as "I".
    [
      '/about',
      'I&rsquo;m a dog walker and pet sitter, and I built this for my own business first.',
    ],
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

  /**
   * 2026-09-09: the owner narrowed /about to two things, why this exists and who made it, and
   * took the product off it. "Four rules the software will not break" MOVED to /how-it-works,
   * where how-it-works.test.ts pins all four; the plans block was deleted outright because the
   * landing page's #pricing section and the product llms.txt already state those numbers, and a
   * fourth surface stating them is a fourth chance for two of them to disagree. What is pinned
   * here is the narrowing: the founder story is the page, and neither the prices nor the rules
   * may drift back onto it without the surfaces that own them being touched too.
   */
  it('keeps /about to the creator, with no plans, prices or product rules on it', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/about', {}, env)).text();
    // The three things the owner supplied, and the whole of what the page may claim about him.
    // The intro is first-name-only from 2026-09-10 on the owner's instruction ("remove my last
    // name from the intro"). The full name is untouched everywhere it is ATTRIBUTION rather than
    // introduction: the photo's alt text, this page's meta description, the shared footer's
    // "Created by", and the homepage JSON-LD's founder. Pinned on the surviving text, so the
    // sentence cannot quietly grow a surname back or lose the introduction altogether.
    expect(body).toContain('I&rsquo;m Brad.');
    expect(body).toContain('Brad Burch with a small black dog');
    expect(body).toContain('https://bradpaws.com/');
    expect(body).toContain('Did I pay you for last week?');
    expect(body).not.toMatch(/\$\d/);
    expect(body).not.toContain('per sitter per month');
    expect(body).not.toContain('free trial');
    expect(body).not.toContain('Four rules the software will not break');
  });

  /**
   * /about's three composition rules, and the proof they cannot reach another page.
   *
   * The page is one column of prose with no second column anywhere in its markup, and every
   * default it inherits was measured for a page that HAS one: the shared `.hero h1` caps at 15ch
   * so a hero-visual can sit beside it, and `.feature h2` is 0.98rem because a `.section-head`
   * h2 normally sits above it. On /about those two produced a four-line headline in a 540px
   * gutter with the right half of the wrap empty, and a section heading that read as a bold
   * label; the founder grid's 200px photo column left a 232px hole under the picture beside
   * prose capped at 52ch. All three were measured in a real browser on 2026-09-10.
   *
   * Each override is scoped through markup only /about carries, which is the half of this test
   * that matters: `.hero-flush` (the hero class and its adjacent sibling, the pattern already
   * used to close this page's hero padding) and `.founder`. A future tidy-up that widened any of
   * these to `.hero h1`, `.feature h2` or `.legal` would silently re-scale the landing page's
   * cards and the three other prose pages, which no test on those pages would catch, because
   * they assert on markup and this is a stylesheet. So both halves are pinned together: the
   * rules exist, AND no page but /about carries anything they can match.
   */
  it("scopes /about's composition overrides to /about", async () => {
    const { env } = createTestEnv();
    const about = await (await app.request('/about', {}, env)).text();
    // 1. The headline uses the width it is standing in instead of a 15ch column with an empty
    //    half beside it.
    expect(about).toContain('.hero-flush h1 {');
    expect(about).toContain('max-width: none;');
    // 2. "Why I built it" is this page's only heading, at the size a section heading is
    //    everywhere else here rather than at the 0.98rem label size the prose pages want.
    expect(about).toContain('.hero-flush + .section .feature h2 {');
    // 3. The portrait moved into the width the 52ch prose leaves over, which closed the hole
    //    under it. Both the placement and the breakpoint it happens at are load-bearing.
    expect(about).toContain('@media (min-width: 920px) {');
    expect(about).toContain('.founder-photo { grid-column: 2; grid-row: 1; width: 100%; }');
    // The base .feature h2 size the other prose pages and the landing cards read at survives.
    expect(about).toContain('font-size: 0.98rem;');
    // The scoping proof. Every selector above needs `.hero-flush` or `.founder` in the markup,
    // and only /about has either, so the rules are unreachable from the other five pages even
    // though the stylesheet is inlined into all of them.
    for (const path of ['/', '/how-it-works', '/privacy', '/terms', '/contact']) {
      const body = await (await app.request(path, {}, env)).text();
      const markup = body.replace(/<style>[\s\S]*?<\/style>/g, '');
      const classes = new Set(
        [...markup.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)),
      );
      expect(
        [...classes].filter((c) => c === 'hero-flush' || c.startsWith('founder')),
        path,
      ).toEqual([]);
    }
  });

  /**
   * 2026-09-09, the same narrowing one step further: the page is the REASON the product exists,
   * so it does not also recruit. The founder story's closing paragraph asked sitters to try it
   * "while it's still early", which is the landing page's invite form stated a second time on the
   * page a reader reaches for who is behind this. Deleting it also took this page's only
   * statements that the product is small and independent and that questions reach a person;
   * /contact makes both in its own words, and the second assertion here is what stops the pair
   * from being lost outright rather than merely moved. The closing demo/tour line stays: it is
   * wayfinding for a reader who has finished the page.
   */
  it('keeps /about off recruiting, and leaves the trust claims standing on /contact', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/about', {}, env)).text();
    for (const pitch of [
      'looking for a handful of pet sitters',
      'help me work out what to improve',
      'The invite list is short',
      'there is no sales team to get past',
    ])
      expect(body, pitch).not.toContain(pitch);
    // The one client-question line is a list of TYPES of question, so it may not put a count on
    // them: there were not exactly three, and three is only how many are quoted.
    expect(body).toContain('I kept getting questions like:');
    expect(body).not.toContain('the same three');
    // Wayfinding survives the cut.
    expect(body).toContain('href="/demo"');
    expect(body).toContain('href="/how-it-works"');
    // The claims the deletion carried off, still made where they were always also made.
    const contact = await (await app.request('/contact', {}, env)).text();
    expect(contact).toContain('no sales team');
    expect(contact).toContain('messages reach the person who builds it');
  });

  it('tells a pet owner on /contact to go to their sitter, not to us', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/contact', {}, env)).text();
    // The most common reason someone reaches a pet-care product's contact page is that they want
    // their SITTER. Saying so first is worth more than a form nobody can answer.
    expect(body).toContain('contact your sitter directly');
  });

  /**
   * The owner asked for /about in the header on 2026-09-09 ("the about page should be part of the
   * header links"). It goes in the .nav-links row and NOT in .nav-right, because .nav-right is
   * where that row's links are duplicated for the widths .nav-links is hidden at, and /about is
   * already in the shared footer's Company block at every width. A copy in both rows would print
   * the link twice on one screen, which is the exact thing the "Full tour" pair is arranged to
   * avoid.
   */
  it('puts /about in the landing header without printing it twice', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/', {}, env)).text();
    const nav = body.slice(body.indexOf('<header class="nav">'), body.indexOf('</header>'));
    expect(nav).toContain('<a href="/about">About</a>');
    expect(nav.match(/href="\/about"/g)?.length).toBe(1);
    // The row carrying five links is the one the measured breakpoints in PAGE_STYLE are cut for.
    expect(nav).toContain('class="nav-links nav-links-5"');
  });

  /**
   * Heading levels, on every worker-served page at once.
   *
   * /about, /contact, /privacy and /terms all went h1 straight to h3: their prose blocks are
   * `.feature`s, and `.feature` was a landing-page CARD component, where h3 is right because a
   * `.section-head` h2 sits above it. On a page with no `.section-head` there is no h2, so a
   * screen reader hears "heading level 3" with nothing at level 2 to hang it on, on the four pages
   * a wary reader or an agent opens to decide whether this is a real business.
   *
   * The fix was the LEVEL and not the look: PAGE_STYLE lists `.feature h2` beside `.feature h3` so
   * those headings keep their 0.98rem size rather than inheriting `.section h2`'s clamp(). This
   * test is why the two halves cannot drift apart again, and it is deliberately a sweep rather
   * than four assertions, so a page added later is covered the day it is added.
   */
  it('never skips a heading level on any page', async () => {
    const { env } = createTestEnv();
    for (const path of [
      '/',
      '/how-it-works',
      '/about',
      '/contact',
      '/privacy',
      '/terms',
      '/request-invite/thanks',
    ]) {
      const body = await (await app.request(path, {}, env)).text();
      const levels = [...body.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
      expect(levels[0], `${path} must open at h1`).toBe(1);
      expect(levels.filter((l) => l === 1).length, `${path} h1 count`).toBe(1);
      let deepest = 0;
      for (const level of levels) {
        expect(
          level,
          `${path} jumps to h${level} with no h${level - 1} above it`,
        ).toBeLessThanOrEqual(deepest + 1);
        deepest = Math.max(deepest, level);
      }
    }
  });

  /**
   * The header is ONE row at every width, and all three five-link rows say so the same way.
   *
   * /how-it-works carries five section anchors plus "Sign in" plus the demo button, which needs
   * 782px of content box: it wrapped onto a second line from 780px (where `.nav-links` appears at
   * all) to 829px, measured in a real browser. `.nav-links-5` is the tuning that already existed
   * for the landing's five-link row — 4px off each gap, and the plain sign-in link dropped below
   * 890px — and it is exactly the 80px that band was short by. /about joined this pair on
   * 2026-09-10 with the landing's own five links (How it works, Dashboard, Pricing, Full tour,
   * About) and the same "Sign in" + "Try the demo" shape /how-it-works carries, so it needs the
   * identical tuning for the identical reason. Pinned on all three rows together, because the
   * failure mode is one of them being edited and the others left behind.
   */
  it('gives all three five-link headers the row tuning cut for five links', async () => {
    const { env } = createTestEnv();
    for (const path of ['/', '/how-it-works', '/about']) {
      const body = await (await app.request(path, {}, env)).text();
      const nav = body.slice(body.indexOf('<header class="nav">'), body.indexOf('</header>'));
      expect(nav, path).toContain('class="nav-links nav-links-5"');
      expect(nav.match(/<a href="#|<a href="\//g)?.length, path).toBeGreaterThan(0);
      // Five links in the row is what the breakpoints are measured against. A sixth needs new
      // measurements, not a sixth <a>.
      const row = nav.slice(nav.indexOf('nav-links-5'), nav.indexOf('</nav>'));
      expect(row.match(/<a /g)?.length, `${path} link count`).toBe(5);
    }
  });

  /**
   * Three rules in the shared stylesheet whose absence is INVISIBLE in review and only shows up
   * to a keyboard user, on a dark band, or in a browser's default palette. Each was a live defect
   * measured in a real browser on 2026-09-09; each is one declaration, which is exactly the kind
   * of line a tidy-up deletes. Asserting on the served CSS is the only reach a unit test has here,
   * since these pages carry no script and the stylesheet is inlined into every one of them.
   */
  it('keeps the three shared-stylesheet rules whose absence is invisible', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/', {}, env)).text();
    // 1. The focus ring is --green, which is 1.83:1 against the CTA panel's dark gradient and
    //    reads as no ring at all. The panel holds the invite form's submit button.
    expect(body).toContain('.cta-panel :focus-visible { outline-color: #fff; }');
    // 2. A <button> inherits neither font-family nor line-height from body, and the invite form's
    //    submit is the one .btn on this site that is not an <a>. Without these it rendered in
    //    Arial at 39px beside a 46px .btn-inverse doing the same job on /how-it-works.
    expect(body).toContain('font-family: inherit;');
    expect(body).toContain('line-height: inherit;');
    // 3. Body links in the prose pages. Until /about and /contact existed, every link on this
    //    site sat in a .note, a button, the nav or the footer, so running copy had no link style
    //    and ten links rendered in the browser default #0000EE.
    expect(body).toContain('.legal p a,');
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
