import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { trialCompUntil } from '../lib/premium';
import { ALLOWED_EMAIL, createTestEnv, OWNER_EMAIL } from './helpers';

/**
 * Self-serve sitter signup: GET/POST /signup (server/routes/signup-page.ts). The page is the ONE
 * public door that may create an allowlist row on its own, and only behind a server-verified
 * Turnstile token and both rate limits. Every fetch is a vi.spyOn on globalThis.fetch dispatched
 * by URL — Siteverify and Resend are both faked, nothing touches the network.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND = 'https://api.resend.com/emails';
const SITE_KEY = '1x00000000000000000000AA';
const NEW_EMAIL = 'brand-new@sitter.test';

function configure(env: Env, opts: { turnstile?: boolean; mode?: string } = {}) {
  env.RESEND_API_KEY = 'test-key';
  env.RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
  env.RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
  if (opts.turnstile !== false) {
    env.TURNSTILE_SITE_KEY = SITE_KEY;
    env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
  }
  if (opts.mode !== undefined) env.SIGNUP_MODE = opts.mode;
}

type Verdict = Partial<{
  success: boolean;
  action: string;
  hostname: string;
  'error-codes': string[];
}>;

/** Fakes both external services. `verdict` is what Siteverify answers; Resend always accepts. */
function fakeFetch(verdict: Verdict | 'throw' = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === SITEVERIFY) {
      if (verdict === 'throw') throw new TypeError('network down');
      return Response.json({
        success: true,
        action: 'signup',
        hostname: 'localhost',
        'error-codes': [],
        ...verdict,
      });
    }
    if (url === RESEND) return Response.json({ id: 'x' });
    throw new Error(`unexpected fetch ${url}`);
  });
}

const calls = (spy: ReturnType<typeof fakeFetch>, url: string) =>
  spy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input) === url);

const sentTo = (spy: ReturnType<typeof fakeFetch>) =>
  calls(spy, RESEND).map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);

function post(
  env: Env,
  fields: Record<string, string>,
  ip: string | null = '203.0.113.7',
): Response | Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (ip) headers['CF-Connecting-IP'] = ip;
  return app.request(
    '/signup',
    { method: 'POST', headers, body: new URLSearchParams(fields).toString() },
    env,
  );
}

const submit = async (env: Env, email: string, ip?: string | null) =>
  post(env, { email, 'cf-turnstile-response': 'tok' }, ip);

const allowRow = (raw: ReturnType<typeof createTestEnv>['raw'], email: string) =>
  raw.prepare('SELECT Email, ClaimedAt FROM AllowedSitters WHERE Email = ?').get(email);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GET /signup', () => {
  it('renders the Turnstile widget and loosens CSP for challenges.cloudflare.com on THIS page only', async () => {
    const { env } = createTestEnv();
    configure(env);
    const res = await app.request('/signup', {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<form class="signup-form" method="post" action="/signup">');
    expect(body).toContain(`data-sitekey="${SITE_KEY}"`);
    expect(body).toContain('data-action="signup"');
    expect(body).toContain('src="https://challenges.cloudflare.com/turnstile/v0/api.js"');
    expect(body).toContain('<meta name="robots" content="noindex" />');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toMatch(/script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toMatch(/frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');

    const landing = await app.request('/', {}, env);
    expect(landing.headers.get('Content-Security-Policy')).not.toContain(
      'challenges.cloudflare.com',
    );
  });

  it('keeps the premium frame-src beside the Turnstile one when a premium origin is configured', async () => {
    const { env } = createTestEnv();
    configure(env);
    env.PREMIUM_ORIGIN = 'https://premium.example';
    const csp =
      (await app.request('/signup', {}, env)).headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain(
      "frame-src 'self' https://challenges.cloudflare.com https://premium.example",
    );
  });

  it('renders no widget and no script when Turnstile is not configured (local development)', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/signup', {}, env)).text();
    expect(body).not.toContain('<script');
    expect(body).not.toContain('cf-turnstile');
  });
});

describe('the sign-up pages read well', () => {
  it('styles the h1 on the dark panel (it was ink-on-green, invisible)', async () => {
    const { PAGE_STYLE } = await import('../lib/page-style');
    expect(PAGE_STYLE).toMatch(/\.cta-panel h1[^{]*\{[^}]*color: var\(--band-ink\)/);
  });

  it('/signup leads with the trial, and says "sign-up link" at most once', async () => {
    const { env } = createTestEnv();
    configure(env);
    const body = await (await app.request('/signup', {}, env)).text();
    expect(body).toContain('start your 30-day free trial');
    expect(body.match(/sign-up link/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('/signup/sent says each thing once, offers the setup guide, and has no big Sign in button', async () => {
    const { env } = createTestEnv();
    configure(env);
    const body = await (await app.request('/signup/sent', {}, env)).text();
    expect(body.match(/Check your email/g)).toHaveLength(2); // <title> and <h1>, never the body copy
    expect(body).toContain(
      'We&rsquo;ve sent a sign-up link to that address if it&rsquo;s new to Pawservation.',
    );
    expect(body).toContain('Check your spam folder');
    expect(body).toContain('href="/getting-started"');
    // The guide link resolves (the page is a worker route, not an asset).
    expect((await app.request('/getting-started', {}, env)).status).toBe(200);
    expect(body).not.toContain('class="btn btn-inverse" href="/admin"');
    configure(env, { mode: 'review' });
    const review = await (await app.request('/signup/sent', {}, env)).text();
    expect(review.match(/Thanks/g)).toHaveLength(1);
  });
});

describe('POST /signup — open mode (the default)', () => {
  it('verifies the token, allowlists the new email, emails her the link and tells the owner', async () => {
    const { env, raw } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    const res = await submit(env, ' Brand-New@Sitter.test ');
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/signup/sent');

    const [, init] = calls(spy, SITEVERIFY)[0];
    const form = new URLSearchParams(String(init!.body));
    expect(form.get('secret')).toBe('turnstile-secret');
    expect(form.get('response')).toBe('tok');
    expect(form.get('remoteip')).toBe('203.0.113.7');

    expect(allowRow(raw, NEW_EMAIL)).toMatchObject({ Email: NEW_EMAIL, ClaimedAt: null });
    const mails = sentTo(spy);
    expect(mails).toHaveLength(2);
    expect(mails[0].to).toBe(NEW_EMAIL);
    expect(String(mails[0].text)).toContain('/setup?t=');
    expect(mails[1].to).toEqual([OWNER_EMAIL]);
    expect(String(mails[1].subject)).toContain('New sign-up');
    expect(String(mails[1].text)).toContain(NEW_EMAIL);
  });

  it('answers every input identically: new, allowlisted, claimed, existing sitter login, owner', async () => {
    const { env, raw } = createTestEnv();
    configure(env);
    fakeFetch();
    raw
      .prepare(
        "INSERT INTO AllowedSitters (Email, ClaimedAt) VALUES ('claimed@x.test', '2026-01-01')",
      )
      .run();
    const existing = raw.prepare('SELECT Email FROM TenantUsers LIMIT 1').get() as {
      Email: string;
    };
    const answers = new Set<string>();
    for (const email of [NEW_EMAIL, ALLOWED_EMAIL, 'claimed@x.test', existing.Email, OWNER_EMAIL]) {
      const res = await submit(env, email);
      answers.add(`${res.status} ${res.headers.get('Location')} ${await res.text()}`);
    }
    expect(answers.size).toBe(1);
  });

  it('never allowlists or emails an address that already has a sitter login', async () => {
    const { env, raw } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    const existing = raw.prepare('SELECT Email FROM TenantUsers LIMIT 1').get() as {
      Email: string;
    };
    await submit(env, existing.Email);
    expect(allowRow(raw, existing.Email)).toBeUndefined();
    expect(sentTo(spy)).toHaveLength(0);
  });

  it('a claimed allowlist row gets nothing, and an owner gets the owner link with no owner notice', async () => {
    const { env, raw } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    raw
      .prepare(
        "INSERT INTO AllowedSitters (Email, ClaimedAt) VALUES ('claimed@x.test', '2026-01-01')",
      )
      .run();
    await submit(env, 'claimed@x.test');
    expect(sentTo(spy)).toHaveLength(0);
    await submit(env, OWNER_EMAIL);
    const mails = sentTo(spy);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe(OWNER_EMAIL);
    expect(String(mails[0].subject)).not.toContain('New sign-up');
  });

  it('re-sending to an already-allowlisted email sends the link but no second owner notice', async () => {
    const { env } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    await submit(env, NEW_EMAIL);
    await submit(env, NEW_EMAIL);
    const mails = sentTo(spy);
    expect(mails.map((m) => m.to)).toEqual([NEW_EMAIL, [OWNER_EMAIL], NEW_EMAIL]);
  });

  it('the emailed link completes into the same state as an invited signup (trial comp, pet types)', async () => {
    const { env, raw } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    await submit(env, NEW_EMAIL);
    const link = String(sentTo(spy)[0].text).match(/\/setup\?t=([^\s]+)/)![1];
    const res = await app.request(
      '/api/signup/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: decodeURIComponent(link),
          password: 'a-long-enough-passphrase-9',
          businessName: 'Brand New Paws',
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const { slug } = (await res.json()) as { slug: string };
    const tenant = raw.prepare('SELECT Id, CompedUntil FROM Tenants WHERE Slug = ?').get(slug) as {
      Id: string;
      CompedUntil: string;
    };
    expect(tenant.CompedUntil.slice(0, 10)).toBe(trialCompUntil().slice(0, 10));
    expect(allowRow(raw, NEW_EMAIL)).toMatchObject({ ClaimedAt: expect.any(String) });
    const petTypes = raw
      .prepare('SELECT PetType FROM TenantPetTypes WHERE TenantId = ? ORDER BY PetType')
      .all(tenant.Id);
    expect(petTypes).toEqual([{ PetType: 'cat' }, { PetType: 'dog' }]);
  });
});

describe('POST /signup — review mode (SIGNUP_MODE=review)', () => {
  it('sends nothing to a new email, adds no row, and asks the owner to review', async () => {
    const { env, raw } = createTestEnv();
    configure(env, { mode: 'review' });
    const spy = fakeFetch();
    const res = await submit(env, NEW_EMAIL);
    expect(res.status).toBe(303);
    expect(allowRow(raw, NEW_EMAIL)).toBeUndefined();
    const mails = sentTo(spy);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual([OWNER_EMAIL]);
    expect(String(mails[0].text)).toContain(NEW_EMAIL);
    expect(String(mails[0].text)).toContain('review');
  });

  it('still emails an allowlisted sitter her link, as today', async () => {
    const { env } = createTestEnv();
    configure(env, { mode: 'review' });
    const spy = fakeFetch();
    await submit(env, ALLOWED_EMAIL);
    expect(sentTo(spy).map((m) => m.to)).toEqual([ALLOWED_EMAIL]);
  });

  it('the sent page says what review mode means, without depending on the email', async () => {
    const { env } = createTestEnv();
    configure(env, { mode: 'review' });
    const body = await (await app.request('/signup/sent', {}, env)).text();
    expect(body).toContain('within a day');
    expect(body).not.toContain('30 minutes');
    configure(env, { mode: 'open' });
    const open = await (await app.request('/signup/sent', {}, env)).text();
    expect(open).toContain('Check your email');
    expect(open).toContain('30 minutes');
  });

  it('review mode never promises speed on the sign-up page itself', async () => {
    const { env } = createTestEnv();
    configure(env, { mode: 'review' });
    const body = await (await app.request('/signup', {}, env)).text();
    expect(body).toContain('within a day');
    expect(body).not.toMatch(/a minute|30-day free trial/);
  });

  it('only the exact string "review" turns review on; anything else is open', async () => {
    const { env, raw } = createTestEnv();
    configure(env, { mode: 'REVIEW ' });
    fakeFetch();
    await submit(env, NEW_EMAIL);
    expect(allowRow(raw, NEW_EMAIL)).toBeDefined();
  });
});

describe('POST /signup — Turnstile', () => {
  it('without a token, re-renders the page with the email kept and the widget, and does nothing', async () => {
    const { env, raw } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    const res = await post(env, { email: NEW_EMAIL });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`value="${NEW_EMAIL}"`);
    expect(body).toContain('cf-turnstile');
    expect(spy).not.toHaveBeenCalled();
    expect(allowRow(raw, NEW_EMAIL)).toBeUndefined();
  });

  const refusals: [string, Verdict | 'throw'][] = [
    ['a failed challenge', { success: false, 'error-codes': ['invalid-input-response'] }],
    ['a token minted for another action', { action: 'login' }],
    ['a token minted on another hostname', { hostname: 'evil.example' }],
    ['an unreachable Siteverify', 'throw'],
  ];
  for (const [label, verdict] of refusals) {
    it(`refuses ${label}: 400, no row, no mail`, async () => {
      const { env, raw } = createTestEnv();
      configure(env);
      const spy = fakeFetch(verdict);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await submit(env, NEW_EMAIL);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('confirm you&rsquo;re a person');
      expect(allowRow(raw, NEW_EMAIL)).toBeUndefined();
      expect(sentTo(spy)).toHaveLength(0);
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
      expect(logged).not.toContain(NEW_EMAIL);
      expect(logged).not.toContain('turnstile-secret');
      expect(logged).not.toContain('203.0.113.7');
    });
  }

  it("accepts Cloudflare's always-pass TEST secret, whose verdict has no action and hostname example.com", async () => {
    const { env, raw } = createTestEnv();
    configure(env);
    env.TURNSTILE_SECRET_KEY = '1x0000000000000000000000000000000AA';
    // The real shape Siteverify returns for the documented test secret.
    fakeFetch({ success: true, hostname: 'example.com', action: '', 'error-codes': [] });
    const res = await submit(env, NEW_EMAIL);
    expect(res.status).toBe(303);
    expect(allowRow(raw, NEW_EMAIL)).toBeDefined();
  });

  it('a REAL secret still refuses that same example.com / no-action verdict', async () => {
    const { env } = createTestEnv();
    configure(env);
    fakeFetch({ success: true, hostname: 'example.com', action: '', 'error-codes': [] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await submit(env, NEW_EMAIL)).status).toBe(400);
  });

  it('fails closed outside development when Turnstile is not (fully) configured: 503 for every input', async () => {
    for (const partial of [{}, { TURNSTILE_SITE_KEY: SITE_KEY }, { TURNSTILE_SECRET_KEY: 's' }]) {
      const { env, raw } = createTestEnv();
      configure(env, { turnstile: false });
      Object.assign(env, partial, { ENVIRONMENT: 'production' });
      const spy = fakeFetch();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await submit(env, NEW_EMAIL);
      expect(res.status).toBe(503);
      expect(spy).not.toHaveBeenCalled();
      expect(allowRow(raw, NEW_EMAIL)).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it('in development with no Turnstile and no email provider, skips the check and shows the link on screen', async () => {
    const { env, raw } = createTestEnv();
    const spy = fakeFetch();
    const res = await post(env, { email: NEW_EMAIL });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/setup?t=');
    expect(spy).not.toHaveBeenCalled();
    expect(allowRow(raw, NEW_EMAIL)).toBeDefined();
    const nobody = await post(env, { email: 'claimed-or-not@x.test' });
    expect(nobody.status).toBe(200);
  });
});

describe('POST /signup — validation, honeypot, rate limits', () => {
  it('re-renders a 400 for an invalid email, before any challenge is spent', async () => {
    const { env } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    const res = await submit(env, 'not-an-email');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Enter a valid email');
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops a filled honeypot silently with the same redirect', async () => {
    const { env, raw } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    const res = await post(env, { email: NEW_EMAIL, 'cf-turnstile-response': 'tok', fax: 'x' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/signup/sent');
    expect(spy).not.toHaveBeenCalled();
    expect(allowRow(raw, NEW_EMAIL)).toBeUndefined();
  });

  it('caps one email at 5 an hour across IPs, with the same answer over the cap', async () => {
    const { env } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 6; i++) {
      const res = await submit(env, ALLOWED_EMAIL, `198.51.100.${i}`);
      expect(res.status).toBe(303);
    }
    expect(sentTo(spy)).toHaveLength(5);
  });

  it('caps one IP at 20 an hour across emails', async () => {
    const { env } = createTestEnv();
    configure(env, { mode: 'review' }); // review: one owner mail per request, easy to count
    const spy = fakeFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 21; i++) await submit(env, `spray${i}@x.test`, '198.51.100.9');
    expect(sentTo(spy)).toHaveLength(20);
  });
});

describe('the retired invite-request pages', () => {
  it('redirect old links to /signup, and the POST is gone', async () => {
    const { env } = createTestEnv();
    for (const path of ['/request-invite', '/request-invite/thanks']) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toBe('/signup');
    }
    const res = await app.request('/request-invite', { method: 'POST' }, env);
    expect(res.status).toBe(404);
  });
});
