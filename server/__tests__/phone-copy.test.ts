import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE PHONE IS FOR ONE THING: the sitter reaching her client. The files this feature added or
 * rewrote say so and say nothing else — no channel, no product, no other purpose. Raw text,
 * comments included, because a comment naming one is the claim. Each word is assembled from its
 * halves (the pay-embed.test.ts precedent) so a grep for it over this repo stays empty.
 *
 * Two scans. The feature's own files may name none of the words. And every tracked file in the
 * repo may name no second project, which is the free product's standing rule: nothing here
 * knows a paid sibling by name.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const FILES = [
  'README.md',
  'server/lib/llms.ts',
  'server/lib/phone.ts',
  'app/embed/PhonePrompt.tsx',
  'app/embed/phone-gate.ts',
  'app/admin/importPrompt.ts',
  'app/admin/sections/ClientsSection.tsx',
  'public/clients-import-example.csv',
  'docs/examples/clients-import-example.csv',
  'server/__tests__/phone.test.ts',
  'server/__tests__/client-phone.test.ts',
  'server/__tests__/phone-prompt.test.ts',
  'server/__tests__/clients-phone-form.test.ts',
  'server/__tests__/phone-copy.test.ts',
];
const word = (...halves: string[]) => new RegExp(`\\b${halves.join('')}\\b`, 'i');
const FORBIDDEN = [
  word('whats', 'app'),
  word('s', 'ms'),
  word('mess', 'aging'),
  word('carr', 'ier'),
  word('pawservation', '-premium'),
];
const OTHER_PROJECT = word('pawservation', '-premium');
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|pdf|zip)$/i;

describe('the phone feature names no reason beyond the sitter reaching her client', () => {
  it('names none of the forbidden words in any file it added or rewrote', () => {
    const offenders = FILES.flatMap((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      return FORBIDDEN.filter((w) => w.test(text)).map((w) => `${file}: ${w}`);
    });
    expect(offenders).toEqual([]);
  });

  it('no tracked file in the repo names the other project', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f && !BINARY.test(f));
    expect(tracked.length).toBeGreaterThan(100);
    const offenders = tracked.filter((f) =>
      OTHER_PROJECT.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('would catch one — the scan is not vacuously green', () => {
    expect(FORBIDDEN.every((w) => !w.test('so a sitter can reach you'))).toBe(true);
    expect(FORBIDDEN.some((w) => w.test(`send an ${['S', 'MS'].join('')}`))).toBe(true);
    expect(OTHER_PROJECT.test(['pawservation', 'premium'].join('-'))).toBe(true);
  });
});
