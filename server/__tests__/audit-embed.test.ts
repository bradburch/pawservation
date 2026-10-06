import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveSource } from './helpers/live-source';

/**
 * THE DASHBOARD'S FRAMED SETTINGS-REVIEW CARD DEGRADES TO ABSENCE, like the bookings view's frame.
 *
 * Pinned at source, as `pay-embed.test.ts` pins its sibling (there is no DOM harness for the admin
 * bundle). A framed page that is down must not leave the sitter a broken box in her settings: the
 * card takes no space until the page has said how tall it is, and a page that never loads, or
 * loads as an error page, never says. That is the whole mechanism: a parent cannot see an iframe
 * fail, because no `error` event is fired for one.
 */
const RAW = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', 'admin', 'sections', 'ServicesSection.tsx'),
  'utf8',
);
const FLAT = liveSource(RAW).replace(/\s+/g, ' ');

describe('the settings-review frame', () => {
  it('carries no onError: neither the browser nor React fires one for an iframe', () => {
    // HTML fires no `error` on an iframe (a failed load renders an error page and fires `load`),
    // and React 19 wires only `load` for one, so a handler there is code that cannot run.
    expect(FLAT).not.toContain('onError');
    const exitAt = FLAT.indexOf('if (!origin) return null;');
    expect(exitAt).toBeGreaterThan(-1);
    expect(FLAT.indexOf('<iframe')).toBeGreaterThan(exitAt);
  });

  it('starts at zero height, so a page that never loads takes no space', () => {
    expect(FLAT).toContain('useState(0)');
    expect(FLAT).not.toContain('useState(240)');
  });

  it('keeps the posted height floor so a short page is not collapsed once it reports', () => {
    expect(FLAT).toContain('Math.max(120, Math.ceil(data.height))');
  });
});
