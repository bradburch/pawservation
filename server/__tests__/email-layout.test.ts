import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  emailShell,
  emailButton,
  sendLoginCode,
  sendBookingStatusEmail,
  sendInvite,
  sendSignupLink,
  sendSitterInvite,
  sendResetLink,
  sendInviteRequest,
} from '../lib/email';

/** The one brand asset every mail carries — see the LOGO_URL doc comment in lib/email.ts. */
const LOGO_URL = 'https://pawservation.com/brand/pawservation-logo.png';

describe('emailShell', () => {
  it('renders the accent bar, the brand lockup, content, and styled container', () => {
    const html = emailShell('<p>hi</p>');
    expect(html).toContain('max-width:560px');
    expect(html).toContain('background:#2e6440'); // accent bar — --green / --leaf
    expect(html).toContain(`<img src="${LOGO_URL}"`);
    expect(html).toContain('<p>hi</p>');
  });

  it('uses the site palette, not stale one-off colours', () => {
    const html = emailShell('<p>hi</p>', 'Sent by Pawservation');
    expect(html).toContain('color:#415044'); // --body-c, the site's body copy colour
    expect(html).toContain('color:#18271d'); // --ink, on the logo's alt text
    expect(html).toContain('color:#5a6a5e'); // --soft, the footer
    expect(html).toContain('1px solid #e3e7e0'); // --line
    // #697a6d was a hand-picked grey that matched no token.
    expect(html).not.toContain('697a6d');
    // The 🐾 emoji was the pre-brand stand-in for a logo.
    expect(html).not.toContain('🐾');
  });

  it('serves the logo from an absolute https URL, not a site-relative path', () => {
    const src = /<img src="([^"]+)"/.exec(emailShell('<p>hi</p>'))?.[1];
    expect(src).toBeDefined();
    expect(new URL(src!).protocol).toBe('https:'); // throws if the path is relative
    // SVG is the site's format and is unrenderable in Gmail/Outlook — the mail ships a PNG.
    expect(src!.endsWith('.png')).toBe(true);
    expect(src).not.toContain('.svg');
  });

  it('stays readable with images off: real alt text, styled, and nothing essential inside it', () => {
    const img = /<img [^>]*\/>/.exec(emailShell('<p>hi</p>'))?.[0] ?? '';
    expect(img).toContain('alt="Pawservation"');
    // Alt text inherits the img's own font/colour rules in clients that block images.
    expect(img).toContain('font-family:');
    expect(img).toContain('color:#18271d');
    expect(img).toContain('width="180"');
    expect(img).toContain('height="70"');
  });

  it('omits footer border when footer is not provided', () => {
    const html = emailShell('<p>hi</p>');
    expect(html).not.toContain('border-top');
  });

  it('escapes footer HTML entities', () => {
    const html = emailShell('<p>x</p>', 'Sent by Pawservation on behalf of <Evil> & Co');
    expect(html).toContain('&lt;Evil&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<Evil>');
  });
});

describe('emailButton', () => {
  it('escapes URL and label', () => {
    const html = emailButton('https://x.test/a?t=1', 'Go <now>');
    expect(html).toContain('href="https://x.test/a?t=1"');
    expect(html).toContain('Go &lt;now&gt;');
    expect(html).not.toContain('<now>');
  });
});

const env = {
  RESEND_API_KEY: 'k',
  RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
  RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
  OWNER_EMAILS: 'owner@x.com',
} as unknown as Env;

/** An untrusted string that must come back escaped wherever a template interpolates it. */
const HOSTILE = 'Ka<script>"&"</script>rin';

/**
 * Every template, invoked with a hostile value in each of its untrusted slots. Named so a failure
 * points at the template rather than at a row index; the third field says whether the template has
 * any untrusted slot at all (the three account-access mails interpolate only server-built URLs).
 */
const TEMPLATES: [string, (send: typeof env) => Promise<void>, boolean][] = [
  ['sendLoginCode', (e) => sendLoginCode(e, 'a@b.test', '123456', HOSTILE), true],
  [
    'sendBookingStatusEmail',
    (e) => sendBookingStatusEmail(e, 'a@b.test', HOSTILE, 'confirmed', `Aug 3 ${HOSTILE}`),
    true,
  ],
  [
    'sendInvite',
    (e) => sendInvite(e, 'a@b.test', HOSTILE, `https://w.test/embed/x?q=${HOSTILE}`),
    true,
  ],
  ['sendSignupLink', (e) => sendSignupLink(e, 'a@b.test', 'https://w.test/setup?t=abc'), false],
  ['sendSitterInvite', (e) => sendSitterInvite(e, 'a@b.test', 'https://w.test/setup?t=abc'), false],
  ['sendResetLink', (e) => sendResetLink(e, 'a@b.test', 'https://w.test/reset?t=abc'), false],
  [
    'sendInviteRequest',
    (e) =>
      sendInviteRequest(e, {
        business: HOSTILE,
        name: HOSTILE,
        email: 'a@b.test',
        city: HOSTILE,
        services: 'Boarding',
        customerCount: '10',
      }),
    true,
  ],
];

describe.each(TEMPLATES)('%s branding', (_name, send, hasUntrustedInput) => {
  afterEach(() => vi.restoreAllMocks());

  async function render(): Promise<string> {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    await send(env);
    const init = spy.mock.calls[0][1] as RequestInit;
    return JSON.parse(init.body as string).html as string;
  }

  it('carries the brand lockup on an absolute https URL', async () => {
    const html = await render();
    expect(html).toContain(`<img src="${LOGO_URL}"`);
    expect(html).toContain('alt="Pawservation"');
    expect(html).toContain('max-width:560px');
  });

  it('inlines its styles — no <style> block and no web font', async () => {
    const html = await render();
    expect(html).not.toContain('<style');
    expect(html).not.toContain('@font-face');
    expect(html).not.toContain('@import');
    // Boogaloo is a self-hosted @font-face on the site; no mail client would load it.
    expect(html).not.toContain('Boogaloo');
    expect(html).not.toContain('fonts.googleapis');
    expect(html).not.toContain('.woff');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
  });

  it('escapes every interpolated value', async () => {
    const html = await render();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('Ka<');
    // Only the templates that actually take a caller-supplied string can show the escaped form;
    // asserting it unconditionally would pass vacuously the day one of them stops escaping.
    if (hasUntrustedInput) expect(html).toContain('&lt;script&gt;');
  });

  it('loads nothing off-origin except the brand logo', async () => {
    const html = await render();
    const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    for (const url of external) {
      const host = new URL(url).host;
      expect(['pawservation.com', 'w.test']).toContain(host);
    }
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual([LOGO_URL]);
  });
});
