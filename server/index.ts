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
import type { AppEnv } from './types';

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
    titled.replace('</head>', () => `${canonical}${ldScript}</head>`),
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

// Every price figure on the landing page interpolates from here — never hardcode one in the
// markup. The Free tier's "$0" is deliberately literal: free is the promise, not a price point.
const PRICING = { proMonthly: 29, proAnnual: 290 } as const;

/**
 * The shared page footer. Extracted when /about and /contact would have made it a SIXTH hand-kept
 * copy of the same markup — the four that existed had already drifted into two variants that
 * differed only in one link's label and one anchor's href, which is the drift a fifth and sixth
 * copy guarantees rather than risks. Every link here is absolute (`/#faq`, not `#faq`) so one
 * version serves every page: from the landing itself an absolute same-page hash still just scrolls.
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
              <li><a href="/#faq">FAQ</a></li>
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
    <meta property="og:image:alt" content="Pawservation — pet sitting and dog walking software" />
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
      'Pet Sitting &amp; Dog Walking Software &mdash; Pawservation',
      'Free booking software for pet sitters and dog walkers. Put a booking page on your own website: your services and rates, your availability rules, client and pet records, payments and what you&rsquo;re owed, and two-way Google Calendar sync.',
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
          <a href="/how-it-works">Full tour</a>
          <a href="#dashboard">Dashboard</a>
          <a href="#workflow">Your workflow</a>
          <a href="#pricing">Pricing</a>
          <a href="#install">Install</a>
          <a href="#faq">FAQ</a>
        </nav>
        <div class="nav-right">
          <a class="signin" href="/admin">Sign in</a>
          <a class="btn btn-primary btn-sm" href="/demo">Try the demo</a>
        </div>
      </div>
    </header>

    <main>
      <section class="hero">
        <div class="wrap hero-grid">
          <div class="hero-copy">
            <p class="chip">Pet sitting &amp; dog walking software</p>
            <h1>Your booking page, on your own website.</h1>
            <p class="sub">
              Pawservation is pet sitting and dog walking software: a booking widget that lives
              on your own site, with your services and your rates. Clients request the dates, you confirm or decline, and it
              keeps track of what you&rsquo;re owed.
            </p>
            <div class="cta-row">
              <a class="btn btn-primary" href="/demo">Try the demo</a>
              <a class="btn btn-ghost" href="#invite-h">Ask for an invite</a>
            </div>
            <p class="note">
              The demo is a made-up sitter&rsquo;s account &mdash; nothing to sign up for, none of
              your own details asked for, nothing you can break. Pawservation itself is
              invite-only while it grows &mdash; <a href="/admin">sign in</a> if you already have
              an account.
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
            <p>The widget shows only what you offer and only when you can take it. Nothing is booked until you say so.</p>
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
                <p>Your services, under your names and your prices &mdash; boarding, daycare, walks, or anything you invent.</p>
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
                <p>Days you can&rsquo;t take aren&rsquo;t offered: a full day, the weekends of a weekday-only service, anything sooner than your notice or further out than your horizon. It counts the pets they picked, so a day with one space left isn&rsquo;t offered to a two-dog household.</p>
              </div>
            </li>
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-request.webp"
                  alt="Booking summary showing the selected dates, an estimated cost of $150, and a Send request button"
                />
              </div>
              <div class="step-body">
                <span class="step-no">03</span>
                <h3>They send the request &mdash; you confirm it</h3>
                <p>A request arrives with dates, pets, and an estimated cost. Nothing is booked until you say so.</p>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section class="section" id="dashboard" aria-labelledby="dash-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Your dashboard</span>
            <h2 id="dash-h">Every request, every dollar, in one place</h2>
            <p>Requests wait for your confirm or decline; clients hear back by email automatically. Nothing books itself.</p>
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
                <div class="mock-who">Jess D. &mdash; Boarding</div>
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
                <div class="mock-who">Priya S. &mdash; Morning walk</div>
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
                <div class="mock-who">Marco T. &mdash; Daycare</div>
                <div class="mock-meta">Aug 8 &middot; 2 pets &middot; $70 &middot; paid in full</div>
              </div>
              <span class="state state-ok">Confirmed</span>
              <div class="mock-actions">
                <span class="mbtn mbtn-line">Payments</span>
              </div>
            </div>
          </div>
          <div class="features">
            <div class="feature">
              <h3>Rates &amp; services</h3>
              <p>Boarding, house sitting, daycare, walks, check-ins, or your own custom service &mdash; each with its own price.</p>
            </div>
            <div class="feature">
              <h3>Caps &amp; time off</h3>
              <p>A boarding cap, a house-sit cap, a longest stay, days of notice, how far ahead people may book, your days off. A full day isn&rsquo;t offered.</p>
            </div>
            <div class="feature">
              <h3>Clients &amp; pets</h3>
              <p>Invite by email or import a CSV. Keep profiles and care notes for every animal.</p>
            </div>
            <div class="feature">
              <h3>Payments</h3>
              <p>Cash, Venmo, Zelle, PayPal, check &mdash; log deposits and partials, see what&rsquo;s outstanding. Upload the CSV from Venmo and match a month of payments to clients in one pass.</p>
            </div>
            <div class="feature">
              <h3>Earnings</h3>
              <p>This month against last, what&rsquo;s still owed, and a year of revenue at a glance.</p>
            </div>
            <div class="feature">
              <h3>Google Calendar</h3>
              <p>Requests land on your calendar instantly and update when you confirm, so your week is where you already look.</p>
            </div>
            <div class="feature">
              <h3>Clients change their own bookings</h3>
              <p>New dates, a different pet, a cancellation &mdash; they do it themselves instead of texting you. A change comes back for your approval; a cancellation applies whatever fee your policy says and emails you.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="workflow" aria-labelledby="workflow-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Alongside your workflow</span>
            <h2 id="workflow-h">It goes in front of what you already do</h2>
            <p>
              Nothing to migrate, nothing to switch off. Pawservation takes the
              &ldquo;are you free?&rdquo; question off your phone and leaves the rest of how you
              work exactly where it is.
            </p>
          </div>
          <div class="wf-grid">
            <div>
              <h3 class="wf-h">What stays exactly as it is</h3>
              <p class="note">Five things that don&rsquo;t change on the day you start.</p>
              <div class="wf-pair">
                <p class="wf-keep">You keep collecting money your own way.</p>
                <p>Cash, Venmo, Zelle, a check on the counter &mdash; you take it and you keep it. Pawservation records what came in and shows what&rsquo;s still outstanding. It never touches the money.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">You keep living in Google Calendar.</p>
                <p>Connect it once and bookings appear there, updating when you confirm. The sync runs both ways &mdash; it writes your bookings out, and something you add to that calendar by hand blocks matching requests here too. Every other calendar in your account is left alone.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">You keep the website you already have.</p>
                <p>One line of HTML on a page you already publish. No rebuild, no move, no second site to keep in step with the first.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">Your clients stay your clients.</p>
                <p>You add each one before they can book, and there&rsquo;s a CSV import for the list you already have. No marketplace, no directory, nobody browsing for a sitter.</p>
              </div>
              <div class="wf-pair">
                <p class="wf-keep">You keep taking texts &mdash; about the pets.</p>
                <p>The widget answers the repetitive question &mdash; what you offer, when you&rsquo;re free, what it costs. That was never the part of the thread that was about the animals. What&rsquo;s left is: the pills at six, the reactive shepherd on the corner, how the old cat did last week. Every other conversation stays where it was, and it&rsquo;s the one worth having.</p>
              </div>
            </div>
            <div>
              <h3 class="wf-h">Moving over, without moving anything</h3>
              <p class="note">Four small steps, none of them destructive.</p>
              <ol class="wf-steps">
                <li class="wf-step">
                  <span class="step-no">01</span>
                  <p><strong>Connect Google Calendar, or skip it.</strong> One link under Connected apps and your bookings start showing up on the calendar you already keep. Skip it and nothing else works differently.</p>
                </li>
                <li class="wf-step">
                  <span class="step-no">02</span>
                  <p><strong>Enter your services, rates, and caps once.</strong> What you call each service, what it costs, how much you&rsquo;ll take at a time, the longest stay you&rsquo;ll do &mdash; and the days you&rsquo;re off.</p>
                </li>
                <li class="wf-step">
                  <span class="step-no">03</span>
                  <p><strong>Add your clients.</strong> Type in the emails you already have, or upload a CSV &mdash; there&rsquo;s an example file to copy the columns from. Pets and care notes sit on their profiles.</p>
                </li>
                <li class="wf-step">
                  <span class="step-no">04</span>
                  <p><strong>Paste one line on your site, then point people at it.</strong> Next time someone asks whether you&rsquo;re free, send them the page instead of answering from memory. Anyone who&rsquo;d rather text you still can.</p>
                </li>
              </ol>
            </div>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">How much time that is &mdash; do the sum yourself</h3>
            <p>An &ldquo;are you free the 12th to the 15th?&rdquo; thread is usually four or five messages spread across an afternoon. Call it a quarter of an hour of your attention, in pieces. The widget answers that from your own caps and your own time off, so the thread never starts:</p>
            <p class="wf-sum">8 requests a month &times; 15 min &asymp; 2 hours a month</p>
            <p>Those are illustrative numbers, not a measured finding &mdash; put your own request count, and your own idea of what one back-and-forth costs you, into the same multiplication. Two smaller ones work the same way: the questions you set per service arrive already answered with the request instead of being asked over text, and &ldquo;who still owes me?&rdquo; is a number on the Earnings page instead of a memory exercise.</p>
            <p>What those messages were about matters as much as how many of them there were. They were about dates and prices, not about the dog. Take them off the thread and what reaches you from a client is a care question. Your client gets the other half of that: they open the page at eleven at night and see which of their dates you can take, instead of waiting on a reply from you. What they still wait for is your yes &mdash; every request stays pending until you confirm it.</p>
          </div>
        </div>
      </section>

      <section class="section" id="pricing" aria-labelledby="pricing-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Pricing</span>
            <h2 id="pricing-h">Taking bookings is free, and stays free</h2>
            <p>
              Your booking page, your availability, and keeping track of what you&rsquo;re owed
              cost nothing &mdash; there is no trial and no card to enter. A paid tier is planned
              for the extras on top, and it isn&rsquo;t built yet.
            </p>
          </div>
          <div class="price-grid">
            <div class="price-card">
              <div class="price-head">
                <h3>Free</h3>
                <span class="state price-tag-live">Available now</span>
              </div>
              <p class="price-amt">
                <span class="price-num">$0</span>
                <span class="price-per">for one sitter</span>
              </p>
              <ul class="price-list">
                <li>Booking widget on your own site, unlimited bookings</li>
                <li>Availability, capacity caps, and conflict rules</li>
                <li>Minimum notice and a booking horizon</li>
                <li>Rates, logged payments, and outstanding balances &mdash; one bill for a whole household</li>
                <li>Cancellation policies, applied for you</li>
                <li>Clients reschedule and cancel their own bookings</li>
                <li>Client accounts and pet profiles</li>
                <li>Google Calendar sync, both directions</li>
              </ul>
              <a class="btn btn-primary" href="#invite-h">Ask for an invite</a>
              <p class="note">New sitters are added by hand for now &mdash; ask, and we&rsquo;ll email you a sign-up link.</p>
            </div>
            <div class="price-card price-card-soon">
              <div class="price-head">
                <h3>Pro</h3>
                <span class="state price-tag-soon">In development</span>
              </div>
              <p class="price-amt">
                <span class="price-num">$${PRICING.proMonthly}</span>
                <span class="price-per">per sitter, per month</span>
              </p>
              <ul class="price-list">
                <li>Everything in Free</li>
                <li>AI concierge &mdash; clients check availability and book by chat</li>
                <li>Connect an AI assistant (like Claude) to check availability and book on your behalf &mdash; less back-and-forth, less time in your inbox</li>
                <li>Back-office assistant &mdash; ask who owes you, what your week looks like, and which pet combinations your clients can&rsquo;t book yet because they have no price</li>
                <li>Card payments &mdash; deposits, saved cards, auto-charge</li>
                <li>Extra sitters, with assignment</li>
              </ul>
              <p class="price-unavail">Not available yet &mdash; nothing here is built or for sale.</p>
              <p class="note">Planned at $${PRICING.proMonthly} per sitter per month, or $${PRICING.proAnnual} per sitter per year &mdash; $${PRICING.proMonthly * 12 - PRICING.proAnnual} less than paying by the month.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="install" aria-labelledby="install-h">
        <div class="wrap install-grid">
          <div class="install-copy">
            <span class="label">Install</span>
            <h2 id="install-h">One line on any website</h2>
            <p>Paste it into Squarespace, Wix, or any page, change the slug &mdash; the short name in your booking page&rsquo;s web address &mdash; to yours, and save. The widget sizes itself to fit.</p>
            <p>If your host strips scripts, paste the plain-iframe version instead &mdash; same widget, no JavaScript needed.</p>
            <p>Not the person who edits your website? Forward this box to whoever is &mdash; it&rsquo;s one line, and it&rsquo;ll take them under a minute.</p>
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

      <section class="section" id="faq" aria-labelledby="faq-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">FAQ</span>
            <h2 id="faq-h">Common questions</h2>
          </div>
          <div class="qa">
            <div class="qa-item">
              <h3>Will it work on my Squarespace or Wix site?</h3>
              <p>Yes. Paste the script line or the iframe version into a page and the widget shows up, sized to fit. Plain HTML sites work too.</p>
            </div>
            <div class="qa-item">
              <h3>Do customers pay by card here?</h3>
              <p><strong>No.</strong> Pawservation tracks money but doesn&rsquo;t take it. A booking arrives with an estimated cost; you collect it yourself (cash, Venmo, Zelle, check) and log the payment so your earnings stay accurate. Two clients sharing a pet are one household on your books, so you can send one bill for the whole household instead of chasing separate payments per booking.</p>
            </div>
            <div class="qa-item">
              <h3>Can it double-book me?</h3>
              <p><strong>No.</strong> Your caps and your time off hold the day, and a request holds its space from the moment it arrives &mdash; not from when you confirm it. Caps count animals, so a booking for three dogs needs three spaces free; a day that can&rsquo;t fit them isn&rsquo;t offered. If you&rsquo;ve connected Google Calendar, an event you keep there blocks matching requests too &mdash; sync runs both ways, which also means deleting a booking&rsquo;s event in Google cancels that booking and emails your client.</p>
            </div>
            <div class="qa-item">
              <h3>Can a client change or cancel a booking themselves?</h3>
              <p><strong>Yes &mdash; that&rsquo;s the point.</strong> They can move the dates, swap the pets, or cancel, from the same page they booked on. A change comes back to you as pending, so you re-approve it rather than discovering it. A cancellation applies the fee your own policy says &mdash; worked out here, not typed in by them &mdash; and emails you either way.</p>
            </div>
            <div class="qa-item">
              <h3>Does this put something between me and my clients?</h3>
              <p><strong>Only the scheduling part.</strong> &ldquo;Are you free the 12th?&rdquo; gets answered on the page, from your own caps, your notice period and your time off, so your client sees which dates you can take the moment they look instead of waiting on a text back. Everything else &mdash; how the old cat is doing, the pills at six, where the key is &mdash; still comes straight to you. And every request is still pending until you say yes.</p>
            </div>
            <div class="qa-item">
              <h3>Can anyone book, or just my clients?</h3>
              <p><strong>Just your clients.</strong> You add each client &mdash; and their pets &mdash; before they can book. A client record always starts with at least one pet, so every request says exactly which animal is coming. Add them one at a time or import a CSV, and choose which animal types you accept.</p>
            </div>
            <div class="qa-item">
              <h3>Can my whole team use it?</h3>
              <p><strong>Not yet.</strong> Pawservation runs one sitter per account today. Extra sitters, with assignment, are part of the Pro plan &mdash; which isn&rsquo;t built yet.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="cta-band" aria-labelledby="invite-h">
        <div class="wrap">
          <div class="cta-panel">
            <h2 id="invite-h">Want in?</h2>
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
 * The long-form tour at /how-it-works — the page the landing links to when someone wants the
 * whole picture before asking for an invite. Same constraints as the landing: served under
 * LOCKED_CSP, so it is script-free, image-free, and styled only by the shared PAGE_STYLE.
 * Both embed snippets are shown as escaped text (&lt;script&gt; / &lt;iframe&gt;).
 *
 * Every claim here is behavior that ships today, and where something is NOT built the page says
 * so out loud (no repeating schedule, no way to type in a stay agreed before signing up).
 * Guardrails are enforced by server/__tests__/how-it-works.test.ts rather
 * than by convention: the page may not use the words "invoice"/"statement"/"SMS"/"AI" (none of
 * those exist), multi-pet pricing must be described as SHIPPED and as the sitter's own CHOICE —
 * per service, either "N pets costs N times the rate" or "only the combinations I priced", with a
 * combination the sitter typed always beating the multiplier and an unpriced group refused under
 * the second setting. The page may NOT carry the pre-0005 absolutes ("nothing is multiplied,
 * ever"), which stopped being true the day PetRateMode shipped —
 * and the developer nouns "idempotency"/"machine-readable"/"llms.txt" are banned from the body
 * copy — the concepts stay, in the language a pet sitter uses.
 */
const HOW_IT_WORKS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${pageHead(
      '/how-it-works',
      'How it works &mdash; Pawservation pet sitting &amp; dog walking software',
      'The full tour of Pawservation, booking software for pet sitters and dog walkers: the services you can offer, the rules that protect your calendar, how clients book, and how the money is tracked.',
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
          <a href="#services">Services</a>
          <a href="#rules">Rules</a>
          <a href="#booking">Booking</a>
          <a href="#money">Money</a>
          <a href="#calendar">Calendar</a>
          <a href="#embed">Website</a>
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
          <p class="chip">The complete tour</p>
          <h1>How it works, in full.</h1>
          <p class="sub">
            Pawservation is a booking page that lives on your own website, showing your
            services, your rates, and only the dates your rules allow. You stay in control of
            all of it &mdash; every request arrives as a request, and waits for you.
          </p>
          <div class="cta-row">
            <a class="btn btn-primary" href="/demo">Try the demo</a>
            <a class="btn btn-ghost" href="/">Back to the overview</a>
          </div>
          <p class="note">
            Everything below is built and working today. Where something isn&rsquo;t, it says so.
            The demo is a made-up sitter&rsquo;s account &mdash; nothing to sign up for, none of your
            own details asked for, nothing you can break.
          </p>
        </div>
      </section>

      <section class="section" id="services" aria-labelledby="services-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Services</span>
            <h2 id="services-h">Five kinds of service, each with its own rules</h2>
            <p>
              Every service you offer starts from one of five templates. The template decides how
              dates are chosen and how the price is counted; everything else &mdash; the name, the
              rate, the limits &mdash; is yours.
            </p>
          </div>
          <div class="features">
            <div class="feature">
              <h3>Boarding &middot; per night</h3>
              <p>Overnight stays at your place, over a range of dates. Set the most pets you&rsquo;ll keep at once and the longest stay you&rsquo;ll accept. There is no minimum stay to set: one night is the shortest thing anyone can ask for.</p>
            </div>
            <div class="feature">
              <h3>House sitting &middot; per night</h3>
              <p>You stay at the client&rsquo;s home, again over a range of dates, under its own cap. And because you can&rsquo;t be in two places at once, house sitting and boarding are held apart &mdash; by however much you say (see below).</p>
            </div>
            <div class="feature">
              <h3>Daycare &middot; per day</h3>
              <p>Daytime care at your place, priced per day. Clients pick single dates rather than a stay, so a Tuesday and a Friday are two separate bookings.</p>
            </div>
            <div class="feature">
              <h3>Walk &middot; per walk</h3>
              <p>Priced per walk, with options that carry their own length and time window &mdash; a &ldquo;Morning 30&rdquo; and an &ldquo;Evening 30&rdquo; can sit side by side at different prices.</p>
            </div>
            <div class="feature">
              <h3>Check-in &middot; per visit</h3>
              <p>Drop-in visits &mdash; feed, let out, top up the water &mdash; with the same per-option lengths and windows as walks.</p>
            </div>
            <div class="feature">
              <h3>Anything you call your own</h3>
              <p>A custom service clones one of the five, so a &ldquo;Morning walk&rdquo; behaves exactly like Walk under your name and your price. New services can&rsquo;t invent behavior the calendar doesn&rsquo;t understand.</p>
            </div>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">What you set on each one</h3>
            <div class="wf-pair">
              <p class="wf-keep">A rate in whole dollars, in a unit you can&rsquo;t get wrong.</p>
              <p>The unit belongs to the service, not to the price box: boarding is per night whether you charge forty or ninety-five. The number and the word printed beside it come from the same place, so they can never drift apart.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Options, each with a length and a fixed window.</p>
              <p>A thirty-minute walk between 10 and 2 is one option; the same walk between 4 and 6 is another. Clients pick the option, not an arbitrary time, so you&rsquo;re never booked at 6am by accident.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">A per-day limit on each option.</p>
              <p>Say your morning pack walk takes eight dogs and your solo walk takes one. Book eight dogs onto Tuesday&rsquo;s pack walk and Tuesday stops being offered for the pack walk &mdash; the solo walk still shows until its one spot goes. Each option fills up on its own, date by date, and it counts animals rather than bookings: with one place left, a household bringing two dogs isn&rsquo;t offered that day either.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Weekdays only, where that&rsquo;s the truth.</p>
              <p>Mark an option weekdays-only and its weekends are struck out in the calendar rather than quietly accepted and then declined.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">The longest stay you&rsquo;ll do.</p>
              <p>For the per-night services, set a maximum number of nights and a request longer than that never gets as far as your queue. There is deliberately no minimum: a stay is at least one night by its nature, so there was nothing honest for that box to do.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">How much notice you need.</p>
              <p>Set the days of notice a service needs and everything sooner than that is struck out. Two days on boarding means the earliest a client can ask for is the day after tomorrow &mdash; so &ldquo;can you take him tonight?&rdquo; stops being a question you have to answer. Leave it blank and same-day is fine.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">One thing that isn&rsquo;t here yet: a repeating schedule.</p>
              <p>Every visit is its own request today &mdash; a client who wants a walk every Tuesday picks each Tuesday. There is no &ldquo;repeat weekly&rdquo; to set, for you or for them.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="rules" aria-labelledby="rules-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Your rules</span>
            <h2 id="rules-h">The limits you set are the limits clients see</h2>
            <p>
              None of this is advisory. A day you can&rsquo;t take isn&rsquo;t offered, and an
              animal you don&rsquo;t accept can&rsquo;t be chosen.
            </p>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">The dials you get</h3>
            <div class="wf-pair">
              <p class="wf-keep">Caps count pets, not bookings.</p>
              <p>If you&rsquo;ll take three at a time, one booking for three dogs fills the day by itself &mdash; three pets, three slots &mdash; and the calendar strikes that day out for everyone else. That is the whole point of counting animals rather than requests.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Only the animals you actually take.</p>
              <p>Accepted pet types are set per service, so you can board dogs and do check-ins for cats without accidentally agreeing to board the cat. Each new service starts from the likely answer rather than from nothing &mdash; walks and daycare start dogs-only, check-ins start cats-only, boarding and house sitting start open to everything &mdash; and you re-tick the boxes if your business is different.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Where you physically are, when boarding meets a house sit.</p>
              <p>You can&rsquo;t sleep at a client&rsquo;s house and keep a boarder at your own, so the two are held apart, and you say by how much: never overlap, one handover day (the default), one handover day at each end of a stay, or no limit if you&rsquo;d rather sort clashes out yourself. A shared day only ever counts as a genuine handover &mdash; one thing ending as the other begins. A boarding dropped into the middle of a house sit is refused however high you set the number, because no number makes that possible.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">How far ahead anyone can book.</p>
              <p>One setting for the whole business: months out, and beyond it the calendar simply stops. New accounts start at twelve months, so nobody books your Christmas two Christmases early. Clear it and there&rsquo;s no horizon at all.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Your questions, asked at booking time.</p>
              <p>Write your own intake questions &mdash; medications, the gate code, which vet, anything you always end up asking &mdash; and they arrive answered, with the request, instead of over six texts on the day. A regular&rsquo;s answers come back already filled in the next time they book that service, so nobody retypes the gate code every month; reword the question and the stale answer is dropped rather than pre-filled.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Time off, in whole days.</p>
              <p>Mark a day &mdash; or a run of days &mdash; as time off and it simply stops being offered, struck out for every service, walks and check-ins included. Away next Tuesday? Block Tuesday and nothing else changes. Time off is whole days only: there is no way to close just the 10am walk and keep the rest of that day open.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Cancellation fees in your own windows.</p>
              <p>Set up to five windows, each a percentage of the estimated cost. When a client cancels, the tightest window that applies is the one that wins. Leave it blank and there&rsquo;s no fee at all &mdash; the policy is only what you wrote. The client cancels from the booking page and the fee is worked out here, from your stored policy, and recorded as owed &mdash; they never get to name the figure, and you never have to do the arithmetic in a difficult conversation. A request you hadn&rsquo;t confirmed yet is always free to withdraw.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section" id="booking" aria-labelledby="booking-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">For your clients</span>
            <h2 id="booking-h">Invite-only, and pending until you confirm</h2>
            <p>
              There is no public sign-up and no directory. Your client list is a list you built,
              and a booking is a request until you act on it.
            </p>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">Step by step, from your client&rsquo;s side</h3>
            <ol class="wf-steps">
              <li class="wf-step">
                <span class="step-no">01</span>
                <p><strong>You add the client first.</strong> Nobody who isn&rsquo;t on your list can book. Add clients one at a time, or import a CSV &mdash; an example file shows the columns to copy.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">02</span>
                <p><strong>They sign in with a code.</strong> No password to invent, forget, or reset. They type the email you invited, a code arrives, and they&rsquo;re in. Co-owned pets work the way households actually do: a dog can belong to two people, and both can book for it.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">03</span>
                <p><strong>They pick a service, then dates.</strong> The widget offers only what you&rsquo;ve set up, only where your rules allow it, and it knows which animals they&rsquo;re bringing while they choose &mdash; a day with one space left is struck out for a two-dog household rather than accepted and then refused. The nights and the price sit next to the button before they press it. That price is worked out by Pawservation itself, so the page can never show one number and charge another &mdash; the figure your client is shown is the figure the booking is stamped with.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">04</span>
                <p><strong>You confirm, or you decline.</strong> Every request is pending until you confirm it, and nothing gets confirmed on its own. A request does land on your calendar straight away, but the event title starts with <code>[REQUEST]</code> until you act, so a maybe never looks like a yes. Declines and cancellations stay on the record rather than disappearing, so the history of what was asked still reads straight months later.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">05</span>
                <p><strong>They change it or cancel it themselves &mdash; without texting you.</strong> New dates, a different pet, a different arrival time, a corrected answer: they edit their own booking on the same page they made it on. What they cannot change is which service it is &mdash; a boarding does not quietly become a house sit. Because you agreed to specific dates for specific animals, an edit to a confirmed booking comes straight back to you as pending, and you re-approve it or decline it like any other request. Rescheduling is not cancelling, so an edit never charges a fee. Every rule that applied when they booked applies again to the change, so an edit can&rsquo;t squeeze past a cap the original request respected.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">06</span>
                <p><strong>A cancellation reaches you as an email, with the number already worked out.</strong> They cancel, your policy decides the fee, and you get a message saying which it was and whether anything is owed. Nothing is deleted: the booking stays on the record as cancelled, and a fee that&rsquo;s owed shows up in what&rsquo;s outstanding like any other money. Even a stay already under way can be cancelled &mdash; refusing would only push the conversation back onto your phone.</p>
              </li>
            </ol>
            <div class="wf-pair">
              <p class="wf-keep">Your client gets an answer without waiting on you.</p>
              <p>The calendar they see is worked out from your own caps, your notice period and your booking horizon, so &ldquo;can you take the 12th to the 15th?&rdquo; is answered on the page at whatever hour they thought to ask it &mdash; rather than sitting on your phone until you get to it. What it shows is the dates you can take, not a promise: the request is still pending until you confirm it, and you can still decline. What it removes is the wait, which was the part of booking a sitter that had nothing to do with their pet.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="money" aria-labelledby="money-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Money</span>
            <h2 id="money-h">You collect it your way &mdash; Pawservation keeps the count</h2>
            <p>
              The arithmetic is deliberately boring: your rate, times the nights, days, walks, or
              visits booked &mdash; and, on the setting you pick, times the number of pets. Nothing
              enters the sum that you did not choose.
            </p>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">How the counting works</h3>
            <div class="wf-pair">
              <p class="wf-keep">You choose what a second pet does to the bill.</p>
              <p>Every service carries one setting, in plain English. Either two dogs cost twice your one-dog rate, or only the combinations you have priced can be booked together. A service you add starts on the first, so a two-dog household can book the moment you type one price; switch it to the second and a pair you have not priced is refused rather than guessed at. Whichever you pick, a second pet also uses a second slot of your capacity, and the figure a client sees traces back to a choice you made &mdash; there is no third behaviour we picked for you.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Record payments as they land.</p>
              <p>Cash, Venmo, Zelle, PayPal, check, card, or something else entirely. Log as many part-payments against one booking as it takes &mdash; a deposit now and the rest later &mdash; each with its own date and note.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Paid on Venmo? Upload the CSV.</p>
              <p>Download the CSV Venmo gives you for a month and drop it into Earnings. Pawservation reads the payments that came in, lines each one up with the client who sent it by their Venmo name, and shows you every match before anything is recorded &mdash; you approve what&rsquo;s right and fix what isn&rsquo;t. The file is read in memory and never stored, and uploading the same one twice records nothing twice.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Pawservation records payments. It never processes them.</p>
              <p>The money goes from your client to you by whatever means you already use. Nothing routes through us, so there is no cut taken and no fee on your earnings. An earnings view totals up what you&rsquo;ve recorded.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Two dogs can cost more than one &mdash; and you decide how much more.</p>
              <p>Price a combination and that combination has that price, whichever setting the service is on. On your walk, one dog might be $40 and two dogs $60 &mdash; two numbers you typed, and they beat the doubling every time. Set them once per service and they apply to every client. A group with no rate of its own falls to the setting you picked: either your rate for each pet, or the widget asks you for a rate before it will book them. There is no third answer invented in between.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">One client can keep an old price.</p>
              <p>Tina and Rob have walked Fido with you since before you raised your rates, and you&rsquo;d rather not raise theirs. Put a $20 walk on Fido&rsquo;s account and Fido&rsquo;s walks stay $20 while everyone else&rsquo;s are $40. A rate on a specific animal wins over a rate for &ldquo;two dogs&rdquo;, which wins over your ordinary rate for the service &mdash; so the narrower promise is always the one that holds.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section" id="calendar" aria-labelledby="calendar-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Google Calendar</span>
            <h2 id="calendar-h">Bookings turn up where you already look</h2>
            <p>
              Connect Google Calendar once and your week keeps living in the place you already
              check twenty times a day.
            </p>
          </div>
          <div class="features">
            <div class="feature">
              <h3>Pending and confirmed, both</h3>
              <p>A request becomes an event the moment it arrives, not only once you&rsquo;ve said yes &mdash; so a busy week looks busy before you&rsquo;ve made up your mind.</p>
            </div>
            <div class="feature">
              <h3>The whole booking, in the event</h3>
              <p>Service, dates, times, the pets by name, the estimated cost, and the client&rsquo;s email address &mdash; enough to answer from your phone without opening anything else.</p>
            </div>
            <div class="feature">
              <h3>Nothing dead looks alive</h3>
              <p>Decline a request, or cancel with nothing owed, and the event is removed. A cancellation that carries a fee keeps its event and retitles it <code>[CANCELLED]</code> instead &mdash; the dates are free again, but money you&rsquo;re still owed doesn&rsquo;t vanish out of your week.</p>
            </div>
            <div class="feature">
              <h3>Optional, and skippable</h3>
              <p>Skip it during setup and everything else works exactly the same. Connect months in and everything still upcoming is added to your calendar then &mdash; nothing you booked before connecting goes missing.</p>
            </div>
            <div class="feature">
              <h3>Your Google connection is stored encrypted</h3>
              <p>The credentials that let us write to your calendar are stored encrypted, and you can disconnect whenever you like.</p>
            </div>
            <div class="feature">
              <h3>It reads your calendar, too</h3>
              <p>Bookings flow out to the connected calendar &mdash; and busy events you keep there flow back. Add a stay by hand in Google and Pawservation blocks those dates automatically; move or delete it and the block follows. That&rsquo;s time off you entered yourself &mdash; a real booking is different: deleting it in Google cancels the booking in Pawservation too, and your client gets an email. Every other calendar in your account is never read and never touched.</p>
            </div>
            <div class="feature">
              <h3>If Google is down</h3>
              <p>Your dashboard is the record; the calendar is a mirror of it. If Google can&rsquo;t be reached, the booking still lands in Pawservation, and a background sweep keeps retrying until the event lands in Google too. Worst case, the mirror lags a few minutes &mdash; it never loses a frame.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="section band" id="embed" aria-labelledby="embed-h">
        <div class="wrap install-grid">
          <div class="install-copy">
            <span class="label">On your website</span>
            <h2 id="embed-h">One line, on the site you already have</h2>
            <p>Paste the script line into a page on Squarespace, Wix, or plain HTML, swap in your slug &mdash; the short name in your booking page&rsquo;s web address &mdash; and save. The widget measures itself and tells the page how tall to be, so it never sits in a box that&rsquo;s too short.</p>
            <p>If your host strips scripts &mdash; Wix&rsquo;s &ldquo;Embed a site&rdquo; is the usual culprit &mdash; use the iframe version underneath instead. Same widget, fixed height, no JavaScript on your side.</p>
            <p>Not the person who edits your website? Forward this box to whoever is &mdash; it&rsquo;s one line, and it&rsquo;ll take them under a minute.</p>
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

      <section class="section" id="setup" aria-labelledby="setup-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Setup</span>
            <h2 id="setup-h">Four steps, none of them destructive</h2>
            <p>
              The wizard gets you from an empty account to a working booking page in one sitting,
              and it only ever adds &mdash; run it again and it won&rsquo;t undo what you set.
            </p>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">What each step asks you for</h3>
            <ol class="wf-steps">
              <li class="wf-step">
                <span class="step-no">01</span>
                <p><strong>Your business.</strong> What you&rsquo;re called, how clients reach you, your brand color, which timezone your dates are in, and how far ahead people may book (twelve months to begin with).</p>
              </li>
              <li class="wf-step">
                <span class="step-no">02</span>
                <p><strong>What you offer.</strong> Six one-tap presets, each a whole service already shaped &mdash; &ldquo;Group walks &middot; weekdays 10&ndash;2 &middot; up to 8 pets&rdquo; is one tap, windows and limits included. Tap the ones that describe you.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">03</span>
                <p><strong>Your prices.</strong> Whole dollars, with each service&rsquo;s own unit printed beside the box. Times and limits come prefilled, and anything can be changed later.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">04</span>
                <p><strong>Your calendar, if you want it.</strong> Connect Google Calendar, or skip it &mdash; skipping costs you nothing else, and you can connect from Connected apps whenever.</p>
              </li>
            </ol>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">What about the stays you&rsquo;ve already agreed to?</h3>
            <p>Straight answer: you can&rsquo;t type an old booking in yourself. But if the stay is already on the calendar you connected, you&rsquo;re done &mdash; Pawservation reads that calendar and blocks those dates automatically, so nothing can be double-booked over it.</p>
            <p>Want the stay tracked properly &mdash; caps, records, what you&rsquo;re owed? Have the client send the request through your booking page. It takes them a minute, and then your calendar and your books match reality.</p>
          </div>
        </div>
      </section>

      <section class="section band" id="next" aria-labelledby="next-h">
        <div class="wrap">
          <div class="section-head">
            <span class="label">Under the hood</span>
            <h2 id="next-h">The plumbing for what comes next is already in</h2>
            <p>
              You can skip this section &mdash; it&rsquo;s for the software your clients might use,
              not for you. It&rsquo;s groundwork, laid early because retrofitting it later is how
              booking systems end up double-booking people.
            </p>
          </div>
          <div class="features">
            <div class="feature">
              <h3>A &ldquo;no&rdquo; that says why</h3>
              <p>A refused booking answers with a fixed code as well as a sentence, so other software can understand a &ldquo;no&rdquo; and say why &mdash; &ldquo;those dates are full&rdquo; and &ldquo;that stay is too long&rdquo; are told apart without guessing at the wording.</p>
            </div>
            <div class="feature">
              <h3>Sent twice, booked once</h3>
              <p>A request can be tagged by whatever sent it. If a shaky connection sends the same request twice, only one booking is created &mdash; the second attempt gets the first booking back rather than making a second.</p>
            </div>
            <div class="feature">
              <h3>Your services, written out plainly</h3>
              <p>Your booking page publishes a plain-text summary of what you offer and how to request it, so automated assistants can read your rules instead of scraping the page.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="cta-band" aria-labelledby="tour-cta-h">
        <div class="wrap">
          <div class="cta-panel">
            <h2 id="tour-cta-h">That&rsquo;s the whole thing. Want in?</h2>
            <p>Pawservation is invite-only while it grows. Ask, and we&rsquo;ll set up your services, rates, and booking page &mdash; taking bookings is free, and stays free. Or just poke at the demo first: it&rsquo;s a made-up sitter&rsquo;s account, nothing to sign up for, none of your own details asked for, nothing you can break.</p>
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
      'Privacy Policy &mdash; Pawservation',
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
          <p class="sub">What we collect, who we share it with, and how long we keep it &mdash; written to match what the product actually does.</p>
          <p class="note">Last updated: August 4, 2026</p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h3>What we collect</h3>
            <p>From customers: name, email, phone, your pets&rsquo; names and any care notes you give your sitter, and the answers you give to your sitter&rsquo;s own booking questions. From sitters: your login email and a securely hashed password &mdash; we never store your password itself. <strong>We never collect card numbers.</strong> Payments you log are just a record of money you already collected outside Pawservation (cash, Venmo, Zelle, check).</p>
          </div>
          <div class="feature">
            <h3>Who we share it with</h3>
            <p><strong>Resend</strong> sends our transactional email &mdash; login codes, booking confirmations, password-reset links &mdash; and nothing else; we don&rsquo;t use it for marketing. <strong>Google</strong> only sees your booking data if a sitter connects Google Calendar, and only enough to write an event: pet names, times, and cost. <strong>Cloudflare</strong> is our hosting and database provider &mdash; everything above lives on Cloudflare&rsquo;s infrastructure.</p>
          </div>
          <div class="feature">
            <h3>Cookies</h3>
            <p>We set exactly one cookie, for ten minutes, only while a sitter is connecting Google Calendar &mdash; it exists purely to stop a cross-site request forgery attack during that one step. There are no cookies for signing in or for tracking you. Every login &mdash; customer, sitter, or platform owner &mdash; works without one.</p>
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
            <p>We run no analytics, no ad pixels, and no fingerprinting &mdash; on this page or anywhere else in the product. Our security policy blocks third-party scripts from loading at all.</p>
          </div>
          <div class="feature">
            <h3>Where your data lives</h3>
            <p>Everything is stored on Cloudflare&rsquo;s global network. We don&rsquo;t currently commit to a specific country or region.</p>
          </div>
          <div class="feature">
            <h3>Questions</h3>
            <p>Reach us at <a href="mailto:brad@pawservation.com">brad@pawservation.com</a>.</p>
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
      'Terms &amp; Conditions &mdash; Pawservation',
      'The terms that govern using Pawservation: what the booking software does, what it deliberately does not do with your money, and what each side is responsible for.',
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
            <p>Pawservation is booking and scheduling software that a pet-sitting business embeds on its own website. Pawservation does not perform pet-sitting services, and is not a party to the agreement between a sitter and her customer.</p>
          </div>
          <div class="feature">
            <h3>Accounts</h3>
            <p>Sitters and the platform owner sign in with an email and password; customers sign in with a one-time code sent to their email. Each person is responsible for keeping their own credentials secure.</p>
          </div>
          <div class="feature">
            <h3>Payments</h3>
            <p>Pawservation is not a payment processor. A sitter collects payment herself, outside Pawservation, and logs the amount here so her records stay accurate. We never process, store, or guarantee any payment, and any payment dispute is between the sitter and her customer.</p>
          </div>
          <div class="feature">
            <h3>Acceptable use</h3>
            <p>Don&rsquo;t attempt to abuse the booking or intake system, or to work around tenant isolation, rate limits, or any other technical safeguard.</p>
          </div>
          <div class="feature">
            <h3>Your data</h3>
            <p>A sitter owns her business&rsquo;s client and booking data. See our <a href="/privacy">Privacy Policy</a> for how long we keep it and how to have it deleted.</p>
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
      'About &mdash; Pawservation',
      'Who makes Pawservation, why it exists, and the four rules the software will not break: nothing books itself, it never touches your money, your clients stay yours, and no price is charged that you did not type.',
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
            page on the website you already have &mdash; your services, your rates, your rules
            &mdash; so the question &ldquo;are you free the 12th to the 15th?&rdquo; answers itself.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h3>Why it exists</h3>
            <p>Every booking a small pet-care business takes starts the same way: a text message asking whether you&rsquo;re free. Answering it means checking a calendar, remembering your own rules, quoting a price from memory, and doing it again four messages later. That thread is the job before the job, and it happens while you have a dog on a lead. Pawservation answers it from the caps, notice periods and days off you set once &mdash; and then gets out of the way. Everything else about how you work stays exactly as it is: the same website, the same calendar, the same way of taking money, the same conversations with the clients who&rsquo;d rather text you anyway.</p>
          </div>
          <div class="feature">
            <h3>Four rules the software will not break</h3>
            <p><strong>Nothing books itself.</strong> Every request arrives as a request and waits for you to confirm or decline. A pending request holds its space so it can&rsquo;t be taken twice, but it is never a commitment you didn&rsquo;t make.</p>
            <p><strong>It never touches your money.</strong> Pawservation records what a booking is worth and what you&rsquo;ve been paid. It does not process cards, hold funds, or take a cut of anything. You collect the way you already collect &mdash; cash, Venmo, Zelle, a check on the counter.</p>
            <p><strong>Your clients stay your clients.</strong> This is not a marketplace and not a directory. Nobody browses for a sitter here. You add each client before they can book, and their details are yours.</p>
            <p><strong>No price you didn&rsquo;t type.</strong> The software will not invent a rate. It multiplies the hours or nights you sold by the rate you stored, and where you&rsquo;ve told it to, by the number of pets. It will refuse to quote a combination you never priced rather than guess at one &mdash; because a rate you didn&rsquo;t type is a price you didn&rsquo;t agree to.</p>
          </div>
          <div class="feature">
            <h3>Where it is today</h3>
            <p>Taking bookings is free and stays free: the booking page, your availability rules, client and pet records, payment tracking and Google Calendar sync cost nothing, with no trial and no card to enter. New sitters are added by invitation while the product grows, which is a deliberate limit on how fast it takes on people rather than a waiting list for its own sake. It runs one sitter per account today &mdash; a team, with assignment between sitters, is not built. A paid tier is planned and is not built either; nothing on it is for sale, and the free tier is not a trial of it.</p>
          </div>
          <div class="feature">
            <h3>Who makes it</h3>
            <p>Pawservation is built and run by <a href="https://bradburch.github.io/">Brad Burch</a>. It is a small, independent product rather than a venture-backed platform, which is why the invite list is short, the roadmap is honest about what isn&rsquo;t built, and there is no sales team to get past &mdash; questions go to a person.</p>
          </div>
          <div class="feature">
            <h3>See it before you believe any of this</h3>
            <p>The <a href="/demo">demo</a> is a made-up sitter&rsquo;s account with real data behind it: pick a service, pick dates, watch it refuse the days that are full. Nothing to sign up for, no details asked for, nothing you can break. The <a href="/how-it-works">full tour</a> is the long version, and it says out loud where something isn&rsquo;t built.</p>
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
      'Contact &mdash; Pawservation',
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
            There is no support desk and no sales team &mdash; Pawservation is small enough that
            messages reach the person who builds it. Here is the quickest route for each reason
            you might be writing.
          </p>
        </div>
      </section>

      <section class="section">
        <div class="wrap legal">
          <div class="feature">
            <h3>You&rsquo;re a pet owner looking for your sitter</h3>
            <p><strong>Please contact your sitter directly.</strong> This is the most common reason people land here, and we genuinely can&rsquo;t help: Pawservation is the software your sitter uses, not the sitter. We can&rsquo;t see, change, or cancel your booking, and we can&rsquo;t pass a message on. Your sitter&rsquo;s own booking page &mdash; the one you booked on &mdash; is where a booking can be changed or cancelled, and every email you&rsquo;ve had about a booking came from your sitter&rsquo;s business, with their address on it.</p>
          </div>
          <div class="feature">
            <h3>You run a pet-care business and want an account</h3>
            <p>Use the <a href="/#invite-h">invite form on the homepage</a>. Tell us what you offer and roughly how you work; the reply sets up your services, rates and booking page so you aren&rsquo;t starting from an empty screen. Pawservation is invite-only while it grows, so this is the front door rather than a marketing capture form.</p>
          </div>
          <div class="feature">
            <h3>You already have an account and something is wrong</h3>
            <p>Email <a href="mailto:${htmlEscape(SUPPORT_EMAIL)}?subject=Pawservation%20support">${htmlEscape(SUPPORT_EMAIL)}</a> and say which business you run &mdash; that&rsquo;s enough to find your account. Include what you expected to happen and what happened instead; if it involves a specific booking, the dates and the client&rsquo;s first name are enough to locate it. Your dashboard is at <a href="/admin">the sign-in page</a> if you just need to get back in; it will email you a reset link.</p>
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
