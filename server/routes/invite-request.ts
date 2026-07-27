import { Hono } from 'hono';
import * as v from 'valibot';
import { sendInviteRequest, type InviteRequestFields } from '../lib/email';
import { PAGE_STYLE } from '../lib/page-style';
import { checkAndBumpRateLimit } from '../lib/rate-limit';
import { EMAIL_RE } from '../lib/validation';
import type { AppEnv } from '../types';

/**
 * Invite-request funnel: replaces the bare `mailto:` CTA with an on-page form (script-free,
 * posted from LANDING_HTML's cta-band) that emails the platform owner(s) a structured request.
 * Not slug-scoped and NOT under /api — these are pages, mounted top-level at '/' in index.ts.
 * No DB table: email is the inbox (YAGNI — see the spec's Never list).
 */

const CUSTOMER_COUNTS = ['0', '1-5', '6-15', '16-50', '50+'] as const;

const InviteRequestBody = v.object({
  business: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(EMAIL_RE)),
  phone: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(40))),
  city: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(80)),
  neighborhoods: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  services: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  customerCount: v.picklist(CUSTOMER_COUNTS),
  notes: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
});

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_TTL_SECONDS = 3600;
const RATE_KEY = (ip: string) => `invite-request:rl:${ip}`;

const THANKS_PATH = '/request-invite/thanks';
const THANKS_FALLBACK_PATH = `${THANKS_PATH}?fallback=1`;

/** A single friendly line for every 400 case (missing field or bad email alike) — deliberately
 * not field-specific, so the re-render stays a small static page rather than a form re-fill. */
const INVALID_MESSAGE =
  'Please fill in every required field with a valid email address, then try again.';

function renderErrorPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pawservation — invite request</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <main class="wrap" style="padding:96px 0;text-align:center;">
      <h1>Couldn&rsquo;t send that</h1>
      <p class="note" style="margin:0 auto 24px;font-size:1rem;">${INVALID_MESSAGE}</p>
      <a class="btn btn-primary" href="/#invite-h">Back to the form</a>
    </main>
  </body>
</html>`;
}

function renderThanksPage(fallback: boolean): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pawservation — request sent</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <main class="wrap" style="padding:96px 0;text-align:center;">
      <h1>Thanks &mdash; we&rsquo;ve got it</h1>
      <p class="note" style="margin:0 auto 12px;font-size:1rem;">
        We&rsquo;ll be in touch by email to set up your services, rates, and booking page.
      </p>
      ${
        fallback
          ? `<p class="note" style="margin:0 auto 24px;font-size:1rem;">
        Or email us directly: <a href="mailto:bradburch@duck.com?subject=Pawservation%20invite">bradburch@duck.com</a>
      </p>`
          : ''
      }
      <a class="btn btn-primary" href="/">Back to the homepage</a>
    </main>
  </body>
</html>`;
}

export const inviteRequestRoutes = new Hono<AppEnv>()
  .get('/request-invite/thanks', (c) => {
    return c.html(renderThanksPage(c.req.query('fallback') === '1'));
  })
  .post('/request-invite', async (c) => {
    const raw = await c.req.parseBody();

    // Honeypot first: a filled hidden field is treated as a bot, dropped silently, and given
    // the SAME redirect as success — checked before validation so no field's shape ever leaks
    // to whatever filled it in.
    if (typeof raw.website === 'string' && raw.website.trim() !== '') {
      return c.redirect(THANKS_PATH, 303);
    }

    // IP-only rate limit (no email dimension here — there's no account to key off of yet).
    // Over cap → the identical success redirect, so the limiter is never an oracle.
    const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const overCap = await checkAndBumpRateLimit(
      c.env.PAWBOOK_CACHE,
      RATE_KEY(ip),
      RATE_LIMIT_MAX,
      RATE_LIMIT_TTL_SECONDS,
    );
    if (overCap) return c.redirect(THANKS_PATH, 303);

    const parsed = v.safeParse(InviteRequestBody, raw);
    if (!parsed.success) return c.html(renderErrorPage(), 400);

    const fields: InviteRequestFields = parsed.output;
    try {
      await sendInviteRequest(c.env, fields);
      return c.redirect(THANKS_PATH, 303);
    } catch (err) {
      // Unconfigured email, no owners configured, and a real Resend failure all land here —
      // best-effort, logged, never a 5xx; the thanks page grows a mailto fallback instead.
      console.error('invite request send failed', err);
      return c.redirect(THANKS_FALLBACK_PATH, 303);
    }
  });
