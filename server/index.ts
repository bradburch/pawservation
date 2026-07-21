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
        /* Palette derived from the widget's own tokens (app/embed/widget.css) so the
           screenshots and the page read as one product. */
        --bg: #fcfcfa;
        --panel: #f1f5ee;
        --ink: #18271d;
        --body-c: #415044;
        --soft: #697a6d;
        --line: #e3e7e0;
        --green: #2e6440;
        --deep: #1d3826;
        --deepest: #142919;
        --card: #ffffff;
        --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
          Helvetica, Arial, sans-serif;
        --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
          "Liberation Mono", monospace;
      }
      * { box-sizing: border-box; }
      html {
        -webkit-text-size-adjust: 100%;
        scroll-behavior: smooth;
      }
      body {
        margin: 0;
        font-family: var(--sans);
        color: var(--body-c);
        background: var(--bg);
        line-height: 1.6;
        font-size: 16px;
      }
      h1, h2, h3 { color: var(--ink); margin: 0; }
      .wrap {
        width: 100%;
        max-width: 1120px;
        margin: 0 auto;
        padding: 0 24px;
      }

      /* ── Header ─────────────────────────────────────────────────── */
      .nav {
        position: sticky;
        top: 0;
        z-index: 10;
        background: rgba(252, 252, 250, 0.88);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border-bottom: 1px solid var(--line);
      }
      .nav-inner {
        display: flex;
        align-items: center;
        gap: 28px;
        height: 64px;
      }
      .logo {
        display: flex;
        align-items: center;
        gap: 9px;
        text-decoration: none;
        color: var(--ink);
        font-weight: 700;
        font-size: 1.06rem;
        letter-spacing: -0.02em;
      }
      .logo svg { display: block; color: var(--green); }
      .nav-links {
        display: none;
        gap: 24px;
        margin-left: 8px;
      }
      .nav-links a {
        color: var(--body-c);
        text-decoration: none;
        font-size: 0.9rem;
        font-weight: 500;
      }
      .nav-links a:hover { color: var(--ink); }
      .nav-right {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 18px;
      }
      .signin {
        color: var(--body-c);
        text-decoration: none;
        font-size: 0.9rem;
        font-weight: 500;
        white-space: nowrap;
      }
      .signin:hover { color: var(--ink); }
      @media (min-width: 780px) {
        .nav-links { display: flex; }
      }

      /* ── Buttons ────────────────────────────────────────────────── */
      .btn {
        display: inline-block;
        padding: 11px 22px;
        border-radius: 8px;
        font-weight: 600;
        font-size: 0.94rem;
        text-decoration: none;
        white-space: nowrap;
        transition: background-color 0.15s ease, color 0.15s ease;
      }
      .btn-primary {
        background: var(--green);
        color: #fff;
      }
      .btn-primary:hover { background: var(--deep); }
      .btn-ghost {
        color: var(--ink);
        border: 1px solid var(--line);
        background: var(--card);
      }
      .btn-ghost:hover { border-color: var(--soft); }
      .btn-sm { padding: 8px 16px; font-size: 0.88rem; }
      .btn-inverse {
        background: #fff;
        color: var(--deep);
      }
      .btn-inverse:hover { background: var(--panel); }

      /* ── Hero ───────────────────────────────────────────────────── */
      .hero { padding: 72px 0 88px; }
      .hero-grid {
        display: grid;
        gap: 56px;
        align-items: center;
      }
      .chip {
        display: inline-block;
        margin: 0 0 20px;
        padding: 5px 12px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--card);
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--green);
        letter-spacing: 0.01em;
      }
      .hero h1 {
        font-size: clamp(2.3rem, 5vw, 3.35rem);
        font-weight: 800;
        line-height: 1.06;
        letter-spacing: -0.032em;
        margin: 0 0 20px;
        max-width: 15ch;
      }
      .hero .sub {
        margin: 0 0 30px;
        max-width: 48ch;
        font-size: 1.08rem;
        color: var(--body-c);
      }
      .cta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 18px;
      }
      .note {
        margin: 0;
        font-size: 0.84rem;
        color: var(--soft);
        max-width: 46ch;
      }
      .note a {
        color: var(--ink);
        text-decoration: underline;
        text-decoration-color: var(--green);
        text-underline-offset: 2px;
      }

      /* Signature: the real widget on a soft product panel, with a CSS-built
         "new request" card floating over it — the confirm-or-decline promise, shown. */
      .hero-visual { position: relative; }
      .visual-panel {
        position: relative;
        border-radius: 16px;
        background: radial-gradient(130% 120% at 20% 0%, #e7efe3 0%, var(--panel) 60%);
        border: 1px solid var(--line);
        padding: clamp(20px, 4vw, 36px) clamp(20px, 4vw, 36px) 0;
        overflow: hidden;
      }
      .screen {
        position: relative;
        max-width: 400px;
        margin: 0 auto;
        height: clamp(360px, 46vw, 480px);
        overflow: hidden;
        border-radius: 12px 12px 0 0;
        border: 1px solid var(--line);
        border-bottom: 0;
        background: #fff;
        box-shadow: 0 24px 60px -32px rgba(24, 39, 29, 0.45);
      }
      .screen img { display: block; width: 100%; height: auto; }
      .screen-fade {
        position: absolute;
        inset: auto 0 0 0;
        height: 90px;
        background: linear-gradient(to bottom, rgba(241, 245, 238, 0), var(--panel));
        pointer-events: none;
      }
      .req-card {
        position: absolute;
        right: clamp(6px, 2vw, 22px);
        bottom: 26px;
        width: 216px;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 12px 14px;
        box-shadow: 0 16px 40px -20px rgba(24, 39, 29, 0.5);
        font-size: 0.78rem;
        line-height: 1.45;
      }
      .req-card .req-label {
        font-weight: 700;
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.07em;
        color: var(--green);
      }
      .req-card .req-what { color: var(--ink); font-weight: 600; }
      .req-card .req-btns {
        display: flex;
        gap: 6px;
        margin-top: 8px;
      }
      .req-card .req-btns span {
        flex: 1;
        text-align: center;
        padding: 5px 0;
        border-radius: 6px;
        font-weight: 600;
        font-size: 0.74rem;
      }
      .req-yes { background: var(--green); color: #fff; }
      .req-no { border: 1px solid var(--line); color: var(--body-c); }
      @media (min-width: 880px) {
        .hero-grid { grid-template-columns: 1.05fr 0.95fr; }
      }

      /* ── Section scaffolding ────────────────────────────────────── */
      section { scroll-margin-top: 80px; }
      .section { padding: 88px 0; }
      .section-head { max-width: 60ch; margin-bottom: 48px; }
      .label {
        display: block;
        margin-bottom: 10px;
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.09em;
        color: var(--green);
      }
      .section h2 {
        font-size: clamp(1.65rem, 3.4vw, 2.15rem);
        font-weight: 750;
        letter-spacing: -0.025em;
        line-height: 1.15;
        margin: 0 0 12px;
      }
      .section-head p { margin: 0; color: var(--body-c); max-width: 52ch; }
      .band { background: var(--panel); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }

      /* ── How it works ───────────────────────────────────────────── */
      .steps {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: 28px;
      }
      .step-card {
        display: flex;
        flex-direction: column;
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        overflow: hidden;
      }
      .step-card .frame {
        background: var(--panel);
        border-bottom: 1px solid var(--line);
        padding: 18px;
        display: flex;
        align-items: center;
        height: 224px;
        overflow: hidden;
      }
      /* The calendar shot is much taller than the others: crop it from the top
         (month header visible) so all three cards stay the same height. */
      .step-card .frame-tall { align-items: flex-start; }
      .step-card img {
        display: block;
        width: 100%;
        height: auto;
        border-radius: 6px;
        border: 1px solid var(--line);
        background: #fff;
        box-shadow: 0 10px 24px -18px rgba(24, 39, 29, 0.5);
      }
      .step-card .step-body { padding: 20px 22px 24px; }
      .step-no {
        font-family: var(--mono);
        font-size: 0.74rem;
        font-weight: 700;
        color: var(--green);
      }
      .step-card h3 {
        margin: 6px 0 8px;
        font-size: 1.06rem;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .step-card p { margin: 0; font-size: 0.92rem; color: var(--body-c); }
      @media (min-width: 780px) {
        .steps { grid-template-columns: 1fr 1fr 1fr; }
      }

      /* ── Dashboard: the bookings queue, rebuilt in CSS ──────────── */
      .mockdash {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 12px;
        box-shadow: 0 20px 50px -30px rgba(24, 39, 29, 0.5);
        margin-bottom: 48px;
        overflow: hidden;
      }
      .mockdash-top {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 14px 22px;
        border-bottom: 1px solid var(--line);
        background: var(--bg);
      }
      .mockdash-title {
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--ink);
      }
      .mockdash-count {
        padding: 2px 9px;
        border-radius: 999px;
        background: var(--panel);
        color: var(--green);
        font-size: 0.73rem;
        font-weight: 700;
      }
      .mockdash-when {
        margin-left: auto;
        font-size: 0.78rem;
        color: var(--soft);
      }
      .mock-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 18px;
        padding: 16px 22px;
        border-bottom: 1px solid var(--line);
      }
      .mock-row:last-child { border-bottom: 0; }
      .mock-info { flex: 1 1 240px; min-width: 0; }
      .mock-who {
        color: var(--ink);
        font-weight: 600;
        font-size: 0.94rem;
      }
      .mock-meta {
        margin-top: 2px;
        font-size: 0.83rem;
        color: var(--soft);
      }
      .state {
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 0.73rem;
        font-weight: 600;
        white-space: nowrap;
      }
      .state-pend { background: #f8f1de; color: #8a6b1c; }
      .state-ok { background: #e7f2e8; color: #23684a; }
      .mock-actions {
        display: flex;
        gap: 8px;
        margin-left: auto;
      }
      .mbtn {
        padding: 7px 14px;
        border-radius: 7px;
        font-size: 0.8rem;
        font-weight: 600;
        white-space: nowrap;
      }
      .mbtn-primary { background: var(--green); color: #fff; }
      .mbtn-line {
        border: 1px solid var(--line);
        background: #fff;
        color: var(--body-c);
      }
      @media (max-width: 560px) {
        .mock-actions { margin-left: 0; width: 100%; }
        .mbtn { flex: 1; text-align: center; }
      }
      .features {
        display: grid;
        gap: 28px 40px;
      }
      .feature h3 {
        font-size: 0.98rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        margin: 0 0 5px;
      }
      .feature p { margin: 0; font-size: 0.9rem; color: var(--body-c); }
      @media (min-width: 640px) { .features { grid-template-columns: 1fr 1fr; } }
      @media (min-width: 960px) { .features { grid-template-columns: 1fr 1fr 1fr; } }

      /* ── Install ────────────────────────────────────────────────── */
      .install-grid {
        display: grid;
        gap: 40px;
        align-items: center;
      }
      .install-copy p { margin: 0 0 14px; max-width: 44ch; }
      .install-copy p:last-child { margin-bottom: 0; font-size: 0.88rem; color: var(--soft); }
      .codecard {
        background: var(--deepest);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 24px 60px -36px rgba(20, 41, 25, 0.9);
      }
      .codecard-cap {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        padding: 11px 18px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.09);
        font-family: var(--mono);
        font-size: 0.7rem;
        letter-spacing: 0.06em;
        color: #8fa896;
      }
      .code-scroll { overflow-x: auto; }
      .codecard pre {
        margin: 0;
        padding: 20px 18px;
        min-width: max-content;
        font-family: var(--mono);
        font-size: 0.84rem;
        line-height: 1.75;
        color: #e8efe8;
      }
      .codecard .tag { color: #93c9a4; }
      .codecard .attr { color: #d8c98a; }
      @media (min-width: 880px) {
        .install-grid { grid-template-columns: 0.85fr 1.15fr; }
      }

      /* ── FAQ ────────────────────────────────────────────────────── */
      .qa { display: grid; gap: 8px 48px; }
      .qa-item { padding: 20px 0; border-top: 1px solid var(--line); }
      .qa-item h3 {
        margin: 0 0 7px;
        font-size: 1rem;
        font-weight: 700;
        letter-spacing: -0.01em;
      }
      .qa-item p { margin: 0; font-size: 0.92rem; color: var(--body-c); max-width: 46ch; }
      .qa-item p strong { color: var(--ink); }
      @media (min-width: 700px) { .qa { grid-template-columns: 1fr 1fr; } }

      /* ── CTA band ───────────────────────────────────────────────── */
      .cta-band { padding: 40px 0 96px; }
      .cta-panel {
        background: linear-gradient(140deg, var(--deep) 0%, var(--deepest) 80%);
        border-radius: 18px;
        padding: clamp(44px, 7vw, 72px) clamp(24px, 6vw, 72px);
        text-align: center;
      }
      .cta-panel h2 {
        color: #fff;
        font-size: clamp(1.7rem, 3.6vw, 2.3rem);
        font-weight: 750;
        letter-spacing: -0.025em;
        margin: 0 0 12px;
      }
      .cta-panel p {
        margin: 0 auto 28px;
        max-width: 46ch;
        color: #c4d2c6;
      }
      .cta-panel .cta-row { justify-content: center; margin-bottom: 0; }
      .cta-panel .signin-inverse {
        align-self: center;
        color: #c4d2c6;
        font-size: 0.9rem;
        text-decoration: underline;
        text-underline-offset: 3px;
      }
      .cta-panel .signin-inverse:hover { color: #fff; }

      /* ── Footer ─────────────────────────────────────────────────── */
      .foot {
        border-top: 1px solid var(--line);
        padding: 48px 0 40px;
        font-size: 0.88rem;
      }
      .foot-grid {
        display: grid;
        gap: 36px;
        margin-bottom: 40px;
      }
      .foot-brand .logo { margin-bottom: 10px; }
      .foot-brand p { margin: 0; color: var(--soft); max-width: 34ch; font-size: 0.86rem; }
      .foot h3 {
        font-size: 0.76rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--soft);
        margin: 0 0 12px;
      }
      .foot ul { list-style: none; margin: 0; padding: 0; }
      .foot li { margin-bottom: 9px; }
      .foot a { color: var(--body-c); text-decoration: none; }
      .foot a:hover { color: var(--ink); }
      .foot-bottom {
        border-top: 1px solid var(--line);
        padding-top: 22px;
        color: var(--soft);
        font-size: 0.8rem;
      }
      .foot-bottom p { margin: 0; }
      @media (min-width: 700px) {
        .foot-grid { grid-template-columns: 1.4fr 1fr 1fr; }
      }

      :focus-visible {
        outline: 3px solid var(--green);
        outline-offset: 3px;
        border-radius: 4px;
      }
      @media (prefers-reduced-motion: reduce) {
        html { scroll-behavior: auto; }
        .btn { transition: none; }
      }
    </style>
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
          <a href="#dashboard">Dashboard</a>
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
              <a class="btn btn-ghost" href="mailto:bradburch@duck.com?subject=Pawservation%20invite">Ask for an invite</a>
            </div>
            <p class="note">
              Pawservation is invite-only while it grows &mdash;
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
            <p>The widget shows only what you offer and only when you can take it. Nothing is booked until you say so.</p>
          </div>
          <ol class="steps">
            <li class="step-card">
              <div class="frame">
                <img
                  src="/img/landing/step-services.webp"
                  alt="The widget's service picker: Boarding selected from a row of services including House sitting, Day care, Walks, Check-ins, and Morning walk"
                />
              </div>
              <div class="step-body">
                <span class="step-no">01</span>
                <h3>They pick a service</h3>
                <p>Your services, under your names and your prices &mdash; boarding, day care, walks, or anything you invent.</p>
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
                <div class="mock-who">Marco T. &mdash; Day care</div>
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
              <p>Boarding, house-sitting, day care, walks, check-ins, or your own custom service &mdash; each with its own price.</p>
            </div>
            <div class="feature">
              <h3>Caps &amp; time off</h3>
              <p>A boarding cap, a house-sits-per-day cap, a longest stay, your days off. A full day isn&rsquo;t offered.</p>
            </div>
            <div class="feature">
              <h3>Clients &amp; pets</h3>
              <p>Invite by email or CSV up to 500. Keep profiles and care notes for every animal.</p>
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

      <section class="section band" id="install" aria-labelledby="install-h">
        <div class="wrap install-grid">
          <div class="install-copy">
            <span class="label">Install</span>
            <h2 id="install-h">One line on any website</h2>
            <p>Paste it into Squarespace, Wix, or any page, change the slug to yours, and save. The widget sizes itself to fit.</p>
            <p>If your host strips scripts, paste the plain-iframe version instead &mdash; same widget, no JavaScript needed.</p>
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
              <p><strong>Just your clients.</strong> You add each client&rsquo;s email (or import a CSV) before they can book. You choose which animal types you accept.</p>
            </div>
            <div class="qa-item">
              <h3>Can I charge more for a second dog?</h3>
              <p><strong>No.</strong> Rates are flat per service. A second pet uses a slot of your capacity, not extra money.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="cta-band" aria-labelledby="invite-h">
        <div class="wrap">
          <div class="cta-panel">
            <h2 id="invite-h">Want in?</h2>
            <p>Pawservation is invite-only while it grows. Ask, and we&rsquo;ll set up your services, rates, and booking page.</p>
            <div class="cta-row">
              <a class="btn btn-inverse" href="mailto:bradburch@duck.com?subject=Pawservation%20invite">Ask for an invite</a>
              <a class="signin-inverse" href="/admin">Already have an account? Sign in</a>
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
              <li><a href="#how">How it works</a></li>
              <li><a href="#faq">FAQ</a></li>
            </ul>
          </div>
          <div>
            <h3>Open source</h3>
            <ul>
              <li><a href="https://github.com/bradburch/pawservation">Source on GitHub</a></li>
              <li><a href="https://github.com/bradburch/pawservation/blob/main/docs/index.md">Technical docs</a></li>
            </ul>
          </div>
        </div>
        <div class="foot-bottom">
          <p>
            Pawservation is open source under the MIT license &middot; Created by
            <a href="https://bradburch.github.io/">Brad Burch</a>
          </p>
        </div>
      </div>
    </footer>
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
