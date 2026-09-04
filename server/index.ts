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
import { bookingRoutes } from './routes/bookings';
import { inviteRequestRoutes } from './routes/invite-request';
import { oauthRoutes } from './routes/oauth';
import { ownerRoutes } from './routes/owner';
import { passwordResetRoutes } from './routes/password-reset';
import { publicRoutes } from './routes/public';
import { signupRoutes } from './routes/signup';
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
  if (c.req.path.startsWith('/embed')) {
    c.header('Content-Security-Policy', EMBEDDABLE_CSP);
  } else {
    // The dashboard frames exactly one thing — whatever premium surface this deployment
    // configures, if any — and nothing else, so the allowance is the configured origin itself,
    // never '*'. Unset (a fork, a self-hoster, no PREMIUM_ORIGIN) leaves LOCKED_CSP with no
    // frame-src at all, i.e. this page frames nothing, exactly as before this existed.
    const origin = premiumOrigin(c.env);
    const csp = origin ? `${LOCKED_CSP}; frame-src 'self' ${origin}` : LOCKED_CSP;
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
app.route('/api', adminRoutes);
app.route('/api', accountsRoutes);
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
      `Booking software for pet sitters and dog walkers, from $${PRICING.soloMonthly} a month. Put a booking page on your own website: your services and rates, your availability rules, client and pet records, payments and what you&rsquo;re owed, and two-way Google Calendar sync.`,
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
        <nav class="nav-links" aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#dashboard">Dashboard</a>
          <a href="#pricing">Pricing</a>
          <a href="/how-it-works">Full tour</a>
        </nav>
        <div class="nav-right">
          <!-- .nav-links is display:none below 780px, which left the tour reachable only from
               the footer on a phone. This copy sits OUTSIDE that row and shows only where the
               row is hidden, so the link exists at every width and is never printed twice. The
               two plain links beside it drop out at the same width, which is what keeps the
               header to three items on a phone: sign-in is in the hero note and the footer, and
               the demo is the hero's own second button. -->
          <a class="signin nav-tour" href="/how-it-works">Full tour</a>
          <a class="signin nav-signin" href="/admin">Sign in</a>
          <a class="signin" href="/demo">Try the demo</a>
          <a class="btn btn-primary btn-sm" href="#invite-h">Ask for an invite</a>
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
            <h1>Your booking page, on your own website.</h1>
            <p class="sub">
              Pawservation is pet sitting and dog walking software. Your clients ask for the dates
              they want on your own site, with your services and your rates, and you confirm each
              request from your phone. It also keeps track of what every client owes you.
            </p>
            <div class="cta-row">
              <a class="btn btn-primary" href="#invite-h">Ask for an invite</a>
              <a class="btn btn-ghost" href="/demo">Try the demo</a>
            </div>
            <p class="note">
              The demo is a made-up sitter&rsquo;s account, so there is nothing to sign up for and
              nothing you can break. Pawservation itself is invite-only while it grows, and you can
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

      <!-- The relationship section: the two sides of one booking, side by side. It was the ninth
           FAQ answer for two rounds, which is the last place a reader looking for "what is this
           like for my clients" would find it. Everything the page says about a client changing or
           cancelling their own booking lives HERE and nowhere else, so the rule is read once,
           whole, rather than three times in fragments. -->
      <section class="section" id="clients" aria-labelledby="clients-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">You and your clients</span>
            <h2 id="clients-h">Your clients get their answer on the page</h2>
            <p>
              The dates question stops being a text.
              Those messages were most of what your clients sent you.
              They were about dates and prices, not about the dog.
              Pawservation doesn&rsquo;t do visit reports or photos, so that relationship is still yours to maintain.
            </p>
          </div>
          <div class="wf-grid">
            <div>
              <h3 class="wf-h">What your client sees</h3>
              <div class="wf-pair">
                <p class="wf-keep">They get an answer while they are looking.</p>
                <p>The page shows which dates you can take, worked out from your own limits, so nobody is left waiting on a text back.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">They see the price before they send anything.</p>
                <p>Your rates are added up on the page for the pets they picked.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">They know it isn&rsquo;t booked yet.</p>
                <p>Every request is still pending until you say yes, and their own screen says awaiting confirmation until then. The email telling them it&rsquo;s booked goes out when you confirm, not when they press send.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">They change or cancel it themselves.</p>
                <p>New dates, a different pet or a cancellation happen on the page, and it takes effect the moment they save it.</p>
              </div>
            </div>
            <div>
              <h3 class="wf-h">What you do</h3>
              <div class="wf-pair">
                <p class="wf-keep">Only your clients can book.</p>
                <p>You add each client, and their pets, before they can book, one at a time or from the list you already have.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">You confirm it or you decline it.</p>
                <p>The request carries the dates, the pets, your questions answered and a price, so you can settle it in one tap from your phone. A new request waits in your dashboard, and on your Google Calendar if you&rsquo;ve connected it.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">You see a change after it happens.</p>
                <p>A change takes effect straight away and the booking drops back to pending, so you see what changed and you can decline it, because your approval comes after the change, not before it.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">You never work out a cancellation fee yourself.</p>
                <p>A cancellation emails you with the fee your own policy sets. A change doesn&rsquo;t email you and waits in your dashboard with the new requests.</p>
              </div>
            </div>
          </div>
          <div class="cta-row mid-cta">
            <a class="btn btn-primary" href="#invite-h">Ask for an invite</a>
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
            <a class="btn btn-primary" href="#invite-h">Ask for an invite</a>
            <a class="btn btn-ghost" href="/demo">Try the demo</a>
          </div>
        </div>
      </section>

      <section class="section" id="workflow" aria-labelledby="workflow-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Alongside your workflow</span>
            <h2 id="workflow-h">It goes in front of what you already do</h2>
            <p>
              Pawservation takes the &ldquo;are you free?&rdquo; question off your phone and leaves
              the rest of how you work exactly where it is.
            </p>
          </div>
          <div class="wf-grid">
            <div>
              <h3 class="wf-h">What stays the same</h3>
              <p class="note">Nothing about how you work has to change.</p>
              <div class="wf-pair">
                <p class="wf-keep">You keep collecting money your own way.</p>
                <p>Cash, Venmo, Zelle or a check on the counter. Pawservation never touches the money.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">You keep your calendar.</p>
                <p>Bookings appear on the Google Calendar you already keep, and what you put there by hand blocks requests. If you don&rsquo;t use it, nothing changes.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">You keep the website you already have.</p>
                <p>One line goes on a page you already publish.</p>
              </div>
            </div>
            <div>
              <h3 class="wf-h">What it takes off your plate</h3>
              <p class="note">Whether you board or walk, the same few jobs eat the day.</p>
              <div class="wf-pair">
                <p class="wf-keep">Boarding and house sitting: a few long threads.</p>
                <p>&ldquo;Are you free the 12th to the 15th?&rdquo; takes four or five messages, which is a quarter of an hour of your attention, in pieces, for every request. The page answers it, so the thread never starts.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">Walks and drop-ins: a lot of short ones.</p>
                <p>The changes are what cost you, and a cancelled Wednesday, a swapped Thursday, an extra dog on Friday all arrive while you are out with someone else&rsquo;s dog. Your clients make those on the page.</p>
              </div>
            </div>
          </div>
          <p class="note wf-more">
            <a href="/how-it-works">The full tour</a> walks through every rule and setting in detail.
          </p>
          <div class="cta-row mid-cta">
            <a class="btn btn-primary" href="#invite-h">Ask for an invite</a>
            <a class="btn btn-ghost" href="/demo">Try the demo</a>
          </div>
        </div>
      </section>

      <section class="section band" id="pricing" aria-labelledby="pricing-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Pricing</span>
            <h2 id="pricing-h">$${PRICING.soloMonthly} a month for one sitter</h2>
            <p>
              Pro adds card payments, extra sitters and booking by chat, for
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
              <a class="btn btn-primary" href="#invite-h">Ask for an invite</a>
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
                <li>AI concierge: clients check availability and book by chat</li>
                <li>Connect an AI assistant such as Claude to check availability and book for you</li>
                <li>Back-office assistant: ask who owes you and what your week looks like</li>
                <li>Card payments: deposits, saved cards, auto-charge</li>
                <li>Extra sitters, with assignment</li>
              </ul>
              <a class="btn btn-primary" href="#invite-h">Ask for an invite</a>
              <p class="note">$${PRICING.proMonthly} per sitter per month, or $${PRICING.proAnnual} per sitter per year, which is $${PRICING.proMonthly * 12 - PRICING.proAnnual} less than paying by the month.</p>
            </div>
          </div>
          <p class="note wf-more">
            <a href="#invite-h">Ask for an invite</a> and we&rsquo;ll get you started.
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
            <p>Forward this box to whoever edits your site.</p>
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
            <h2 id="invite-h">Ask for an invite</h2>
            <p>Pawservation is invite-only while it grows. Tell us about your business and we&rsquo;ll set up your services, rates, and booking page.</p>
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
      'How Pawservation works for pet sitters and dog walkers: your clients request services on your own website, you confirm or decline from your phone, and you block your own time off.',
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
        <nav class="nav-links" aria-label="Sections">
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
          <p class="chip">The full tour</p>
          <h1>How Pawservation works</h1>
          <p class="sub">
            Your clients request the services you offer on your own website. You confirm or
            decline from your phone. Your calendar stays yours.
          </p>
          <div class="cta-row">
            <a class="btn btn-primary" href="/#invite-h">Ask for an invite</a>
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
            <h2 id="booking-h">Your clients request on your website</h2>
            <p>
              Your booking page lives on the site you already have. A client picks a service,
               picks the dates or a visit time, chooses which of their pets are coming, sees the
               price and answers your intake questions.
              Only clients you have added can book. Anyone else sees your name and a sign-in box.
            </p>
          </div>
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
            <p>Payment stays between you and your client. Card payments are part of Pro.</p>
          </div>
        </div>
      </section>

      <section class="section band" id="setup" aria-labelledby="setup-h">
        <div class="wrap install-grid">
          <div class="install-copy">
            <span class="label">Getting started</span>
            <h2 id="setup-h">Three steps to a booking page</h2>
            <p><strong>Ask for an invite.</strong> Pawservation is invite-only while it grows, so tell us about your business and we will email you a sign-up link.</p>
            <p><strong>Set up your services and rates.</strong> The wizard offers presets, each a whole service already shaped, so you tap the ones that describe you and type your prices.</p>
            <p><strong>Paste one line on your website.</strong> Into a page on Squarespace, Wix or plain HTML, swapping in your own short name. The widget sizes itself to fit, and there is an iframe version if your host strips scripts.</p>
            <p class="note">Solo is $${PRICING.soloMonthly} per sitter per month and starts with a ${PRICING.trialDays}-day free trial. Pro is $${PRICING.proMonthly} per sitter per month, or $${PRICING.proAnnual} a year, and adds card payments, extra sitters and booking by chat.</p>
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
        </div>
      </section>

      <section class="cta-band" aria-labelledby="tour-cta-h">
        <div class="wrap">
          <div class="cta-panel">
            <h2 id="tour-cta-h">Ask for an invite when you are ready</h2>
            <p>Tell us about your business and we will set up your services, rates and booking page. Or poke at the demo first: nothing to sign up for and nothing you can break.</p>
            <div class="cta-row">
              <a class="btn btn-inverse" href="/#invite-h">Ask for an invite</a>
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
            <h3>What we collect</h3>
            <p>From customers: their name, email, phone, their pets&rsquo; names and any care notes they give their sitter, and the answers they give to their sitter&rsquo;s own booking questions. From sitters: your login email and a securely hashed password; we never store your password itself. <strong>On Solo we never collect card numbers.</strong> Payments you log are just a record of money you already collected outside Pawservation (cash, Venmo, Zelle, check). Card payments are part of Pro.</p>
          </div>
          <div class="feature">
            <h3>Who we share it with</h3>
            <p><strong>Resend</strong> sends our transactional email (login codes, booking confirmations, password-reset links) and nothing else; we don&rsquo;t use it for marketing. <strong>Google</strong> only sees your booking data if a sitter connects Google Calendar, and only enough to write an event: pet names, times, cost, and your client&rsquo;s email address. <strong>Cloudflare</strong> is our hosting and database provider: everything above lives on Cloudflare&rsquo;s infrastructure.</p>
          </div>
          <div class="feature">
            <h3>Cookies</h3>
            <p>We set exactly one cookie, for ten minutes, only while a sitter is connecting Google Calendar, to stop a cross-site request forgery attack during that one step. There are no cookies for signing in or for tracking you. Customers, sitters and the platform owner all sign in without one.</p>
          </div>
          <div class="feature">
            <h3>How long we keep it</h3>
            <p>Cancelled and declined bookings stay on the record as part of your sitter&rsquo;s booking history, the same way a paper ledger would keep them. Login codes and one-time links expire in minutes and can&rsquo;t be reused. A sitter can delete a client who has no booking history, and can ask us to delete an entire account&rsquo;s data.</p>
          </div>
          <div class="feature">
            <h3>Children</h3>
            <p>Pawservation is not directed at children, and we don&rsquo;t knowingly collect data from them.</p>
          </div>
          <div class="feature">
            <h3>No tracking</h3>
            <p>We run no analytics, no ad pixels, and no fingerprinting, on this page or anywhere else in the product. Our security policy blocks third-party scripts from loading at all.</p>
          </div>
          <div class="feature">
            <h3>Where your data lives</h3>
            <p>Everything is stored on Cloudflare&rsquo;s global network. We don&rsquo;t currently commit to a specific country or region.</p>
          </div>
          <div class="feature">
            <h3>Questions</h3>
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
            <h3>What Pawservation is</h3>
            <p>Pawservation is booking and scheduling software that a pet-sitting business embeds on its own website. Pawservation does not perform pet-sitting services, and is not a party to the agreement between a sitter and their customer.</p>
          </div>
          <div class="feature">
            <h3>Accounts</h3>
            <p>Sitters and the platform owner sign in with an email and password; customers sign in with a one-time code sent to their email. Each person is responsible for keeping their own credentials secure.</p>
          </div>
          <div class="feature">
            <h3>Payments</h3>
            <p>On Solo, Pawservation is not a payment processor. A sitter collects payment themselves, outside Pawservation, and logs the amount here so their records stay accurate. On Solo we never process, store, or guarantee any payment. Card payments are part of Pro. Any payment dispute is between the sitter and their customer.</p>
          </div>
          <div class="feature">
            <h3>Acceptable use</h3>
            <p>Don&rsquo;t attempt to abuse the booking or intake system, or to work around tenant isolation, rate limits, or any other technical safeguard.</p>
          </div>
          <div class="feature">
            <h3>Your data</h3>
            <p>A sitter owns their business&rsquo;s client and booking data. See our <a href="/privacy">Privacy Policy</a> for how long we keep it and how to have it deleted.</p>
          </div>
          <div class="feature">
            <h3>Availability</h3>
            <p>Pawservation is provided &ldquo;as is,&rdquo; without any uptime guarantee. To the fullest extent the law allows, Pawservation is not liable for indirect, incidental, or consequential damages arising from use of the service.</p>
          </div>
          <div class="feature">
            <h3>Termination</h3>
            <p>The platform owner may disable or remove an account that violates these terms.</p>
          </div>
          <div class="feature">
            <h3>Governing law</h3>
            <p>These terms are governed by the laws of the State of California, and any dispute will be brought in the state or federal courts located in San Francisco County, California.</p>
          </div>
          <div class="feature">
            <h3>Changes</h3>
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
 * /about — one of the two "trust anchor" pages a person (or an agent vetting a tool) looks for
 * before trusting a business. Every claim here is either behaviour this codebase enforces or a
 * status the landing page already states; nothing about headcount, funding, founding date or
 * customer numbers, because none of that is knowable from this repo and a fabricated detail on the
 * page whose whole job is legitimacy is worse than an absent one.
 */
const ABOUT_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/about',
      'About | Pawservation',
      'Who makes Pawservation, why it exists, and the four rules the software will not break: nothing books itself, your money is yours, your clients stay yours, and no price is charged that you did not type.',
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
          <p class="chip">About</p>
          <h1>Booking software that stays out of the way.</h1>
          <p class="sub">
            Pawservation is booking software for pet sitters and dog walkers. It puts a booking
            page on the website you already have, with your services, your rates and your
            rules, so the question &ldquo;are you free the 12th to the 15th?&rdquo; answers itself.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h3>Why it exists</h3>
            <p>Every booking a small pet-care business takes starts the same way: a text message asking whether you&rsquo;re free. Answering it means checking a calendar, remembering your own rules, quoting a price from memory, and doing it again four messages later. That thread is the job before the job, and it happens while you have a dog on a lead. Pawservation answers it from the caps, notice periods and days off you set once, and then gets out of the way. Everything else about how you work stays exactly as it is: the same website, the same calendar, the same way of taking money, the same conversations with the clients who&rsquo;d rather text you anyway.</p>
          </div>
          <div class="feature">
            <h3>Four rules the software will not break</h3>
            <p><strong>Nothing books itself.</strong> Every request arrives as a request and waits for you to confirm or decline. A pending request holds its space so it can&rsquo;t be taken twice, but it is never a commitment you didn&rsquo;t make.</p>
            <p><strong>Your money is yours.</strong> Pawservation records what a booking is worth and what you&rsquo;ve been paid. On Solo it does not process cards, hold funds, or take a cut. Card payments are part of Pro. You collect the way you already collect: cash, Venmo, Zelle, a check on the counter.</p>
            <p><strong>Your clients stay your clients.</strong> This is not a marketplace and not a directory. Nobody browses for a sitter here. You add each client before they can book, and their details are yours.</p>
            <p><strong>No price you didn&rsquo;t type.</strong> The software will not invent a rate. It multiplies the hours or nights you sold by the rate you stored, and where you&rsquo;ve told it to, by the number of pets. It will refuse to quote a combination you never priced rather than guess at one, because a rate you didn&rsquo;t type is a price you didn&rsquo;t agree to.</p>
          </div>
          <div class="feature">
            <h3>Where it is today</h3>
            <p>Solo is $${PRICING.soloMonthly} per sitter per month and starts with a ${PRICING.trialDays}-day free trial. It covers the booking page, your availability rules, client and pet records, payment tracking and Google Calendar sync. Pro is $${PRICING.proMonthly} per sitter per month, or $${PRICING.proAnnual} per sitter per year, and adds card payments, extra sitters and booking by chat. New sitters are added by invitation while the product grows. Solo runs one sitter per account; extra sitters, with assignment between them, are part of Pro.</p>
          </div>
          <div class="feature">
            <h3>Who makes it</h3>
            <p>Pawservation is built and run by <a href="https://bradburch.github.io/">Brad Burch</a>. It is a small, independent product. The invite list is short, the tour is plain about the limits, and there is no sales team to get past. Questions go to a person.</p>
          </div>
          <div class="feature">
            <h3>Try it yourself</h3>
            <p>The <a href="/demo">demo</a> is a made-up sitter&rsquo;s account with real data behind it: pick a service, pick dates, watch it refuse the days that are full. Nothing to sign up for, no details asked for, nothing you can break. The <a href="/how-it-works">full tour</a> is the long version, and it says plainly what the software does and doesn&rsquo;t do.</p>
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
      'How to reach Pawservation: ask for an invite, get help with an account you already have, or find out where to go if you are a pet owner looking for your own sitter.',
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
            <h3>You&rsquo;re a pet owner looking for your sitter</h3>
            <p><strong>Please contact your sitter directly.</strong> This is the most common reason people land here, and we can&rsquo;t reach your sitter for you. Pawservation is the software your sitter uses, so we can&rsquo;t see, change, or cancel your booking. Your sitter&rsquo;s own booking page, the one you booked on, is where a booking can be changed or cancelled. Every email you&rsquo;ve had about a booking was sent by Pawservation on your sitter&rsquo;s behalf and names their business, and replying to it does not reach them. Contact your sitter the way you normally do.</p>
          </div>
          <div class="feature">
            <h3>You run a pet-care business and want an account</h3>
            <p>Use the <a href="/#invite-h">invite form on the homepage</a>. Tell us what you offer and roughly how you work; the reply sets up your services, rates and booking page so you aren&rsquo;t starting from an empty screen. Pawservation is invite-only while it grows, so this is the front door rather than a marketing capture form.</p>
          </div>
          <div class="feature">
            <h3>You already have an account and something is wrong</h3>
            <p>Email <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}?subject=Pawservation%20support">${htmlEscape(SUPPORT_EMAIL)}</a> and say which business you run; that&rsquo;s enough to find your account. Include what you expected to happen and what happened instead; if it involves a specific booking, the dates and the client&rsquo;s first name are enough to locate it. Your dashboard is at <a href="/admin">the sign-in page</a> if you just need to get back in; it will email you a reset link.</p>
          </div>
          <div class="feature">
            <h3>Press, partnerships, or anything else</h3>
            <p>Same address: <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}">${htmlEscape(SUPPORT_EMAIL)}</a>. A person reads these and there is no ticket system behind it, so a plain description of what you want beats a formal one.</p>
          </div>
          <div class="feature">
            <h3>Security</h3>
            <p>If you believe you&rsquo;ve found a vulnerability, write to the same address with &ldquo;security&rdquo; in the subject and please give us a chance to fix it before publishing. See our <a href="/privacy">Privacy Policy</a> for what data exists to be at risk in the first place.</p>
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
