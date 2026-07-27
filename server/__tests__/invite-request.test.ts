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
  website: '', // honeypot, empty on a real submission
};

function postInvite(env: Env, fields: Record<string, string>, ip = '203.0.113.1') {
  return app.request(
    '/request-invite',
    {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
      body: new URLSearchParams(fields),
    },
    env,
  );
}

describe('POST /request-invite', () => {
  afterEach(() => vi.restoreAllMocks());

  it('happy path: sends one email to every OWNER_EMAILS address with every field, then 303s to the thanks page', async () => {
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
      subject: string;
      text: string;
      html: string;
    };
    expect(body.to).toEqual([OWNER_EMAIL]);
    expect(body.from).toBe(env.RESEND_FROM_NOREPLY);
    expect(body.subject).toBe("Invite request: Rex's Best Walks (Portland)");
    for (const value of [
      VALID_FIELDS.business,
      VALID_FIELDS.name,
      VALID_FIELDS.email,
      VALID_FIELDS.phone,
      VALID_FIELDS.city,
      VALID_FIELDS.neighborhoods,
      VALID_FIELDS.services,
      VALID_FIELDS.notes,
    ]) {
      expect(body.text).toContain(value);
    }
  });

  it('missing a required field: 400 friendly HTML re-render, no email sent', async () => {
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
    expect(html).toContain('href="/#invite-h"');
    expect(fetchSpy).not.toHaveBeenCalled();
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
    expect(html).toContain('href="/#invite-h"');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rate limited: the 6th POST in an hour from one IP gets the identical success redirect, no email sent', async () => {
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

  it('honeypot filled: identical success redirect, no email sent (silent drop)', async () => {
    const { env } = createTestEnv();
    withResendEnv(env);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const res = await postInvite(env, { ...VALID_FIELDS, website: 'http://spam.example' });
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

  it('the fallback variant (?fallback=1) shows a mailto fallback line', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/request-invite/thanks?fallback=1', {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script');
    expect(html).toMatch(/href="mailto:[^"]+"/);
  });
});
