import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { cleanRefOrigin, cleanUtm } from '../lib/attribution';
import { createTestEnv } from './helpers';

/**
 * Where a sign-up came from: `utm_source` / `utm_campaign` off the URL a visitor ARRIVES on (`/` or
 * `/signup`) and the ORIGIN of the site that linked there, carried as hidden fields through every
 * step of POST /signup and stated in the owner's sign-up notice. The useful Referer is the one on
 * the arrival GET (reddit.com, facebook.com) — the one on the POST is always our own page.
 *
 * Attribution is never a reason to refuse a sign-up: anything malformed is DROPPED, never a 400.
 */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const RESEND = 'https://api.resend.com/emails';

function configure(env: Env) {
  env.RESEND_API_KEY = 'test-key';
  env.RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
  env.RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
  env.TURNSTILE_SITE_KEY = '1x00000000000000000000AA';
  env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
}

function fakeFetch(resendStatus = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === SITEVERIFY) {
      return Response.json({ success: true, action: 'signup', hostname: 'localhost' });
    }
    if (url === RESEND) return new Response('{}', { status: resendStatus });
    throw new Error(`unexpected fetch ${url}`);
  });
}

/** The owner notice is the Resend call addressed to OWNER_EMAILS (the other is the sitter's link). */
function ownerNotice(spy: ReturnType<typeof fakeFetch>) {
  const bodies = spy.mock.calls
    .filter(([input]) => String(input) === RESEND)
    .map(
      ([, init]) =>
        JSON.parse(String(init!.body)) as { subject: string; text: string; html: string },
    );
  const notice = bodies.find((b) => b.subject.startsWith('New sign-up'));
  if (!notice) throw new Error('no owner notice was sent');
  return notice;
}

function post(env: Env, fields: Record<string, string>) {
  return app.request(
    '/signup',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'CF-Connecting-IP': '203.0.113.9',
      },
      body: new URLSearchParams(fields).toString(),
    },
    env,
  );
}

const EMAIL = 'new-sitter@sitter.test';

describe('cleanUtm', () => {
  it.each([
    ['reddit', 'reddit'],
    [' r-petsitting ', 'r-petsitting'],
    ['fb_group.oct', 'fb_group.oct'],
    ['a'.repeat(64), 'a'.repeat(64)],
  ])('keeps %j as %j', (input, out) => expect(cleanUtm(input)).toBe(out));

  it.each([
    'a'.repeat(65),
    '',
    '   ',
    'has space',
    '<script>',
    'a"b',
    'x\r\ny',
    'rex@example.com',
    undefined,
    ['reddit', 'linkedin'],
    42,
  ])('drops %j', (input) => expect(cleanUtm(input)).toBeUndefined());
});

describe('cleanRefOrigin', () => {
  const own = 'https://pawservation.com';
  it('keeps only the origin of a foreign http(s) referrer, never its path or query', () => {
    expect(cleanRefOrigin('https://www.reddit.com/r/petsitting/comments/abc?x=1', own)).toBe(
      'https://www.reddit.com',
    );
    expect(cleanRefOrigin('https://l.facebook.com/', own)).toBe('https://l.facebook.com');
  });

  it.each([
    'https://pawservation.com/how-it-works', // our own site is not a source
    'javascript:alert(1)',
    'data:text/html,hi',
    'not a url',
    '',
    `https://${'a'.repeat(300)}.com/`,
    undefined,
    ['https://www.reddit.com/'],
  ])('drops %j', (input) => expect(cleanRefOrigin(input, own)).toBeUndefined());
});

describe('GET / carries attribution forward on its Sign up links', () => {
  it('appends the cleaned tags and the referring ORIGIN to every /signup link', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/?utm_source=reddit&utm_campaign=r-petsitting',
      { headers: { Referer: 'https://www.reddit.com/r/petsitting/comments/xyz/some_title/' } },
      env,
    );
    const html = await res.text();
    const carried =
      'href="/signup?utm_source=reddit&amp;utm_campaign=r-petsitting&amp;ref_origin=https%3A%2F%2Fwww.reddit.com"';
    expect(html).toContain(carried);
    expect(html).not.toContain('href="/signup"');
    expect(html).not.toContain('some_title');
  });

  it('leaves the links bare on a direct, untagged visit', async () => {
    const { env } = createTestEnv();
    const html = await (await app.request('/', {}, env)).text();
    expect(html).toContain('href="/signup"');
    expect(html).not.toContain('/signup?');
  });

  it('drops a malformed tag rather than reflecting it, and ignores a same-site referrer', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      `/?utm_source=${encodeURIComponent('"><script>alert(1)</script>')}&utm_campaign=ok`,
      { headers: { Referer: 'http://localhost/how-it-works' } },
      env,
    );
    const html = await res.text();
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('href="/signup?utm_campaign=ok"');
  });
});

describe('GET /signup reads the carried query, or the Referer on a direct arrival', () => {
  it('takes ref_origin from the query the homepage link carried, cleaned again', async () => {
    const { env } = createTestEnv();
    configure(env);
    const res = await app.request(
      `/signup?utm_source=reddit&ref_origin=${encodeURIComponent('https://www.reddit.com/r/x')}`,
      { headers: { Referer: 'http://localhost/' } },
      env,
    );
    const html = await res.text();
    expect(html).toContain('<input type="hidden" name="utm_source" value="reddit" />');
    expect(html).toContain(
      '<input type="hidden" name="ref_origin" value="https://www.reddit.com" />',
    );
    expect(html).not.toContain('/r/x');
  });
});

describe.each(['/signup'])('GET %s carries attribution into the sign-up form', (path) => {
  it('puts utm_source, utm_campaign and the referring ORIGIN into hidden fields', async () => {
    const { env } = createTestEnv();
    configure(env);
    const res = await app.request(
      `${path}?utm_source=reddit&utm_campaign=r-petsitting`,
      { headers: { Referer: 'https://www.reddit.com/r/petsitting/comments/xyz/some_title/' } },
      env,
    );
    const html = await res.text();
    expect(html).toContain('<input type="hidden" name="utm_source" value="reddit" />');
    expect(html).toContain('<input type="hidden" name="utm_campaign" value="r-petsitting" />');
    expect(html).toContain(
      '<input type="hidden" name="ref_origin" value="https://www.reddit.com" />',
    );
    expect(html).not.toContain('some_title');
  });

  it('renders no hidden attribution fields on a direct, untagged visit', async () => {
    const { env } = createTestEnv();
    configure(env);
    const html = await (await app.request(path, {}, env)).text();
    expect(html).not.toContain('name="utm_source"');
    expect(html).not.toContain('name="utm_campaign"');
    expect(html).not.toContain('name="ref_origin"');
  });

  it('drops a malformed tag rather than reflecting it, and ignores a same-site referrer', async () => {
    const { env } = createTestEnv();
    configure(env);
    const res = await app.request(
      `${path}?utm_source=${encodeURIComponent('"><script>alert(1)</script>')}&utm_campaign=ok`,
      { headers: { Referer: 'http://localhost/how-it-works' } },
      env,
    );
    const html = await res.text();
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('name="utm_source"');
    expect(html).toContain('name="utm_campaign" value="ok"');
    expect(html).not.toContain('name="ref_origin"');
  });
});

describe('POST /signup carries attribution to the owner notice', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps it through the Turnstile step the landing form lands on', async () => {
    const { env } = createTestEnv();
    configure(env);
    // The landing form posts only the email: the answer is /signup with the widget and the form.
    const res = await post(env, {
      email: EMAIL,
      utm_source: 'linkedin',
      ref_origin: 'https://www.linkedin.com',
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="cf-turnstile"');
    expect(html).toContain('<input type="hidden" name="utm_source" value="linkedin" />');
    expect(html).toContain(
      '<input type="hidden" name="ref_origin" value="https://www.linkedin.com" />',
    );
  });

  it('keeps the (cleaned) attribution through a 400 re-render', async () => {
    const { env } = createTestEnv();
    configure(env);
    const res = await post(env, {
      email: 'not-an-email',
      utm_source: 'linkedin',
      utm_campaign: '"><b>x</b>',
      ref_origin: 'https://www.linkedin.com/feed/',
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('<input type="hidden" name="utm_source" value="linkedin" />');
    expect(html).toContain(
      '<input type="hidden" name="ref_origin" value="https://www.linkedin.com" />',
    );
    expect(html).not.toContain('name="utm_campaign"');
    expect(html).not.toContain('<b>x</b>');
  });

  it('states source, campaign and referring origin in the owner notice, never in its subject', async () => {
    const { env } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    const res = await post(env, {
      email: EMAIL,
      'cf-turnstile-response': 'tok',
      utm_source: 'reddit',
      utm_campaign: 'r-petsitting',
      ref_origin: 'https://www.reddit.com',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/signup/sent');
    const notice = ownerNotice(spy);
    expect(notice.text).toContain('Source (utm_source): reddit');
    expect(notice.text).toContain('Campaign (utm_campaign): r-petsitting');
    expect(notice.text).toContain('Referred from: https://www.reddit.com');
    expect(notice.html).toContain('Referred from: https://www.reddit.com');
    expect(notice.subject).not.toContain('reddit');
  });

  it('says nothing was recorded when the sign-up carries no attribution', async () => {
    const { env } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    await post(env, { email: EMAIL, 'cf-turnstile-response': 'tok' });
    const notice = ownerNotice(spy);
    expect(notice.text).toContain('Source: none recorded (a direct visit or an untagged link)');
    expect(notice.text).not.toContain('utm_source');
  });

  it('never refuses a sign-up over attribution: garbage and oversize values are dropped', async () => {
    const { env } = createTestEnv();
    configure(env);
    const spy = fakeFetch();
    const res = await post(env, {
      email: EMAIL,
      'cf-turnstile-response': 'tok',
      utm_source: 'x'.repeat(5000),
      utm_campaign: 'a\r\nBcc: evil@example.com',
      ref_origin: 'https://www.reddit.com/r/petsitting/comments/secret-path',
    });
    expect(res.status).toBe(303);
    const notice = ownerNotice(spy);
    expect(notice.text).not.toContain('xxxx');
    expect(notice.text).not.toContain('Bcc');
    // A posted ref_origin is re-reduced to its origin at the trust boundary.
    expect(notice.text).toContain('Referred from: https://www.reddit.com');
    expect(notice.text).not.toContain('secret-path');
  });

  it('writes no log line carrying attribution when the sends fail', async () => {
    const { env } = createTestEnv();
    configure(env);
    fakeFetch(500);
    const lines: string[] = [];
    for (const level of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
      });
    }
    await post(env, {
      email: EMAIL,
      'cf-turnstile-response': 'tok',
      utm_source: 'uniquesourcetag',
      utm_campaign: 'uniquecampaigntag',
      ref_origin: 'https://uniquereferrer.example',
    });
    expect(lines.length).toBeGreaterThan(0); // the failure WAS logged — just not the attribution
    const all = lines.join('\n');
    expect(all).not.toContain('uniquesourcetag');
    expect(all).not.toContain('uniquecampaigntag');
    expect(all).not.toContain('uniquereferrer');
  });
});
