import { Hono } from 'hono';
import { tenantMiddleware } from './lib/middleware';
import { adminRoutes } from './routes/admin';
import { adminAuthRoutes } from './routes/admin-auth';
import { authRoutes } from './routes/auth';
import { bookingRoutes } from './routes/bookings';
import { oauthRoutes } from './routes/oauth';
import { publicRoutes } from './routes/public';
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

/**
 * Root landing page: a self-contained capability page for prospective sitters. Static and
 * script-free (served under LOCKED_CSP, so only inline styles are allowed — NO <script>, no
 * external fonts/CSS/images), so it needs no build step. Any interactivity is native HTML/CSS
 * (the FAQ uses <details>/<summary>). The embed snippet below is shown as escaped text
 * (&lt;script&gt;…) so the served body genuinely contains no <script tag.
 */
const LANDING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pawbook — booking, kept like a ledger</title>
    <style>
      :root {
        color-scheme: light;
        --paper: #ece6d8;
        --paper-2: #f7f3ea;
        --ink: #26312e;
        --soft: #545d4d;
        --rule: #d6cebc;
        --accent: #c77d0a;
        --stamp: #9e3b4e;
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
          radial-gradient(120% 60% at 50% -6%, #f2ecdd 0%, var(--paper) 55%),
          repeating-linear-gradient(
            to bottom,
            transparent 0 31px,
            rgba(38, 49, 46, 0.05) 31px 32px
          );
      }
      .page {
        width: 100%;
        max-width: 760px;
        margin: 0 auto;
        padding: 40px 22px 64px;
      }

      /* ── Utility type: mono eyebrows / folios / captions ─────────── */
      .eyebrow {
        font-family: var(--mono);
        font-size: 0.66rem;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--soft);
        margin: 0;
      }

      /* ── Signature: the ledger card ─────────────────────────────── */
      .hero { text-align: center; }
      .ledger {
        position: relative;
        text-align: left;
        max-width: 460px;
        margin: 0 auto;
        background: var(--paper-2);
        border: 1px solid var(--rule);
        border-radius: 4px;
        padding: 18px 20px 20px;
        box-shadow:
          0 1px 0 #fff inset,
          0 18px 40px -26px rgba(38, 49, 46, 0.6);
        transform: rotate(-0.7deg);
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
      .ledger-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 10px;
        border-bottom: 2px solid var(--ink);
      }
      .ledger-head .eyebrow { line-height: 1.5; }
      .ledger-head .eyebrow b {
        display: block;
        color: var(--ink);
        font-weight: 700;
        letter-spacing: 0.24em;
        font-size: 0.78rem;
      }
      .stamp {
        flex: none;
        width: 66px;
        height: 66px;
        margin-top: -2px;
        color: var(--stamp);
        opacity: 0.88;
        transform: rotate(-9deg);
      }
      .entries {
        margin: 0;
        font-family: var(--mono);
        font-size: 0.82rem;
      }
      .entry {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 2px 12px;
        align-items: baseline;
        padding: 9px 0;
        border-bottom: 1px solid var(--rule);
      }
      .entry:last-child { border-bottom: 0; padding-bottom: 2px; }
      .entry .who { font-weight: 700; color: var(--ink); }
      .entry .when {
        grid-column: 1;
        color: var(--soft);
        font-size: 0.74rem;
      }
      .entry .cost {
        grid-column: 2;
        grid-row: 1 / span 2;
        align-self: center;
        color: var(--accent);
        font-weight: 700;
      }

      /* ── Wordmark + hero copy ───────────────────────────────────── */
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
        max-width: 42ch;
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
        background: var(--ink);
        color: var(--paper-2);
        text-decoration: none;
        border-radius: 4px;
        font-weight: 600;
        font-size: 1rem;
        border: 1px solid var(--ink);
        transition:
          transform 0.12s ease,
          box-shadow 0.12s ease;
        box-shadow: 0 6px 18px -10px rgba(38, 49, 46, 0.8);
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
      .deploy-note {
        margin: 4px auto 0;
        max-width: 46ch;
        font-family: var(--mono);
        font-size: 0.72rem;
        line-height: 1.55;
        letter-spacing: 0.01em;
        color: var(--soft);
      }

      /* ── Section rhythm ─────────────────────────────────────────── */
      .section {
        margin-top: 60px;
        padding-top: 22px;
        border-top: 2px solid var(--ink);
      }
      .section-title {
        margin: 6px 0 6px;
        font-family: var(--serif);
        font-weight: 700;
        font-size: clamp(1.7rem, 6vw, 2.2rem);
        line-height: 1.06;
        letter-spacing: -0.01em;
      }
      .section-note {
        margin: 0 0 8px;
        max-width: 54ch;
        color: var(--soft);
      }

      /* ── The day's work: a numbered run down the book ───────────── */
      .steps { margin: 22px 0 0; }
      .step {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 4px 20px;
        padding: 20px 0;
        border-bottom: 1px solid var(--rule);
      }
      .step:last-child { border-bottom: 0; }
      .step .folio {
        grid-row: 1 / span 2;
        font-family: var(--mono);
        font-size: 0.72rem;
        letter-spacing: 0.14em;
        color: var(--accent);
        padding-top: 0.35em;
        white-space: nowrap;
      }
      .step h3 {
        margin: 0;
        font-family: var(--serif);
        font-weight: 700;
        font-size: 1.28rem;
        line-height: 1.2;
      }
      .step p {
        margin: 6px 0 0;
        color: var(--soft);
        max-width: 56ch;
      }
      .step .fine {
        display: block;
        margin-top: 6px;
        font-family: var(--mono);
        font-size: 0.74rem;
        letter-spacing: 0.02em;
        color: var(--ink);
        opacity: 0.75;
      }

      /* ── Embed slip ─────────────────────────────────────────────── */
      .slip {
        margin-top: 22px;
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

      /* ── FAQ: entries you can lift the flap on ──────────────────── */
      .faq { margin-top: 22px; }
      .faq details {
        border-bottom: 1px solid var(--rule);
      }
      .faq details[open] summary { color: var(--ink); }
      .faq summary {
        list-style: none;
        cursor: pointer;
        padding: 16px 34px 16px 0;
        position: relative;
        font-family: var(--serif);
        font-size: 1.14rem;
        font-weight: 700;
        color: var(--ink);
      }
      .faq summary::-webkit-details-marker { display: none; }
      .faq summary::after {
        content: "+";
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        font-family: var(--mono);
        font-weight: 400;
        font-size: 1.3rem;
        color: var(--accent);
      }
      .faq details[open] summary::after { content: "\\2212"; }
      .faq .answer {
        margin: 0;
        padding: 0 0 18px;
        color: var(--soft);
        max-width: 60ch;
      }
      .faq .answer strong { color: var(--ink); font-weight: 700; }

      /* ── Footer ─────────────────────────────────────────────────── */
      .foot {
        margin-top: 56px;
        padding-top: 20px;
        border-top: 2px solid var(--ink);
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px 14px;
        font-family: var(--mono);
        font-size: 0.68rem;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--soft);
      }
      .foot a {
        color: var(--soft);
        text-decoration: none;
        border-bottom: 1px solid var(--accent);
      }
      .foot a:hover { color: var(--ink); }
      .foot .dot { opacity: 0.5; }

      :focus-visible {
        outline: 3px solid var(--accent);
        outline-offset: 3px;
        border-radius: 3px;
      }
      @media (prefers-reduced-motion: reduce) {
        a.cta { transition: none; }
        a.cta:hover { transform: none; }
      }
      @media (min-width: 620px) {
        .step { grid-template-columns: 5.5rem 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <header class="hero">
        <div class="ledger">
          <div class="ledger-head">
            <p class="eyebrow">Pawbook<b>Day book</b>Wed &middot; Jul 2</p>
            <svg class="stamp" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true">
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
          <div class="entries">
            <div class="entry">
              <span class="who">Bella</span>
              <span class="cost">$180</span>
              <span class="when">boarding &middot; Jul 2&ndash;5 &middot; 3 nights</span>
            </div>
            <div class="entry">
              <span class="who">Otis</span>
              <span class="cost">$22</span>
              <span class="when">dog walk &middot; Jul 3 &middot; 8&ndash;9am</span>
            </div>
            <div class="entry">
              <span class="who">Mochi</span>
              <span class="cost">$240</span>
              <span class="when">house-sit &middot; Jul 6&ndash;9</span>
            </div>
          </div>
          <span class="marginalia" aria-hidden="true">the day, all in one place</span>
        </div>

        <h1 class="brand">Pawbook</h1>
        <p class="lede">Booking, kept like a ledger &mdash; for the people who keep other people&rsquo;s pets.</p>
        <p class="sub">
          A booking page you drop onto your own site, with your services, your rates, and your rules.
          Every request waits for your yes, and the book keeps count of what you&rsquo;re owed.
        </p>

        <div class="actions">
          <a class="cta" href="/demo">See two sitters&rsquo; widgets, live &rarr;</a>
          <div class="links">
            <a class="quiet" href="/admin">Already set up? Sign in &rarr;</a>
            <a class="quiet" href="https://github.com/bradburch/pawbook">View source / self-host &rarr;</a>
          </div>
          <p class="deploy-note">
            Open source and self-hosted &mdash; today you (or a developer) deploy your own copy on Cloudflare Workers. Hosted signup is on the roadmap.
          </p>
        </div>
      </header>

      <section class="section" aria-labelledby="work">
        <p class="eyebrow">What it does</p>
        <h2 class="section-title" id="work">One day book, start to finish</h2>
        <p class="section-note">
          The same five moves, every booking &mdash; from the moment a client asks to the moment the money&rsquo;s down on the page.
        </p>
        <div class="steps">
          <div class="step">
            <span class="folio">No. 1</span>
            <h3>Take bookings on your own site</h3>
            <p>
              One line of HTML drops a live booking widget onto your site &mdash; Squarespace, Wix, a hand-built page, it doesn&rsquo;t care. It sizes itself to fit, so there&rsquo;s nothing to lay out and no theme to fight.
              <span class="fine">A plain-iframe version stands in for hosts that strip scripts.</span>
            </p>
          </div>
          <div class="step">
            <span class="folio">No. 2</span>
            <h3>Set your own services and rules</h3>
            <p>
              Boarding, house sitting, day care, walks, check-ins &mdash; you choose what you offer, what it costs, and how long it runs. Add timed walk windows (Morning walk, 8&ndash;9am) with their own capacity, per-service intake questions, and min/max nights or pet counts.
            </p>
          </div>
          <div class="step">
            <span class="folio">No. 3</span>
            <h3>Let the book keep the day honest</h3>
            <p>
              A daily boarding cap, a house-sits-per-day cap, a longest-stay limit, blocked time-off dates, and your business timezone. One booking can&rsquo;t oversell the day &mdash; if you&rsquo;re full, the widget won&rsquo;t offer it.
            </p>
          </div>
          <div class="step">
            <span class="folio">No. 4</span>
            <h3>Confirm or decline every request</h3>
            <p>
              Nothing books itself. Each request waits for your yes; you can confirm, decline, or later cancel. Clients get status emails automatically &mdash; and if an email didn&rsquo;t actually send, the dashboard says so instead of pretending.
            </p>
          </div>
          <div class="step">
            <span class="folio">No. 5</span>
            <h3>Keep the clients, the pets, and the money</h3>
            <p>
              Invite clients by email (one at a time, or a CSV up to 500 rows). Keep pet profiles and care notes. Log every payment &mdash; cash, Venmo, Zelle, PayPal, check &mdash; and read the earnings dashboard: this month against last, what&rsquo;s outstanding, a year of revenue, your top clients. Confirmed bookings push to your Google Calendar.
            </p>
          </div>
        </div>
      </section>

      <section class="section" aria-labelledby="embed">
        <p class="eyebrow">Drop it into your site</p>
        <h2 class="section-title" id="embed">One line, where you want it</h2>
        <p class="section-note">
          Paste this where the widget should appear and change the slug to yours. No code editing beyond that, no plugins.
        </p>
        <div class="slip">
          <div class="slip-cap">
            <span class="eyebrow">embed &middot; your-page.html</span>
            <span class="eyebrow">paste &amp; save</span>
          </div>
          <div class="code-scroll">
<pre><span class="tag">&lt;script</span> <span class="attr">src</span>=&quot;https://your-site/embed.js&quot;
        <span class="attr">data-pawbook-tenant</span>=&quot;your-slug&quot;
        <span class="attr">data-height</span>=&quot;520&quot;<span class="tag">&gt;&lt;/script&gt;</span></pre>
          </div>
          <p class="slip-foot">
            On a host that strips scripts? Paste the plain-iframe version instead &mdash; same widget, no JavaScript needed. Works on Squarespace, Wix, or a page you wrote by hand.
          </p>
        </div>
      </section>

      <section class="section" aria-labelledby="faq">
        <p class="eyebrow">Before you commit</p>
        <h2 class="section-title" id="faq">Straight answers</h2>
        <div class="faq">
          <details open>
            <summary>Do customers pay through Pawbook?</summary>
            <p class="answer">
              <strong>No &mdash; Pawbook doesn&rsquo;t process card payments.</strong> A booking comes in as a request with an estimated cost; you collect the money the way you already do (cash, Venmo, Zelle, PayPal, check) and log it so the earnings dashboard stays accurate. It&rsquo;s bookkeeping, not a checkout.
            </p>
          </details>
          <details>
            <summary>Does it sync with my Google Calendar?</summary>
            <p class="answer">
              <strong>One way only.</strong> Confirmed bookings push to your Google Calendar as events. It does <strong>not</strong> read your other calendar entries, so being busy elsewhere won&rsquo;t block a request on its own &mdash; mark those days as time off if you want them held.
            </p>
          </details>
          <details>
            <summary>Can I charge more for a second pet?</summary>
            <p class="answer">
              <strong>No &mdash; rates are flat per service (and per option).</strong> A second dog doesn&rsquo;t cost more; it just uses a slot of your daily capacity. If you need per-pet pricing, Pawbook won&rsquo;t do it today.
            </p>
          </details>
          <details>
            <summary>Can strangers book me from the widget?</summary>
            <p class="answer">
              <strong>No &mdash; clients are invite-only, on purpose.</strong> You add a client&rsquo;s email before they can book (one at a time, or by CSV import). You can&rsquo;t publish the widget and take walk-in strangers.
            </p>
          </details>
          <details>
            <summary>Does it handle cats, or other animals?</summary>
            <p class="answer">
              <strong>Dogs and cats only.</strong> Pet profiles are typed as dog or cat, with care notes. Other animals aren&rsquo;t supported.
            </p>
          </details>
          <details>
            <summary>Do I need to know how to code?</summary>
            <p class="answer">
              To run the widget, no &mdash; you paste one line (or the iframe) and you&rsquo;re done. Standing up your <em>own</em> Pawbook instance is a developer job today (see the next answer), but the day-to-day dashboard needs no code.
            </p>
          </details>
          <details open>
            <summary>How do I sign up? Is it free?</summary>
            <p class="answer">
              <strong>There&rsquo;s no signup button yet.</strong> Pawbook is open source (MIT) and you run your own copy on Cloudflare Workers &mdash; free to use, you provide the hosting. You (or a developer) deploy an instance and provision your business. Self-serve, hosted signup is on the roadmap; for now, start from the <a class="quiet" href="https://github.com/bradburch/pawbook">GitHub repo</a>.
            </p>
          </details>
        </div>
      </section>

      <footer class="foot">
        <span>Pawbook</span>
        <span class="dot" aria-hidden="true">&middot;</span>
        <span>Open source</span>
        <span class="dot" aria-hidden="true">&middot;</span>
        <span>MIT</span>
        <span class="dot" aria-hidden="true">&middot;</span>
        <span>Runs on Cloudflare Workers</span>
        <span class="dot" aria-hidden="true">&middot;</span>
        <a href="https://github.com/bradburch/pawbook">GitHub</a>
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
