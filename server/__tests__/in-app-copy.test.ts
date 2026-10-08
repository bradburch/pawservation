import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { PAGE_STYLE } from '../lib/page-style';
import { createTestEnv } from './helpers';
import { liveSource } from './helpers/live-source';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) =>
  liveSource(readFileSync(join(ROOT, rel), 'utf8'), { keepLiterals: true });

describe('in-app copy tells the truth about Pro', () => {
  it('Help says Solo takes no cards and Pro can, and links the card guide', () => {
    const help = read('app/admin/sections/HelpSection.tsx');
    expect(help).not.toContain('Pawservation doesn&rsquo;t process payments');
    expect(help).toContain('On Solo, Pawservation doesn&rsquo;t process cards');
    expect(help).toContain('href="/getting-started/card-payments"');
  });

  it('the plan panel does not tell a sitter with Pro on that Pro is needed', () => {
    const panel = read('app/admin/PlanPanel.tsx');
    expect(panel).toContain('Pro features are switched on for your account.');
    expect(panel.replace(/\s+/g, ' ')).toMatch(/premium\?\.assistant === true/);
  });

  it('the token panel says what a sitter uses a token for, one per feature', () => {
    const tokens = read('app/admin/TokensPanel.tsx');
    expect(tokens).toContain('make a separate token for each');
    expect(tokens).toContain('e.g. Card payments');
    expect(tokens).not.toContain('e.g. Booking sync script');
    // Verbatim: setup-guides.test reads these two labels from this file.
    expect(tokens).toContain('<h3>Access tokens</h3>');
    expect(tokens).toContain('Create token');
  });

  it('the demo note speaks to a sitter', () => {
    const demo = readFileSync(join(ROOT, 'demo.html'), 'utf8');
    expect(demo).toContain('This is what your clients see.');
    const note = demo.match(/<p class="note">([\s\S]*?)<\/p>/)![1];
    expect(note).not.toMatch(/tenant/i);
    expect(note).not.toContain('/embed.js');
  });
});

describe('landing wording', () => {
  const landing = async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    return res.text();
  };

  it('serves no HTML comments on any public page, the sent page or the demo', async () => {
    // Internal notes belong in TS comments outside the template, where they are never served.
    const { env } = createTestEnv();
    for (const path of [
      '/',
      '/how-it-works',
      '/getting-started',
      '/getting-started/whatsapp',
      '/getting-started/card-payments',
      '/about',
      '/contact',
      '/privacy',
      '/terms',
      '/signup',
      '/signup/sent',
    ]) {
      const res = await app.request(path, {}, env);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain('<!--');
    }
    // /demo is a Vite-built page served from ASSETS, which the test env stubs, so read its source.
    expect(readFileSync(join(ROOT, 'demo.html'), 'utf8'), '/demo').not.toContain('<!--');
  });

  it('gives the three helpers three names', async () => {
    const body = await landing();
    expect(body).toContain('a friendly AI assistant answers');
    expect(body).toContain('A helper for your back office');
    expect(body).toMatch(/back-office helper.*who owes you/i);
    expect(body).toMatch(/clients who use an AI assistant can connect it and book with you/i);
    for (const vendor of ['Claude', 'ChatGPT', 'Gemini', 'Copilot'])
      expect(body).not.toContain(vendor);
    expect(body).not.toContain('back-office assistant');
  });

  it('promises an answer, and keeps the final yes with the sitter', async () => {
    const body = await landing();
    expect(body).toContain('Your client gets an answer right away, and the final yes is yours.');
    expect(body).not.toContain('Your client hears your answer right away');
  });
});

describe('privacy names the booking assistant that exists', () => {
  it('describes the WhatsApp booking assistant, not a booking-page chat', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/privacy', {}, env)).text();
    expect(body).not.toMatch(/booking chat|chat assistant on a sitter/i);
    expect(body).toContain('booking assistant that answers clients on WhatsApp');
  });
});

describe('the guide pair goes two-column at 640px', () => {
  it('scopes the rule to .legal .features-2', () => {
    expect(PAGE_STYLE).toMatch(
      /@media \(min-width: 640px\)\s*\{\s*\.legal \.features-2 \{ grid-template-columns: 1fr 1fr; \}/,
    );
  });
});
