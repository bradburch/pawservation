import { Hono } from 'hono';
import { listServiceOptions, listServices } from './db/repo';
import { runCalendarSweep } from './lib/calendar-cron';
import { BRAND_ORIGIN, htmlEscape, SUPPORT_EMAIL } from './lib/email';
import {
  buildJsonLdScript,
  buildLlmsTxt,
  buildProductJsonLdScript,
  buildProductLlmsTxt,
} from './lib/llms';
import { renderInviteForm } from './lib/invite-form';
import { requestContext } from './lib/log';
import { tenantMiddleware } from './lib/middleware';
import { PAGE_STYLE } from './lib/page-style';
import { PRICING } from './lib/plan-pricing';
import { premiumOrigin } from './lib/premium';
import { resolveTenant } from './lib/tenant-resolve';
import { accountsRoutes } from './routes/accounts';
import { adminRoutes } from './routes/admin';
import { adminAuthRoutes } from './routes/admin-auth';
import { authRoutes } from './routes/auth';
import { billingRoutes } from './routes/billing';
import { bookingRoutes } from './routes/bookings';
import { inviteRequestRoutes } from './routes/invite-request';
import { oauthRoutes } from './routes/oauth';
import { ownerRoutes } from './routes/owner';
import { passwordResetRoutes } from './routes/password-reset';
import { publicRoutes } from './routes/public';
import { signupRoutes } from './routes/signup';
import { tenantTokenRoutes } from './routes/tenant-tokens';
import { tokenRoutes } from './routes/tokens';
import type { AppEnv, Tenant } from './types';

/**
 * Embed routes must be framable by ANY host page (Wix/Squarespace/etc.), so they omit
 * X-Frame-Options and frame-ancestors entirely; clickjacking is mitigated in-widget via
 * explicit confirm steps. Everything else (admin, demo, API) refuses framing outright.
 */
const EMBEDDABLE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";
const LOCKED_CSP = `${EMBEDDABLE_CSP}; frame-ancestors 'none'`;

const app = new Hono<AppEnv>();

// Known publicly-shipped/placeholder secrets that must never sign real tokens — anyone with the
// repo knows them, so reusing one in production makes every session token forgeable. New setups
// generate a random secret (`openssl rand -base64 32`) for dev too, so no fixed string can leak.
// (Short placeholders like "change-me" are already caught by the length floor below.)
const KNOWN_INSECURE_SECRETS = new Set([
  'embed-proto-dev-secret-not-for-production',
  'local-dev-secret-change-me',
]);
const MIN_TOKEN_SECRET_LENGTH = 16;

function isInsecureTokenSecret(secret: string | undefined): boolean {
  return !secret || secret.length < MIN_TOKEN_SECRET_LENGTH || KNOWN_INSECURE_SECRETS.has(secret);
}

app.use('*', async (c, next) => {
  if (isInsecureTokenSecret(c.env.TOKEN_SECRET)) {
    return c.json({ error: 'Server misconfigured: TOKEN_SECRET is missing or insecure.' }, 503);
  }
  return next();
});

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (c.req.path.startsWith('/api/')) {
    // Keep raw JSON out of the search index — the same "noindex, never Disallow" rule
    // public/robots.txt applies to the signed-in pages, reaching JSON the only way it can. A
    // Disallow here would ALSO stop Googlebot fetching /api/:slug/config while rendering
    // /embed/:slug, and that page is a client-rendered widget: app/embed/App.tsx returns
    // `Loading…` until config arrives, so every tenant's booking page would index as that one
    // word. The header suppresses the API's own URLs without touching the render.
    c.header('X-Robots-Tag', 'noindex');
  }
  // Both policies frame exactly one thing — whatever premium surface this deployment configures,
  // if any — and nothing else, so the allowance is the configured origin itself, never '*'. Unset
  // (a fork, a self-hoster, no PREMIUM_ORIGIN) leaves either policy with no frame-src at all, i.e.
  // the page frames nothing, exactly as before this existed. The dashboard frames it from the
  // Services section (`app/admin/sections/ServicesSection.tsx`); the widget frames it from the
  // signed-in bookings view (`app/embed/MineTab.tsx`), and without this directive the frame is
  // blocked by `default-src 'self'` before it loads — silently, since the mount takes no space
  // until the page reports a height.
  const origin = premiumOrigin(c.env);
  const frameSrc = origin ? `; frame-src 'self' ${origin}` : '';
  if (c.req.path.startsWith('/embed')) {
    c.header('Content-Security-Policy', `${EMBEDDABLE_CSP}${frameSrc}`);
  } else {
    // AND `connect-src` here, for the same origin and in the same breath, because the dashboard
    // does not only FRAME that surface: the plan panel POSTs to it for a checkout session and for a
    // billing portal session (`app/admin/PlanPanel.tsx`). With no `connect-src` the policy falls
    // back to `default-src 'self'` and the browser blocks both requests before they leave the page
    // — on any deployment whose paid surface is on a different host. The commercial deployment
    // happens to publish the dashboard's own origin, which is the only reason nothing noticed.
    // The widget gets no `connect-src`: nothing in it fetches that origin.
    const csp = origin ? `${LOCKED_CSP}${frameSrc}; connect-src 'self' ${origin}` : LOCKED_CSP;
    c.header('Content-Security-Policy', csp);
    c.header('X-Frame-Options', 'DENY');
  }
});

// Registered ONCE here — sub-apps must not re-register it, and merged sub-app middleware
// is path-scoped tightly (Hono flattens .use() patterns across every app mounted at /api).
app.use('/api/:slug/*', tenantMiddleware);

app.route('/api', adminAuthRoutes); // /api/admin/login, /api/admin/session (no slug)
app.route('/api', publicRoutes);
app.route('/api', authRoutes);
app.route('/api', bookingRoutes);
app.route('/api', tokenRoutes); // /api/:slug/tokens — the customer's own API credentials
// BEFORE adminRoutes, and that is not cosmetic. `adminRoutes` does .use('/:slug/admin/*', adminAuth)
// and Hono FLATTENS .use() patterns across every app mounted at the same base, so
// /api/:slug/admin/billing/events is inside that pattern. Handlers compose in registration order and
// a .post() that returns a Response ends the chain — so registering billing first is what keeps a
// shared-secret request from being 401'd by a session gate it carries no session for. Moving this
// line below the next one is caught by the mount-order test in
// server/__tests__/billing-endpoint.test.ts.
app.route('/api', billingRoutes); // /api/:slug/admin/billing/events — shared-secret, no session
app.route('/api', adminRoutes);
app.route('/api', accountsRoutes);
app.route('/api', tenantTokenRoutes); // /api/:slug/admin/tokens — the sitter's own API credentials
app.route('/api', signupRoutes); // /api/signup/* — no slug ('signup' is a reserved slug)
app.route('/api', passwordResetRoutes); // /api/password-reset/* — no slug ('password-reset' is a reserved slug)
app.route('/api', ownerRoutes); // /api/owner/* — owner-token-gated ('owner' is a reserved slug)
app.route('/', oauthRoutes); // global OAuth callback — no slug, no tenant middleware
app.route('/', inviteRequestRoutes); // GET/POST /request-invite* — a page, not an /api route

/** Serve a built Vite page for a worker-routed path, with mutable headers. */
const page = (asset: string) =>
  async function servePage(c: { env: Env; req: { url: string } }) {
    const res = await c.env.ASSETS.fetch(new URL(`/${asset}`, c.req.url));
    return new Response(res.body, res);
  };

app.get('/embed/:slug/llms.txt', async (c) => {
  const tenant = await resolveTenant(c.req.param('slug'), c.env);
  if (!tenant || tenant.DisabledAt) return c.text('Not found', 404);
  const [services, options] = await Promise.all([
    listServices(c.env.PAWSERVATION_DB, tenant.Id),
    listServiceOptions(c.env.PAWSERVATION_DB, tenant.Id),
  ]);
  return c.text(buildLlmsTxt(tenant, services, options, new URL(c.req.url).origin));
});

/**
 * The link-preview card for ONE sitter's booking page.
 *
 * A sitter texts her clients this URL, and until this existed the page declared no card tags at
 * all: iMessage, Slack and WhatsApp fell back to the site favicon and no title, so the single most
 * shared link this product has unfurled as a bare icon. The marketing pages get theirs from
 * `pageHead`; this page cannot use it, because its head is a Vite-built file spliced at request
 * time and because two of its four strings are per-tenant.
 *
 * The AUDIENCE is what separates this from `pageHead`'s card, and it is why the image is a second
 * file rather than a reuse of `og-card.png`: the reader here is a pet owner who has been handed her
 * own sitter's booking link, not a sitter being recruited, so "Pet sitting & dog walking software"
 * and a monthly price per sitter are the wrong words on the wrong screen. `public/img/og-booking.png` is
 * the brand lockup and one owner-facing line, nothing else. Same rule as `pageHead`'s: the image
 * and `summary_large_image` move together or not at all.
 *
 * `og:description` is a LITERAL, deliberately generic over every tenant: a sitter's own service
 * list is right there on the page, and a card that named boarding to a dog walker's clients would
 * advertise something she does not sell. `og:title` interpolates `DisplayName`, which is
 * tenant-controlled text landing inside an attribute value, so it goes through the same
 * `htmlEscape` the `<title>` splice above uses.
 *
 * ORIGINS. `og:image` is absolute and pinned to `BRAND_ORIGIN` because an unfurler is a third
 * party with no page context to resolve a relative path against, and because the card is ONE asset
 * on ONE host regardless of which host served the page. `og:url` is pinned there too, for exactly
 * the reason the canonical beside it is: og:url is the canonical URL of the *shared object*, so a
 * link forwarded from the workers.dev copy and one from the custom domain must unfurl as the same
 * object rather than two. That is the opposite answer from the JSON-LD below, and deliberately so:
 * its `url` is a live address an agent will call, and must keep working for whichever host the
 * request arrived on.
 */
function embedCardTags(tenant: Tenant): string {
  const name = htmlEscape(tenant.DisplayName);
  const url = `${BRAND_ORIGIN}/embed/${encodeURIComponent(tenant.Slug)}`;
  const description =
    'Check your sitter&rsquo;s availability, pick your dates and your pets, and send a booking request.';
  return `<meta property="og:type" content="website" />
    <meta property="og:site_name" content="Pawservation" />
    <meta property="og:title" content="Book with ${name}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${BRAND_ORIGIN}/img/og-booking.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Pawservation: your sitter&rsquo;s booking page" />
    <meta name="twitter:card" content="summary_large_image" />`;
}

// Wraps the built embed.html with per-tenant LocalBusiness JSON-LD for crawlers/agents. Buffers
// the (few-KB) HTML and does a plain string replace rather than HTMLRewriter: HTMLRewriter is a
// Workers-runtime global that doesn't exist in the Node-based Vitest harness. Unknown/disabled
// tenants still get the page (just without JSON-LD) — only the dedicated llms.txt route 404s.
app.get('/embed/:slug', async (c) => {
  const res = await c.env.ASSETS.fetch(new URL('/embed.html', c.req.url));
  const tenant = await resolveTenant(c.req.param('slug'), c.env).catch(() => null);
  if (!tenant || tenant.DisabledAt) return new Response(res.body, res);
  const html = await res.text();
  const ldScript = buildJsonLdScript(tenant, new URL(c.req.url).origin);
  // The built embed.html ships the generic `Book with us`, so every tenant's page carried the same
  // title — the one string a crawler or a browser tab shows, on the one page that already goes out
  // of its way to be machine-readable (JSON-LD above, llms.txt beside it). DisplayName is
  // tenant-controlled, so it is HTML-escaped; the replace is anchored on the exact built title, so
  // a Vite build that changes it leaves the generic one standing rather than corrupting the head.
  const titled = html.replace(
    '<title>Book with us</title>',
    () => `<title>Book with ${htmlEscape(tenant.DisplayName)}</title>`,
  );
  // Same multi-host dedup `pageHead` explains, and this page needs it MORE than the marketing
  // pages do: nothing disallows the workers.dev copy, so a crawler that finds one indexes a second
  // copy of the tenant's page. Pinned to BRAND_ORIGIN, while the JSON-LD above deliberately keeps
  // the REQUEST origin — the two answer different questions. Canonical says which copy to index;
  // the JSON-LD `url` (like llms.txt's endpoints) is a live address an agent will actually call,
  // and must keep working for whichever host it arrived on.
  const canonical = `<link rel="canonical" href="${BRAND_ORIGIN}/embed/${encodeURIComponent(tenant.Slug)}" />`;
  return new Response(
    titled.replace('</head>', () => `${canonical}${embedCardTags(tenant)}${ldScript}</head>`),
    res,
  );
});
app.get('/admin', page('admin.html')); // login landing — the dashboard learns its slug from the session
app.get('/admin/:slug', page('admin.html')); // deep link still works; auth drives the rest
app.get('/demo', page('demo.html'));
app.get('/setup', page('setup.html')); // create-password page for emailed signup links

// Raw bundle filenames (as Vite emits them into dist/) must also be worker-routed — the admin
// session token lives in localStorage and auto-restores, so an un-headered /admin.html would let
// any host page iframe a live authenticated dashboard (clickjacking); same exposure for the
// credential-setting /setup.html?t=... link. Mirrored in wrangler.jsonc's run_worker_first list —
// a path missing from BOTH bypasses the worker entirely via the assets layer, with no CSP/DENY.
app.get('/admin.html', page('admin.html'));
app.get('/demo.html', page('demo.html'));
app.get('/setup.html', page('setup.html'));

/**
 * The shared page footer. Extracted when /about and /contact would have made it a SIXTH hand-kept
 * copy of the same markup — the four that existed had already drifted into two variants that
 * differed only in one link's label and one anchor's href, which is the drift a fifth and sixth
 * copy guarantees rather than risks. Every link here is absolute (`/#pricing`, not `#pricing`) so
 * one version serves every page: from the landing itself an absolute same-page hash still just
 * scrolls.
 */
function pageFooter(): string {
  return `<footer class="foot">
      <div class="wrap">
        <div class="foot-grid">
          <div class="foot-brand">
            <a class="logo" href="/">
              <img src="/brand/calendar.svg" width="30" height="28" alt="" />
              Pawservation
            </a>
            <p>Booking software for pet sitters and dog walkers, embedded on your own website.</p>
          </div>
          <div>
            <h3>Product</h3>
            <ul>
              <li><a href="/demo">Try the demo</a></li>
              <li><a href="/admin">Sitter sign in</a></li>
              <li><a href="/how-it-works">Full tour</a></li>
              <li><a href="/getting-started">Setup guide</a></li>
              <li><a href="/#pricing">Pricing</a></li>
            </ul>
          </div>
          <div>
            <h3>Company</h3>
            <ul>
              <li><a href="/about">About</a></li>
              <li><a href="/contact">Contact</a></li>
            </ul>
          </div>
          <div>
            <h3>Legal</h3>
            <ul>
              <li><a href="/privacy">Privacy</a></li>
              <li><a href="/terms">Terms</a></li>
            </ul>
          </div>
        </div>
        <div class="foot-bottom">
          <p>
            Created by <a href="https://bradburch.github.io/">Brad Burch</a>
          </p>
        </div>
      </div>
    </footer>`;
}

/**
 * The <head> tags every worker-served marketing page shares, so a page's own file carries only
 * what differs: its title and its one-sentence description.
 *
 * `rel="canonical"` is ABSOLUTE and pinned to BRAND_ORIGIN on purpose. This worker answers on
 * several hosts (the pawservation.com custom domain, workers.dev under `workers_dev: true`, and a
 * fresh preview URL per `wrangler versions upload`), and without a canonical a crawler indexes the
 * same page once per host and splits its ranking across the copies. Same reasoning as
 * `callbackUriFor`'s, arriving at the opposite answer: OAuth needs the host the request actually
 * came in on, search needs the one host the page should be found under.
 *
 * Title and description are the two strings a search result is BUILT from, so they carry the words
 * a sitter actually types ("pet sitting software", "dog walking") rather than the in-house framing
 * ("booking for pet-sitting businesses") the body copy used to carry alone. Both are literals here,
 * never interpolated from anything a tenant controls — these pages have no tenant.
 *
 * NOT emitted here: the homepage's JSON-LD, which is spliced into LANDING_HTML alone. It answers
 * "what is this product and who stands behind it", a question only the homepage is the answer to —
 * repeating an identity graph on /privacy would give a crawler four competing candidates for one
 * entity. It is an inert `application/ld+json` DATA block, which is why it survives LOCKED_CSP: the
 * type is not a script type, so it never executes and CSP never evaluates it — the same exemption
 * the embed page's LocalBusiness block already relies on. The marketing pages stay free of
 * EXECUTABLE script, which is what that rule was always protecting; `landing.test.ts` pins the
 * distinction rather than the substring.
 *
 * `og:image` is a PURPOSE-BUILT 1200x630 PNG (`public/img/og-card.png`), not a screenshot. The
 * branch that added these tags first pointed at `widget-hero.webp` — 932x1990, a portrait strip —
 * under `summary_large_image`, which crops to roughly 1.91:1 and would have unfurled every shared
 * link as an unreadable sliver of a calendar. The image and the card type move TOGETHER or not at
 * all, which a test pins: a large-image card with no image, or this image under a `summary` card,
 * are both wrong. PNG rather than WebP because not every unfurler accepts WebP, and the file is
 * never loaded by the page itself — only fetched by an unfurler — so it sits outside the landing
 * page's weight budget. Regenerate it with the recipe in `docs/og-card.md`.
 *
 * It is the card for THESE pages only. `/embed/:slug` carries its own (`embedCardTags`, above)
 * against `public/img/og-booking.png`, because a pet owner handed her sitter's booking link is not
 * a sitter being recruited, and this card's words are addressed to the sitter.
 */
function pageHead(path: string, title: string, description: string): string {
  return `<title>${title}</title>
    <meta name="description" content="${description}" />
    <link rel="canonical" href="${BRAND_ORIGIN}${path}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Pawservation" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:url" content="${BRAND_ORIGIN}${path}" />
    <meta property="og:image" content="${BRAND_ORIGIN}/img/og-card.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="Pawservation: pet sitting and dog walking software" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`;
}

/**
 * Root landing page: a marketing page for prospective pet sitters, built around real
 * screenshots of the seeded demo (public/img/landing/*.webp). Static and script-free (served
 * under LOCKED_CSP, so only inline styles and same-origin images are allowed — NO <script>,
 * no external fonts/CSS/images), so it needs no build step. There is no interactivity at all.
 * The embed snippet below is shown as escaped text (&lt;script&gt;…) so the served body
 * genuinely contains no <script tag. Screenshot regeneration recipe (fixed 2028 seed months):
 * docs/superpowers/specs/2026-07-19-landing-marketing-redesign.md.
 */
const LANDING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/',
      'Pet Sitting &amp; Dog Walking Software | Pawservation',
      `Booking software for pet sitters and dog walkers, from $${PRICING.soloMonthly} a month, that answers your clients&rsquo; routine questions so you can spend your day on the pets. Clients book on your own website or from a link you send them, so no website is needed, and on Pro they can book by WhatsApp. You confirm every booking.`,
    )}
    ${buildProductJsonLdScript(BRAND_ORIGIN)}
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <img src="/brand/calendar.svg" width="30" height="28" alt="" />
          Pawservation
        </a>
        <nav class="nav-links nav-links-5" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#dashboard">Dashboard</a>
          <a href="#pricing">Pricing</a>
          <a href="/how-it-works">Full tour</a>
          <a href="/about">About</a>
        </nav>
        <div class="nav-right">
          <!-- About joined the .nav-links row above and is deliberately NOT repeated here: it
               is in the shared footer's Company block, so it stays reachable below 780px without
               this row printing it a second time. Adding a fifth link did move one breakpoint;
               see .nav-links-5 in PAGE_STYLE.
               .nav-links is display:none below 780px, which left the tour reachable only from
               the footer on a phone. This copy sits OUTSIDE that row and shows only where the
               row is hidden, so the link exists at every width and is never printed twice. The
               two plain links beside it drop out at the same width, which is what keeps the
               header to three items on a phone: sign-in is in the hero note and the footer, and
               the demo is the hero's own second button. -->
          <a class="signin nav-tour" href="/how-it-works">Full tour</a>
          <a class="signin nav-signin" href="/admin">Sign in</a>
          <a class="signin" href="/demo">Try the demo</a>
          <a class="btn btn-primary btn-sm" href="#invite-h">Sign up</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap hero-grid">
          <div class="hero-copy">
            <!-- The chip is the price, not the category: the h1 and the sub below already say
                 what this is, and a shopper arrives holding an incumbent's monthly figure. The
                 words are the pricing section's own heading, so the hero and section five cannot
                 drift apart, and every figure comes from PRICING rather than the markup. -->
            <p class="chip">$${PRICING.soloMonthly} a month for one sitter. ${PRICING.trialDays}-day free trial.</p>
            <h1>Less time answering texts. More time with the pets.</h1>
            <p class="sub">
              Pawservation is pet sitting and dog walking software. Your booking page answers the
              questions clients ask you all day, like which days you&rsquo;re free and what a stay
              costs, and on Pro a friendly assistant answers the rest, from moving a date to what
              they owe. You still confirm every booking, so the relationship stays yours.
            </p>
            <div class="cta-row">
              <a class="btn btn-primary" href="#invite-h">Sign up</a>
              <a class="btn btn-ghost" href="/demo">Try the demo</a>
            </div>
            <p class="note">
              The demo is there so you can poke around without signing up for anything.
              Pawservation itself is invite-only while it grows, and you can
              <a href="/admin">sign in</a> if you already have an account.
            </p>
          </div>
          <div class="hero-visual">
            <!-- Screenshots are captured from the seeded demo (fixed 2028 months, never
                 "today"). Regenerate via the recipe in
                 docs/superpowers/specs/2026-07-19-landing-marketing-redesign.md whenever the
                 widget's look changes. -->
            <div class="visual-panel">
              <div class="screen">
                <img
                  src="/img/landing/widget-hero.webp"
                  alt="The Pawservation booking widget: a June calendar with a three-night boarding stay selected and a $150 quote"
                />
              </div>
              <div class="screen-fade" aria-hidden="true"></div>
              <div class="req-card" aria-hidden="true">
                <span class="req-label">New request</span><br />
                <span class="req-what">Boarding &middot; 3 nights &middot; $150</span>
                <div class="req-btns">
                  <span class="req-yes">Confirm</span>
                  <span class="req-no">Decline</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Who it is for, said once and plainly: one sitter or walker with a regular book of about
           ten to twenty clients. Each card is something that sitter does today by text and what
           changes, with no figure the product cannot back. A band, so the sections below keep
           alternating. -->
      <section class="section band" id="fit" aria-labelledby="fit-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Is this for you?</span>
            <h2 id="fit-h">Made for a sitter with ten to twenty regular clients</h2>
            <p>If you walk dogs or pet sit on your own, and most of your week is the same households asking the same questions, this is for you.</p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>&ldquo;Are you free the weekend of the 14th?&rdquo;</h3>
              <p>Your clients see your open days for themselves, so the question never has to reach you.</p>
            </div>
            <div class="feature">
              <h3>&ldquo;What would it be for both dogs?&rdquo;</h3>
              <p>The price appears as they pick dates and pets, at the rates you set. A combination you haven&rsquo;t priced is never guessed at.</p>
            </div>
            <div class="feature">
              <h3>&ldquo;Did I pay you for last week?&rdquo;</h3>
              <p>Every household has one running balance, so you both see the same answer without scrolling back through texts.</p>
            </div>
          </div>
        </div>
      </section>

      <!-- Two first-class paths, not a website and a footnote: the booking page on her own site,
           and no website at all. The link is the /embed/:slug page itself, the one og-booking.png
           exists to unfurl when she texts it to a client. WhatsApp is the Pro half of the
           no-website path, and the card says so. -->
      <section class="section" id="ways" aria-labelledby="ways-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Website or not</span>
            <h2 id="ways-h">Your clients book wherever they find you</h2>
            <p>Put your booking page on your website, or skip the website. You don&rsquo;t need one, or any tech at all.</p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>On your own website</h3>
              <p>Paste <a href="#install">one line</a> into Squarespace, Wix or whatever you already use, and your booking page appears there under your name.</p>
            </div>
            <div class="feature">
              <h3>No website needed</h3>
              <p>You get a booking page of your own at a link you can text or email to clients. They open it and book, and there is nothing to build or host.</p>
            </div>
            <div class="feature">
              <h3>By WhatsApp, on Pro</h3>
              <p>Clients just message your WhatsApp number. The assistant answers, takes the request, and sends it to you to confirm.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="how" aria-labelledby="how-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">How it works</span>
            <h2 id="how-h">Your clients book in three steps</h2>
            <p>Your clients pick from the services you offer, on the days you can take them, and you have the final say on every request.</p>
          </div>
          <ol class="steps">
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-services.webp"
                  alt="The widget's service picker: Boarding selected from a row of services including House sitting, Daycare, Walk, Check-in, and Morning walk"
                />
              </div>
              <div class="step-body">
                <span class="step-no">01</span>
                <h3>They pick a service</h3>
                <p>They choose from the services you set up, under your own names and your own prices.</p>
              </div>
            </li>
            <li class="step-card">
              <div class="frame frame-tall">
                <img
                  src="/img/landing/step-calendar.webp"
                  alt="Month grid where full days are struck through and the weekends of a weekday-only service are struck through as unavailable"
                />
              </div>
              <div class="step-body">
                <span class="step-no">02</span>
                <h3>They pick the dates</h3>
                <p>The calendar shows the days you can take, counting the pets they picked, or a visit time for walks and drop-ins.</p>
              </div>
            </li>
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-request.webp"
                  alt="Booking summary showing the selected dates, an estimated cost of $150, and a Request Booking button"
                />
              </div>
              <div class="step-body">
                <span class="step-no">03</span>
                <h3>They send the request, you confirm it</h3>
                <p>The request reaches you with the dates, the pets and a price on it, and nothing is booked until you say so.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <!-- The relationship section: one booking read from the client's side. It was the ninth
           FAQ answer for two rounds, which is the last place a reader looking for "what is this
           like for my clients" would find it. It ran as a two-column "what they see / what you do"
           grid until the owner cut it on 2026-09-09 for reading as filler. What is here is that
           cut copy's own sentences, unchanged, re-laid as the .features cards #dashboard already
           uses: the section had shrunk to a .section-head alone, which is a centred 60ch intro
           block, so it read narrow and half-height beside its neighbours. The fix was the layout
           and NOT the word count, and no claim was added to fill the row. Everything the page says
           about a client changing or cancelling their own booking still lives HERE and nowhere
           else, so the rule is read once, whole, rather than three times in fragments. -->
      <section class="section" id="clients" aria-labelledby="clients-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">You and your clients</span>
            <h2 id="clients-h">Your clients see what you see</h2>
            <p>
              Your clients see which dates you have open and what the stay costs before they ask for it.
            </p>
          </div>
          <!-- .features-3 rather than bare .features: three cards in the grid's 640-959px
               two-column band leave the third alone with an empty cell beside it. See PAGE_STYLE;
               it reflows one-or-three like the .steps row further up this same page. -->
          <div class="features features-3">
            <div class="feature">
              <h3>Pending until you confirm</h3>
              <p>Every request waits as pending until you confirm it, and their screen says so.</p>
            </div>
            <div class="feature">
              <h3>Changes and cancellations</h3>
              <p>When they need to change dates or cancel they do it on the page, and your own cancellation policy sets the fee, so nobody has to raise it in a text.</p>
            </div>
            <div class="feature">
              <h3>Updates stay yours</h3>
              <p>What they send you now is about the dog. Pawservation doesn&rsquo;t do visit reports or photos, so that part of the relationship stays yours.</p>
            </div>
          </div>
          <div class="cta-row mid-cta">
            <a class="btn btn-primary" href="#invite-h">Sign up</a>
            <a class="btn btn-ghost" href="/demo">Try the demo</a>
          </div>
        </div>
      </section>

      <section class="section band" id="dashboard" aria-labelledby="dash-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Your dashboard</span>
            <h2 id="dash-h">Your bookings and your money in one place</h2>
            <p>You collect the money however you already do, and Pawservation keeps the count.</p>
          </div>
          <!-- Coded mock of the dashboard's bookings queue (not a screenshot): stays
               crisp at any scale and inherits the page palette. role="img" so assistive
               tech reads it as one illustration, not fake buttons. -->
          <div
            class="mockdash"
            role="img"
            aria-label="The sitter dashboard's bookings list: two pending requests with Confirm and Decline buttons, and a confirmed booking with a Payments button"
          >
            <div class="mockdash-top">
              <span class="mockdash-title">Bookings</span>
              <span class="mockdash-count">2 pending</span>
              <span class="mockdash-when">August 2028</span>
            </div>
            <div class="mock-row">
              <div class="mock-info">
                <div class="mock-who">Jess D. &middot; Boarding</div>
                <div class="mock-meta">Aug 20 &ndash; Aug 23 &middot; 1 pet &middot; $150</div>
              </div>
              <span class="state state-pend">Pending</span>
              <div class="mock-actions">
                <span class="mbtn mbtn-primary">Confirm</span>
                <span class="mbtn mbtn-line">Decline</span>
              </div>
            </div>
            <div class="mock-row">
              <div class="mock-info">
                <div class="mock-who">Priya S. &middot; Morning walk</div>
                <div class="mock-meta">Aug 10, 9:00 AM &middot; 1 pet &middot; $20</div>
              </div>
              <span class="state state-pend">Pending</span>
              <div class="mock-actions">
                <span class="mbtn mbtn-primary">Confirm</span>
                <span class="mbtn mbtn-line">Decline</span>
              </div>
            </div>
            <div class="mock-row">
              <div class="mock-info">
                <div class="mock-who">Marco T. &middot; Daycare</div>
                <div class="mock-meta">Aug 8 &middot; 2 pets &middot; $70 &middot; paid in full</div>
              </div>
              <span class="state state-ok">Confirmed</span>
              <div class="mock-actions">
                <span class="mbtn mbtn-line">Payments</span>
              </div>
            </div>
          </div>
          <!-- Four short cards on one row. The grid is .features-4 rather than .features
               because the three-column default left the fourth card orphaned on a row of its own. -->
          <div class="features features-4">
            <div class="feature">
              <h3>Services and rates</h3>
              <p>Boarding, house sitting, daycare, walks and check-ins, or a service you invent, at your own prices.</p>
            </div>
            <div class="feature">
              <h3>Clients and pets</h3>
              <p>Invite clients by email or import the list you already have, and keep care notes on each animal.</p>
            </div>
            <div class="feature">
              <h3>Payments and what you&rsquo;re owed</h3>
              <p>Log cash, Venmo, Zelle, PayPal or a check, and each client&rsquo;s balance updates itself. Upload the CSV from Venmo and a month of payments matches up at once.</p>
            </div>
            <div class="feature">
              <h3>Google Calendar</h3>
              <p>Connect it once and your bookings turn up on the calendar you already keep, or skip it and everything else works the same.</p>
            </div>
          </div>
          <div class="cta-row mid-cta">
            <a class="btn btn-primary" href="#invite-h">Sign up</a>
            <a class="btn btn-ghost" href="/demo">Try the demo</a>
          </div>
        </div>
      </section>

      <!-- What Pro adds, as cards ahead of the prices. The assistant leads: it answers the routine
           questions so the sitter is not answering them all day, and it never replaces her, since
           every request still waits for her tap. Card payments are a card here and a bullet on the
           price card, not the headline. Three cards on .features-3 for the reflow #clients uses.
           The section is plain and #pricing below it is a band, so the page keeps alternating;
           #install flipped to plain for the same reason. What these cards claim is the whole of
           each integration: nothing about photos, reminders or the sitter chatting back, and no
           number handed to her by us. -->
      <section class="section" id="pro" aria-labelledby="pro-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Pro</span>
            <h2 id="pro-h">A friendly assistant, and you still decide</h2>
            <p>
              On Pro, a booking assistant answers your clients in the chat on your booking page and
              on your own WhatsApp number. It handles the routine questions and leaves every booking
              for you to confirm with a tap.
            </p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>Booking by WhatsApp</h3>
              <p>Clients message your own WhatsApp number to book, get a quote, reschedule or cancel. Each new request reaches you as a WhatsApp alert with Confirm and Decline buttons, and your client hears the answer.</p>
            </div>
            <div class="feature">
              <h3>The same assistant on your booking page</h3>
              <p>The chat on your booking page is the same assistant, with your rates, your rules and your open dates, so clients get the same answers wherever they ask.</p>
            </div>
            <div class="feature">
              <h3>Card payments through your own Stripe account</h3>
              <p>Take deposits, let clients save a card, and have the balance charged after each stay. You pay Stripe&rsquo;s published rate and no fee to Pawservation.</p>
            </div>
          </div>
          <div class="cta-row mid-cta">
            <a class="btn btn-primary" href="#invite-h">Sign up</a>
            <a class="btn btn-ghost" href="#pricing">See Pro pricing</a>
          </div>
        </div>
      </section>

      <section class="section band" id="pricing" aria-labelledby="pricing-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Pricing</span>
            <h2 id="pricing-h">$${PRICING.soloMonthly} a month for one sitter</h2>
            <p>
              Pro adds a booking assistant in your page&rsquo;s chat and on WhatsApp, card
              payments through your own Stripe account and extra sitters, for
              $${PRICING.proMonthly} per sitter per month or $${PRICING.proAnnual} a year.
            </p>
          </div>
          <div class="price-grid">
            <div class="price-card">
              <div class="price-head">
                <h3>Solo</h3>
              </div>
              <p class="price-amt">
                <span class="price-num">$${PRICING.soloMonthly}</span>
                <span class="price-per">for one sitter</span>
              </p>
              <ul class="price-list">
                <li>Booking page on your own site, unlimited bookings</li>
                <li>Your availability rules, applied for you</li>
                <li>How much notice you need, and how far ahead people can book</li>
                <li>Rates, payments and one running balance per household</li>
                <li>Cancellation policies, applied for you</li>
                <li>Clients reschedule and cancel their own bookings</li>
                <li>Client accounts and pet records</li>
                <li>Google Calendar sync, both directions</li>
              </ul>
              <a class="btn btn-primary" href="#invite-h">Sign up</a>
              <p class="note">The first ${PRICING.trialDays} days are free. New sitters are added by hand for now, so ask and we&rsquo;ll email you a sign-up link.</p>
            </div>
            <div class="price-card">
              <div class="price-head">
                <h3>Pro</h3>
              </div>
              <p class="price-amt">
                <span class="price-num">$${PRICING.proMonthly}</span>
                <span class="price-per">per sitter, per month</span>
              </p>
              <ul class="price-list">
                <li>Everything in Solo</li>
                <li>Booking by WhatsApp: clients book, get quotes, reschedule and cancel by messaging your own number, and you confirm or decline each new request from a WhatsApp alert</li>
                <li>A booking assistant in your page&rsquo;s chat: clients check availability, get a quote and book</li>
                <li>Connect an AI assistant such as Claude to check availability and book for you</li>
                <li>Back-office assistant: ask who owes you and what your week looks like</li>
                <li>Card payments through your own Stripe account: deposits, saved cards, and the balance charged after each stay, at Stripe&rsquo;s published rate with no fee from Pawservation</li>
                <li>Extra sitters, with assignment</li>
              </ul>
              <a class="btn btn-primary" href="#invite-h">Sign up</a>
              <p class="note">$${PRICING.proMonthly} per sitter per month, or $${PRICING.proAnnual} per sitter per year, which is $${PRICING.proMonthly * 12 - PRICING.proAnnual} less than paying by the month.</p>
            </div>
          </div>
          <p class="note wf-more">
            <a href="#invite-h">Sign up</a> and we&rsquo;ll get you started.
          </p>
        </div>
      </section>

      <section class="section" id="install" aria-labelledby="install-h">
        <div class="wrap install-grid">
          <div class="install-copy">
            <span class="label">Install</span>
            <h2 id="install-h">One line on any website</h2>
            <p>Paste it into Squarespace, Wix or whatever you already use, swap in your business&rsquo;s short name, and save. It sizes itself to fit the page.</p>
            <p>It is safe on a public page, because only your clients can book. Anyone else gets a welcome under your name and a sign-in box.</p>
            <p>Forward this box to whoever edits your site. No site? Skip this step and send clients your booking link instead.</p>
          </div>
          <div class="codecard">
            <div class="codecard-cap">
              <span>your-page.html</span>
              <span>paste &amp; save</span>
            </div>
            <div class="code-scroll">
<pre><span class="tag">&lt;script</span> <span class="attr">src</span>=&quot;https://your-site/embed.js&quot;
        <span class="attr">data-pawservation-tenant</span>=&quot;your-slug&quot;
        <span class="attr">data-height</span>=&quot;520&quot;<span class="tag">&gt;&lt;/script&gt;</span></pre>
            </div>
          </div>
        </div>
      </section>

      <section class="cta-band" aria-labelledby="invite-h">
        <div class="wrap">
          <div class="cta-panel">
            <h2 id="invite-h">Sign up</h2>
            <p>Pawservation is invite-only while it grows, so new sitters are added by hand. Tell us about your business and we&rsquo;ll email you a sign-up link, then help you set up your services, rates, and booking page.</p>
            ${renderInviteForm()}
          </div>
        </div>
      </section>
    </main>

    ${pageFooter()}
  </body>
</html>
`;

/**
 * The tour at /how-it-works — the page the landing links to when someone wants the whole picture
 * before asking for an invite. Same constraints as the landing: served under LOCKED_CSP, so it is
 * script-free and styled only by the shared PAGE_STYLE. The embed snippet is shown as escaped
 * text (&lt;script&gt;), and the three screenshots are the landing page's own, already budgeted.
 *
 * Rewritten as marketing copy on 2026-09-04 on the owner's instruction: the page had grown into a
 * 4,100-word specification full of "we do X, we do not do Y" asides, and the three things a sitter
 * is deciding about (her clients request on her own website, she confirms or declines, she takes
 * time off from her own calendar) were buried in it. What survives from the old page is every
 * claim's TRUTH, not its length.
 *
 * Every claim here is behavior that ships today. Guardrails are enforced by
 * server/__tests__/how-it-works.test.ts rather than by convention: the page may not use the words
 * "invoice"/"statement"/"SMS"/"AI" (none of those exist), may not claim a repeating schedule, an
 * automatic export or an import path, and may not carry the pre-0005 pricing absolutes ("nothing
 * is multiplied, ever"), which stopped being true the day PetRateMode shipped. The developer nouns
 * "idempotency"/"machine-readable"/"llms.txt" stay out of the body copy; the concepts live in the
 * language a pet sitter uses.
 */
const HOW_IT_WORKS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/how-it-works',
      'How it works | Pawservation pet sitting &amp; dog walking software',
      'How Pawservation works for pet sitters and dog walkers: your clients check your open dates, get a price and book on your website, from a link you send or on Pro by WhatsApp, and you confirm every booking from your phone.',
    )}
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <img src="/brand/calendar.svg" width="30" height="28" alt="" />
          Pawservation
        </a>
        <!-- .nav-links-5: this row carries five links and the same right-hand pair the landing
             does, and it wrapped onto a second line from 780px to 829px. The class is the row
             tuning that already exists for a five-link header rather than a second copy of it;
             its measurements are in PAGE_STYLE. -->
        <nav class="nav-links nav-links-5" aria-label="Sections">
          <a href="#booking">Requests</a>
          <a href="#confirm">Confirming</a>
          <a href="#calendar">Calendar</a>
          <a href="#services">Services</a>
          <a href="#setup">Setup</a>
        </nav>
        <div class="nav-right">
          <a class="signin" href="/admin">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/demo">Try the demo</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap">
          <p class="chip">How Pawservation works</p>
          <h1>Fewer texts to answer, and every client still yours</h1>
          <p class="sub">
            Your clients see your open dates, get a price, and change or cancel their own bookings
            without waiting on you. They book on your own website, from a link you send them, or on
            Pro by messaging your WhatsApp number. You confirm every booking, so
            the relationship stays yours.
          </p>
          <div class="cta-row">
            <a class="btn btn-primary" href="/#invite-h">Sign up</a>
            <a class="btn btn-ghost" href="/demo">Try the demo</a>
          </div>
          <p class="note">
            The demo is a made-up sitter&rsquo;s account, so there is nothing to sign up for and
            nothing you can break.
          </p>
        </div>
      </section>

      <section class="section band" id="booking" aria-labelledby="booking-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">For your clients</span>
            <h2 id="booking-h">Your clients book wherever they find you</h2>
            <p>
              You don&rsquo;t need a website. Your booking page can sit on the site you already
              have, or live at a link of its own.
              Only clients you have added can book. Anyone else sees your name and a sign-in box.
            </p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>On your own website</h3>
              <p>Paste <a href="#setup">one line</a> into Squarespace, Wix or whatever you already use, and your booking page appears there under your name.</p>
            </div>
            <div class="feature">
              <h3>From a link you send</h3>
              <p>Your booking page also has a link of its own. Text or email it to clients and they book from there, with nothing to build or host.</p>
            </div>
            <div class="feature">
              <h3>By WhatsApp, on Pro</h3>
              <p>Clients message your own WhatsApp number, and the assistant answers and takes the request for you to confirm. <a href="#pro">More on Pro</a>.</p>
            </div>
          </div>
          <p class="note wf-more">
            On your booking page, a client picks a service, picks the dates or a visit time, chooses
            which of their pets are coming, sees the price and answers your intake questions.
          </p>
          <!-- The landing page's own screenshots, captured from the seeded demo (fixed 2028
               months, never "today") and already inside its weight budget. -->
          <ol class="steps">
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-services.webp"
                  alt="The widget's service picker: Boarding selected from a row of services including House sitting, Daycare, Walk, Check-in, and Morning walk"
                />
              </div>
              <div class="step-body">
                <span class="step-no">01</span>
                <h3>They pick a service</h3>
                <p>From the services you set up, under your own names and your own prices.</p>
              </div>
            </li>
            <li class="step-card">
              <div class="frame frame-tall">
                <img
                  src="/img/landing/step-calendar.webp"
                  alt="Month grid where full days are struck through and the weekends of a weekday-only service are struck through as unavailable"
                />
              </div>
              <div class="step-body">
                <span class="step-no">02</span>
                <h3>They pick the dates</h3>
                <p>The calendar shows the days you can take, counting the pets they picked.</p>
              </div>
            </li>
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-request.webp"
                  alt="Booking summary showing the selected dates, an estimated cost of $150, and a Request Booking button"
                />
              </div>
              <div class="step-body">
                <span class="step-no">03</span>
                <h3>They send the request</h3>
                <p>It reaches you with the dates, the pets, your questions answered and a price on it.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section class="section" id="confirm" aria-labelledby="confirm-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Your dashboard</span>
            <h2 id="confirm-h">You confirm or decline</h2>
            <p>
              A request waits in your dashboard with everything you need to answer it, so it is
              settled in a tap from your phone. Every request is pending until you
              confirm it, and your client is emailed the moment you do.
            </p>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">What your clients do without texting you</h3>
            <div class="wf-pair">
              <p class="wf-keep">They get your open dates while they are looking.</p>
              <p>&ldquo;Can you take the 12th to the 15th?&rdquo; and &ldquo;can you do Tuesday at ten?&rdquo; are answered on the page at whatever hour they thought to ask. The request is still pending until you confirm it.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">They change their own bookings.</p>
              <p>New dates, a different pet, a different arrival time. The change takes effect straight away and drops the booking back to pending, so you see it and can still decline. Every rule that applied when they booked applies again.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">They cancel their own bookings.</p>
              <p>Your policy sets the fee, worked out here from the windows you wrote, and you get an email saying what is owed. A request you have not confirmed yet is free to withdraw.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="calendar" aria-labelledby="calendar-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Your calendar</span>
            <h2 id="calendar-h">Your calendar, and your time off</h2>
            <p>
              Time off comes first. Block a day, or a run of days, and those dates stop being
              offered across every service you run.
            </p>
          </div>
          <div class="wf-math">
            <div class="wf-pair">
              <p class="wf-keep">Time off, in whole days.</p>
              <p>Away next Tuesday? Block Tuesday and nothing else changes. Bookings you have already confirmed stay as they are.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">How much notice you need.</p>
              <p>Set the days of notice each service needs, so nobody books you for tomorrow morning.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">How far ahead people can book.</p>
              <p>New accounts start at twelve months.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Google Calendar, if you want it.</p>
              <p>Connect it and your bookings turn up in the calendar you already check. Anything you put on that calendar by hand blocks those dates too, for six months ahead or as far as your booking horizon, whichever is longer. Skip it and everything else works the same.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section" id="services" aria-labelledby="services-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Services</span>
            <h2 id="services-h">Your services, your rates</h2>
            <p>
              Every service starts from one of five kinds. The name, the rate and the limits are
              yours.
            </p>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">Five kinds to start from</h3>
            <div class="wf-pair">
              <p class="wf-keep">Boarding &middot; per night</p>
              <p>Overnight stays at your place.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">House sitting &middot; per night</p>
              <p>You stay at the client&rsquo;s home.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Daycare &middot; per day</p>
              <p>Daytime care, one date at a time.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Walk &middot; per walk</p>
              <p>Your own morning and evening options, at their own prices.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Check-in &middot; per visit</p>
              <p>Drop-in visits to feed, let out and top up the water.</p>
            </div>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">What you set on each one</h3>
            <div class="wf-pair">
              <p class="wf-keep">A rate, per night, day, visit or walk.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">A holiday rate, if you charge one.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">A rate for a combination of pets, when two dogs is a price of its own.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Options with a length and a time window, such as a 30-minute walk between 10 and 2.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">A per-day limit on each option, counted in animals.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Weekdays only, if that&rsquo;s how you work.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">The longest stay you will take.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Which pet types the service accepts.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Up to five intake questions your clients answer when they book.</p>
            </div>
          </div>
          <div class="wf-aside">
            <h3 class="wf-h">Optional: keep track of payments</h3>
            <p>If you want to, log what each client has paid, by cash, Venmo, Zelle, PayPal, check or card, and Pawservation keeps a running balance per household. Upload the CSV Venmo gives you and a month of payments matches up at once.</p>
            <p>Payment stays between you and your client. Card payments are part of Pro, and they run through your own Stripe account.</p>
          </div>
        </div>
      </section>

      <!-- What Pro adds, in the landing page's own words (#pro there). The assistant leads because
           it is the time back; card payments are one card, not the headline. The Stripe
           arrangement itself is stated ONCE on this page, in the Services aside above, so the
           card here names only the fee terms (how-it-works.test.ts counts it). Not a nav
           destination: the five-link row is measured for five. -->
      <section class="section" id="pro" aria-labelledby="pro-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Pro</span>
            <h2 id="pro-h">On Pro, a friendly assistant takes the routine questions</h2>
            <p>
              The assistant answers your clients with your rates, your rules and your open dates:
              whether you&rsquo;re free, what a stay costs, moving a date, what they owe. Every
              booking it takes still waits for you.
            </p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>Booking by WhatsApp</h3>
              <p>Clients message your own WhatsApp number to book, get a quote, reschedule or cancel. Each new request reaches you as a WhatsApp alert with Confirm and Decline buttons, and your client hears the answer.</p>
            </div>
            <div class="feature">
              <h3>The same assistant on your booking page</h3>
              <p>The chat on your booking page gives the same answers, so clients hear the same thing wherever they ask.</p>
            </div>
            <div class="feature">
              <h3>Card payments</h3>
              <p>Take deposits, let clients save a card, and have the balance charged after each stay. You pay Stripe&rsquo;s published rate and no fee to Pawservation.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="setup" aria-labelledby="setup-h">
        <div class="wrap install-grid">
          <div class="install-copy">
            <span class="label">Getting started</span>
            <h2 id="setup-h">Three steps to a booking page</h2>
            <p><strong>Sign up.</strong> Pawservation is invite-only while it grows, so tell us about your business and we will email you a sign-up link.</p>
            <p><strong>Set up your services and rates.</strong> The wizard offers presets, each a whole service already shaped, so you tap the ones that describe you and type your prices.</p>
            <p><strong>Paste one line on your website.</strong> Into a page on Squarespace, Wix or plain HTML, swapping in your own short name. The widget sizes itself to fit, and there is an iframe version if your host strips scripts.</p>
            <p class="note">Solo is $${PRICING.soloMonthly} per sitter per month and starts with a ${PRICING.trialDays}-day free trial. Pro is $${PRICING.proMonthly} per sitter per month, or $${PRICING.proAnnual} a year, and adds card payments, booking by WhatsApp, booking by chat and extra sitters. You pay Stripe&rsquo;s published rate on a card payment and no fee to Pawservation.</p>
            <p class="note">Want every step written out, from your first sign-in to connecting WhatsApp? Read the <a href="/getting-started">setup guide</a>.</p>
          </div>
          <div class="codecard">
            <div class="codecard-cap">
              <span>your-page.html</span>
              <span>paste &amp; save</span>
            </div>
            <div class="code-scroll">
<pre><span class="tag">&lt;script</span> <span class="attr">src</span>=&quot;https://your-site/embed.js&quot;
        <span class="attr">data-pawservation-tenant</span>=&quot;your-slug&quot;
        <span class="attr">data-height</span>=&quot;520&quot;<span class="tag">&gt;&lt;/script&gt;</span></pre>
            </div>
            <div class="codecard-cap">
              <span>or, if scripts are stripped</span>
              <span>iframe fallback</span>
            </div>
            <div class="code-scroll">
<pre><span class="tag">&lt;iframe</span> <span class="attr">src</span>=&quot;https://your-site/embed/your-slug&quot;
        <span class="attr">title</span>=&quot;Booking widget&quot;
        <span class="attr">style</span>=&quot;width:100%;height:640px;border:0;&quot;<span class="tag">&gt;&lt;/iframe&gt;</span></pre>
            </div>
          </div>
        </div>
      </section>

      <!-- The honesty section. Each line is a plain limit a sitter would otherwise meet after
           paying, and several of them are pinned from landing.test.ts as well as this page's own
           test, because the landing page dropped its FAQ and these are where those answers went. -->
      <section class="section" id="limits" aria-labelledby="limits-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Good to know</span>
            <h2 id="limits-h">Good to know before you start</h2>
          </div>
          <div class="wf-math">
            <div class="wf-pair">
              <p class="wf-keep">No repeating bookings yet.</p>
              <p>A client who wants a walk every Tuesday picks each Tuesday, and there is no &ldquo;repeat weekly&rdquo; to set.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Solo runs one sitter per account.</p>
              <p>Extra sitters, with assignment between them, are part of Pro.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Your rates are public.</p>
              <p>Your booking address also publishes a plain-text summary of your services and prices that anyone can read without signing in.</p>
            </div>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">What if you want to take your book elsewhere?</h3>
            <p>Under Business in your dashboard, Export your data gives you four downloads: clients, pets, bookings and payments, as ordinary CSVs that open in Excel, Numbers or Google Sheets. Cancelled bookings, declined requests and pets who have died are all there with their status in a column.</p>
            <p>These are your records. Your settings stay here, meaning your services, rates, cancellation policies and questions, and so does your time off, which is in none of the four files. It goes one way only: there is nothing scheduled to set up, and no way to load one of these files back in.</p>
          </div>
          <!-- The four rules moved here from /about on 2026-09-09, when the owner narrowed that
               page to why it exists and who made it. They are stated on no other page, so this was
               a move and not a delete, and the honesty section is where a sitter is already being
               told what the software will and will not do. The money rule is the one sentence-level
               edit: the Services aside above it already says, in words how-it-works.test.ts pins,
               that payment stays between her and her client and where a Pro card is processed, so
               the rule states what that aside does not (no cut, no funds held, on either plan) and
               stops. -->
          <div class="wf-math">
            <h3 class="wf-h">Four rules the software will not break</h3>
            <div class="wf-pair">
              <p class="wf-keep">Nothing books itself.</p>
              <p>Every request arrives as a request and waits for you to confirm or decline. A pending request holds its space so it can&rsquo;t be taken twice, but it is never a commitment you didn&rsquo;t make.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Your money is yours.</p>
              <p>Pawservation records what a booking is worth and what you&rsquo;ve been paid. It never holds your funds or takes a cut, on either plan. On Solo it does not process cards at all, and you collect the way you already collect. On Pro, Stripe pays you directly.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Your clients stay your clients.</p>
              <p>This is not a marketplace and not a directory. Nobody browses for a sitter here. You add each client before they can book, and their details are yours.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">No price you didn&rsquo;t type.</p>
              <p>The software will not invent a rate. It multiplies the hours or nights you sold by the rate you stored, and where you&rsquo;ve told it to, by the number of pets. It will refuse to quote a combination you never priced rather than guess at one, because a rate you didn&rsquo;t type is a price you didn&rsquo;t agree to.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="cta-band" aria-labelledby="tour-cta-h">
        <div class="wrap">
          <div class="cta-panel">
            <h2 id="tour-cta-h">Sign up when you are ready</h2>
            <p>Tell us about your business and we will set up your services, rates and booking page. Or poke at the demo first: nothing to sign up for and nothing you can break.</p>
            <div class="cta-row">
              <a class="btn btn-inverse" href="/#invite-h">Sign up</a>
              <a class="signin-inverse" href="/demo">Try the demo</a>
              <a class="signin-inverse" href="/#pricing">See pricing</a>
            </div>
          </div>
        </div>
      </section>
    </main>

    ${pageFooter()}
  </body>
</html>
`;

/**
 * The Privacy Policy at /privacy — same LOCKED_CSP, script-free, PAGE_STYLE-only constraints as
 * every other static page here. Content is grounded in what this codebase actually does (see the
 * design doc's audit); this is not a substitute for legal review before it is a real business's
 * live policy.
 */
const PRIVACY_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/privacy',
      'Privacy Policy | Pawservation',
      "What Pawservation collects, who it's shared with, and how long it's kept.",
    )}
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <img src="/brand/calendar.svg" width="30" height="28" alt="" />
          Pawservation
        </a>
        <div class="nav-right">
          <a class="signin" href="/admin">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/demo">Try the demo</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap">
          <p class="chip">Legal</p>
          <h1>Privacy Policy</h1>
          <p class="sub">What we collect, who we share it with, and how long we keep it, written to match what the product does.</p>
          <p class="note">Last updated: August 4, 2026</p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h2>What we collect</h2>
            <p>From customers: their name, email, phone, their pets&rsquo; names and any care notes they give their sitter, and the answers they give to their sitter&rsquo;s own booking questions. From sitters: your login email and a securely hashed password; we never store your password itself. <strong>We never collect or store card numbers, on either plan.</strong> Payments you log are just a record of money you already collected outside Pawservation (cash, Venmo, Zelle, check). On Pro, a card is entered on a page hosted by Stripe, which holds the card details under the sitter&rsquo;s own Stripe account; Pawservation stores only that a payment happened and its amount.</p>
          </div>
          <div class="feature">
            <h2>Who we share it with</h2>
            <p><strong>Resend</strong> sends our transactional email (login codes, booking confirmations, password-reset links) and nothing else; we don&rsquo;t use it for marketing. <strong>Google</strong> only sees your booking data if a sitter connects Google Calendar, and only enough to write an event: pet names, times, cost, and your client&rsquo;s email address. <strong>Cloudflare</strong> is our hosting and database provider: everything above lives on Cloudflare&rsquo;s infrastructure.</p>
          </div>
          <div class="feature">
            <h2>Cookies</h2>
            <p>We set exactly one cookie, for ten minutes, only while a sitter is connecting Google Calendar, to stop a cross-site request forgery attack during that one step. There are no cookies for signing in or for tracking you. Customers, sitters and the platform owner all sign in without one.</p>
          </div>
          <div class="feature">
            <h2>How long we keep it</h2>
            <p>Cancelled and declined bookings stay on the record as part of your sitter&rsquo;s booking history, the same way a paper ledger would keep them. Login codes and one-time links expire in minutes and can&rsquo;t be reused. A sitter can delete a client who has no booking history, and can ask us to delete an entire account&rsquo;s data.</p>
          </div>
          <div class="feature">
            <h2>Children</h2>
            <p>Pawservation is not directed at children, and we don&rsquo;t knowingly collect data from them.</p>
          </div>
          <div class="feature">
            <h2>No tracking</h2>
            <p>We run no analytics, no ad pixels, and no fingerprinting, on this page or anywhere else in the product. Our security policy blocks third-party scripts from loading at all.</p>
          </div>
          <div class="feature">
            <h2>Where your data lives</h2>
            <p>Everything is stored on Cloudflare&rsquo;s global network. We don&rsquo;t currently commit to a specific country or region.</p>
          </div>
          <div class="feature">
            <h2>Questions</h2>
            <p>Reach us at <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}">${htmlEscape(SUPPORT_EMAIL)}</a>.</p>
          </div>
        </div>
      </section>
    </main>

    ${pageFooter()}
  </body>
</html>
`;

/**
 * The Terms & Conditions at /terms — same LOCKED_CSP, script-free, PAGE_STYLE-only constraints as
 * every other static page here. Not a substitute for legal review before it is a real business's
 * live terms.
 */
const TERMS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/terms',
      'Terms &amp; Conditions | Pawservation',
      'The terms that govern using Pawservation: what the booking software does, what it deliberately does not do with your money on Solo, and what each side is responsible for.',
    )}
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <img src="/brand/calendar.svg" width="30" height="28" alt="" />
          Pawservation
        </a>
        <div class="nav-right">
          <a class="signin" href="/admin">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/demo">Try the demo</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap">
          <p class="chip">Legal</p>
          <h1>Terms &amp; Conditions</h1>
          <p class="sub">The terms that govern using Pawservation.</p>
          <p class="note">Last updated: August 4, 2026</p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h2>What Pawservation is</h2>
            <p>Pawservation is booking and scheduling software that a pet-sitting business embeds on its own website. Pawservation does not perform pet-sitting services, and is not a party to the agreement between a sitter and their customer.</p>
          </div>
          <div class="feature">
            <h2>Accounts</h2>
            <p>Sitters and the platform owner sign in with an email and password; customers sign in with a one-time code sent to their email. Each person is responsible for keeping their own credentials secure.</p>
          </div>
          <div class="feature">
            <h2>Payments</h2>
            <p>Pawservation is not a payment processor. On Solo, a sitter collects payment themselves, outside Pawservation, and logs the amount here so their records stay accurate, and we never process, store, or guarantee any payment. On Pro, card payments are processed by Stripe under the sitter&rsquo;s own Stripe account: the sitter is the merchant, Stripe holds the card details and the funds and pays the sitter directly, and Pawservation is not a party to the payment, holds no funds, and takes no fee. Refunds and disputes are between the sitter, their customer and Stripe.</p>
          </div>
          <div class="feature">
            <h2>Acceptable use</h2>
            <p>Don&rsquo;t attempt to abuse the booking or intake system, or to work around tenant isolation, rate limits, or any other technical safeguard.</p>
          </div>
          <div class="feature">
            <h2>Your data</h2>
            <p>A sitter owns their business&rsquo;s client and booking data. See our <a href="/privacy">Privacy Policy</a> for how long we keep it and how to have it deleted.</p>
          </div>
          <div class="feature">
            <h2>Availability</h2>
            <p>Pawservation is provided &ldquo;as is,&rdquo; without any uptime guarantee. To the fullest extent the law allows, Pawservation is not liable for indirect, incidental, or consequential damages arising from use of the service.</p>
          </div>
          <div class="feature">
            <h2>Termination</h2>
            <p>The platform owner may disable or remove an account that violates these terms.</p>
          </div>
          <div class="feature">
            <h2>Governing law</h2>
            <p>These terms are governed by the laws of the State of California, and any dispute will be brought in the state or federal courts located in San Francisco County, California.</p>
          </div>
          <div class="feature">
            <h2>Changes</h2>
            <p>We may update these terms from time to time; check back periodically.</p>
          </div>
        </div>
      </section>
    </main>

    ${pageFooter()}
  </body>
</html>
`;

/**
 * The product's own llms.txt, the sibling of the per-tenant one above. Request origin, not
 * BRAND_ORIGIN, for the reason the tenant document uses it: every URL in there is an address the
 * reader is expected to CALL, so it has to keep working on whichever host they arrived at.
 */
/**
 * /about — the creator's page, narrowed to that on 2026-09-09 on the owner's instruction: why this
 * exists and who made it, and nothing about the product, its plans or its behaviour. Those belong
 * to the landing page and the tour, which are already the only place any of them was stated twice;
 * the four rules that used to sit here now live in /how-it-works' honesty section. It is still a
 * trust anchor, so the fabrication rule is unchanged and tighter for being personal: the prior
 * career, the business name and the three client questions are what the owner supplied, and no
 * year, client count, headcount, employer or address may be added to them.
 *
 * It is also not a call to action. The founder story's closing paragraph ("I'm looking for a
 * handful of pet sitters and dog walkers to try it while it's still early") was removed on the
 * owner's instruction the same week: the page states why the thing exists, and recruiting belongs
 * to the landing page's invite form. The closing line pointing at the demo and the tour stays,
 * because it is wayfinding for a reader who has finished this page rather than a pitch. That
 * removal also took the page's only statements that this is a small independent product with no
 * sales team and that questions reach a person; /contact still says both, in its own words.
 */
const ABOUT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/about',
      'About | Pawservation',
      'Pawservation is built by Brad Burch, a software engineer turned dog walker and pet sitter who got tired of running his own business out of a text thread.',
    )}
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <img src="/brand/calendar.svg" width="30" height="28" alt="" />
          Pawservation
        </a>
        <!-- .nav-links-5: the same five-link row the landing header carries, with the same
             row-tuning class, because it is a third row measured at five links plus "Sign in"
             plus "Try the demo": the .how-it-works shape, not the landing page's four-item
             .nav-right. The first three hrefs are absolute (/#how, /#dashboard, /#pricing)
             rather than the landing header's bare fragments, because a fragment link on this
             page would scroll nowhere: there is no #how/#dashboard/#pricing section here, only
             on /. -->
        <nav class="nav-links nav-links-5" aria-label="Sections">
          <a href="/#how">How it works</a>
          <a href="/#dashboard">Dashboard</a>
          <a href="/#pricing">Pricing</a>
          <a href="/how-it-works">Full tour</a>
          <a href="/about">About</a>
        </nav>
        <div class="nav-right">
          <a class="signin" href="/admin">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/demo">Try the demo</a>
        </div>
      </div>
    </header>

    <main>
      <!-- .hero-flush: this hero is the top of one continuous page rather than the first of
           several bands, so the hero's bottom padding and the next section's top padding are both
           dropped and the .sub's own margin becomes the gap. -->
      <section class="hero hero-flush">
        <div class="wrap">
          <p class="chip">About</p>
          <h1>I&rsquo;m a dog walker and pet sitter, and I built this for my own business first.</h1>
          <p class="sub">
            I needed this for my own dog walking and pet sitting business before it was ever a
            product anyone else could buy.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h2>Why I built it</h2>
            <div class="founder">
              <img
                class="founder-photo"
                src="/img/brad.jpg"
                width="360"
                height="480"
                alt="Brad Burch with a small black dog resting across his shoulders"
              />
              <div>
                <p>Hi, I&rsquo;m Brad. I was a software engineer before I started walking dogs, and these days I run <a href="https://bradpaws.com/">Brad Paws</a>. I got tired of running my own business through a mess of texts, emails and payment records. Pawservation is the solution I needed for it.</p>
                <p>I kept getting questions like:</p>
                <ul class="founder-qs">
                  <li>&ldquo;Are you available to watch Lucie in 2 weeks?&rdquo;</li>
                  <li>&ldquo;Which days did I ask you to watch Fido in November?&rdquo;</li>
                  <li>&ldquo;Did I pay you for last week?&rdquo;</li>
                </ul>
                <p>Every one of those answers was already written down somewhere. Finding it meant scrolling back through a text thread, looking at my calendar, and most of the time while I was out walking dogs. So I built Pawservation to help other dog walkers also keep scheduling, bookings and payments in one place. It does not replace your updates or your relationship with your clients. It makes the back office transparent and frees up time for you to spend doing what you love, which is spending time with the pets.</p>
                <p>Everything else about how you work stays as it is. The same website, the same calendar, the same way of taking money, the same conversations with the clients who&rsquo;d rather text you anyway.</p>
              </div>
            </div>
          </div>
          <div class="feature">
            <p>If you would rather see it than read about it, the <a href="/demo">demo</a> is there so you can poke around without signing up for anything, and the <a href="/how-it-works">full tour</a> is the long version of what it does.</p>
          </div>
        </div>
      </section>
    </main>

    ${pageFooter()}
  </body>
</html>
`;

/**
 * /contact — the other trust anchor. Its most useful job is the redirect in the second block: most
 * people who reach a pet-care booking product's contact page are looking for their SITTER, not for
 * the software, and sending them to the right place beats an unanswered form.
 */
const CONTACT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/contact',
      'Contact | Pawservation',
      'How to reach Pawservation: sign up, get help with an account you already have, or find out where to go if you are a pet owner looking for your own sitter.',
    )}
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <img src="/brand/calendar.svg" width="30" height="28" alt="" />
          Pawservation
        </a>
        <div class="nav-right">
          <a class="signin" href="/admin">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/demo">Try the demo</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap">
          <p class="chip">Contact</p>
          <h1>Talk to a person.</h1>
          <p class="sub">
            There is no support desk and no sales team. Pawservation is small enough that
            messages reach the person who builds it. Here is the quickest route for each reason
            you might be writing.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h2>You&rsquo;re a pet owner looking for your sitter</h2>
            <p><strong>Please contact your sitter directly.</strong> This is the most common reason people land here, and we can&rsquo;t reach your sitter for you. Pawservation is the software your sitter uses, so we can&rsquo;t see, change, or cancel your booking. Your sitter&rsquo;s own booking page, the one you booked on, is where a booking can be changed or cancelled. Every email you&rsquo;ve had about a booking was sent by Pawservation on your sitter&rsquo;s behalf and names their business, and replying to it does not reach them. Contact your sitter the way you normally do.</p>
          </div>
          <div class="feature">
            <h2>You run a pet-care business and want an account</h2>
            <p>Use the <a href="/#invite-h">sign-up form on the homepage</a>. Tell us what you offer and roughly how you work; the reply sets up your services, rates and booking page so you aren&rsquo;t starting from an empty screen. Pawservation is invite-only while it grows, so this is the front door rather than a marketing capture form.</p>
          </div>
          <div class="feature">
            <h2>You already have an account and something is wrong</h2>
            <p>Email <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}?subject=Pawservation%20support">${htmlEscape(SUPPORT_EMAIL)}</a> and say which business you run; that&rsquo;s enough to find your account. Include what you expected to happen and what happened instead; if it involves a specific booking, the dates and the client&rsquo;s first name are enough to locate it. Your dashboard is at <a href="/admin">the sign-in page</a> if you just need to get back in; it will email you a reset link.</p>
          </div>
          <div class="feature">
            <h2>Press, partnerships, or anything else</h2>
            <p>Same address: <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}">${htmlEscape(SUPPORT_EMAIL)}</a>. A person reads these and there is no ticket system behind it, so a plain description of what you want beats a formal one.</p>
          </div>
          <div class="feature">
            <h2>Security</h2>
            <p>If you believe you&rsquo;ve found a vulnerability, write to the same address with &ldquo;security&rdquo; in the subject and please give us a chance to fix it before publishing. See our <a href="/privacy">Privacy Policy</a> for what data exists to be at risk in the first place.</p>
          </div>
        </div>
      </section>
    </main>

    ${pageFooter()}
  </body>
</html>
`;

/**
 * The sitter's setup guide at /getting-started: every step from the sign-up email to booking by
 * WhatsApp, written to her, in the order she meets them. Linked from the tour, the shared footer
 * and the product llms.txt; listed in the sitemap and run_worker_first. Same constraints as every
 * marketing page: LOCKED_CSP, script-free, PAGE_STYLE only, and the /contact skeleton (a bare
 * .nav-right, .legal prose, one h2 per .feature) so it adds no CSS of its own.
 *
 * Every label in quotes is the label the dashboard prints (app/admin/**), and the Pro steps use the
 * labels the paid surfaces print. Two rules shape the Pro sections: this repo may not name a path on
 * the paid origin, so the guide says which part of her dashboard to open and never a URL; and the
 * copy describes the flow as it ships, without a hedge. getting-started.test.ts pins the labels a
 * sitter will look for, the PRICING figures and the bans.
 *
 * Quoted labels are trimmed to their dash-free part where the UI string carries an em dash, because
 * seo.test.ts's em-dash budget covers this page; the one exception it allows is the calendar name.
 */
const GETTING_STARTED_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/getting-started',
      'Setup guide | Pawservation pet sitting &amp; dog walking software',
      'A step-by-step setup guide for pet sitters and dog walkers on Pawservation: your services and rates, time off, clients, your booking page or booking link, your plan, card payments and booking by WhatsApp.',
    )}
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <img src="/brand/calendar.svg" width="30" height="28" alt="" />
          Pawservation
        </a>
        <div class="nav-right">
          <a class="signin" href="/admin">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/#invite-h">Sign up</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap">
          <p class="chip">Setup guide</p>
          <h1>Getting started, step by step</h1>
          <p class="sub">
            From your first sign-in to your first booking: set your services and rates, add your
            clients, and send them your booking page. The Pro steps come after, whenever you want
            them.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h2>In this guide</h2>
            <ol>
              <li><a href="#sign-up">Sign up and sign in</a></li>
              <li><a href="#business">Your business details</a></li>
              <li><a href="#services">Services and rates</a></li>
              <li><a href="#availability">Time off and how far ahead people book</a></li>
              <li><a href="#cancellations">Your cancellation policy</a></li>
              <li><a href="#calendar">Google Calendar</a></li>
              <li><a href="#clients">Adding your clients</a></li>
              <li><a href="#booking-page">Your booking page or booking link</a></li>
              <li><a href="#plan">Choosing a plan</a></li>
              <li><a href="#cards">Card payments, on Pro</a></li>
              <li><a href="#whatsapp">Booking by WhatsApp, on Pro</a></li>
              <li><a href="#your-clients">What your clients do</a></li>
              <li><a href="#questions">Questions and fixes</a></li>
            </ol>
          </div>

          <div class="feature" id="sign-up">
            <h2>1. Sign up and sign in</h2>
            <p>Enter your email on the <a href="/#invite-h">sign-up form</a> and we email you a sign-up link. Follow it to the page headed &ldquo;Set up your business&rdquo;, type your business name, choose a password, and press &ldquo;Finish setup&rdquo;. You land in your dashboard, already signed in.</p>
            <p>Your booking page&rsquo;s address is made from the business name you type here, so type it the way you want clients to see it.</p>
            <p>After that, sign in at <a href="/admin">the sign-in page</a> with your email and password. &ldquo;Forgot password?&rdquo; there emails you a reset link.</p>
            <p>The first time you sign in, &ldquo;Quick setup&rdquo; opens by itself and walks you through four steps: &ldquo;About Your Business&rdquo;, &ldquo;What Services Do You Offer?&rdquo;, &ldquo;Set Your Prices&rdquo; and &ldquo;Connect Your Calendar&rdquo;. Each step has &ldquo;Skip for now&rdquo;, and everything it sets can be changed later in the places below.</p>
          </div>

          <div class="feature" id="business">
            <h2>2. Your business details</h2>
            <p>Open <strong>Settings &rarr; Business</strong>. Clients see these on your booking page:</p>
            <ul>
              <li>&ldquo;Business name&rdquo; and &ldquo;Brand color&rdquo;.</li>
              <li>&ldquo;Contact email&rdquo; and &ldquo;Contact phone&rdquo;, shown to your clients so they can reach you.</li>
              <li>&ldquo;Your time zone&rdquo;, which every date and time is counted in.</li>
            </ul>
            <p>Press &ldquo;Save changes&rdquo; when you are done.</p>
          </div>

          <div class="feature" id="services">
            <h2>3. Services and rates</h2>
            <p>The quickest start is the wizard&rsquo;s presets: tap the ones that describe you (&ldquo;Pack Walks&rdquo;, &ldquo;Solo Walks&rdquo;, &ldquo;Boarding&rdquo;, &ldquo;House sitting&rdquo;, &ldquo;Daycare&rdquo;, &ldquo;Check-in&rdquo;) and type a price for each. You can run &ldquo;Quick setup&rdquo; again any time from <strong>Settings &rarr; Services &amp; Rates</strong>; it only adds, and never overwrites.</p>
            <p>To build one by hand, press &ldquo;+ Add a service&rdquo;, pick one of the five kinds (Boarding, House sitting, Daycare, Walk or Check-in), name it, and press &ldquo;Add service&rdquo;. You can offer up to six services. Open a service to set:</p>
            <ul>
              <li><strong>Pricing &amp; options</strong>: the rate per night, day, walk or visit. Walks and check-ins can carry several options, each with its own length, price, pickup window and capacity.</li>
              <li><strong>Holiday rate</strong>, if you charge one.</li>
              <li><strong>Booking limits</strong>: how many pets you take, the longest stay, and &ldquo;Days of notice needed&rdquo;.</li>
              <li><strong>Questions</strong>: what clients answer when they book.</li>
              <li><strong>Accepted pets</strong>: which kinds of animal the service takes.</li>
            </ul>
            <p>Each service has an on and off switch. A service that is off reads &ldquo;Not offered&rdquo; and takes no bookings.</p>
            <p><strong>Pricing more than one pet.</strong> Under &ldquo;Multi-pet pricing&rdquo; you choose what a booking with several pets costs. A new service starts on &ldquo;my rate &times; the number of pets&rdquo;, so two dogs cost twice your one-dog rate. Under that you can add a combination with a price of its own, such as two dogs for $60. Choose &ldquo;only the combinations I price below&rdquo; instead and only the combinations you have priced can be booked together.</p>
            <p>In that second mode, a client who picks pets you have not priced as a group is told their dates are free but that you haven&rsquo;t set a price for that group of pets yet. They are given your email or phone to ask you, and told they can book one pet at a time. The price is never guessed, and the request cannot be sent until you add a rate.</p>
          </div>

          <div class="feature" id="availability">
            <h2>4. Time off and how far ahead people book</h2>
            <p>Open <strong>Settings &rarr; Time off</strong>, pick a &ldquo;First day off&rdquo; and a &ldquo;Last day off&rdquo;, and press &ldquo;Block these days&rdquo;. Both days are included, so for a single day pick the same date twice. Those days stop being offered on every service at once, and bookings you have already confirmed stay as they are.</p>
            <p>How far ahead clients can book is set in <strong>Settings &rarr; Business</strong>, as a number of months (new accounts start at twelve). How much notice each service needs is under that service&rsquo;s &ldquo;Booking limits&rdquo;.</p>
          </div>

          <div class="feature" id="cancellations">
            <h2>5. Your cancellation policy</h2>
            <p>Each service has its own policy, at the bottom of the service under &ldquo;Cancellation policy&rdquo;. Press &ldquo;Add tier&rdquo; and fill in &ldquo;Within [days] days of start: [percent] % of cost&rdquo;. You can add several tiers, and the tightest window that applies wins. Leave it blank and cancelling costs nothing.</p>
            <p>When a client cancels on your booking page, the fee comes from the policy you wrote, and you get an email saying what is owed.</p>
          </div>

          <div class="feature" id="calendar">
            <h2>6. Google Calendar</h2>
            <p>Optional. Open <strong>Settings &rarr; Connected apps</strong> and press &ldquo;Connect Google Calendar&rdquo;, then sign in with Google in the window that opens. Your bookings start appearing on your calendar. Press &ldquo;Create a pet calendar&rdquo; if you would like them on a calendar of their own, named &ldquo;Pawservation &mdash; Pet bookings&rdquo;.</p>
            <p>Anything you put on the connected calendar yourself blocks those dates for new requests, so a dentist appointment typed into Google is time off here too. Skip this step and everything else works the same.</p>
          </div>

          <div class="feature" id="clients">
            <h2>7. Adding your clients</h2>
            <p>Only clients you add can book with you. Open <strong>Clients</strong> and fill in the client&rsquo;s email, name and phone, plus their first pet&rsquo;s name and type, then press &ldquo;Add account&rdquo;. Every client needs a phone number and at least one pet.</p>
            <p>Adding a client sends them nothing. When you are ready, open their row and press &ldquo;Send welcome email&rdquo;.</p>
            <p>Have a list already? Use the CSV import on the same page. &ldquo;Download example CSV&rdquo; shows the columns, and tick &ldquo;Send welcome emails to new clients&rdquo; if you want them sent as the list goes in.</p>
          </div>

          <div class="feature" id="booking-page">
            <h2>8. Your booking page or booking link</h2>
            <p>Open <strong>Settings &rarr; Your website</strong>. You will see your booking page as clients see it, and three ways to share it:</p>
            <ul>
              <li><strong>On Squarespace and most website builders</strong>: press &ldquo;Copy the code&rdquo; and paste it into a code block on any page. It already has your business filled in.</li>
              <li><strong>On Wix</strong> (choose &ldquo;Embed a site&rdquo;) and builders where the first one doesn&rsquo;t work, use the second code and its own &ldquo;Copy the code&rdquo; button.</li>
              <li><strong>No website?</strong> Press &ldquo;Copy the link&rdquo; and text or email it to your clients. It opens the same booking page on its own, with nothing to build or host.</li>
            </ul>
            <p>The page is safe to put in public, because only clients you have added can book. Anyone else sees your name and a sign-in box. Your services and rates can be read by anyone with the address.</p>
          </div>

          <div class="feature" id="plan">
            <h2>9. Choosing a plan</h2>
            <p>Solo is $${PRICING.soloMonthly} per sitter per month and starts with a ${PRICING.trialDays}-day free trial: your booking page, clients, rates, payment tracking and Google Calendar. Pro is $${PRICING.proMonthly} per sitter per month, or $${PRICING.proAnnual} a year, and adds a booking assistant in your booking page&rsquo;s chat and on WhatsApp, card payments through your own Stripe account, and extra sitters.</p>
            <p>Your plan lives at the bottom of <strong>Settings &rarr; Business</strong>, under &ldquo;Your plan&rdquo;. Press &ldquo;Subscribe&rdquo; beside Solo, Pro or Pro, yearly, and payment happens on Stripe&rsquo;s own page, so Pawservation never sees your card. Once you have a plan, &ldquo;Manage plan&rdquo; is where you change your card or see past payments, and &ldquo;Sync with Stripe&rdquo; puts things right if your plan ever looks wrong there.</p>
            <p>Nothing about your bookings, clients or pets changes when you subscribe or switch plans. A plan only decides which extras are switched on.</p>
          </div>

          <div class="feature" id="cards">
            <h2>10. Card payments, on Pro</h2>
            <p>Card payments run through a Stripe account of your own. You pay Stripe&rsquo;s published rate on each payment, no fee to Pawservation, and Stripe pays you directly into your own bank account on Stripe&rsquo;s schedule. Pawservation never holds your money.</p>
            <p><strong>Connecting.</strong> In your Pawservation assistant, press &ldquo;Connect Stripe&rdquo;. Stripe opens and asks for your details and your bank account, the same as any Stripe signup. When you come back, Stripe may still be checking your details for a few minutes; &ldquo;Continue setup&rdquo; takes you back to Stripe if it needs anything else.</p>
            <p><strong>An access token.</strong> Card payments need to act for you when nobody is signed in, for example to record a deposit at night. Open <strong>Settings &rarr; Business &rarr; Access tokens</strong>, create a token, paste it into the assistant and press &ldquo;Save token&rdquo;. When it is done the assistant says card payments are on and names the Stripe account the money goes to.</p>
            <p><strong>Deposits.</strong> Choose &ldquo;No deposit&rdquo;, &ldquo;A fixed amount&rdquo; or &ldquo;A percentage of the estimate&rdquo;, press &ldquo;Set deposit rule&rdquo;, read the sentence it shows you, and press &ldquo;Confirm deposit rule&rdquo;. A deposit is asked for on confirmed bookings whose stay has not ended yet.</p>
            <p><strong>Charging the balance after a stay.</strong> Press &ldquo;Charge saved cards after stays&rdquo; and confirm. From then on, every household that has allowed it is charged what its booking still owes on the morning after the stay ends. A card is only charged if that client said yes first, and you can pause any one household, or press &ldquo;Stop charging saved cards&rdquo; to stop them all.</p>
            <p><strong>What clients see.</strong> In &ldquo;My bookings&rdquo; on your booking page, a deposit that is due shows its amount and a &ldquo;Pay deposit&rdquo; button, which opens Stripe&rsquo;s own payment page. Paying a deposit saves their card. They can then ask the assistant to charge that card after each stay, and they can stop it whenever they like.</p>
            <p><strong>Turning it off.</strong> &ldquo;Disconnect Stripe&rdquo; removes saved cards, closes open payment links and stops any scheduled charges. Payments already made stay in your Stripe account.</p>
          </div>

          <div class="feature" id="whatsapp">
            <h2>11. Booking by WhatsApp, on Pro</h2>
            <p>Your clients message your own WhatsApp Business number to check dates, get a quote, book, reschedule or cancel. The assistant answers, and every new request comes to you to Confirm or Decline.</p>
            <p><strong>What you need.</strong> A WhatsApp Business number you control, either the one your clients already message or a new one; a second WhatsApp number of your own for alerts, such as your personal phone; and a payment method with Meta, because Meta bills you directly for the messages your business number sends.</p>
            <p><strong>Where it lives.</strong> On Pro, open <strong>Settings &rarr; Services &amp; Rates</strong> and scroll to the bottom. The panel there has a section headed &ldquo;WhatsApp&rdquo;.</p>
            <ol>
              <li>Press &ldquo;Connect WhatsApp&rdquo;. A window opens with two choices: &ldquo;Keep the number my clients already text&rdquo; or &ldquo;Use a new number&rdquo;. Meta&rsquo;s own signup runs next; pick one WhatsApp Business account and one number. When it says &ldquo;Connected&rdquo;, close the window.</li>
              <li>Meta reviews the message wording for your number. Until it approves it, the panel says so, and alerts wait.</li>
              <li>Create an access token under <strong>Settings &rarr; Business &rarr; Access tokens</strong>, paste it into &ldquo;Access token for booking by message&rdquo; and press &ldquo;Save token&rdquo;.</li>
              <li>Add your admin number: a WhatsApp number other than your business number. Press &ldquo;Send code&rdquo;, type the six-digit code it sends there, and press &ldquo;Prove&rdquo;.</li>
              <li>Press &ldquo;Switch booking by message on&rdquo;, read the sentence it shows you, and press &ldquo;Accept and switch on&rdquo;. The panel then reads &ldquo;Ready&rdquo;.</li>
            </ol>
            <p><strong>Confirm and Decline.</strong> Each new request, whether it came by WhatsApp or from your booking page, reaches your admin number as an alert with the client, the dates and the estimate, and two buttons. &ldquo;Confirm&rdquo; confirms it in one tap. &ldquo;Decline&rdquo; asks once more, &ldquo;Yes, decline&rdquo; or &ldquo;Keep it&rdquo;. A client who booked by WhatsApp gets the answer on WhatsApp. Confirming by message goes ahead even past the capacity you set, and the reply tells you when it did, so you can change it in your dashboard. You can always decide in your dashboard instead.</p>
            <p><strong>Sharing it.</strong> While you are connected, the panel shows your WhatsApp link and a QR code for it. Add an optional greeting for clients&rsquo; first message, then put the link on your website or social profiles and print the QR code for flyers or your car.</p>
            <p><strong>Turning it off.</strong> &ldquo;Switch booking by message off&rdquo; stops it straight away: clients who message your number are pointed to your booking page. &ldquo;Disconnect WhatsApp&rdquo; removes Pawservation&rsquo;s access to your WhatsApp account altogether. Your booking page keeps working either way.</p>
          </div>

          <div class="feature" id="your-clients">
            <h2>12. What your clients do</h2>
            <ul>
              <li>They open your booking page, on your website or from your link, enter the email you have on file for them, and type the six-digit code they are emailed. There is no password to remember.</li>
              <li>The first time, they are asked for a phone number if you have not added one, so you can reach them.</li>
              <li>They pick a service, the dates or a visit time, and their pets, see the price, answer your questions, and press &ldquo;Request Booking&rdquo;.</li>
              <li>Under &ldquo;My bookings&rdquo; they see each request as &ldquo;Awaiting confirmation&rdquo; until you confirm it, and they are emailed when you do. They can change or cancel their own bookings there.</li>
              <li>On Pro, they can ask the chat on your booking page, or message your WhatsApp number, instead.</li>
            </ul>
          </div>

          <div class="feature" id="questions">
            <h2>13. Questions and fixes</h2>
            <p><strong>A client says they can&rsquo;t book.</strong> Check they are in <strong>Clients</strong> with the email they are typing. Only clients you have added can book.</p>
            <p><strong>A client sees no price for their pets.</strong> That service is set to &ldquo;only the combinations I price below&rdquo; and that group of pets has no rate. Add one under &ldquo;Multi-pet pricing&rdquo;, or switch the service to &ldquo;my rate &times; the number of pets&rdquo;.</p>
            <p><strong>A day shows as unavailable.</strong> Look for time off, a booking that fills your limit, an event on your connected Google Calendar, or a service set to weekdays only or needing more notice.</p>
            <p><strong>My booking page won&rsquo;t show on Wix.</strong> Use the second code on <strong>Settings &rarr; Your website</strong>, with Wix&rsquo;s &ldquo;Embed a site&rdquo;.</p>
            <p><strong>My dashboard is read-only.</strong> Your plan has lapsed. Start one under &ldquo;Your plan&rdquo;; your bookings, clients and pets are untouched.</p>
            <p><strong>WhatsApp alerts aren&rsquo;t arriving.</strong> Check the WhatsApp section for its status line: alerts need an admin number you have proven, and Meta&rsquo;s approval of your message wording.</p>
            <p><strong>Anything else.</strong> Email <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}?subject=Pawservation%20support">${htmlEscape(SUPPORT_EMAIL)}</a> and say which business you run. A person reads it.</p>
            <p>Want the bigger picture first? Read the <a href="/how-it-works">full tour</a>, or try the <a href="/demo">demo</a>: a made-up sitter&rsquo;s account, so there is nothing to sign up for and nothing you can break.</p>
          </div>
        </div>
      </section>
    </main>

    ${pageFooter()}
  </body>
</html>
`;

app.get('/llms.txt', (c) => c.text(buildProductLlmsTxt(new URL(c.req.url).origin)));

/**
 * The homepage, with a markdown representation for agents that ask for one (acceptmarkdown.com).
 *
 * The markdown is llms.txt — NOT a hand-maintained markdown twin of the landing page. A second
 * copy of every claim on this site is precisely the drift this codebase is built to prevent: it
 * would go stale the first time a price or a feature changed, and a stale machine-readable copy is
 * read with more confidence than the stale HTML it contradicts. One document, two content types.
 *
 * `Vary: Accept` is set on BOTH branches, deliberately. Set on only the markdown one, a cache that
 * stored the HTML first would keep serving HTML to every agent asking for markdown, because the
 * stored response never said the request's Accept header mattered.
 */
app.get('/', (c) => {
  c.header('Vary', 'Accept');
  if ((c.req.header('Accept') ?? '').includes('text/markdown')) {
    return c.body(buildProductLlmsTxt(new URL(c.req.url).origin), 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
    });
  }
  return c.html(LANDING_HTML);
});
// Listed in wrangler.jsonc's run_worker_first as the BARE path "/how-it-works" — a glob does not
// match it. Today nothing is emitted at that path, so it would reach the worker regardless (as
// "/" does, which is not listed); the entry is defensive, so that if a build ever emits an asset
// there it can never shadow this route.
app.get('/how-it-works', (c) => c.html(HOW_IT_WORKS_HTML));
app.get('/about', (c) => c.html(ABOUT_HTML));
app.get('/contact', (c) => c.html(CONTACT_HTML));
app.get('/privacy', (c) => c.html(PRIVACY_HTML));
app.get('/terms', (c) => c.html(TERMS_HTML));
app.get('/getting-started', (c) => c.html(GETTING_STARTED_HTML));

// Uniform JSON 500 so an unhandled throw (e.g. a route that rethrows after cleanup) doesn't fall
// through to Hono's plain-text default and break the { error } contract every client parses.
// Internal detail is logged, never returned.
/**
 * A 404 an agent can recover from. Hono's default is the bare string `404 Not Found`, which tells
 * a reader that this path is wrong and nothing about where the right one is.
 *
 * The requested path is deliberately NOT echoed back: reflecting it would let a crafted URL author
 * markdown structure — headings, list items, a link — inside a document an agent is about to act
 * on, and no line of this response needs it to be useful.
 *
 * /api keeps its JSON shape. Every other error on that prefix answers `{ error }`, and a client
 * parsing JSON should get a parse-able 404, not prose about a sitemap it has no use for.
 */
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);
  const origin = new URL(c.req.url).origin;
  return c.body(
    `# 404 — no such page\n\n` +
      `That path does not exist on Pawservation. Where to look instead:\n\n` +
      `- What this product is, and when to use it: ${origin}/llms.txt\n` +
      `- Every public page: ${origin}/sitemap.xml\n` +
      `- Overview: ${origin}/\n` +
      `- A specific sitter's services and rates: ${origin}/embed/{sitter-slug}/llms.txt\n`,
    404,
    { 'Content-Type': 'text/markdown; charset=utf-8' },
  );
});

app.onError((err, c) => {
  console.error('unhandled error', requestContext(c.req), err);
  return c.json({ error: 'Something went wrong.' }, 500);
});

/**
 * Module-worker export: `fetch` is the Hono instance's own handler; `scheduled` drives the
 * calendar sweep (wrangler.jsonc triggers.crons, every 15 minutes). Object.assign keeps the
 * default export === the Hono app, so every test's `app.request(...)` works unchanged.
 */
const scheduled: NonNullable<ExportedHandler<Env>['scheduled']> = (_controller, env, ctx) => {
  ctx.waitUntil(runCalendarSweep(env));
};

export default Object.assign(app, { scheduled });
