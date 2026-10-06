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
 * What this guards is the stated PURPOSE of a phone number every client is required to give:
 * the copy that asks for it must never suggest it is collected for any channel to send on. It does
 * not guard against the product naming a channel anywhere at all. `server/lib/llms.ts` is the
 * one SHARED file in the list: it carries the phone line AND the product document, which sells
 * booking through a chat app on Pro, where the client writes to the sitter's number rather
 * than this product using hers. So that file is scanned per LINE: every line that mentions a
 * phone must name none of the words, and no line that names one may mention a phone. Every other
 * file in the list is the feature's own and is still scanned whole.
 *
 * Two scans. The feature's own files may name none of the words. And every tracked file in the
 * repo may name no second project, which is the free product's standing rule: nothing here
 * knows a paid sibling by name.
 */
const ROOT = join(import.meta.dirname, '..', '..');
/** Files the phone feature touched but does not own, scanned line by line (see above). */
const SHARED_FILES = ['server/lib/llms.ts'];
const FILES = [
  'README.md',
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

  it('in a shared file, keeps every phone line free of the words, and every such line phone-free', () => {
    const offenders = SHARED_FILES.flatMap((file) =>
      readFileSync(join(ROOT, file), 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${file}:${i + 1}` }))
        .filter(({ line }) => /phone/i.test(line))
        .flatMap(({ line, at }) => FORBIDDEN.filter((w) => w.test(line)).map((w) => `${at}: ${w}`)),
    );
    expect(offenders).toEqual([]);
    // Not vacuous: the shared file really does carry the phone line this scan protects.
    expect(readFileSync(join(ROOT, SHARED_FILES[0]), 'utf8')).toMatch(
      /so the sitter can reach them/,
    );
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
