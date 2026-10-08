import { describe, expect, it } from 'vitest';
import app from '../index';
import { buildProductJsonLdScript } from '../lib/llms';
import { BRAND_ORIGIN } from '../lib/email';
import { PRICE_LINE } from '../lib/plan-pricing';
import { createTestEnv } from './helpers';

/**
 * Claims that were published but are not true of the product: extra sitters (one sitter per
 * account), an assistant in a chat on the booking page (the widget mounts none), and a demo
 * described as a sitter's account (it shows two booking pages as a client sees them). Each is
 * banned on every public surface at once, so a page added later is covered by adding its path.
 */
const PAGES = [
  '/',
  '/how-it-works',
  '/getting-started',
  '/getting-started/whatsapp',
  '/getting-started/card-payments',
];

const BANNED = [
  'extra sitters',
  'with assignment',
  'per sitter',
  'chat on your booking page',
  'page&rsquo;s chat',
  'same assistant on your booking page',
  'booking by chat',
  'made-up sitter&rsquo;s account',
  "made-up sitter's account",
  // The demo is two sitters' booking pages, never one.
  'made-up sitter&rsquo;s booking page',
  "made-up sitter's booking page",
  '[NEED',
];

async function text(path: string, accept?: string): Promise<string> {
  const { env } = createTestEnv();
  const res = await app.request(path, accept ? { headers: { Accept: accept } } : {}, env);
  expect(res.status, path).toBe(200);
  return res.text();
}

describe('no published claim outruns the product', () => {
  it('bans the retired claims on every page, in llms.txt and in the JSON-LD', async () => {
    const surfaces: [string, string][] = [];
    for (const path of PAGES) surfaces.push([path, await text(path)]);
    surfaces.push(['/llms.txt', await text('/llms.txt')]);
    surfaces.push(['/ as markdown', await text('/', 'text/markdown')]);
    surfaces.push(['JSON-LD', buildProductJsonLdScript(BRAND_ORIGIN)]);
    for (const [label, body] of surfaces)
      for (const phrase of BANNED)
        expect(body.toLowerCase(), `${label}: ${phrase}`).not.toContain(phrase.toLowerCase());
  });

  it('states both plans as one sitter each', () => {
    expect(PRICE_LINE).toBe('Solo is $15 a month. Pro is $29 a month or $290 a year.');
  });
});
