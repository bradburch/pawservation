/**
 * `formatTimestamp` (`app/admin/shared.ts`) — the dashboard's one renderer for a stored instant.
 *
 * A unit test for a pure string-in/string-out helper, and the only behavioural cover it has ever
 * had. A mutation probe replaced its whole body with `return sqlDatetime` and the suite stayed
 * green: it was pinned nowhere except by `plan-panel.test.ts` asserting that the panel CALLS it,
 * which says nothing about what it answers. It was promoted to shared infrastructure (out of
 * `TokensPanel.tsx`) when the plan panel needed the same column shape rendered, and its docblock
 * now defends four non-obvious decisions — zone labelling, the separator insertion, the
 * second-space offset strip and the fallback — none of which anything checked.
 *
 * THE ZONE IS FORCED for this file — not "before the import that reads it": ESM imports are
 * hoisted, so the `import` below actually runs before this assignment does. It works anyway
 * because `formatTimestamp` reads `Intl`'s ambient zone at CALL time, not at import time, so
 * setting `TZ` any time before the first call is enough. The claim under test is that a stored
 * instant renders as its own UTC calendar day rather than the viewer's, and on a machine whose
 * clock is already UTC that claim is true of every implementation — so a test that took the
 * ambient zone would be green on a UTC CI box against the bug it exists to catch. The first case
 * below asserts the forcing actually took effect, so a host where `TZ` is silently ignored fails
 * loudly here instead of passing every other assertion for the wrong reason.
 */
process.env.TZ = 'America/Los_Angeles';

import { describe, expect, it } from 'vitest';
import { formatTimestamp } from '../../app/admin/shared';

/** `Tenants.BilledUntil` / `TenantAccessTokens.CreatedAt`: SQLite's `datetime('now')` shape. */
const STORED = '2026-10-08 00:30:00';

describe('formatTimestamp renders a stored instant as a date', () => {
  it('reads the unlabelled stored shape as UTC rather than as local time', () => {
    // The forcing above actually took effect: America/Los_Angeles is 480 minutes behind UTC at
    // the epoch (standard time, no DST question in January). A host that ignores `TZ` would read
    // its own ambient offset here instead — 0 on a UTC CI box — and every assertion below would
    // then be passing in the wrong zone for the wrong reason.
    expect(new Date(0).getTimezoneOffset()).toBe(480);
    // 00:30 UTC on the 8th is 17:30 on the 7th in the forced zone. The column is UTC, so the date a
    // sitter reads must be the 8th — "paid through Oct 7" for a subscription that runs to the 8th
    // is a day of her plan rendered away, and the nearer the stored instant is to midnight the more
    // likely it is that the only people who see it are the ones it is wrong for.
    expect(formatTimestamp(STORED)).toBe(
      new Date(Date.UTC(2026, 9, 8)).toLocaleDateString(undefined, { timeZone: 'UTC' }),
    );
    // The same claim stated so that it cannot pass by accident in any zone: both ends of one UTC
    // day render as the same date, and two instants half an hour apart across UTC midnight do not.
    expect(formatTimestamp('2026-10-08 23:30:00')).toBe(formatTimestamp(STORED));
    expect(formatTimestamp('2026-10-07 23:30:00')).not.toBe(formatTimestamp(STORED));
  });

  it('honours a zone the stamp states for itself, rather than labelling it twice', () => {
    // A stamp that already carries 'Z' or an offset is not re-labelled — the test in the helper is
    // for a stated ZONE and not for a 'T', because "2026-10-08T00:30:00" carries a separator and no
    // zone at all and JavaScript reads that one as LOCAL time.
    expect(formatTimestamp('2026-10-08T00:30:00Z')).toBe(formatTimestamp(STORED));
    // 20:30 on the 7th at -04:00 IS 00:30 on the 8th UTC.
    expect(formatTimestamp('2026-10-07 20:30:00 -04:00')).toBe(formatTimestamp(STORED));
    // And the zone-less separator shape, which is the one the 'T' test would have got wrong: still
    // read as UTC, so it renders as the 8th and not as the 7th in the viewer's zone.
    expect(formatTimestamp('2026-10-08T00:30:00')).toBe(formatTimestamp(STORED));
  });

  it('falls back to the raw string rather than ever rendering "Invalid Date"', () => {
    // The contract for anything it cannot parse: hand back what it was given. A sitter reading an
    // odd-looking stamp can at least quote it; "Invalid Date" on her own plan line reads as her
    // account being broken.
    for (const raw of ['', 'next tuesday', '0000-00-00 00:00:00', 'null']) {
      expect(formatTimestamp(raw)).toBe(raw);
    }
  });
});
