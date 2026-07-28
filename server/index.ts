import { Hono } from 'hono';
import { listServiceOptions, listServices } from './db/repo';
import { buildJsonLdScript, buildLlmsTxt } from './lib/llms';
import { renderInviteForm } from './lib/invite-form';
import { tenantMiddleware } from './lib/middleware';
import { PAGE_STYLE } from './lib/page-style';
import { resolveTenant } from './lib/tenant-resolve';
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
  if (c.req.path.startsWith('/embed')) {
    c.header('Content-Security-Policy', EMBEDDABLE_CSP);
  } else {
    c.header('Content-Security-Policy', LOCKED_CSP);
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
app.route('/api', adminRoutes);
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
    listServices(c.env.PAWBOOK_DB, tenant.Id),
    listServiceOptions(c.env.PAWBOOK_DB, tenant.Id),
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
  return new Response(
    html.replace('</head>', () => `${ldScript}</head>`),
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
    <title>Pawservation — booking for pet sitters</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <svg width="22" height="22" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
            <ellipse cx="50" cy="63" rx="24" ry="20" />
            <ellipse cx="18" cy="38" rx="10" ry="13" />
            <ellipse cx="39" cy="24" rx="10" ry="14" />
            <ellipse cx="61" cy="24" rx="10" ry="14" />
            <ellipse cx="82" cy="38" rx="10" ry="13" />
          </svg>
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
            <p class="chip">Booking for pet-sitting businesses</p>
            <h1>Your booking page, on your own website.</h1>
            <p class="sub">
              Pawservation is a booking widget that lives on your site, with your services
              and your rates. Clients request the dates, you confirm or decline, and it
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
                <p>Days you can&rsquo;t take aren&rsquo;t offered: full days and the weekends of a weekday-only service are struck out as unavailable.</p>
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
              <p>A boarding cap, a house-sits-per-day cap, a longest stay, your days off. A full day isn&rsquo;t offered.</p>
            </div>
            <div class="feature">
              <h3>Clients &amp; pets</h3>
              <p>Invite by email or import a CSV. Keep profiles and care notes for every animal.</p>
            </div>
            <div class="feature">
              <h3>Payments</h3>
              <p>Cash, Venmo, Zelle, PayPal, check &mdash; log deposits and partials, see what&rsquo;s outstanding.</p>
            </div>
            <div class="feature">
              <h3>Earnings</h3>
              <p>This month against last, what&rsquo;s still owed, and a year of revenue at a glance.</p>
            </div>
            <div class="feature">
              <h3>Google Calendar</h3>
              <p>Requests land on your calendar instantly and update when you confirm, so your week is where you already look.</p>
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
                <p>Connect it once and bookings appear there, updating when you confirm. The sync runs one way, Pawservation to Google &mdash; it writes your bookings and leaves the rest of your calendar alone, so something you keep only in Google won&rsquo;t block a request unless you enter it as time off.</p>
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
                <p class="wf-keep">You keep taking texts.</p>
                <p>The widget answers the repetitive question &mdash; what you offer, when you&rsquo;re free, what it costs. Every other conversation stays where it was.</p>
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
                <li>Rates, logged payments, and outstanding balances</li>
                <li>Cancellation policies</li>
                <li>Client accounts and pet profiles</li>
                <li>Google Calendar sync</li>
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
              <p><strong>No.</strong> Pawservation tracks money but doesn&rsquo;t take it. A booking arrives with an estimated cost; you collect it yourself (cash, Venmo, Zelle, check) and log the payment so your earnings stay accurate.</p>
            </div>
            <div class="qa-item">
              <h3>Can it double-book me?</h3>
              <p><strong>No.</strong> Your caps and time off hold the day, and a full day isn&rsquo;t offered. One caveat: Google Calendar sync is one-way, so being busy elsewhere won&rsquo;t block a request unless you enter it as time off.</p>
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

    <footer class="foot">
      <div class="wrap">
        <div class="foot-grid">
          <div class="foot-brand">
            <a class="logo" href="/">
              <svg width="20" height="20" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
                <ellipse cx="50" cy="63" rx="24" ry="20" />
                <ellipse cx="18" cy="38" rx="10" ry="13" />
                <ellipse cx="39" cy="24" rx="10" ry="14" />
                <ellipse cx="61" cy="24" rx="10" ry="14" />
                <ellipse cx="82" cy="38" rx="10" ry="13" />
              </svg>
              Pawservation
            </a>
            <p>Booking for pet-sitting businesses, embedded on your own website.</p>
          </div>
          <div>
            <h3>Product</h3>
            <ul>
              <li><a href="/demo">Try the demo</a></li>
              <li><a href="/admin">Sitter sign in</a></li>
              <li><a href="/how-it-works">Full tour</a></li>
              <li><a href="#faq">FAQ</a></li>
            </ul>
          </div>
        </div>
        <div class="foot-bottom">
          <p>
            Created by <a href="https://bradburch.github.io/">Brad Burch</a>
          </p>
        </div>
      </div>
    </footer>
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
 * those exist), multi-pet pricing must be described as SHIPPED — rates the sitter typed, with an
 * unpriced group refused rather than inferred, and nothing ever multiplied —
 * and the developer nouns "idempotency"/"machine-readable"/"llms.txt" are banned from the body
 * copy — the concepts stay, in the language a pet sitter uses.
 */
const HOW_IT_WORKS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>How it works &mdash; Pawservation</title>
    <meta
      name="description"
      content="The full tour of Pawservation: the services you can offer, the rules that protect your calendar, how clients book, and how the money is tracked."
    />
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <header class="nav">
      <div class="wrap nav-inner">
        <a class="logo" href="/">
          <svg width="22" height="22" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
            <ellipse cx="50" cy="63" rx="24" ry="20" />
            <ellipse cx="18" cy="38" rx="10" ry="13" />
            <ellipse cx="39" cy="24" rx="10" ry="14" />
            <ellipse cx="61" cy="24" rx="10" ry="14" />
            <ellipse cx="82" cy="38" rx="10" ry="13" />
          </svg>
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
              <p>Overnight stays at your place, over a range of dates. Set the most pets you&rsquo;ll keep at once, and the shortest and longest stay you&rsquo;ll accept.</p>
            </div>
            <div class="feature">
              <h3>House sitting &middot; per night</h3>
              <p>You stay at the client&rsquo;s home, again over a range of dates, under its own cap. And because you can&rsquo;t be in two places at once, a house sit won&rsquo;t overlap an occupied boarding stay by more than a day.</p>
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
              <p>Say your morning pack walk takes eight dogs and your solo walk takes one. Book eight dogs onto Tuesday&rsquo;s pack walk and Tuesday stops being offered for the pack walk &mdash; the solo walk still shows until its one spot goes. Each option fills up on its own, date by date.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Weekdays only, where that&rsquo;s the truth.</p>
              <p>Mark an option weekdays-only and its weekends are struck out in the calendar rather than quietly accepted and then declined.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">A shortest and longest stay.</p>
              <p>For the per-night services, set a minimum and a maximum number of nights. A request outside that range never gets as far as your queue.</p>
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
              <p>Accepted pet types are set per service, so you can board dogs and do check-ins for cats without accidentally agreeing to board the cat.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Your questions, asked at booking time.</p>
              <p>Write your own intake questions &mdash; medications, the gate code, which vet, anything you always end up asking &mdash; and they arrive answered, with the request, instead of over six texts on the day.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Time off, in whole days.</p>
              <p>Mark a day &mdash; or a run of days &mdash; as time off and it simply stops being offered, struck out for every service, walks and check-ins included. Away next Tuesday? Block Tuesday and nothing else changes. Time off is whole days only: there is no way to close just the 10am walk and keep the rest of that day open.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Cancellation fees in your own windows.</p>
              <p>Set up to five windows, each a percentage of the estimated cost. When a client cancels, the tightest window that applies is the one that wins. Leave it blank and there&rsquo;s no fee at all &mdash; the policy is only what you wrote.</p>
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
                <p><strong>They pick a service, then dates.</strong> The widget offers only what you&rsquo;ve set up, only where your rules allow it. The price is worked out by Pawservation itself, so the page can never show you one number and charge another &mdash; the figure your client is shown is the figure the booking is stamped with.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">04</span>
                <p><strong>You confirm, or you decline.</strong> Every request is pending until you confirm it, and nothing gets confirmed on its own. A request does land on your calendar straight away, but the event title starts with <code>[REQUEST]</code> until you act, so a maybe never looks like a yes. Declines and cancellations stay on the record rather than disappearing, so the history of what was asked still reads straight months later.</p>
              </li>
            </ol>
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
              visits booked. Nothing else multiplies it.
            </p>
          </div>
          <div class="wf-math">
            <h3 class="wf-h">How the counting works</h3>
            <div class="wf-pair">
              <p class="wf-keep">Rates are per service, and they don&rsquo;t multiply behind your back.</p>
              <p>A second pet uses a second slot of your capacity; it does not quietly double the bill. Any figure a client sees comes from a rate you typed in, never from a multiplier nobody chose.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Record payments as they land.</p>
              <p>Cash, Venmo, Zelle, PayPal, check, card, or something else entirely. Log as many part-payments against one booking as it takes &mdash; a deposit now and the rest later &mdash; each with its own date and note.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Pawservation records payments. It never processes them.</p>
              <p>The money goes from your client to you by whatever means you already use. Nothing routes through us, so there is no cut taken and no fee on your earnings. An earnings view totals up what you&rsquo;ve recorded.</p>
            </div>
            <div class="wf-pair">
              <p class="wf-keep">Two dogs can cost more than one &mdash; because you said so, not because we multiplied.</p>
              <p>Set a rate for a combination and that combination has a price. On your walk, one dog might be $40 and two dogs $60 &mdash; two numbers you typed, not $40 doubled. Set them once per service and they apply to every client. If a group of pets has no rate yet, we don&rsquo;t invent one: the client sees the dates are free, but the widget asks you for a rate before it will book them &mdash; no price is guessed, and nothing is multiplied, ever.</p>
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
              <h3>Cancelled means gone</h3>
              <p>Cancel or decline in Pawservation and the event is removed from the calendar, so a dead booking never sits there looking alive.</p>
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
              <h3>One way, on purpose</h3>
              <p>Pawservation writes your bookings and leaves the rest of your calendar alone. Something you keep only in Google won&rsquo;t block a request unless you enter it as time off.</p>
            </div>
            <div class="feature">
              <h3>If Google is down</h3>
              <p>Your dashboard is the record; the calendar is a mirror of it. If Google can&rsquo;t be reached, the booking still lands in Pawservation &mdash; nothing is lost, the mirror just misses a frame.</p>
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
                <p><strong>Your business.</strong> What you&rsquo;re called, how clients reach you, your brand color, and which timezone your dates are in.</p>
              </li>
              <li class="wf-step">
                <span class="step-no">02</span>
                <p><strong>What you offer.</strong> Seven one-tap presets, each a whole service already shaped &mdash; &ldquo;Group walks &middot; weekdays 10&ndash;2 &middot; up to 8 pets&rdquo; is one tap, windows and limits included. Tap the ones that describe you.</p>
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
            <p>Straight answer: you can&rsquo;t type an old booking in yourself. Bookings only arrive through your booking page, so for a stay you agreed to before you joined, have the client send the request &mdash; it takes them a minute, and then your caps, your calendar, and what you&rsquo;re owed all match reality.</p>
            <p>If you&rsquo;d rather not ask them, block those dates as time off instead. The stay won&rsquo;t be tracked, but nothing else can be booked over the top of it.</p>
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

    <footer class="foot">
      <div class="wrap">
        <div class="foot-grid">
          <div class="foot-brand">
            <a class="logo" href="/">
              <svg width="20" height="20" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
                <ellipse cx="50" cy="63" rx="24" ry="20" />
                <ellipse cx="18" cy="38" rx="10" ry="13" />
                <ellipse cx="39" cy="24" rx="10" ry="14" />
                <ellipse cx="61" cy="24" rx="10" ry="14" />
                <ellipse cx="82" cy="38" rx="10" ry="13" />
              </svg>
              Pawservation
            </a>
            <p>Booking for pet-sitting businesses, embedded on your own website.</p>
          </div>
          <div>
            <h3>Product</h3>
            <ul>
              <li><a href="/demo">Try the demo</a></li>
              <li><a href="/admin">Sitter sign in</a></li>
              <li><a href="/">Overview</a></li>
              <li><a href="/#faq">FAQ</a></li>
            </ul>
          </div>
        </div>
        <div class="foot-bottom">
          <p>
            Created by <a href="https://bradburch.github.io/">Brad Burch</a>
          </p>
        </div>
      </div>
    </footer>
  </body>
</html>
`;

app.get('/', (c) => c.html(LANDING_HTML));
// Listed in wrangler.jsonc's run_worker_first as the BARE path "/how-it-works" — a glob does not
// match it. Today nothing is emitted at that path, so it would reach the worker regardless (as
// "/" does, which is not listed); the entry is defensive, so that if a build ever emits an asset
// there it can never shadow this route.
app.get('/how-it-works', (c) => c.html(HOW_IT_WORKS_HTML));

// Uniform JSON 500 so an unhandled throw (e.g. a route that rethrows after cleanup) doesn't fall
// through to Hono's plain-text default and break the { error } contract every client parses.
// Internal detail is logged, never returned.
app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.json({ error: 'Something went wrong.' }, 500);
});

export default app;
