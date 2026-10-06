import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveSource } from './helpers/live-source';

/**
 * THE DASHBOARD'S FRAMED SETTINGS-REVIEW CARD DEGRADES TO ABSENCE, like the bookings view's frame.
 *
 * Pinned at source, as `pay-embed.test.ts` pins its sibling (there is no DOM harness for the admin
 * bundle). A framed page that is down must not leave the sitter a broken box in her settings: the
 * card unmounts when the frame reports a failure, and takes no space before the page has said how
 * tall it is.
 *
 * Honest limit: a browser fires an iframe's `error` only for failures it can see at the network
 * layer; an HTTP error page still loads. This is the same best-effort the bookings view has.
 */
const RAW = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', 'admin', 'sections', 'ServicesSection.tsx'),
  'utf8',
);
const FLAT = liveSource(RAW).replace(/\s+/g, ' ');

describe('the settings-review frame', () => {
  it('unmounts on error, after the origin check and before the markup', () => {
    expect(FLAT).toContain('onError={() => setFailed(true)}');
    const exitAt = FLAT.indexOf('if (!origin || failed) return null;');
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
