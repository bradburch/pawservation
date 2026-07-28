import { Hono } from 'hono';
import * as v from 'valibot';
import { sendInviteRequest, type InviteRequestFields } from '../lib/email';
import { renderInviteForm, type InviteFormValues } from '../lib/invite-form';
import { parseOwnerEmails } from '../lib/owners';
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
  email: v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254), v.regex(EMAIL_RE)),
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
const FALLBACK_OWNER_EMAIL = 'bradburch@duck.com';

/** The generic 400 line, shown when the body was unparsable and no per-field detail exists. */
const INVALID_MESSAGE =
  'Please fill in every required field with a valid email address, then try again.';

/** Names the required fields that are missing or invalid, so the 400 page can say WHICH ones
 * to fix instead of making the visitor re-check all nine. Mirrors InviteRequestBody's rules for
 * the required fields only (optional fields can't 400 on emptiness). */
function invalidFields(values: InviteFormValues): string[] {
  const bad: string[] = [];
  if (!values.business?.trim()) bad.push('Business name');
  if (!values.name?.trim()) bad.push('Your name');
  const email = values.email?.trim() ?? '';
  if (!email) bad.push('Email');
  else if (!EMAIL_RE.test(email) || email.length > 254) bad.push('Email (not a valid address)');
  if (!values.city?.trim()) bad.push('City');
  if (!values.services?.trim()) bad.push('Services you offer');
  if (!CUSTOMER_COUNTS.includes(values.customerCount as (typeof CUSTOMER_COUNTS)[number]))
    bad.push('How many customers');
  return bad;
}

/** `raw` is Hono's parsed-body shape: each key is a string, a File (multipart), or — when the
 * same key is submitted more than once — an array of either. Only plain strings are ever safe to
 * echo back into the re-rendered form; anything else (a duplicate key, a file) is dropped rather
 * than reflected. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function echoValues(raw: Record<string, unknown>): InviteFormValues {
  return {
    business: asString(raw.business),
    name: asString(raw.name),
    email: asString(raw.email),
    phone: asString(raw.phone),
    city: asString(raw.city),
    neighborhoods: asString(raw.neighborhoods),
    services: asString(raw.services),
    customerCount: asString(raw.customerCount),
    notes: asString(raw.notes),
  };
}

/** The honeypot ("fax") is filled by a bot, never a sighted visitor — but only when it carries a
 * real value. `undefined` (field absent) and an empty/whitespace-only string are both "empty" and
 * must NOT trip the check. Anything else counts as filled, including a value that isn't a plain
 * string at all — an array (the same key submitted more than once) or a File (a multipart field
 * posted as a file upload) — since a naive `typeof value === 'string'` check would silently let
 * either of those sail through undetected. */
function isHoneypotFilled(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function renderErrorPage(values: InviteFormValues): string {
  const problems = invalidFields(values);
  const detail =
    problems.length > 0
      ? `Please fix ${problems.length === 1 ? 'this field' : 'these fields'}, then try again: ${problems.join(', ')}.`
      : INVALID_MESSAGE;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pawservation — invite request</title>
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <main class="wrap" style="padding:96px 0;">
      <div class="cta-panel" style="max-width:640px;margin:0 auto;">
        <h1 style="font-size:1.6rem;margin:0 0 8px;">Couldn&rsquo;t send that</h1>
        <p class="note" style="color:#c4d2c6;margin:0 auto 20px;font-size:1rem;">${detail}</p>
        ${renderInviteForm(values)}
        <p class="note" style="margin:20px auto 0;"><a href="/" style="color:#c4d2c6;">&larr; Back to the homepage</a></p>
      </div>
    </main>
  </body>
</html>`;
}

function renderThanksPage(fallback: boolean, ownerEmail: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pawservation — request sent</title>
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
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
        Or email us directly: <a href="mailto:${ownerEmail}?subject=Pawservation%20invite">${ownerEmail}</a>
      </p>`
          : ''
      }
      <a class="btn btn-primary" href="/">Back to the homepage</a>
    </main>
  </body>
</html>`;
}

export const inviteRequestRoutes = new Hono<AppEnv>()
  .get('/request-invite', (c) => c.redirect('/#invite-h', 302))
  .get('/request-invite/thanks', (c) => {
    const ownerEmail = parseOwnerEmails(c.env)[0] ?? FALLBACK_OWNER_EMAIL;
    return c.html(renderThanksPage(c.req.query('fallback') === '1', ownerEmail));
  })
  .post('/request-invite', async (c) => {
    let raw: Record<string, unknown>;
    try {
      // `all: true` so a duplicate key (the same field submitted twice) surfaces as an array
      // instead of silently collapsing to its last value — real fields then simply fail
      // validation (an array isn't a string), and the honeypot check below treats an array as
      // filled regardless of contents.
      raw = await c.req.parseBody({ all: true });
    } catch (err) {
      // A malformed body (e.g. a Content-Type that claims multipart but isn't) throws inside
      // Hono's own form-data parsing — that must not become an unhandled 500.
      console.error('invite request body parse failed', err);
      return c.html(renderErrorPage({}), 400);
    }

    // Honeypot first: a filled hidden field is treated as a bot, dropped silently, and given
    // the SAME redirect as success — checked before validation so no field's shape ever leaks
    // to whatever filled it in.
    if (isHoneypotFilled(raw.fax)) return c.redirect(THANKS_PATH, 303);

    const parsed = v.safeParse(InviteRequestBody, raw);
    if (!parsed.success) return c.html(renderErrorPage(echoValues(raw)), 400);

    // Rate limit is charged ONLY now, on a submission that already passed validation — repeated
    // invalid submissions (bad email, missing field) must never burn a legitimate caller's cap.
    // Skipped entirely when CF-Connecting-IP is absent (always present in production; local/dev/
    // test callers would otherwise all share one 'unknown' bucket), and a KV failure fails OPEN
    // (log + proceed) rather than 500 — the limiter is a soft cap, not a hard dependency.
    const ip = c.req.header('CF-Connecting-IP');
    let overCap = false;
    if (ip) {
      try {
        overCap = await checkAndBumpRateLimit(
          c.env.PAWBOOK_CACHE,
          RATE_KEY(ip),
          RATE_LIMIT_MAX,
          RATE_LIMIT_TTL_SECONDS,
        );
      } catch (err) {
        console.error('invite request rate limit check failed', err);
        overCap = false;
      }
    }
    if (overCap) return c.redirect(THANKS_PATH, 303);

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
