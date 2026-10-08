import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { BRAND_ORIGIN } from '../lib/email';
import { createTestEnv } from './helpers';

const GUIDES = {
  '/getting-started/whatsapp': {
    ids: [
      'at-a-glance',
      'which-number',
      'connect',
      'while-you-wait',
      'switch-on',
      'done',
      'costs',
      'problems',
    ],
    // The Pro surfaces' own labels. They live in another worker, so this list cannot be checked
    // against source here; the owner checks each by hand at the pre-merge run (merge precondition).
    labels: [
      'Connect WhatsApp',
      'Use a new number',
      'Keep the number my clients already text',
      'Access token for booking by message',
      'Save token',
      'Admin number',
      'Send code',
      'Prove',
      'Switch booking by message on',
      'Accept and switch on',
      'Ready',
      'Switch booking by message off',
      'Disconnect WhatsApp',
    ],
    dashboard: ['Services &amp; Rates', 'Access tokens', 'Create token', 'Your plan'],
  },
  '/getting-started/card-payments': {
    ids: ['at-a-glance', 'connect', 'token', 'deposits', 'after-stays', 'done', 'problems'],
    labels: [
      'Card payments',
      'Open card payments',
      'Connect Stripe',
      'Continue setup',
      'Save token',
      'No deposit',
      'A fixed amount',
      'A percentage of the estimate',
      'Set deposit rule',
      'Confirm deposit rule',
      'Pay deposit',
      'Allow charges after stays',
      'Charge saved cards after stays',
      'Disconnect Stripe',
    ],
    dashboard: [
      'Services &amp; Rates',
      'Access tokens',
      'Create token',
      'Copy the link',
      'Your website',
    ],
  },
} as const;

async function page(path: string): Promise<Response> {
  const { env } = createTestEnv();
  return app.request(path, {}, env);
}

function copyOf(body: string): string {
  return body
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ');
}

describe.each(Object.entries(GUIDES))('%s', (path, guide) => {
  it('is a script-free marketing page with its own canonical, listed everywhere', async () => {
    const res = await page(path);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toMatch(/<script\b/);
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(body).toContain(`<link rel="canonical" href="${BRAND_ORIGIN}${path}" />`);
    const root = join(__dirname, '..', '..');
    expect(readFileSync(join(root, 'public', 'sitemap.xml'), 'utf8')).toContain(
      `<loc>${BRAND_ORIGIN}${path}</loc>`,
    );
    expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toContain(`"${path}"`);
    expect(await (await page('/llms.txt')).text()).toContain(path);
    // The hub's own cards, not the shared footer, which also links both guides.
    const hub = await (await page('/getting-started')).text();
    expect(hub.slice(0, hub.indexOf('<footer'))).toContain(`href="${path}"`);
  });

  it('walks its parts in order', async () => {
    const body = await (await page(path)).text();
    let last = -1;
    for (const id of guide.ids) {
      const at = body.indexOf(`id="${id}"`);
      expect(at, id).toBeGreaterThan(last);
      last = at;
    }
  });

  it('opens with time, plan and what you need', async () => {
    const body = await (await page(path)).text();
    const glance = body.slice(
      body.indexOf('id="at-a-glance"'),
      body.indexOf(`id="${guide.ids[1]}"`),
    );
    for (const word of ['Time:', 'Plan:', 'You&rsquo;ll need:'])
      expect(glance, word).toContain(word);
  });

  it('quotes the labels the sitter will press, and the dashboard really prints its own', async () => {
    const body = await (await page(path)).text();
    for (const label of [...guide.labels, ...guide.dashboard]) expect(body, label).toContain(label);
    const app = join(__dirname, '..', '..', 'app');
    const dashboard = [
      'admin/App.tsx',
      'admin/TokensPanel.tsx',
      'admin/PlanPanel.tsx',
      'admin/sections/EmbedSection.tsx',
    ]
      .map((rel) => readFileSync(join(app, rel), 'utf8'))
      .join('\n');
    for (const label of guide.dashboard)
      expect(dashboard, label).toContain(label.replace('&amp;', '&'));
  });

  it('keeps the voice rules and names no Pro path', async () => {
    const body = await (await page(path)).text();
    const copy = copyOf(body);
    for (const banned of [
      /\bAI\b/,
      /invoice/i,
      /statement/i,
      /\bSMS\b/,
      /text message/i,
      /\bslug\b/i,
    ])
      expect(copy, String(banned)).not.toMatch(banned);
    expect(copy).not.toMatch(/coming soon|not (yet )?available|in development/i);
    expect(body).not.toContain('/premium/');
    expect(body).not.toContain(['pawservation', 'premium'].join('-'));
  });

  it('carries sign-up attribution like the other guide', async () => {
    const { env } = createTestEnv();
    const res = await app.request(`${path}?utm_source=flyer`, {}, env);
    expect(await res.text()).toContain('href="/signup?utm_source=flyer');
  });
});

describe('what each guide must say', () => {
  it('WhatsApp: the costs, the allowance, both number paths and the alerts number', async () => {
    const body = await (await page('/getting-started/whatsapp')).text();
    expect(body).toContain('href="https://business.whatsapp.com/products/platform-pricing"');
    expect(body).toContain('Replies to your clients&rsquo; messages are free.');
    expect(body).toContain('daily allowance');
    expect(body).toMatch(/pointed to your booking page, which always works/);
    expect(body).toContain('A new number just for bookings (recommended).');
    expect(body).toContain('The number your clients already message.');
    expect(body).toContain('becomes the number your alerts go to');
    expect(body).toContain('Make a separate token for card payments');
    // The admin number has to be a US number, and not the business number.
    expect(body).toContain('WhatsApp on your own phone, on a different US number');
  });

  it('WhatsApp: the "done" test starts by adding the friend as a client', async () => {
    const body = await (await page('/getting-started/whatsapp')).text();
    const done = body.slice(body.indexOf('id="done"'), body.indexOf('id="costs"'));
    // Premium answers an unknown sender with a fixed reply, and emails a recognised
    // client a code the first time they message, so the friend must be a client first.
    expect(done).toContain(
      'Add a friend as a client in <strong>Clients</strong>, with their mobile number.',
    );
    expect(done).toContain('they&rsquo;re emailed a code');
    expect(done).toContain('&ldquo;Are you free next Saturday?&rdquo;');
    expect(done.indexOf('Add a friend')).toBeLessThan(done.indexOf('Are you free next Saturday'));
  });

  it('cards: what Stripe asks for, its rate by link, payout timing, and after-stay rules', async () => {
    const body = await (await page('/getting-started/card-payments')).text();
    expect(body).toContain('href="https://stripe.com/pricing"');
    expect(body).toContain('Pawservation takes no cut');
    expect(body).toContain('Stripe pays you directly');
    expect(body).toContain('You don&rsquo;t need an EIN');
    expect(body).toContain(
      'find &ldquo;Card payments&rdquo; and choose &ldquo;Open card payments&rdquo;',
    );
    expect(body).toContain('This only ever happens to a client who asked for it.');
    expect(body).toContain('Clients who don&rsquo;t opt in pay you the way they do now.');
    expect(body).toContain('If a card is declined, it is not tried again');
    expect(body).toContain('Use a different token from the one for WhatsApp');
  });
});
