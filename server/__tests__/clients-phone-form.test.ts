import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveSource } from './helpers/live-source';

/**
 * The dashboard's two client-creating forms require a phone, as the routes behind them now do. No
 * DOM harness for the admin bundle (see plan-panel.test.ts), so the promise is pinned at the source.
 */
const RAW = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', 'admin', 'sections', 'ClientsSection.tsx'),
  'utf8',
);
const FLAT = liveSource(RAW).replace(/\s+/g, ' ');
const TEXT = liveSource(RAW, { keepLiterals: true }).replace(/\s+/g, ' ');

describe('the dashboard asks for a phone wherever it creates a client', () => {
  it('no longer calls the phone optional anywhere', () => {
    expect(TEXT).not.toMatch(/phone \(optional\)/i);
  });

  it('marks both phone inputs required, as tel fields', () => {
    for (const label of ['Client phone', "New person's phone"]) {
      const at = TEXT.indexOf(`aria-label="${label}"`);
      expect(at).toBeGreaterThan(-1);
      const input = TEXT.slice(TEXT.lastIndexOf('<input', at), TEXT.indexOf('/>', at));
      expect(input).toContain('type="tel"');
      expect(input).toContain('required');
    }
  });

  it('keeps Add disabled until a phone is typed, on both forms', () => {
    expect(FLAT).toMatch(/const canAddCustomer = [^;]*custPhone\.trim\(\) !== ''/);
    expect(FLAT).toMatch(/const ready = [^;]*phone\.trim\(\) !== ''/);
  });
});
