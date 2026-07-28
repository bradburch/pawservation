import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { createTestEnv, OWNER_EMAIL } from './helpers';

function withResendEnv(env: Env) {
  env.RESEND_API_KEY = 'test-key';
  env.RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
  env.RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
}

const VALID_FIELDS: Record<string, string> = {
  business: "Rex's Best Walks",
  name: 'Rex Handler',
  email: 'rex@example.com',
  phone: '555-0100',
  city: 'Portland',
  neighborhoods: 'Alberta, Hawthorne',
  services: 'Dog walking, drop-in visits',
  customerCount: '1-5',
  notes: 'Started last spring, mostly dogs.',
  fax: '', // honeypot, empty on a real submission
};

function postInvite(env: Env, fields: Record<string, string>, ip: string | null = '203.0.113.1') {
  return app.request(
    '/request-invite',
    {
      method: 'POST',
      headers: ip ? { 'CF-Connecting-IP': ip } : {},
      body: new URLSearchParams(fields),
    },
    env,
  );
}

describe('GET /request-invite', () => {
  it('redirects to the landing page form anchor', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/request-invite', {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('/#invite-h');
  });
});

describe('POST /request-invite', () => {
  afterEach(() => vi.restoreAllMocks());

  it('happy path: sends one email to every OWNER_EMAILS address with every field (incl. customerCount), reply-to the submitter, then 303s to the thanks page', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await postInvite(env, VALID_FIELDS);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/request-invite/thanks');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(init.body as string) as {
      to: string | string[];
      from: string;
      reply_to: string;
      subject: string;
      text: string;
      html: string;
    };
    expect(body.to).toEqual([OWNER_EMAIL]);
    expect(body.from).toBe(env.RESEND_FROM_NOREPLY);
    expect(body.reply_to).toBe(VALID_FIELDS.email);
    expect(body.subject).toBe("Invite request: Rex's Best Walks (Portland)");
    for (const value of [
      VALID_FIELDS.business,
      VALID_FIELDS.name,
      VALID_FIELDS.email,
      VALID_FIELDS.phone,
      VALID_FIELDS.city,
      VALID_FIELDS.neighborhoods,
      VALID_FIELDS.services,
      VALID_FIELDS.customerCount,
      VALID_FIELDS.notes,
    ]) {
      expect(body.text).toContain(value);
    }
  });

  it('sanitizes embedded control characters (CRLF) out of every field, especially the subject-bound business/city', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await postInvite(env, {
      ...VALID_FIELDS,
      business: 'Rex\r\nBcc: evil@example.com',
      city: 'Portland\r\nX-Injected: 1',
    });
    expect(res.status).toBe(303);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { subject: string; text: string };
    expect(body.subject).not.toMatch(/[\r\n]/);
    expect(body.subject).toBe('Invite request: Rex Bcc: evil@example.com (Portland X-Injected: 1)');
    // The text body is legitimately multi-line (one row per field) — what must NOT happen is a
    // submitted value's embedded CRLF producing an extra, header-like line of its own.
    expect(body.text).toContain('Business: Rex Bcc: evil@example.com');
    expect(body.text).toContain('City: Portland X-Injected: 1');
    expect(body.text).not.toContain('\nBcc:');
    expect(body.text).not.toContain('\nX-Injected:');
  });

  it('a malformed body (bad multipart) is a friendly 400, never a 500', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await app.request(
      '/request-invite',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'multipart/form-data; boundary=----x',
          'CF-Connecting-IP': '203.0.113.1',
        },
        body: 'not-a-valid-multipart-body',
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).not.toContain('<script');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a JSON body (wrong content type) is also a friendly 400, not a 500', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await app.request(
      '/request-invite',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.1' },
        body: JSON.stringify({ business: 'Rex' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('missing a required field: 400 re-renders the form with the other submitted values pre-filled, plus a single friendly error line', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const { business: _business, ...rest } = VALID_FIELDS;
    const res = await postInvite(env, rest);
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).not.toContain('<script');
    // The 400 page now NAMES the offending field rather than the old generic line.
    expect(html).toContain('Business name');
    expect(html).toContain('Please fix this field, then try again:');
    expect(html).toContain('<form class="invite-form" method="post" action="/request-invite">');
    // The city that WAS submitted survives, pre-filled.
    expect(html).toContain(`value="${VALID_FIELDS.city}"`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('echoes a submitted value back into the 400 page HTML-escaped, never raw', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const res = await postInvite(env, { ...rest(VALID_FIELDS), email: 'notanemail' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is CSP/X-Frame-Options locked, same as the thanks page', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const { business: _business, ...rest2 } = VALID_FIELDS;
    const res = await postInvite(env, rest2);
    expect(res.status).toBe(400);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('bad email format: the same friendly 400 page', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await postInvite(env, { ...VALID_FIELDS, email: 'notanemail' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Email (not a valid address)');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the rate limit is charged ONLY on valid submissions: five invalid posts do not burn the cap, and five subsequent valid posts all succeed', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const ip = '198.51.100.9';
    const { business: _business, ...invalid } = VALID_FIELDS;
    for (let i = 0; i < 5; i++) {
      const res = await postInvite(env, invalid, ip);
      expect(res.status).toBe(400);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) {
      const res = await postInvite(env, VALID_FIELDS, ip);
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('/request-invite/thanks');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('rate limited: the 6th VALID POST in an hour from one IP gets the identical success redirect, no email sent', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const ip = '198.51.100.7';
    for (let i = 0; i < 5; i++) {
      const res = await postInvite(env, VALID_FIELDS, ip);
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('/request-invite/thanks');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    const sixth = await postInvite(env, VALID_FIELDS, ip);
    expect(sixth.status).toBe(303);
    // Indistinguishable from success: same Location, no oracle.
    expect(sixth.headers.get('Location')).toBe('/request-invite/thanks');
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  it('missing CF-Connecting-IP skips the limiter entirely (prod always sends it; dev/test callers must not share one bucket)', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    for (let i = 0; i < 6; i++) {
      const res = await postInvite(env, VALID_FIELDS, null);
      expect(res.status).toBe(303);
      expect(res.headers.get('Location')).toBe('/request-invite/thanks');
    }
    expect(fetchSpy).toHaveBeenCalledTimes(6); // never rate-limited
  });

  it('a KV failure in the rate limiter fails OPEN (logs, proceeds, never 500)', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    env.PAWBOOK_CACHE.get = () => {
      throw new Error('KV unavailable');
    };
    const res = await postInvite(env, VALID_FIELDS);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/request-invite/thanks');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // proceeded to send despite the KV failure
    expect(errSpy).toHaveBeenCalled();
  });

  it('honeypot filled: identical success redirect, no email sent (silent drop)', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await postInvite(env, { ...VALID_FIELDS, fax: 'http://spam.example' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/request-invite/thanks');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honeypot array bypass: submitting "fax" twice (a non-string array value) still trips detection', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(VALID_FIELDS)) {
      if (key === 'fax') continue;
      params.append(key, value);
    }
    params.append('fax', '');
    params.append('fax', 'spam-via-second-value');
    const res = await app.request(
      '/request-invite',
      { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.1' }, body: params },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/request-invite/thanks');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('email unconfigured: valid POST still 303s, to the fallback thanks variant, no 5xx', async () => {
    const { env } = createTestEnv(); // no RESEND_* set
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await postInvite(env, VALID_FIELDS);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/request-invite/thanks?fallback=1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('OWNER_EMAILS unset: valid POST still 303s, to the fallback thanks variant, no 5xx', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    env.OWNER_EMAILS = '';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await postInvite(env, VALID_FIELDS);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/request-invite/thanks?fallback=1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('Resend API failure: valid POST still 303s, to the fallback thanks variant, no 5xx (best-effort, logged)', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const res = await postInvite(env, VALID_FIELDS);
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/request-invite/thanks?fallback=1');
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('GET /request-invite/thanks', () => {
  it('serves a static script-free thanks page under the locked CSP', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/request-invite/thanks', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    const html = await res.text();
    expect(html).not.toContain('<script');
    expect(html).not.toContain('mailto:');
  });

  it('the fallback variant (?fallback=1) shows a mailto to the first configured OWNER_EMAILS address', async () => {
    const { env } = createTestEnv(); // OWNER_EMAILS = OWNER_EMAIL, per createTestEnv
    const res = await app.request('/request-invite/thanks?fallback=1', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script');
    expect(html).toContain(`href="mailto:${OWNER_EMAIL}?subject=Pawservation%20invite"`);
  });

  it('falls back to the hardcoded address only when OWNER_EMAILS is unset', async () => {
    const { env } = createTestEnv();
    env.OWNER_EMAILS = '';
    const res = await app.request('/request-invite/thanks?fallback=1', {}, env);
    const html = await res.text();
    expect(html).toContain('href="mailto:bradburch@duck.com?subject=Pawservation%20invite"');
  });
});

/** VALID_FIELDS with `business` swapped for an XSS payload — used by the 400-page-escaping test,
 * which still needs SOME other field to be invalid (paired with a bad email below) to reach the
 * 400 branch at all. */
function rest(fields: Record<string, string>): Record<string, string> {
  return { ...fields, business: '<script>alert(1)</script>' };
}
