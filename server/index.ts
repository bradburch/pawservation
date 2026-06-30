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
    <title>Pawbook</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, -apple-system, sans-serif;
        color: #1f2937;
        background: linear-gradient(160deg, #eef2ff 0%, #f6f3ee 100%);
      }
      main { text-align: center; padding: 32px; }
      .logo { font-size: 2.5rem; line-height: 1; }
      h1 { margin: 12px 0 4px; font-size: 1.8rem; letter-spacing: -0.01em; }
      p { margin: 0 0 28px; color: #6b7280; }
      a.cta {
        display: inline-block;
        padding: 12px 28px;
        background: #4f46e5;
        color: #fff;
        text-decoration: none;
        border-radius: 9999px;
        font-weight: 600;
        font-size: 1rem;
        transition: background 0.15s ease;
      }
      a.cta:hover { background: #4338ca; }
    </style>
  </head>
  <body>
    <main>
      <div class="logo">🐾</div>
      <h1>Pawbook</h1>
      <p>Multi-tenant booking for pet care providers.</p>
      <a class="cta" href="/admin">Open the admin dashboard</a>
    </main>
  </body>
</html>
`;

app.get('/', (c) => c.html(LANDING_HTML));

export default app;
