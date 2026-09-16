import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveSource } from './helpers/live-source';

/**
 * THE BOOKINGS VIEW'S PAID-SURFACE MOUNT, pinned at its own source.
 *
 * There is no DOM harness for the embed bundle either — every UI promise in this suite is pinned
 * the way `plan-panel.test.ts` pins the plan panel: by reading the component and asserting on what
 * it contains. Every assertion reads `liveSource` (`helpers/live-source.ts`) rather than the raw
 * file, and `keepLiterals` only where the SUBJECT of the pin is a literal (the path template).
 *
 * What is being pinned is the shape the dashboard's settings-review card already has
 * (`app/admin/sections/ServicesSection.tsx`), with one more check that card can skip: the widget
 * sits on somebody else's page, so a `message` it receives is not necessarily from the frame it
 * mounted, and `event.source` is checked as well as `event.origin`.
 */

const EMBED = join(import.meta.dirname, '..', '..', 'app', 'embed');
const RAW = readFileSync(join(EMBED, 'MineTab.tsx'), 'utf8');
/** Executable structure only: no comments, no string or template literals. */
const MINE = liveSource(RAW);
/** Comments stripped, literals kept — for the pins whose subject is a literal. */
const MINE_TEXT = liveSource(RAW, { keepLiterals: true });
/** Whitespace collapsed: where Prettier wraps a condition is not a property worth pinning. */
const FLAT = MINE.replace(/\s+/g, ' ');
const FLAT_TEXT = MINE_TEXT.replace(/\s+/g, ' ');

const sourcesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
const EMBED_SOURCES = sourcesUnder(EMBED);

describe('the bookings view mounts the paid surface by path template, like the audit card', () => {
  it('names the path template exactly once across the embed bundle, in MineTab', () => {
    const hits = EMBED_SOURCES.filter((path) =>
      liveSource(readFileSync(path, 'utf8'), { keepLiterals: true }).includes('/premium/pay/'),
    );
    expect(hits).toEqual([join(EMBED, 'MineTab.tsx')]);
    expect(MINE_TEXT.split('/premium/pay/')).toHaveLength(2);
  });

  it('builds the address from the published origin and the widget slug, with the whole path', () => {
    expect(FLAT_TEXT).toContain('`${origin}/premium/pay/${slug}`');
  });

  it('is inside the premium.chat && origin condition, and renders nothing otherwise', () => {
    // The same condition in KIND as the audit card's `premium.assistant`: a surface asks about
    // itself, not about the subscription, and `chat` is the flag for the customer-facing one.
    expect(FLAT).toContain('config.premium?.chat === true ? config.premium.origin : null');
    expect(MINE).not.toContain('premium?.assistant');
    expect(MINE).not.toContain('premium?.mcp');
    // The early exit on a missing origin precedes the markup, so no origin means no element and no
    // space — not an iframe with an empty `src`.
    const exitAt = FLAT.indexOf('if (!origin || failed) return null;');
    const frameAt = FLAT.indexOf('<iframe');
    expect(exitAt).toBeGreaterThan(-1);
    expect(frameAt).toBeGreaterThan(exitAt);
  });

  it('checks event.origin before it reads the height, and event.source as well', () => {
    const handlerAt = FLAT.indexOf('const onMessage = (event: MessageEvent) =>');
    expect(handlerAt).toBeGreaterThan(-1);
    const originAt = FLAT.indexOf('if (event.origin !== origin) return;', handlerAt);
    const sourceAt = FLAT.indexOf(
      'if (event.source !== frame.current?.contentWindow) return;',
      handlerAt,
    );
    expect(originAt).toBeGreaterThan(handlerAt);
    expect(sourceAt).toBeGreaterThan(handlerAt);
    // Every use of the posted height inside the handler comes AFTER both checks.
    const heightAt = FLAT.indexOf('data.height', handlerAt);
    const setAt = FLAT.indexOf('setHeight(', handlerAt);
    expect(heightAt).toBeGreaterThan(Math.max(originAt, sourceAt));
    expect(setAt).toBeGreaterThan(Math.max(originAt, sourceAt));
    // And the message shape is the one the widget itself posts to its host.
    expect(FLAT_TEXT).toContain(
      "data?.type === 'pawservation:resize' && typeof data.height === 'number'",
    );
  });

  it('starts at zero height and unmounts on error, so a page that never loads takes no space', () => {
    // The audit card starts at 240px because the dashboard is its own page. This one sits inside a
    // widget that is itself an auto-resizing iframe on a host page: a default height would be
    // blank space on every widget whose paid surface is down.
    expect(FLAT).toContain('useState(0)');
    expect(FLAT).toContain('onError={() => setFailed(true)}');
  });

  it('is rendered by the bookings view once signed in, on the list and on the empty state', () => {
    // One element, created once, placed under both of the signed-in returns — never under the
    // re-identify, error or loading ones, which come first.
    expect(FLAT).toContain('const paid = <PaidSurfaceEmbed config={config} />;');
    expect(FLAT.match(/\{paid\}/g)).toHaveLength(2);
    const paidAt = FLAT.indexOf('const paid = ');
    expect(paidAt).toBeGreaterThan(FLAT.indexOf('if (!bookings) return'));
  });
});

describe('the embed bundle does not know what the framed page shows', () => {
  // A word here is the free product describing a page it does not serve. `widget.css` is not
  // scanned: its "connected band" is the calendar's selected range, and CSS is not a bundle of
  // claims about anything. Raw text, comments included — a comment naming it is the leak. The
  // last pattern is the paid product's repository name, assembled from its halves so that a grep
  // for it over this repo stays empty — this scan is the one place it may be looked for.
  const FORBIDDEN = [
    /stripe/i,
    /connected/i,
    /deposit/i,
    new RegExp(['pawservation', 'premium'].join('-'), 'i'),
  ];

  it('names none of the forbidden words in any embed source file', () => {
    const offenders = EMBED_SOURCES.flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return FORBIDDEN.filter((word) => word.test(text)).map((word) => `${path}: ${word}`);
    });
    expect(offenders).toEqual([]);
  });

  it('would catch one — the scan is not vacuously green', () => {
    expect(EMBED_SOURCES.length).toBeGreaterThan(0);
    expect(FORBIDDEN.some((word) => word.test('a Stripe page'))).toBe(true);
    expect(FORBIDDEN.some((word) => word.test(['pawservation', 'premium'].join('-')))).toBe(true);
  });
});
