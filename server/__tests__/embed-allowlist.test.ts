import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveSource } from './helpers/live-source';

/**
 * THE FREE PRODUCT'S EMBED ALLOWLIST, as a closed set.
 *
 * This product frames, and calls, a handful of pages on the origin its `/config` publishes as
 * `premium.origin`. Each one is a hardcoded path template on that one origin, and the budget is
 * deliberate: a path on one origin plus one `postMessage` shape, nothing else crosses. A new
 * template is a decision about what this public product knows about the other side, so it must
 * be made here, in a diff a reviewer reads, and not arrive as one more string in a component.
 *
 *   - the settings-review card the dashboard frames,
 *   - the plan panel's three controls (checkout, portal, resync), one route family, one caller,
 *   - the pay page the widget's bookings view frames,
 *   - the resize message those frames post.
 *
 * The scan reads every tracked source file for the path prefix, in code only (comments stripped,
 * literals kept), so a fifth template — a chat frame, say — fails here.
 */
const ROOT = join(import.meta.dirname, '..', '..');

const SOURCE = /\.(tsx?|jsx?|mjs|html)$/;
const sources = execFileSync(
  'git',
  ['ls-files', '-z', '--', 'app', 'server', 'src', 'public', '*.html'],
  {
    cwd: ROOT,
    encoding: 'utf8',
  },
)
  .split('\0')
  .filter((p) => p && SOURCE.test(p) && !p.startsWith('server/__tests__/'));

const live = (path: string) =>
  liveSource(readFileSync(join(ROOT, path), 'utf8'), { keepLiterals: true });

/** `${origin}/premium/pay/${slug}` -> `/premium/pay/:slug`; the path only, whatever frames it. */
const templatesIn = (text: string): string[] =>
  [...text.matchAll(/\/premium\/[^\s`'"]*/g)].map((m) => m[0].replace(/\$\{[^}]*\}/g, ':slug'));

describe('the add-on path templates this repo frames or calls', () => {
  it('are exactly these, each in its own file', () => {
    const found = sources
      .flatMap((path) => templatesIn(live(path)).map((t) => `${path} ${t}`))
      .sort();
    expect(found).toEqual(
      [
        'app/admin/PlanPanel.tsx /premium/billing/:slug/checkout',
        'app/admin/PlanPanel.tsx /premium/billing/:slug/portal',
        'app/admin/PlanPanel.tsx /premium/billing/:slug/resync',
        'app/admin/sections/ServicesSection.tsx /premium/audit/:slug',
        'app/embed/MineTab.tsx /premium/pay/:slug',
      ].sort(),
    );
  });

  it('are the whole distinct set: audit, the billing family and pay', () => {
    const distinct = new Set(sources.flatMap((p) => templatesIn(live(p))));
    expect([...distinct].sort()).toEqual([
      '/premium/audit/:slug',
      '/premium/billing/:slug/checkout',
      '/premium/billing/:slug/portal',
      '/premium/billing/:slug/resync',
      '/premium/pay/:slug',
    ]);
  });

  it('would catch a fifth — the scan is not vacuous', () => {
    expect(sources).toContain('app/embed/MineTab.tsx');
    expect(templatesIn('src={`${origin}/premium/chat/${slug}`}')).toEqual(['/premium/chat/:slug']);
  });
});

describe('the resize message', () => {
  const RESIZE = "'pawservation:resize'";
  it('is named in code by exactly the widget, the loader and the two receivers of a framed page', () => {
    const files = sources.filter((p) => live(p).includes(RESIZE)).sort();
    expect(files).toEqual([
      'app/admin/sections/ServicesSection.tsx',
      'app/embed/App.tsx',
      'app/embed/MineTab.tsx',
      'public/embed.js',
    ]);
  });

  it('is received by the two frames as { type, height: number } and nothing else', () => {
    for (const path of ['app/admin/sections/ServicesSection.tsx', 'app/embed/MineTab.tsx']) {
      const flat = live(path).replace(/\s+/g, ' ');
      expect(flat, path).toContain(
        "data?.type === 'pawservation:resize' && typeof data.height === 'number'",
      );
    }
  });
});
