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
 * Root landing page: a single button into the admin dashboard. Static, script-free HTML (served
 * under LOCKED_CSP, so only inline styles are allowed — no <script>), so it needs no build step.
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
        --soft: #5e675f;
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
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 32px 20px;
        font-family: var(--sans);
        color: var(--ink);
        /* A faint ruled-notebook wash on warm paper — the ledger, felt not shouted. */
        background-color: var(--paper);
        background-image:
          radial-gradient(120% 80% at 50% -10%, #f2ecdd 0%, var(--paper) 55%),
          repeating-linear-gradient(
            to bottom,
            transparent 0 31px,
            rgba(38, 49, 46, 0.05) 31px 32px
          );
      }
      main {
        width: 100%;
        max-width: 560px;
        text-align: center;
      }

      /* ── Signature: the ledger card ─────────────────────────────── */
      .ledger {
        text-align: left;
        background: var(--paper-2);
        border: 1px solid var(--rule);
        border-radius: 4px;
        padding: 18px 20px 20px;
        box-shadow:
          0 1px 0 #fff inset,
          0 18px 40px -26px rgba(38, 49, 46, 0.6);
        transform: rotate(-0.7deg);
      }
      .ledger-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding-bottom: 10px;
        border-bottom: 2px solid var(--ink);
      }
      .ledger-head .eyebrow {
        font-family: var(--mono);
        font-size: 0.66rem;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--soft);
        line-height: 1.5;
      }
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
      .entry .svc { color: var(--soft); }
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

      /* ── Wordmark + copy ────────────────────────────────────────── */
      .brand {
        margin: 30px 0 6px;
        font-family: var(--serif);
        font-weight: 700;
        font-size: clamp(3rem, 12vw, 4.4rem);
        line-height: 0.92;
        letter-spacing: -0.02em;
      }
      .lede {
        margin: 0 auto 4px;
        max-width: 30ch;
        font-family: var(--serif);
        font-size: 1.12rem;
        line-height: 1.4;
      }
      .sub {
        margin: 0 auto 26px;
        max-width: 34ch;
        color: var(--soft);
        font-size: 0.95rem;
      }

      /* ── Actions ────────────────────────────────────────────────── */
      .actions {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 14px;
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
      a.demo {
        font-family: var(--mono);
        font-size: 0.78rem;
        letter-spacing: 0.06em;
        color: var(--soft);
        text-decoration: none;
        border-bottom: 2px solid var(--accent);
        padding-bottom: 1px;
      }
      a.demo:hover { color: var(--ink); }
      :focus-visible {
        outline: 3px solid var(--accent);
        outline-offset: 3px;
        border-radius: 3px;
      }
      .foot {
        margin-top: 34px;
        font-family: var(--mono);
        font-size: 0.66rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--soft);
      }
      @media (prefers-reduced-motion: reduce) {
        a.cta { transition: none; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="ledger" aria-hidden="true">
        <div class="ledger-head">
          <div class="eyebrow">Pawbook<b>Day book</b>Wed · Jul 2</div>
          <svg class="stamp" viewBox="0 0 100 100" fill="currentColor" role="img" aria-label="booked">
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
            <span class="when">boarding · Jul 2&ndash;5 · 3 nights</span>
          </div>
          <div class="entry">
            <span class="who">Otis</span>
            <span class="cost">$22</span>
            <span class="when">dog walk · Jul 3 · 30 min</span>
          </div>
          <div class="entry">
            <span class="who">Mochi</span>
            <span class="cost">$240</span>
            <span class="when">house-sit · Jul 6&ndash;9</span>
          </div>
        </div>
      </div>

      <h1 class="brand">Pawbook</h1>
      <p class="lede">Booking, kept like a ledger &mdash; for the people who keep other people&rsquo;s pets.</p>
      <p class="sub">
        One embeddable widget, every sitter&rsquo;s own rates, dates, and rules.
      </p>

      <div class="actions">
        <a class="cta" href="/admin">Open the dashboard &rarr;</a>
        <a class="demo" href="/demo">See two sitters&rsquo; widgets, live &rarr;</a>
      </div>

      <div class="foot">Open source &middot; Runs on Cloudflare Workers</div>
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
