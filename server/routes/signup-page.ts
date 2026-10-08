import { Hono } from 'hono';
import * as v from 'valibot';
import {
  addAllowedSitter,
  getAllowedSitter,
  getOwnerUserByEmail,
  getTenantUserByEmail,
} from '../db/repo';
import { htmlEscape, isEmailConfigured, sendSignupLink, sendSignupNotice } from '../lib/email';
import { isOwnerEmail } from '../lib/owners';
import { PAGE_STYLE } from '../lib/page-style';
import { PRICING } from '../lib/plan-pricing';
import { attributionFromForm, attributionFromRequest, type Attribution } from '../lib/attribution';
import { checkAndBumpRateLimit } from '../lib/rate-limit';
import { mintLink, SIGNUP_LINK_TTL_SECONDS } from '../lib/signup-link';
import { renderSignupForm, TURNSTILE_SCRIPT_TAG } from '../lib/signup-form';
import { turnstileState, verifyTurnstile } from '../lib/turnstile';
import { EMAIL_RE } from '../lib/validation';
import { marketingHtml } from '../lib/web-analytics';
import type { AppEnv } from '../types';

/**
 * Self-serve sitter signup: the public front door that replaced the invite-request form.
 *
 * A sitter enters her email; a Turnstile-verified, rate-limited submission is answered with ONE
 * redirect (to /signup/sent) whatever the address, and everything that depends on the address runs
 * after the response, exactly as /api/signup/start does. What happens behind it is the mode:
 *
 *   - OPEN (the default; `SIGNUP_MODE` unset or anything but "review"): an address with no login
 *     and no claimed allowlist row is ADDED to the allowlist and emailed the usual 30-minute link,
 *     and the owner gets an FYI. From there it is the invited path, unchanged: /setup →
 *     /api/signup/complete → `createTenantFromSignup`, the trial comp, the pet-type registry.
 *     Auto-allowlisting rather than a second provisioning path is the point: a self-serve tenant
 *     cannot drift from an invited one because there is only one way to make a tenant.
 *   - REVIEW (`SIGNUP_MODE=review`): today's allowlist behaviour. An allowlisted address gets its
 *     link; any other address gets nothing, and the owner is emailed to allowlist it by hand (the
 *     owner console's allowlist add sends the sitter her invite).
 *
 * Owners (OWNER_EMAILS) without a password get the owner link here as they do at
 * /api/signup/start, with no owner notice. `/api/signup/start` itself is untouched and remains
 * allowlist-only in every mode: it carries no Turnstile token, so it must never create a row.
 *
 * Rate limits follow the invite-request route's conventions, which this replaces: charged only
 * after validation and the challenge pass (a malformed or unverified POST must not burn a real
 * caller's allowance), the per-IP bucket is skipped when CF-Connecting-IP is absent (always
 * present in production; otherwise every local caller shares one bucket), and a KV failure fails
 * OPEN — Turnstile is the hard gate, the caps are soft. Two buckets, not the combined email+IP key
 * /api/signup/start uses, because a combined key lets one IP spray addresses and one address be
 * hammered from many IPs.
 */

export type SignupMode = 'open' | 'review';

/** Exactly "review" is review; anything else, including unset, is open (the PLAN_ENFORCE shape). */
export function signupMode(env: Env): SignupMode {
  return env.SIGNUP_MODE === 'review' ? 'review' : 'open';
}

const EMAIL_RATE_MAX = 5;
const IP_RATE_MAX = 20;
const RATE_WINDOW_SECONDS = 3600;
const EMAIL_RATE_KEY = (email: string) => `signup-page:rl:email:${email}`;
const IP_RATE_KEY = (ip: string) => `signup-page:rl:ip:${ip}`;

const SENT_PATH = '/signup/sent';

const Email = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.maxLength(254), v.regex(EMAIL_RE));

const INVALID_EMAIL = 'Enter a valid email address.';
const CHALLENGE_FAILED =
  'We couldn&rsquo;t confirm you&rsquo;re a person. Please complete the check and try again.';

type Plan = { link: { kind: 'sitter' | 'owner' } | null; notice: SignupMode | null };

/**
 * What this address gets, by mode. Runs AFTER the response (or inline in local development), so
 * nothing here can change what the caller is told. Writes at most one allowlist row, open mode only.
 */
async function plan(env: Env, email: string, mode: SignupMode): Promise<Plan> {
  if (isOwnerEmail(env, email)) {
    const owner = await getOwnerUserByEmail(env.PAWSERVATION_DB, email);
    return { link: owner ? null : { kind: 'owner' }, notice: null };
  }
  // A login already exists: completion would 409 on TenantUsers.Email, so neither a row nor a link.
  if (await getTenantUserByEmail(env.PAWSERVATION_DB, email)) return { link: null, notice: null };
  const row = await getAllowedSitter(env.PAWSERVATION_DB, email);
  if (row?.ClaimedAt) return { link: null, notice: null };
  if (row) return { link: { kind: 'sitter' }, notice: null };
  if (mode === 'review') return { link: null, notice: 'review' };
  await addAllowedSitter(env.PAWSERVATION_DB, email);
  return { link: { kind: 'sitter' }, notice: 'open' };
}

function shell(title: string, body: string, opts: { turnstile?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <!-- Transactional, not a landing target: the homepage carries the same form, and a searcher
         who lands on a confirmation has arrived at a dead end. Kept crawlable so this tag is read;
         see public/robots.txt for why a Disallow would defeat it. -->
    <meta name="robots" content="noindex" />
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <style>${PAGE_STYLE}</style>${opts.turnstile ? `\n    ${TURNSTILE_SCRIPT_TAG}` : ''}
  </head>
  <body>
    <main class="wrap" style="padding:96px 0;">
      <div class="cta-panel" style="max-width:640px;margin:0 auto;">
        ${body}
        <p class="note" style="margin:20px auto 0;"><a class="signup-back" href="/">&larr; Back to the homepage</a></p>
      </div>
    </main>
  </body>
</html>`;
}

function renderSignupPage(
  env: Env,
  opts: { email?: string; error?: string; attribution?: Attribution } = {},
): string {
  const siteKey = turnstileState(env) === 'on' ? env.TURNSTILE_SITE_KEY : undefined;
  const review = signupMode(env) === 'review';
  // Review mode promises no speed: a person reads each request (README, "Provisioning").
  const intro = review
    ? 'Enter your email and we&rsquo;ll be in touch within a day to set up your account.'
    : `Enter your email to start your ${PRICING.trialDays}-day free trial. We&rsquo;ll email you a link to set your password.`;
  const lead = opts.error
    ? `<p class="note signup-error" role="alert" style="margin:0 auto 8px;font-size:1rem;">${opts.error}</p>`
    : `<p class="note" style="margin:0 auto 8px;font-size:1rem;">${intro}</p>`;
  return shell(
    'Pawservation: sign up',
    `<h1 style="font-size:1.6rem;margin:0 0 8px;">Sign up for Pawservation</h1>
        ${lead}
        ${renderSignupForm({
          email: opts.email,
          siteKey,
          attribution: opts.attribution,
          submitLabel: review ? 'Ask for an account' : 'Start my free trial',
        })}`,
    { turnstile: Boolean(siteKey) },
  );
}

/** Mode-dependent, address-independent. No primary button: a sitter who just signed up has
 * nothing to sign in to yet, so the useful next step is the setup guide. */
function renderSentPage(mode: SignupMode, prototypeLink?: string): string {
  const open = mode === 'open';
  const copy = open
    ? 'If that address can sign up, your link is on its way. It works for 30 minutes.'
    : 'We&rsquo;ll email you within a day, once your account is ready.';
  const dev = prototypeLink
    ? `<p class="note" style="margin:12px auto 0;"><a href="${htmlEscape(prototypeLink)}">Open your sign-up link (local development)</a></p>`
    : '';
  return shell(
    open ? 'Pawservation: Check your email' : 'Pawservation: request received',
    `<h1 style="font-size:1.6rem;margin:0 0 8px;">${open ? 'Check your email' : 'Thanks, we&rsquo;ve got it'}</h1>
        <p class="note" style="margin:0 auto 8px;font-size:1rem;">${copy}</p>${dev}
        <p class="note" style="margin:12px auto 0;">While you wait, read <a href="/getting-started">the setup guide</a>. Already have an account? <a href="/admin">Sign in</a>.</p>`,
  );
}

function renderUnavailable(): string {
  return shell(
    'Pawservation: sign up',
    `<h1 style="font-size:1.6rem;margin:0 0 8px;">Sign-up is temporarily unavailable</h1>
        <p class="note" style="margin:0 auto 8px;font-size:1rem;">Please try again later.</p>`,
  );
}

/** A filled honeypot is a bot (see lib/signup-form.ts). Same rule as the retired invite form:
 * absent or blank is empty, anything else (an array, a File) is filled. */
function isHoneypotFilled(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

async function overCap(cache: KVNamespace, key: string, max: number): Promise<boolean> {
  try {
    return await checkAndBumpRateLimit(cache, key, max, RATE_WINDOW_SECONDS, 'signup-page');
  } catch (err) {
    console.error('signup page rate limit check failed', err);
    return false;
  }
}

export const signupPageRoutes = new Hono<AppEnv>()
  // The retired invite-request pages: old links and bookmarks land on the new door. The POST is
  // gone on purpose — nothing renders a form that targets it any more.
  .get('/request-invite', (c) => c.redirect('/signup', 301))
  .get('/request-invite/thanks', (c) => c.redirect('/signup', 301))
  // The two GETs are marketing pages: they carry the analytics beacon when one is configured
  // (`server/lib/web-analytics.ts`), and a view of /signup/sent is the conversion the landing
  // page's views are counted against. POST responses never carry it — they echo a typed email.
  // /signup is also where a visitor from an outreach link may ARRIVE, so it reads attribution
  // the way the landing page does (`server/lib/attribution.ts`).
  .get('/signup', (c) =>
    marketingHtml(c, renderSignupPage(c.env, { attribution: attributionFromRequest(c) })),
  )
  .get('/signup/sent', (c) => marketingHtml(c, renderSentPage(signupMode(c.env))))
  .post('/signup', async (c) => {
    let raw: Record<string, unknown>;
    try {
      raw = await c.req.parseBody({ all: true });
    } catch (err) {
      console.error('signup body parse failed', err);
      return c.html(renderSignupPage(c.env, { error: INVALID_EMAIL }), 400);
    }
    if (isHoneypotFilled(raw.fax)) return c.redirect(SENT_PATH, 303);
    // Cleaned again here: hidden fields are visitor-writable. Malformed values are DROPPED, never
    // a reason to refuse the sign-up, and they ride along on every re-render below.
    const attribution = attributionFromForm(raw, new URL(c.req.url).origin);

    const parsed = v.safeParse(Email, raw.email);
    if (!parsed.success) {
      const echo = typeof raw.email === 'string' ? raw.email : undefined;
      return c.html(
        renderSignupPage(c.env, { email: echo, error: INVALID_EMAIL, attribution }),
        400,
      );
    }
    const email = parsed.output;

    // The challenge. Its outcome depends on the token, never on the address, so answering it
    // before the neutral redirect reveals nothing about who has an account.
    const state = turnstileState(c.env);
    if (state === 'missing') {
      // A secret that was never set, not weather — the one line that says so (email's posture).
      console.error('turnstile not configured', { surface: 'signup-page' });
      return c.html(renderUnavailable(), 503);
    }
    const ip = c.req.header('CF-Connecting-IP');
    if (state === 'on') {
      const token = raw['cf-turnstile-response'];
      // No token at all is the landing page's first step, not a failure: show the challenge.
      if (token === undefined || token === '') {
        return c.html(renderSignupPage(c.env, { email, attribution }));
      }
      const ok = await verifyTurnstile(c.env, typeof token === 'string' ? token : '', {
        remoteIp: ip,
        hostname: new URL(c.req.url).hostname,
      });
      if (!ok) {
        return c.html(
          renderSignupPage(c.env, { email, error: CHALLENGE_FAILED, attribution }),
          400,
        );
      }
    }

    const cache = c.env.PAWSERVATION_CACHE;
    const emailCapped = await overCap(cache, EMAIL_RATE_KEY(email), EMAIL_RATE_MAX);
    const ipCapped = ip ? await overCap(cache, IP_RATE_KEY(ip), IP_RATE_MAX) : false;
    const mode = signupMode(c.env);
    const origin = new URL(c.req.url).origin;

    if (!isEmailConfigured(c.env)) {
      if (c.env.ENVIRONMENT !== 'development') {
        console.error('email not configured', { surface: 'signup-page' });
        return c.html(renderUnavailable(), 503);
      }
      // Local-dev degrade (mirrors /api/signup/start's prototypeLink): run inline, show the link.
      if (emailCapped || ipCapped) return c.html(renderSentPage(mode));
      const p = await plan(c.env, email, mode);
      const link = p.link
        ? await mintLink(c.env, origin, email, p.link.kind, SIGNUP_LINK_TTL_SECONDS)
        : undefined;
      return c.html(renderSentPage(mode, link));
    }

    const work = (async () => {
      if (emailCapped || ipCapped) return;
      const p = await plan(c.env, email, mode);
      if (p.link) {
        const url = await mintLink(c.env, origin, email, p.link.kind, SIGNUP_LINK_TTL_SECONDS);
        await sendSignupLink(c.env, email, url).catch((err) =>
          console.error('signup link send failed', err),
        );
      }
      if (p.notice) {
        await sendSignupNotice(c.env, { email, mode: p.notice, attribution }).catch((err) =>
          console.error('signup owner notice failed', err),
        );
      }
    })().catch((err) => console.error('signup page work failed', err));
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work; // tests have no ExecutionContext — await for determinism (bookings.ts pattern)
    }
    return c.redirect(SENT_PATH, 303);
  });
