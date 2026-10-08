import { Hono, type Context } from 'hono';
import { listServiceOptions, listServices } from './db/repo';
import { runCalendarSweep } from './lib/calendar-cron';
import { BRAND_ORIGIN, htmlEscape, SUPPORT_EMAIL } from './lib/email';
import {
  buildJsonLdScript,
  buildLlmsTxt,
  buildProductJsonLdScript,
  buildProductLlmsTxt,
} from './lib/llms';
import { TURNSTILE_SCRIPT_ORIGIN } from './lib/turnstile';
import { requestContext } from './lib/log';
import { tenantMiddleware } from './lib/middleware';
import { pageFooter, pageHead, STRIPE_LINK } from './lib/page-chrome';
import { PAGE_STYLE } from './lib/page-style';
import { CARD_GUIDE_HTML, GETTING_STARTED_HTML, WHATSAPP_GUIDE_HTML } from './lib/setup-guides';
import { PRICE_LINE, PRICING, TRIAL_LINE } from './lib/plan-pricing';
import { testimonialsHtml } from './lib/testimonials';
import { premiumOrigin } from './lib/premium';
import { resolveTenant } from './lib/tenant-resolve';
import {
  marketingHtml,
  WEB_ANALYTICS_CONNECT_ORIGIN,
  WEB_ANALYTICS_SCRIPT_ORIGIN,
} from './lib/web-analytics';
import { attributionFromRequest, attributionQuery } from './lib/attribution';
import { accountsRoutes } from './routes/accounts';
import { adminRoutes } from './routes/admin';
import { adminAuthRoutes } from './routes/admin-auth';
import { authRoutes } from './routes/auth';
import { billingRoutes } from './routes/billing';
import { bookingRoutes } from './routes/bookings';
import { oauthRoutes } from './routes/oauth';
import { ownerRoutes } from './routes/owner';
import { passwordResetRoutes } from './routes/password-reset';
import { publicRoutes } from './routes/public';
import { signupPageRoutes } from './routes/signup-page';
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
  // /signup is the ONE page that runs a third-party script: Cloudflare Turnstile's widget, a
  // script plus an iframe from challenges.cloudflare.com (routes/signup-page.ts). The allowance
  // is added for that exact path only — every other marketing page stays script-free.
  const turnstile = c.req.path === '/signup' ? TURNSTILE_SCRIPT_ORIGIN : null;
  const frames = [turnstile, origin].filter(Boolean).join(' ');
  const frameSrc = frames ? `; frame-src 'self' ${frames}` : '';
  // A marketing page rendered WITH the Cloudflare Web Analytics beacon (`marketingHtml` set the
  // flag) also admits the beacon's script host and its report host. Each joins the ONE list for
  // its directive — beside Turnstile's script host on /signup, beside the premium origin in
  // `connect-src` — because a browser honours the first of two same-named directives and silently
  // ignores the second. Without the flag every policy is exactly what it was before analytics
  // existed, which is what keeps the widget and the dashboard untouched.
  const analytics = c.get('webAnalytics') === true;
  const scripts = [turnstile, analytics ? WEB_ANALYTICS_SCRIPT_ORIGIN : null].filter(Boolean);
  const scriptSrc = scripts.length > 0 ? `; script-src 'self' ${scripts.join(' ')}` : '';
  const connects = [origin, analytics ? WEB_ANALYTICS_CONNECT_ORIGIN : null].filter(Boolean);
  const connectSrc = connects.length > 0 ? `; connect-src 'self' ${connects.join(' ')}` : '';
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
    const csp = `${LOCKED_CSP}${scriptSrc}${frameSrc}${connectSrc}`;
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
app.route('/', signupPageRoutes); // GET/POST /signup, /signup/sent (+ /request-invite redirects) — pages

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
 * Root landing page: a marketing page for prospective pet sitters, built around real
 * screenshots of the seeded demo (public/img/landing/*.webp) and two coded mocks (the WhatsApp
 * phone and the dashboard's bookings queue). Script-free (served under LOCKED_CSP, so only inline
 * styles and same-origin images are allowed: NO <script>, no external fonts/CSS/images) apart from
 * the analytics beacon `marketingHtml` may append, so it needs no build step. The FAQ is native
 * <details>, which opens without script. Its "Sign up" links are rewritten per request (the route
 * below) to carry the visitor's already-cleaned attribution to /signup.
 * The embed snippet in the FAQ is shown as escaped text (&lt;script&gt;…) so the served body
 * genuinely contains no <script tag. The screenshots show Boarding for Bella, Sat 14 to Tue 17
 * November 2026 (3 nights, $150), and the hero alt, request card, phone example, step alts and
 * dashboard mock all name that stay; docs/landing-screenshots.md is the recipe for retaking them.
 */
/*
 * Notes on the landing markup below, moved out of the template so none of them is served.
 * Each is keyed by the element it sat above.
 *
 * [a class="signin nav-tour"] About joined the .nav-links row above and is deliberately NOT
 *     repeated here: it is in the shared footer's Company block, so it stays reachable below 780px
 *     without this row printing it a second time. Adding a fifth link did move one breakpoint; see
 *     .nav-links-5 in PAGE_STYLE. .nav-links is display:none below 780px, which left the tour
 *     reachable only from the footer on a phone. This copy sits OUTSIDE that row and shows only
 *     where the row is hidden, so the link exists at every width and is never printed twice. The
 *     two plain links beside it drop out at the same width, which is what keeps the header to
 *     three items on a phone: sign-in is in the hero note and the footer, and the demo is the
 *     hero's own second button.
 * [p class="chip"] The chip is the price, not the category: the h1 and the sub below already say
 *     what this is, and a shopper arrives holding an incumbent's monthly figure. The words are the
 *     pricing section's own heading, so the hero and the pricing section cannot drift apart, and
 *     every figure comes from PRICING rather than the markup.
 * [div class="cta-row"] The one button on the page that names the trial (owner, 2026-10-08). Every
 *     other button, the nav's included, reads "Sign up": the nav is one row on measured
 *     breakpoints, and the rest sit beside the price that explains them.
 * [div class="visual-panel"] Screenshots are captured from the seeded demo, in a month inside the
 *     demo sitter's booking window. Retake them with docs/landing-screenshots.md whenever the
 *     widget's look changes or the month leaves the window. The card's three nights at $150 is
 *     the screenshot's own quote, and the WhatsApp example in #pro tells the same stay.
 * [section class="section band"] Who it is for, in her clients' own words: each card is a question
 *     she answers by text today and what answers it instead, with no figure the product cannot
 *     back.
 * [section class="section"] Three first-class paths, not a website and two footnotes. The link is
 *     the /embed/:slug page itself, the one og-booking.png exists to unfurl when she texts it to a
 *     client; WhatsApp is the Pro path and says so.
 * [section class="section"] Booking by WhatsApp is Pro's headline, shown rather than described: a
 *     coded phone (HTML and CSS on the page's own tokens, never WhatsApp's logo or brand green)
 *     read as one illustration through its aria-label. Its stay is the hero's three nights at
 *     $150. What this section claims is the whole of the integration: nothing about photos,
 *     reminders or the assistant booking on its own, and no number handed to her by us. Card
 *     payments and the back-office helper follow as the two "Also on Pro" cards.
 * [section class="section band"] Control, and the fear of a bot or a lost client. Everything the
 *     page says about a client changing or cancelling their own booking lives HERE and nowhere
 *     else, so the rule is read once, whole. .features-3 rather than bare .features: three cards
 *     in the grid's 640-959px two-column band leave the third alone with an empty cell beside it.
 * [div class="mockdash"] Coded mock of the dashboard's bookings queue (not a screenshot): stays
 *     crisp at any scale and inherits the page palette. role="img" so assistive tech reads it as
 *     one illustration, not fake buttons.
 * [div class="features features-4"] Four short cards on one row. The grid is .features-4 rather
 *     than .features because the three-column default left the fourth card orphaned on a row of
 *     its own.
 * [section class="section band"] Trust without invented proof: a founder line built only from what
 *     /about states, and a testimonial slot that renders nothing until the owner adds a real,
 *     permitted quote (server/lib/testimonials.ts). No counts, no ratings, no logos.
 * [section class="section band"] The six objections the walks raised, collapsed: native <details>
 *     needs no script, so it is allowed under the locked CSP, and a reader who does not open one
 *     pays nothing for it. The website answer's id is ON its <details>, because Safari does not
 *     open a closed details for a fragment that targets its contents.
 */
const LANDING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/',
      'Pet Sitting &amp; Dog Walking Software | Pawservation',
      `Booking software for pet sitters and dog walkers, from $${PRICING.soloMonthly} a month. Clients check your dates, see your prices and ask to book from a link you send, or on Pro by WhatsApp. You confirm every booking.`,
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
          <a href="#pro">WhatsApp</a>
          <a href="#pricing">Pricing</a>
          <a href="/how-it-works">Full tour</a>
          <a href="/about">About</a>
        </nav>
        <div class="nav-right">
          <a class="signin nav-tour" href="/how-it-works">Full tour</a>
          <a class="signin nav-signin" href="/admin">Sign in</a>
          <a class="signin" href="/demo">Try the demo</a>
          <a class="btn btn-primary btn-sm" href="/signup">Sign up</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap hero-grid">
          <div class="hero-copy">
            <p class="chip">$${PRICING.soloMonthly} a month. ${PRICING.trialDays}-day free trial.</p>
            <h1>Spend less time on booking texts and more time with the pets.</h1>
            <p class="sub">
              Clients check your open days, see your prices and ask to book from one link you send
              them. On Pro they can simply message you on WhatsApp, and a friendly AI assistant answers
              with your rates and open dates. You confirm every booking with one tap, and you can
              switch the assistant off any time.
            </p>
            <div class="cta-row">
              <a class="btn btn-primary" href="/signup">Start your ${PRICING.trialDays}-day free trial</a>
              <a class="btn btn-ghost" href="/demo">Try the demo</a>
            </div>
            <p class="note">Solo, $${PRICING.soloMonthly} a month: your booking link and calendar. Pro, $${PRICING.proMonthly} a month: adds booking by WhatsApp, cards and deposits.</p>
            <p class="note">
              <a href="/signup">Sign up</a> with just your email. No card needed to start. The demo
              lets you book as a client without signing up for anything. Have an account?
              <a href="/admin">Sign in</a>.
            </p>
          </div>
          <div class="hero-visual">
            <div class="visual-panel">
              <div class="screen">
                <img
                  src="/img/landing/widget-hero.webp"
                  alt="The Pawservation booking widget: a November calendar with a three-night boarding stay selected, Saturday the 14th to Tuesday the 17th"
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

      <section class="section band" id="fit" aria-labelledby="fit-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Sound familiar?</span>
            <h2 id="fit-h">Built for sitters and walkers who run the business themselves</h2>
            <p>If most of your week is the same households asking the same questions, your booking page can answer them for you.</p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>&ldquo;Are you free the weekend of the 14th?&rdquo;</h3>
              <p>Clients see your open days for themselves, so the question never reaches your phone.</p>
            </div>
            <div class="feature">
              <h3>&ldquo;What would it be for both dogs?&rdquo;</h3>
              <p>The price appears as they pick dates and pets, at the rates you set. A combination you haven&rsquo;t priced is never guessed at.</p>
            </div>
            <div class="feature">
              <h3>&ldquo;Did I pay you for last week?&rdquo;</h3>
              <p>Each household has one running balance, so you both see the same answer.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section" id="ways" aria-labelledby="ways-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Website or not</span>
            <h2 id="ways-h">Clients book wherever they find you</h2>
            <p>Send a link, use your website, or let them message you.</p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>No website needed</h3>
              <p>You get a booking page of your own at a link. Text it, email it, or put it in your Instagram bio.</p>
            </div>
            <div class="feature">
              <h3>On your own website</h3>
              <p>Paste <a href="#faq-website">one line</a> into Squarespace, Wix or whatever you use, and your booking page appears there under your name.</p>
            </div>
            <div class="feature">
              <h3>By WhatsApp, on Pro</h3>
              <p>Clients message your business number. The assistant answers and sends each request to you to confirm.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="how" aria-labelledby="how-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">How it works</span>
            <h2 id="how-h">Set it up once, then just tap Confirm</h2>
            <p>You set your services and prices. Your clients do the rest, and you have the final say on every request.</p>
          </div>
          <ol class="steps">
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-services.webp"
                  alt="A sitter's services as her clients see them on her booking page: Boarding selected, beside House sitting, Daycare, Walk, Check-in and Morning walk"
                />
              </div>
              <div class="step-body">
                <span class="step-no">01</span>
                <h3>Your services, your prices</h3>
                <p>Pick from walks, drop-in visits, boarding, house sitting and daycare, and type your prices. Your clients choose from them on your booking page.</p>
              </div>
            </li>
            <li class="step-card">
              <div class="frame frame-tall">
                <img
                  src="/img/landing/step-calendar.webp"
                  alt="The November month grid with the 14th to the 17th selected: days off struck through, nearly full days ringed, and the client's own bookings dotted"
                />
              </div>
              <div class="step-body">
                <span class="step-no">02</span>
                <h3>Clients pick their dates</h3>
                <p>Your calendar shows only the days you can take, and the price shows before they ask.</p>
              </div>
            </li>
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-request.webp"
                  alt="The Request Booking button beside the quote for the stay: 3 nights, $150.00"
                />
              </div>
              <div class="step-body">
                <span class="step-no">03</span>
                <h3>You confirm with one tap</h3>
                <p>Each request reaches you with the dates, the pets and the price. Nothing is booked until you say yes.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section class="section" id="pro" aria-labelledby="pro-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">On Pro</span>
            <h2 id="pro-h">Let clients book you on WhatsApp</h2>
            <p>Clients message your business number the way they&rsquo;d text you. The assistant answers with your open dates and your prices, takes the request, and sends it to your own WhatsApp with Confirm and Decline buttons. Your client gets an answer right away, and the final yes is yours.</p>
          </div>
          <div class="pro-grid">
            <div class="phone" role="img" aria-label="Example WhatsApp conversation. A client asks whether Biscuit can board from Saturday the 14th to Tuesday the 17th. The assistant says the dates are open and the price is $150 for three nights, and offers to send the request. The sitter gets an alert with Confirm and Decline buttons.">
              <div aria-hidden="true">
                <p class="phone-cap">Example</p>
                <p class="bubble bubble-in">Hi! Could you take Biscuit from Sat 14th to Tue 17th?</p>
                <p class="bubble bubble-out">Hi Sam! Those dates are open. Boarding for Biscuit is $150 for 3 nights. Shall I send the request to Maya?</p>
                <p class="bubble bubble-in">Yes please</p>
                <p class="phone-cap">Your alert</p>
                <div class="alert-card">
                  <span class="req-label">New request from Sam</span>
                  <span class="req-what">Boarding &middot; Sat 14 to Tue 17 &middot; $150</span>
                  <span class="req-btns"><span class="req-yes">Confirm</span><span class="req-no">Decline</span></span>
                </div>
              </div>
            </div>
            <div class="pro-points">
              <div class="feature">
                <h3>Your number, your name</h3>
                <p>Clients message a number that belongs to your business, and replies come under your business name.</p>
              </div>
              <div class="feature">
                <h3>Answers at 10pm and mid-walk</h3>
                <p>Routine questions get answered from your own rates and your own calendar while you&rsquo;re busy.</p>
              </div>
              <div class="feature">
                <h3>You decide every booking</h3>
                <p>Confirm or Decline straight from the alert, or later in your dashboard.</p>
              </div>
              <p class="note">Setting it up takes a Facebook login and a phone number for your business. <a href="/getting-started/whatsapp">See what you need</a>. We&rsquo;ll set it up with you: email <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}">${htmlEscape(SUPPORT_EMAIL)}</a>.</p>
            </div>
          </div>
          <h3 class="label pro-also">Also on Pro</h3>
          <div class="features features-2">
            <div class="feature">
              <h3>Card payments through your own Stripe account</h3>
              <p>Take deposits, and let clients who choose to save a card pay what they owe after each stay. You pay Stripe&rsquo;s standard rate ${STRIPE_LINK}, Stripe pays you directly, and Pawservation takes no cut.</p>
            </div>
            <div class="feature">
              <h3>A helper for your back office</h3>
              <p>Ask who still owes you or what next week looks like, and get the answer from your own records.</p>
            </div>
          </div>
          <div class="cta-row mid-cta">
            <a class="btn btn-primary" href="/signup">Sign up</a>
            <a class="btn btn-ghost" href="#pricing">See pricing</a>
          </div>
        </div>
      </section>

      <section class="section band" id="clients" aria-labelledby="clients-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">You stay in charge</span>
            <h2 id="clients-h">Your clients, your rules</h2>
            <p>Your booking page works while you&rsquo;re busy, and it never promises anything you didn&rsquo;t.</p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>Nothing is booked until you say yes</h3>
              <p>Every request waits as pending until you confirm it, and their screen says so.</p>
            </div>
            <div class="feature">
              <h3>Changes on your terms</h3>
              <p>When clients need to move dates or cancel, they do it on the page, and your own cancellation policy sets the fee.</p>
            </div>
            <div class="feature">
              <h3>Your clients stay yours</h3>
              <p>Only clients you add can book. Nobody browses for a sitter here, and their details are yours.</p>
            </div>
          </div>
          <div class="cta-row mid-cta">
            <a class="btn btn-primary" href="/signup">Sign up</a>
            <a class="btn btn-ghost" href="/demo">Try the demo</a>
          </div>
        </div>
      </section>

      <section class="section" id="dashboard" aria-labelledby="dash-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Your dashboard</span>
            <h2 id="dash-h">Your bookings and your money in one place</h2>
            <p>Collect money however you already do, and Pawservation keeps the count.</p>
          </div>
          <div
            class="mockdash"
            role="img"
            aria-label="The sitter dashboard's bookings list: two pending requests with Confirm and Decline buttons, and a confirmed booking with a Payments button"
          >
            <div class="mockdash-top">
              <span class="mockdash-title">Bookings</span>
              <span class="mockdash-count">2 pending</span>
              <span class="mockdash-when">November 2026</span>
            </div>
            <div class="mock-row">
              <div class="mock-info">
                <div class="mock-who">Jess D. &middot; Boarding</div>
                <div class="mock-meta">Nov 14 &ndash; Nov 17 &middot; 1 pet &middot; $150</div>
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
                <div class="mock-meta">Nov 12, 9:00 AM &middot; 1 pet &middot; $20</div>
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
                <div class="mock-meta">Nov 6 &middot; 2 pets &middot; $70 &middot; paid in full</div>
              </div>
              <span class="state state-ok">Confirmed</span>
              <div class="mock-actions">
                <span class="mbtn mbtn-line">Payments</span>
              </div>
            </div>
          </div>
          <div class="features features-4">
            <div class="feature">
              <h3>Services and rates</h3>
              <p>Walks, drop-ins, boarding, house sitting and daycare, at your own prices.</p>
            </div>
            <div class="feature">
              <h3>Clients and pets</h3>
              <p>Add clients by email or import your list, and keep care notes on each pet.</p>
            </div>
            <div class="feature">
              <h3>Who owes you</h3>
              <p>Log cash, Venmo, Zelle, PayPal or a check, and each household&rsquo;s balance updates itself. Upload the CSV from Venmo and a month of payments matches up at once.</p>
            </div>
            <div class="feature">
              <h3>Google Calendar</h3>
              <p>Bookings show up on the calendar you already keep. Skip it and everything else works the same.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="story" aria-labelledby="story-h">
        <div class="wrap">
          <div class="section-head story-head">
            <span class="label">Who&rsquo;s behind it</span>
            <h2 id="story-h">Made by a dog walker, for his own business first</h2>
            <p>Pawservation is built by Brad, a dog walker and pet sitter who got tired of running his own business out of a text thread. <a href="/about">Read why he built it</a>.</p>
            ${testimonialsHtml()}
            <p>Want to see it first? <a href="/demo">Try the demo</a> and book a stay as a client.</p>
          </div>
        </div>
      </section>

      <section class="section" id="pricing" aria-labelledby="pricing-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Pricing</span>
            <h2 id="pricing-h">$${PRICING.soloMonthly} a month</h2>
            <p>${PRICE_LINE} Unlike a marketplace app, neither plan takes a cut of your bookings.</p>
          </div>
          <div class="price-grid">
            <div class="price-card">
              <div class="price-head">
                <h3>Solo</h3>
              </div>
              <p class="price-amt">
                <span class="price-num">$${PRICING.soloMonthly}</span>
                <span class="price-per">a month</span>
              </p>
              <p class="price-tag">Your booking link and calendar</p>
              <ul class="price-list">
                <li>Your booking page, at a link or on your website</li>
                <li>Your services, prices, time off and cancellation policy, applied for you</li>
                <li>Clients change and cancel their own bookings</li>
                <li>Client and pet records, and one running balance per household</li>
                <li>Google Calendar sync</li>
                <li>No AI talks to your clients unless you add Pro and switch it on</li>
              </ul>
              <a class="btn btn-primary" href="/signup">Sign up</a>
              <p class="note">Your ${PRICING.trialDays}-day free trial needs no card to start.</p>
            </div>
            <div class="price-card">
              <div class="price-head">
                <h3>Pro</h3>
                <span class="badge">Books by WhatsApp</span>
              </div>
              <p class="price-amt">
                <span class="price-num">$${PRICING.proMonthly}</span>
                <span class="price-per">a month</span>
              </p>
              <p class="price-tag">Adds booking by WhatsApp, cards and deposits</p>
              <ul class="price-list">
                <li>Everything in Solo</li>
                <li>Booking by WhatsApp on your own business number, with a friendly AI assistant and Confirm and Decline alerts</li>
                <li>Card payments through your own Stripe account, with no cut for Pawservation</li>
                <li>A back-office helper that tells you who owes you and what your week looks like</li>
                <li>Clients who use an AI assistant can connect it and book with you</li>
              </ul>
              <a class="btn btn-primary" href="/signup">Sign up</a>
              <p class="note">$${PRICING.proMonthly} a month or $${PRICING.proAnnual} a year. Paying yearly saves $${PRICING.proMonthly * 12 - PRICING.proAnnual}.</p>
            </div>
          </div>
          <p class="note wf-more">${TRIAL_LINE}</p>
        </div>
      </section>

      <section class="section band" id="faq" aria-labelledby="faq-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Questions</span>
            <h2 id="faq-h">Questions sitters ask</h2>
          </div>
          <div class="faq-list">
            <details class="faq-item">
              <summary>Do I need a website?</summary>
              <div class="faq-a">
                <p>No. Every account comes with a booking page at its own link. Text it to clients or put it in your Instagram bio.</p>
              </div>
            </details>
            <details class="faq-item">
              <summary>Do my clients need an app?</summary>
              <div class="faq-a">
                <p>No. Your booking page opens in any browser, and clients sign in with a code we email them. On Pro they can message you on WhatsApp instead.</p>
              </div>
            </details>
            <details class="faq-item">
              <summary>Do I need a new phone number for WhatsApp?</summary>
              <div class="faq-a">
                <p>The simplest way is a second number just for bookings, such as a second line from your phone company. If you already use the WhatsApp Business app for your pet business, you may be able to keep that number. The <a href="/getting-started/whatsapp">WhatsApp setup guide</a> walks you through both.</p>
              </div>
            </details>
            <details class="faq-item" id="faq-website">
              <summary>Have a website? Here&rsquo;s how the booking page goes on it.</summary>
              <div class="faq-a">
                <p>Copy one line from <strong>Settings &rarr; Your website</strong> in your dashboard, where it already carries your business&rsquo;s name. On Squarespace, add a Code block and paste it. On Wix, choose &ldquo;Embed a site&rdquo; and use the second code shown there.</p>
                <p>It&rsquo;s safe on a public page, because only your clients can book. A new visitor gets a welcome under your name, a sign-in box, and a note to get in touch with you so you can add them.</p>
                <p><a href="/getting-started#booking-page">Add it to your website, step by step</a>.</p>
              </div>
            </details>
            <details class="faq-item">
              <summary>What does it cost to take cards?</summary>
              <div class="faq-a">
                <p>Card payments are part of Pro and run through your own Stripe account. You pay Stripe&rsquo;s standard rate on each payment ${STRIPE_LINK} and no fee to Pawservation, and Stripe pays you directly.</p>
              </div>
            </details>
            <details class="faq-item">
              <summary>Can I cancel?</summary>
              <div class="faq-a">
                <p>Yes, any time, from &ldquo;Manage plan&rdquo; in your dashboard. Your records stay yours, and you can download them as spreadsheets first.</p>
              </div>
            </details>
          </div>
        </div>
      </section>

      <section class="cta-band" aria-labelledby="invite-h">
        <div class="wrap">
          <div class="cta-panel">
            <h2 id="invite-h">Try it with your own clients</h2>
            <p>Enter your email and we&rsquo;ll email you a sign-up link. Set up your services and prices, and send your booking link the same day.</p>
            <div class="cta-row">
              <a class="btn btn-inverse" href="/signup">Sign up</a>
              <a class="signin-inverse" href="/admin">Already have an account? Sign in</a>
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
 * The tour at /how-it-works — the page the landing links to when someone wants the whole picture
 * before signing up. Same constraints as the landing: served under LOCKED_CSP, so it is
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
 *
 * Notes on the markup, kept here so none of them is served:
 * - `.nav-links-5`: the header carries five links and the same right-hand pair the landing does,
 *   and it wrapped onto a second line from 780px to 829px. The class is the row tuning that already
 *   exists for a five-link header rather than a second copy of it; its measurements are in
 *   PAGE_STYLE.
 * - The screenshots are the landing page's own, already inside its weight budget; how to retake
 *   them is in docs/landing-screenshots.md.
 * - `#pro` states what Pro adds in the landing page's own words. The assistant leads because it is
 *   the time back; card payments are one card, not the headline. The Stripe arrangement itself is
 *   stated ONCE on this page, in the Services aside, so the card names only the fee terms
 *   (how-it-works.test.ts counts it). Not a nav destination: the five-link row is measured for five.
 * - `#limits` is the honesty section. Each line is a plain limit a sitter would otherwise meet
 *   after paying, and several are pinned from landing.test.ts as well as this page's own test,
 *   because the landing page dropped its FAQ and these are where those answers went.
 * - The four rules moved there from /about on 2026-09-09, when the owner narrowed that page to why
 *   it exists and who made it. They are stated on no other page. The money rule states what the
 *   Services aside does not (no cut, no funds held, on either plan) and stops.
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
            <a class="btn btn-primary" href="/signup">Sign up</a>
            <a class="btn btn-ghost" href="/demo">Try the demo</a>
          </div>
          <p class="note">
            The demo shows two made-up sitters&rsquo; booking pages, so there is nothing to sign up for and
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
              Only clients you have added can book. Anyone else sees your name and a sign-in box,
              with a note to get in touch with you so you can add them.
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
              <p>Clients message your own WhatsApp number, and an AI assistant answers and takes the request for you to confirm. <a href="#pro">More on Pro</a>.</p>
            </div>
          </div>
          <p class="note wf-more">
            On your booking page, a client picks a service, picks the dates or a visit time, chooses
            which of their pets are coming, sees the price and answers your intake questions.
          </p>
          <div class="wf-math">
            <div class="wf-pair">
              <p class="wf-keep">No repeating bookings on the booking page yet.</p>
              <p>A client who wants a walk every Tuesday picks each Tuesday there, and there is no &ldquo;repeat weekly&rdquo; to set. On Pro they can ask the assistant instead, for every Tuesday and Thursday until the end of November, say: it lists each date with its price for them to approve, up to 60 dates at a time, and every one still comes to you to confirm. They can cancel the rest of a run the same way.</p>
            </div>
          </div>
          <ol class="steps">
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-services.webp"
                  alt="The widget's service cards: Boarding selected, beside House sitting, Daycare, Walk, Check-in and Morning walk"
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
                  alt="The November month grid with the 14th to the 17th selected: days off struck through, nearly full days ringed, and the client's own bookings dotted"
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
                  alt="The Request Booking button beside the quote for the stay: 3 nights, $150.00"
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

      <section class="section" id="pro" aria-labelledby="pro-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Pro</span>
            <h2 id="pro-h">On Pro, a friendly AI assistant takes the routine questions</h2>
            <p>
              The assistant answers your clients with your rates, your rules and your open dates:
              whether you&rsquo;re free, what a stay costs, moving a date, what they owe. Every
              booking it takes still waits for you. You can switch it off any time. It has a daily allowance, and when that runs
              out clients are pointed to your booking page, which always works.
            </p>
          </div>
          <div class="features features-3">
            <div class="feature">
              <h3>Booking by WhatsApp</h3>
              <p>Clients message your own WhatsApp number to book, get a quote, reschedule or cancel. Each new request reaches you as a WhatsApp alert with Confirm and Decline buttons, and your client hears the answer.</p>
            </div>
            <div class="feature">
              <h3>A helper for your back office</h3>
              <p>Ask who still owes you or what next week looks like, and get the answer from your own records.</p>
            </div>
            <div class="feature">
              <h3>Card payments</h3>
              <p>Take deposits. A client who pays one can save the card and allow charges after each stay, and then what that booking still owes is charged the morning after it ends. Clients who don&rsquo;t opt in pay you the way they do now. You pay Stripe&rsquo;s published rate and no fee to Pawservation ${STRIPE_LINK}.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="setup" aria-labelledby="setup-h">
        <div class="wrap install-grid">
          <div class="install-copy">
            <span class="label">Getting started</span>
            <h2 id="setup-h">Three steps to a booking page</h2>
            <p><strong>Sign up.</strong> Enter your email on the homepage and we will email you a sign-up link.</p>
            <p><strong>Set up your services and rates.</strong> The wizard offers presets, each a whole service already shaped, so you tap the ones that describe you and type your prices.</p>
            <p><strong>Share your booking page.</strong> No website? Copy your booking link from <strong>Settings &rarr; Your website</strong>, and send it to clients. Have a website? Copy the code from the same place, already carrying your business&rsquo;s name, and paste it into a Code block on Squarespace, or use the second code with Wix&rsquo;s &ldquo;Embed a site&rdquo;. It sizes itself to fit.</p>
            <p class="note">${PRICE_LINE} Pro adds booking by WhatsApp, card payments and a back-office helper. You pay Stripe&rsquo;s published rate on a card payment and no fee to Pawservation.</p>
            <p class="note">${TRIAL_LINE}</p>
            <p class="note">Want every step written out, from your first sign-in to connecting WhatsApp? Read the <a href="/getting-started">setup guide</a>.</p>
          </div>
          <div class="codecard">
            <div class="codecard-cap">
              <span>your-page.html</span>
              <span>paste &amp; save</span>
            </div>
            <div class="code-scroll">
<pre><span class="tag">&lt;script</span> <span class="attr">src</span>=&quot;${BRAND_ORIGIN}/embed.js&quot;
        <span class="attr">data-pawservation-tenant</span>=&quot;your-business&quot;
        <span class="attr">data-height</span>=&quot;520&quot;<span class="tag">&gt;&lt;/script&gt;</span></pre>
            </div>
            <div class="codecard-cap">
              <span>or, on Wix and builders that strip scripts</span>
              <span>second code</span>
            </div>
            <div class="code-scroll">
<pre><span class="tag">&lt;iframe</span> <span class="attr">src</span>=&quot;${BRAND_ORIGIN}/embed/your-business&quot;
        <span class="attr">title</span>=&quot;Booking widget&quot;
        <span class="attr">style</span>=&quot;width:100%;height:640px;border:0;&quot;<span class="tag">&gt;&lt;/iframe&gt;</span></pre>
            </div>
          </div>
        </div>
      </section>

      <section class="section" id="limits" aria-labelledby="limits-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Good to know</span>
            <h2 id="limits-h">Good to know before you start</h2>
          </div>
          <div class="wf-math">
            <div class="wf-pair">
              <p class="wf-keep">One sitter per account.</p>
              <p>Pawservation is made for one person running her own book.</p>
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
            <p>Enter your email and we will email you a sign-up link; the wizard then sets up your services, rates and booking page. Or poke at the demo first: nothing to sign up for and nothing you can break.</p>
            <div class="cta-row">
              <a class="btn btn-inverse" href="/signup">Sign up</a>
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
 * The Privacy Policy at /privacy — same LOCKED_CSP, PAGE_STYLE-only constraints (script-free bar the analytics beacon) as
 * every other static page here. Content is grounded in what this codebase actually does (see the
 * design doc's audit); this is not a substitute for legal review before it is a real business's
 * live policy. "Who we share it with" names every processor the code calls, premium's included
 * (Stripe, Anthropic, Meta), and "What we measure" names, page by page, where `marketingHtml` may
 * add the analytics beacon (`server/lib/web-analytics.ts`) and where Turnstile runs; either list
 * changes in the same commit as the code it describes.
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
          <p class="note">Last updated: October 8, 2026</p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h2>What we collect</h2>
            <p>From customers: their name, email, phone, their pets&rsquo; names and any care notes they give their sitter, and the answers they give to their sitter&rsquo;s own booking questions. From sitters: your login email and a securely hashed password; we never store your password itself. <strong>We never collect or store card numbers, on either plan.</strong> Payments you log are just a record of money you already collected outside Pawservation (cash, Venmo, Zelle, PayPal, check or card). On Pro, a card is entered on a page hosted by Stripe, which holds the card details under the sitter&rsquo;s own Stripe account; Pawservation stores only that a payment happened and its amount. On Pro, we also keep transcripts of conversations with its AI features, described in the next section.</p>
          </div>
          <div class="feature">
            <h2>Conversations with Pro&rsquo;s AI features</h2>
            <p>When a client or a sitter uses one of Pro&rsquo;s AI features, we keep a transcript of the messages they send and the assistant&rsquo;s replies, stored on Pawservation&rsquo;s own systems. That covers the booking assistant that answers clients on WhatsApp and the sitter&rsquo;s back-office helper. When a client connects their own AI assistant, we keep only what that assistant sends to Pawservation (its requests and our answers), not the client&rsquo;s own conversation with their assistant.</p>
            <p>Before a transcript is stored, we remove verification codes and any other standalone six-digit number, booking confirmation codes, and payment links.</p>
            <p>The Pawservation operator reads these transcripts to support customers, fix problems, and improve the service. A sitter on Pro can also read the conversations her own clients had with the friendly AI assistant, on WhatsApp and in the chat on her booking page, from the day booking by message began (October 6, 2026). She sees only her own clients, can&rsquo;t edit or delete what was said, and never sees verification codes or payment links. She can&rsquo;t see what you ask your own AI assistant, or the conversations of any other sitter&rsquo;s clients. Your sitter can read what you and the assistant said to each other.</p>
            <p>Messages are also checked automatically for profanity, and a flagged word is recorded alongside the message, as a sign that someone may be having trouble. It is never used to make any decision about the person.</p>
          </div>
          <div class="feature">
            <h2>Who we share it with</h2>
            <p>These are every company that handles data for Pawservation, and what each one sees.</p>
            <p><strong>Cloudflare</strong> hosts the product and its database: everything above lives on Cloudflare&rsquo;s infrastructure. Cloudflare also runs two small scripts on our own pages, described under &ldquo;What we measure&rdquo; below: Web Analytics on the public marketing pages, and Turnstile on the sign-up page, which checks that the person signing up is a person and not a bot.</p>
            <p><strong>Resend</strong> sends our email (login codes, sign-up links, booking confirmations, password-reset links) and nothing else; we don&rsquo;t use it for marketing.</p>
            <p><strong>Google</strong> only sees booking data if a sitter connects Google Calendar, and only enough to write an event: pet names, times, cost, and the client&rsquo;s email address.</p>
            <p><strong>Stripe</strong> processes a sitter&rsquo;s Pawservation subscription; the card for it is entered on Stripe&rsquo;s own page, and we never see the card number. On Pro, a client&rsquo;s card payment is also processed by Stripe, under the sitter&rsquo;s own Stripe account.</p>
            <p><strong>Anthropic</strong> provides the AI model behind the booking assistant that answers clients on WhatsApp and the sitter&rsquo;s back-office helper. When someone uses one of those, what they type and the booking details needed to answer them (dates, pets, prices) are sent to Anthropic&rsquo;s model to write the reply. A client who connects their own AI assistant uses that assistant&rsquo;s model, not ours.</p>
            <p><strong>Meta</strong> carries WhatsApp messages, only if a sitter on Pro connects WhatsApp: a client&rsquo;s messages to that sitter and the replies pass through Meta&rsquo;s WhatsApp service.</p>
          </div>
          <div class="feature">
            <h2>Cookies</h2>
            <p>We set exactly one cookie, for ten minutes, only while a sitter is connecting Google Calendar, to stop a cross-site request forgery attack during that one step. There are no cookies for signing in or for tracking you. Customers, sitters and the platform owner all sign in without one.</p>
          </div>
          <div class="feature">
            <h2>How long we keep it</h2>
            <p>Cancelled and declined bookings stay on the record as part of your sitter&rsquo;s booking history, the same way a paper ledger would keep them. Login codes and one-time links expire in minutes and can&rsquo;t be reused. A sitter can delete a client who has no booking history, and can ask us to delete an entire account&rsquo;s data.</p>
            <p>Transcripts of conversations with Pro&rsquo;s AI features are kept with no set deletion date, and we can&rsquo;t currently erase one person&rsquo;s messages from them on request. Texting STOP on WhatsApp stops the messages; it doesn&rsquo;t delete the transcript.</p>
          </div>
          <div class="feature">
            <h2>Children</h2>
            <p>Pawservation is not directed at children, and we don&rsquo;t knowingly collect data from them.</p>
          </div>
          <div class="feature">
            <h2>What we measure</h2>
            <p>Our public marketing pages (the homepage, the tour, the setup guides, About, Contact, this policy, the Terms, the sign-up page and the page you see after signing up) use <strong>Cloudflare Web Analytics</strong> to count page views: which page was viewed, the site that linked to it, and the browser, device type and country. It sets no cookies, stores nothing on your device, and does not fingerprint you, so it cannot follow you from one visit or one site to the next. <strong>It is never on a sitter&rsquo;s booking page, the booking widget, the dashboard, or any page you sign in to</strong>, and we run no ad pixels anywhere.</p>
            <p>The only third-party scripts our security policy lets any of our pages load are that analytics script on the marketing pages and Cloudflare Turnstile on the sign-up page. Everything else on every page, including the booking widget and the dashboard, is served by Pawservation itself.</p>
            <p>When a sitter signs up, we also record where the sign-up came from: the campaign tag on the link they followed, if it had one, and the address of the site that linked to us (only the site, such as reddit.com, never the page). That goes only into the email we receive about the new sign-up.</p>
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
 * The Terms & Conditions at /terms — same LOCKED_CSP, PAGE_STYLE-only constraints (script-free bar the analytics beacon) as
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
          <p class="note">Last updated: October 5, 2026</p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h2>What Pawservation is</h2>
            <p>Pawservation is booking and scheduling software that a pet-sitting business uses to take bookings on its own website or at a booking link it shares. Pawservation does not perform pet-sitting services, and is not a party to the agreement between a sitter and their customer.</p>
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
            <h2>Your subscription</h2>
            <p>A sitter can cancel at any time from the dashboard: <strong>Manage plan</strong> opens Stripe&rsquo;s billing page, where the subscription can be cancelled, and the card or plan changed. A cancelled subscription runs to the end of the period already paid for and is not renewed. After that, and a three-day grace period, the dashboard becomes read-only: you can still answer booking requests, block dates and record payments, your booking page keeps taking requests, and anything that needs a current plan, such as changing services or rates or syncing Google Calendar, waits until you subscribe again. For a question about a charge, including a refund, contact us at <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}">${htmlEscape(SUPPORT_EMAIL)}</a>.</p>
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
            <p>We may update these terms from time to time. We&rsquo;ll email you at least 30 days before a material change takes effect.</p>
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
 * to the sign-up page. The closing line pointing at the demo and the tour stays,
 * because it is wayfinding for a reader who has finished this page rather than a pitch. That
 * removal also took the page's only statements that this is a small independent product with no
 * sales team and that questions reach a person; /contact still says both, in its own words.
 *
 * Notes on the markup, kept here so none of them is served:
 * - `.nav-links-5`: the same five-link row the tour carries, with the same row-tuning class. The
 *   first three hrefs are absolute (/#how, /#pro, /#pricing) rather than the landing header's bare
 *   fragments, because there is no #how/#pro/#pricing section on this page, only on /.
 * - `.hero-flush`: this hero is the top of one continuous page rather than the first of several
 *   bands, so the hero's bottom padding and the next section's top padding are both dropped and
 *   the .sub's own margin becomes the gap.
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
        <nav class="nav-links nav-links-5" aria-label="Sections">
          <a href="/#how">How it works</a>
          <a href="/#pro">WhatsApp</a>
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
            <p>Use the <a href="/signup">sign-up page</a>. Enter your email and we&rsquo;ll email you a sign-up link; from there you set up your services, rates and booking page.</p>
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

app.get('/llms.txt', (c) => c.text(buildProductLlmsTxt(new URL(c.req.url).origin)));

/**
 * A landing page's "Sign up" links, rewritten per request to carry the outreach link's UTM tags and
 * the ORIGIN of the site that linked here (`server/lib/attribution.ts`) on to /signup — because the
 * Referer /signup itself sees is this page. Applied to the pages an outreach link points at:
 * `/` and the three setup guides. No attribution, no rewrite: the page is byte-identical.
 */
function withSignupAttribution(c: Context<AppEnv>, html: string): string {
  const query = attributionQuery(attributionFromRequest(c));
  return query ? html.replaceAll('href="/signup"', `href="/signup${query}"`) : html;
}

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
  return marketingHtml(c, withSignupAttribution(c, LANDING_HTML));
});
// Listed in wrangler.jsonc's run_worker_first as the BARE path "/how-it-works" — a glob does not
// match it. Today nothing is emitted at that path, so it would reach the worker regardless (as
// "/" does, which is not listed); the entry is defensive, so that if a build ever emits an asset
// there it can never shadow this route.
app.get('/how-it-works', (c) => marketingHtml(c, HOW_IT_WORKS_HTML));
app.get('/about', (c) => marketingHtml(c, ABOUT_HTML));
app.get('/contact', (c) => marketingHtml(c, CONTACT_HTML));
app.get('/privacy', (c) => marketingHtml(c, PRIVACY_HTML));
app.get('/terms', (c) => marketingHtml(c, TERMS_HTML));
app.get('/getting-started', (c) =>
  marketingHtml(c, withSignupAttribution(c, GETTING_STARTED_HTML)),
);
app.get('/getting-started/whatsapp', (c) =>
  marketingHtml(c, withSignupAttribution(c, WHATSAPP_GUIDE_HTML)),
);
app.get('/getting-started/card-payments', (c) =>
  marketingHtml(c, withSignupAttribution(c, CARD_GUIDE_HTML)),
);

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
