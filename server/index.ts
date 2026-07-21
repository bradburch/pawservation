import { Hono } from 'hono';
import { tenantMiddleware } from './lib/middleware';
import { adminRoutes } from './routes/admin';
import { adminAuthRoutes } from './routes/admin-auth';
import { authRoutes } from './routes/auth';
import { bookingRoutes } from './routes/bookings';
import { oauthRoutes } from './routes/oauth';
import { ownerRoutes } from './routes/owner';
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
app.route('/api', ownerRoutes); // /api/owner/* — owner-token-gated ('owner' is a reserved slug)
app.route('/', oauthRoutes); // global OAuth callback — no slug, no tenant middleware

/** Serve a built Vite page for a worker-routed path, with mutable headers. */
const page = (asset: string) =>
  async function servePage(c: { env: Env; req: { url: string } }) {
    const res = await c.env.ASSETS.fetch(new URL(`/${asset}`, c.req.url));
    return new Response(res.body, res);
  };

app.get('/embed/:slug', page('embed.html'));
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
    <style>
      :root {
        color-scheme: light;
        --paper: #eae9d9;
        --paper-2: #f6f4e9;
        --ink: #24322a;
        --pine: #22422e;
        --soft: #55604f;
        --rule: #d2cfba;
        --accent: #4a7d3c;
        --stamp: #a23e33;
        --serif: Georgia, "Iowan Old Style", "Palatino Linotype", Palatino,
          "Times New Roman", serif;
        --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif;
        --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
          "Liberation Mono", monospace;
      }
      * { box-sizing: border-box; }
      html { -webkit-text-size-adjust: 100%; }
      body {
        margin: 0;
        font-family: var(--sans);
        color: var(--ink);
        line-height: 1.55;
        /* A faint ruled-notebook wash on warm paper — the ledger, felt not shouted. */
        background-color: var(--paper);
        background-image:
          radial-gradient(120% 60% at 50% -6%, #f2f1e1 0%, var(--paper) 55%),
          repeating-linear-gradient(
            to bottom,
            transparent 0 31px,
            rgba(34, 50, 40, 0.05) 31px 32px
          );
      }
      .page {
        width: 100%;
        max-width: 760px;
        margin: 0 auto;
        padding: 40px 22px 64px;
      }

      /* ── Utility type: mono eyebrows / captions ─────────────────── */
      .eyebrow {
        font-family: var(--mono);
        font-size: 0.66rem;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--soft);
        margin: 0;
      }

      /* ── Signature: screenshots as physical objects on the paper ── */
      .shot {
        position: relative;
        background: var(--paper-2);
        border: 1px solid var(--rule);
        border-radius: 4px;
        padding: 10px;
        box-shadow:
          0 1px 0 #fff inset,
          0 18px 40px -26px rgba(34, 50, 40, 0.6);
        transform: rotate(-0.7deg);
      }
      .shot img {
        display: block;
        width: 100%;
        height: auto;
        border: 1px solid var(--rule);
        border-radius: 2px;
      }
      .shot-tilt-r { transform: rotate(0.6deg); }
      .hero-shot {
        max-width: 440px;
        margin: 0 auto;
        text-align: left;
      }
      /* Penciled marginalia — a bookkeeper's aside, the page's quiet signature. */
      .marginalia {
        position: absolute;
        right: -6px;
        bottom: -30px;
        font-family: var(--serif);
        font-style: italic;
        font-size: 0.9rem;
        color: var(--soft);
        transform: rotate(-4deg);
        pointer-events: none;
      }
      /* The red paw BOOKED stamp, spent where the promise lands: "you confirm it". */
      .stamp {
        color: var(--stamp);
        opacity: 0.88;
      }
      .stamp-over {
        position: absolute;
        top: -18px;
        right: -12px;
        width: 70px;
        height: 70px;
        transform: rotate(-11deg);
      }

      /* ── Wordmark + hero copy ───────────────────────────────────── */
      .hero { text-align: center; }
      .brand {
        margin: 46px 0 8px;
        font-family: var(--serif);
        font-weight: 700;
        font-size: clamp(3rem, 12vw, 4.6rem);
        line-height: 0.92;
        letter-spacing: -0.02em;
      }
      .lede {
        margin: 0 auto 10px;
        max-width: 26ch;
        font-family: var(--serif);
        font-size: clamp(1.15rem, 4.4vw, 1.5rem);
        line-height: 1.35;
      }
      .sub {
        margin: 0 auto 28px;
        max-width: 44ch;
        color: var(--soft);
        font-size: 1rem;
      }

      /* ── Actions ────────────────────────────────────────────────── */
      .actions {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
      }
      a.cta {
        display: inline-block;
        padding: 13px 30px;
        background: var(--pine);
        color: var(--paper-2);
        text-decoration: none;
        border-radius: 4px;
        font-weight: 600;
        font-size: 1rem;
        border: 1px solid var(--pine);
        transition:
          transform 0.12s ease,
          box-shadow 0.12s ease;
        box-shadow: 0 6px 18px -10px rgba(34, 50, 40, 0.8);
      }
      a.cta:hover { transform: translateY(-1px); }
      .links {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 8px 22px;
      }
      a.quiet {
        font-family: var(--mono);
        font-size: 0.78rem;
        letter-spacing: 0.05em;
        color: var(--soft);
        text-decoration: none;
        border-bottom: 2px solid var(--accent);
        padding-bottom: 1px;
      }
      a.quiet:hover { color: var(--ink); }
      .invite-note {
        margin: 4px auto 0;
        max-width: 46ch;
        font-family: var(--mono);
        font-size: 0.72rem;
        line-height: 1.55;
        letter-spacing: 0.01em;
        color: var(--soft);
      }
      .invite-note a {
        color: var(--ink);
        text-decoration: underline;
        text-decoration-color: var(--accent);
        text-underline-offset: 2px;
      }

      /* ── Section rhythm + running heads ─────────────────────────── */
      .section {
        margin-top: 60px;
        padding-top: 22px;
        border-top: 2px solid var(--ink);
      }
      .runhead {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 8px 16px;
        margin-bottom: 26px;
      }
      .runhead h2 {
        margin: 0;
        font-family: var(--serif);
        font-weight: 700;
        font-size: clamp(1.7rem, 6vw, 2.3rem);
        line-height: 1.02;
        letter-spacing: -0.01em;
      }
      .runhead .rule {
        flex: 1 1 40px;
        height: 0;
        align-self: center;
        border-top: 1px solid var(--rule);
      }
      .runhead .tab {
        font-family: var(--mono);
        font-size: 0.66rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--soft);
      }

      /* ── What your clients see: the numbered 3-step strip ───────── */
      .steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 44px 26px;
      }
      .step h3 {
        margin: 0 0 6px;
        font-family: var(--serif);
        font-size: 1.15rem;
        font-weight: 700;
        line-height: 1.2;
      }
      .step .step-no {
        font-family: var(--mono);
        font-size: 0.8rem;
        font-weight: 700;
        color: var(--accent);
        margin-right: 6px;
      }
      .step p {
        margin: 0 0 16px;
        color: var(--soft);
        font-size: 0.92rem;
        line-height: 1.5;
        max-width: 38ch;
      }
      @media (min-width: 720px) {
        .steps { grid-template-columns: 1fr 1fr 1fr; }
      }

      /* ── What you control: admin shot beside the ledger lines ───── */
      .control {
        display: grid;
        gap: 40px 46px;
      }
      .control-shot { align-self: start; }
      .control dl { margin: 0; }
      .line {
        display: grid;
        grid-template-columns: 1fr;
        gap: 1px 16px;
        padding: 10px 0;
        border-bottom: 1px solid var(--rule);
      }
      .line:first-child { border-top: 2px solid var(--ink); }
      .line:last-child { border-bottom: 0; }
      .line dt {
        font-family: var(--mono);
        font-size: 0.73rem;
        letter-spacing: 0.01em;
        font-weight: 700;
        color: var(--ink);
      }
      .line dd {
        margin: 0;
        color: var(--soft);
        font-size: 0.92rem;
        line-height: 1.42;
      }
      @media (min-width: 520px) {
        .line { grid-template-columns: 8.5rem 1fr; align-items: baseline; }
      }
      @media (min-width: 760px) {
        .control { grid-template-columns: 0.95fr 1.05fr; align-items: start; }
      }

      /* ── How it installs: words left, the slip right ────────────── */
      .embed-grid {
        display: grid;
        gap: 22px 46px;
        align-items: start;
      }
      .embed-say p {
        margin: 0;
        color: var(--soft);
        max-width: 34ch;
      }
      @media (min-width: 720px) {
        .embed-grid { grid-template-columns: 0.82fr 1.18fr; }
      }
      .slip {
        background: var(--paper-2);
        border: 1px solid var(--rule);
        border-radius: 4px;
        box-shadow: 0 1px 0 #fff inset;
        overflow: hidden;
      }
      .slip-cap {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 16px;
        border-bottom: 1px dashed var(--rule);
      }
      .code-scroll { overflow-x: auto; }
      .slip pre {
        margin: 0;
        padding: 16px;
        min-width: max-content;
        font-family: var(--mono);
        font-size: 0.82rem;
        line-height: 1.7;
        color: var(--ink);
      }
      .slip .tag { color: var(--stamp); }
      .slip .attr { color: var(--accent); }
      .slip-foot {
        margin: 0;
        padding: 12px 16px 14px;
        border-top: 1px dashed var(--rule);
        font-size: 0.9rem;
        color: var(--soft);
      }

      /* ── Common questions: answers laid open, no toggles ────────── */
      .qa {
        display: grid;
        gap: 0 46px;
      }
      .qa-item {
        padding: 18px 0;
        border-top: 1px solid var(--rule);
      }
      .qa-item h3 {
        margin: 0 0 6px;
        font-family: var(--serif);
        font-size: 1.12rem;
        font-weight: 700;
        line-height: 1.2;
        color: var(--ink);
      }
      .qa-item p {
        margin: 0;
        color: var(--soft);
        font-size: 0.92rem;
        line-height: 1.5;
        max-width: 42ch;
      }
      .qa-item p strong { color: var(--ink); font-weight: 700; }
      @media (min-width: 640px) {
        .qa { grid-template-columns: 1fr 1fr; }
      }

      /* ── Invite band ────────────────────────────────────────────── */
      .invite { text-align: center; }
      .invite p {
        margin: 0 auto 22px;
        max-width: 44ch;
        color: var(--soft);
      }
      .invite .links { margin-top: 16px; }

      /* ── Footer: one OSS line for the technical reader's exit ───── */
      .foot {
        margin-top: 56px;
        padding-top: 20px;
        border-top: 2px solid var(--ink);
        font-family: var(--mono);
        font-size: 0.72rem;
        line-height: 1.7;
        color: var(--soft);
      }
      .foot p { margin: 0; }
      .foot a {
        color: var(--soft);
        text-decoration: none;
        border-bottom: 1px solid var(--accent);
      }
      .foot a:hover { color: var(--ink); }

      :focus-visible {
        outline: 3px solid var(--accent);
        outline-offset: 3px;
        border-radius: 3px;
      }
      @media (prefers-reduced-motion: reduce) {
        a.cta { transition: none; }
        a.cta:hover { transform: none; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <header class="hero">
        <!-- Screenshots below are captured from the seeded demo (fixed 2028 months, never
             "today"). Regenerate via the recipe in
             docs/superpowers/specs/2026-07-19-landing-marketing-redesign.md whenever the
             widget's look changes. -->
        <div class="shot hero-shot">
          <img
            src="/img/landing/widget-hero.webp"
            alt="The Pawservation booking widget: a June calendar with a three-night boarding stay selected and a $150 quote"
          />
          <span class="marginalia" aria-hidden="true">what your clients see</span>
        </div>

        <h1 class="brand">Pawservation</h1>
        <p class="lede">Your own booking page, on your own website.</p>
        <p class="sub">
          It lives on your site with your services and your rates. Clients request the dates,
          you confirm or decline, and Pawservation keeps track of what you&rsquo;re owed.
        </p>

        <div class="actions">
          <a class="cta" href="/demo">Try the demo &rarr;</a>
          <div class="links">
            <a class="quiet" href="/admin">Sitter sign in &rarr;</a>
          </div>
          <p class="invite-note">
            Pawservation is invite-only right now &mdash;
            <a href="mailto:bradburch@duck.com?subject=Pawservation%20invite">ask for an invite</a>
            or <a href="/admin">sign in</a> if you have an account.
          </p>
        </div>
      </header>

      <section class="section" aria-labelledby="clients">
        <div class="runhead">
          <h2 id="clients">What your clients see</h2>
          <span class="rule" aria-hidden="true"></span>
          <span class="tab">booking, in three steps</span>
        </div>
        <ol class="steps">
          <li class="step">
            <h3><span class="step-no" aria-hidden="true">1</span>They pick a service</h3>
            <p>Your services, under your names and your prices &mdash; boarding, day care, walks, or anything you invent.</p>
            <div class="shot">
              <img
                src="/img/landing/step-services.webp"
                alt="The widget's service picker: Boarding selected from a row of services including House sitting, Day care, Walks, Check-ins, and Morning walk"
              />
            </div>
          </li>
          <li class="step">
            <h3><span class="step-no" aria-hidden="true">2</span>They pick the dates</h3>
            <p>Days you can&rsquo;t take aren&rsquo;t offered: full days and the weekends of a weekday-only service are struck out as unavailable.</p>
            <div class="shot shot-tilt-r">
              <img
                src="/img/landing/step-calendar.webp"
                alt="Month grid where full days are struck through and the weekends of a weekday-only service are struck through as unavailable"
              />
            </div>
          </li>
          <li class="step">
            <h3><span class="step-no" aria-hidden="true">3</span>They send the request &mdash; you confirm it</h3>
            <p>A request arrives with dates, pets, and an estimated cost. Nothing is booked until you say so.</p>
            <div class="shot">
              <img
                src="/img/landing/step-request.webp"
                alt="Booking summary showing the selected dates, an estimated cost of $150, and a Send request button"
              />
              <svg class="stamp stamp-over" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
                <circle cx="50" cy="50" r="47" fill="none" stroke="currentColor" stroke-width="2.5" />
                <circle cx="50" cy="50" r="41" fill="none" stroke="currentColor" stroke-width="1" />
                <ellipse cx="50" cy="44" rx="14" ry="11.5" />
                <ellipse cx="30" cy="34" rx="6.4" ry="8.4" />
                <ellipse cx="42" cy="26" rx="6.4" ry="8.8" />
                <ellipse cx="58" cy="26" rx="6.4" ry="8.8" />
                <ellipse cx="70" cy="34" rx="6.4" ry="8.4" />
                <text x="50" y="72" text-anchor="middle" font-family="ui-monospace, monospace" font-size="9" font-weight="700" letter-spacing="1.5">BOOKED</text>
              </svg>
            </div>
          </li>
        </ol>
      </section>

      <section class="section" aria-labelledby="control">
        <div class="runhead">
          <h2 id="control">What you control</h2>
          <span class="rule" aria-hidden="true"></span>
          <span class="tab">your dashboard</span>
        </div>
        <div class="control">
          <div class="shot shot-tilt-r control-shot">
            <img
              src="/img/landing/admin-bookings.webp"
              alt="The sitter dashboard's bookings list: pending requests with Confirm and Decline buttons"
            />
            <span class="marginalia" aria-hidden="true">nothing books itself</span>
          </div>
          <dl>
            <div class="line"><dt>Rates &amp; services</dt><dd>Boarding, house-sitting, day care, walks, check-ins, or your own custom service &mdash; each with its own price.</dd></div>
            <div class="line"><dt>Caps &amp; time off</dt><dd>A boarding cap, a house-sits-per-day cap, a longest stay, your days off. A full day isn&rsquo;t offered.</dd></div>
            <div class="line"><dt>Every request</dt><dd>Confirm, decline, or cancel &mdash; clients hear back by email automatically.</dd></div>
            <div class="line"><dt>Clients &amp; pets</dt><dd>Invite by email or CSV up to 500. Keep profiles and care notes.</dd></div>
            <div class="line"><dt>Payments</dt><dd>Cash, Venmo, Zelle, PayPal, check &mdash; deposits and partials too.</dd></div>
            <div class="line"><dt>Earnings</dt><dd>This month against last, what&rsquo;s outstanding, a year of revenue.</dd></div>
            <div class="line"><dt>Google Calendar</dt><dd>Confirmed bookings push straight to your calendar.</dd></div>
          </dl>
        </div>
      </section>

      <section class="section" aria-labelledby="install">
        <div class="runhead">
          <h2 id="install">How it installs</h2>
          <span class="rule" aria-hidden="true"></span>
          <span class="tab">one line</span>
        </div>
        <div class="embed-grid">
          <div class="embed-say">
            <p>Adding it is one line &mdash; paste it into Squarespace, Wix, or any page, change the slug to yours, and save. The widget sizes itself to fit.</p>
          </div>
          <div class="slip">
            <div class="slip-cap">
              <span class="eyebrow">embed &middot; your-page.html</span>
              <span class="eyebrow">paste &amp; save</span>
            </div>
            <div class="code-scroll">
<pre><span class="tag">&lt;script</span> <span class="attr">src</span>=&quot;https://your-site/embed.js&quot;
        <span class="attr">data-pawservation-tenant</span>=&quot;your-slug&quot;
        <span class="attr">data-height</span>=&quot;520&quot;<span class="tag">&gt;&lt;/script&gt;</span></pre>
            </div>
            <p class="slip-foot">
              If your host strips scripts, paste the plain-iframe version instead &mdash; same widget, no JavaScript needed.
            </p>
          </div>
        </div>
      </section>

      <section class="section" aria-labelledby="faq">
        <div class="runhead">
          <span class="tab">details</span>
          <span class="rule" aria-hidden="true"></span>
          <h2 id="faq">Common questions</h2>
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
            <p><strong>Just your clients.</strong> You add each client&rsquo;s email (or import a CSV) before they can book. You choose which animal types you accept.</p>
          </div>
          <div class="qa-item">
            <h3>Can I charge more for a second dog?</h3>
            <p><strong>No.</strong> Rates are flat per service. A second pet uses a slot of your capacity, not extra money.</p>
          </div>
        </div>
      </section>

      <section class="section invite" aria-labelledby="invite">
        <div class="runhead">
          <h2 id="invite">Want in?</h2>
          <span class="rule" aria-hidden="true"></span>
          <span class="tab">invite-only</span>
        </div>
        <p>Pawservation is invite-only while it grows. Ask, and we&rsquo;ll set up your services, rates, and booking page.</p>
        <a class="cta" href="mailto:bradburch@duck.com?subject=Pawservation%20invite">Ask for an invite &rarr;</a>
        <div class="links">
          <a class="quiet" href="/admin">Already have an account? Sign in &rarr;</a>
        </div>
      </section>

      <footer class="foot">
        <p>
          Pawservation is open source (MIT) &mdash;
          <a href="https://github.com/bradburch/pawservation">source &amp; technical docs on GitHub</a>
          &middot;
          <a href="https://github.com/bradburch/pawservation/blob/main/docs/index.md">project page</a>
        </p>
      </footer>
    </main>
  </body>
</html>
`;

app.get('/', (c) => c.html(LANDING_HTML));

// Uniform JSON 500 so an unhandled throw (e.g. a route that rethrows after cleanup) doesn't fall
// through to Hono's plain-text default and break the { error } contract every client parses.
// Internal detail is logged, never returned.
app.onError((err, c) => {
  console.error('unhandled error', err);
  return c.json({ error: 'Something went wrong.' }, 500);
});

export default app;
