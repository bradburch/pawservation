import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { PAGE_STYLE } from '../lib/page-style';
import { createTestEnv } from './helpers';

const ROOT_BLOCK = /:root\s*\{([^}]*)\}/g;
const DARK = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/;

function tokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,8})\s*;/gi))
    out.set(m[1], m[2].toLowerCase());
  return out;
}

function luminance(hex: string): number {
  const h = hex.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Every text-on-ground pair the pages draw. AA body text, 4.5:1, in BOTH schemes. */
const PAIRS: [string, string][] = [
  ['ink', 'bg'],
  ['body-c', 'bg'],
  ['soft', 'bg'],
  ['ink', 'panel'],
  ['body-c', 'panel'],
  ['soft', 'panel'],
  ['ink', 'card'],
  ['body-c', 'card'],
  ['soft', 'card'],
  ['link', 'bg'],
  ['link', 'panel'],
  ['link', 'card'],
  ['btn-ink', 'btn-bg'],
  ['band-ink', 'band-bg'],
  ['chip-ink', 'chip-bg'],
  ['pend-ink', 'pend-bg'],
  ['ok-ink', 'ok-bg'],
  ['code-ink', 'code-bg'],
  ['ink', 'bubble-in'],
  ['ink', 'bubble-out'],
  // The dark band and the embed snippet carry secondary text and syntax colors of their own.
  ['band-soft', 'band-bg'],
  ['band-mute', 'band-bg'],
  // The sign-up form's fields on the band: typed text and the placeholder.
  ['band-ink', 'field-bg'],
  ['band-soft', 'field-bg'],
  ['band-mute', 'code-bg'],
  ['code-tag', 'code-bg'],
  ['code-attr', 'code-bg'],
];

describe('PAGE_STYLE: one token set, light and dark', () => {
  const blocks = [...PAGE_STYLE.matchAll(ROOT_BLOCK)].map((m) => m[1]);
  const light = tokens(blocks[0] ?? '');
  const dark = tokens(DARK.exec(PAGE_STYLE)?.[1] ?? '');

  it('gives the sign-up fields solid tokens, not a color-mix() a browser may not support', () => {
    const rule = PAGE_STYLE.match(/\.signup-field input,[^{]*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('background: var(--field-bg);');
    expect(rule).toContain('border: 1px solid var(--field-line);');
    expect(rule).not.toContain('color-mix');
  });

  it('stacks the hero buttons full width on a phone', () => {
    expect(PAGE_STYLE).toMatch(
      /@media \(max-width: ?560px\) ?\{ ?\.hero \.cta-row \.btn ?\{ ?flex: ?1 1 100%; ?text-align: ?center;? ?\} ?\}/,
    );
  });

  it('serves no CSS comments: internal notes stay in the source', async () => {
    expect(PAGE_STYLE).not.toContain('/*');
    const { env } = createTestEnv();
    const body = await (await app.request('/', {}, env)).text();
    const style = body.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(style.length).toBeGreaterThan(1000);
    expect(style).not.toContain('/*');
  });

  it('has exactly two :root blocks, the second under prefers-color-scheme: dark', () => {
    expect(blocks.length).toBe(2);
    expect(DARK.test(PAGE_STYLE)).toBe(true);
    expect(PAGE_STYLE).toContain('color-scheme: light dark');
  });

  it('redefines every color token in dark mode, and adds none', () => {
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
    for (const name of PAIRS.flat()) expect(light.has(name), name).toBe(true);
  });

  it('meets 4.5:1 for every text pair in both schemes', () => {
    for (const [scheme, t] of [
      ['light', light],
      ['dark', dark],
    ] as const)
      for (const [fg, bg] of PAIRS)
        expect(contrast(t.get(fg)!, t.get(bg)!), `${scheme} ${fg} on ${bg}`).toBeGreaterThanOrEqual(
          4.5,
        );
  });

  it('keeps every color literal inside the two token blocks', () => {
    const rest = PAGE_STYLE.replace(ROOT_BLOCK, '');
    expect(rest).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rest).not.toMatch(/rgba?\(/i);
  });

  it('clears the sticky header for every in-page target, not only sections', () => {
    // The ways card links #faq-website, a <details> in the FAQ: without a margin of its own the
    // jump lands it under the sticky nav, and the question the link promised is hidden.
    expect(PAGE_STYLE).toMatch(/\[id\]\s*\{\s*scroll-margin-top: 80px;/);
  });

  it('narrows the side gutter to 16px on a phone', () => {
    expect(PAGE_STYLE).toMatch(
      /@media \(max-width: 560px\)\s*\{[^}]*\.wrap\s*\{[^}]*padding: 0 16px/,
    );
  });

  it('self-hosts the display face under its budget, with its license beside it', () => {
    const dir = join(__dirname, '..', '..', 'public', 'fonts');
    const file = join(dir, 'fraunces-600.woff2');
    expect(readFileSync(file).subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(statSync(file).size).toBeLessThanOrEqual(40 * 1024);
    expect(readFileSync(join(dir, 'OFL-fraunces.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE');
    expect(PAGE_STYLE).toContain("url('/fonts/fraunces-600.woff2')");
    expect(PAGE_STYLE).toContain('font-display: swap');
  });

  it('puts no color literal in any marketing page markup', async () => {
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
    ]) {
      const body = (await (await app.request(path, {}, env)).text()).replace(
        /<style>[\s\S]*?<\/style>/g,
        '',
      );
      expect(body, path).not.toMatch(/style="[^"]*(#[0-9a-f]{3,8}|rgba?\()/i);
    }
  });
});
