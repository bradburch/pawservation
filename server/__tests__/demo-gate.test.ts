import { describe, expect, it } from 'vitest';
import { DEMO_EMAIL, demoHostAllowed } from '../lib/demo';

describe('demoHostAllowed', () => {
  it('accepts pawservation.com, www, and local dev on any scheme/port', () => {
    expect(demoHostAllowed('https://pawservation.com')).toBe(true);
    expect(demoHostAllowed('https://www.pawservation.com')).toBe(true);
    expect(demoHostAllowed('http://localhost:8787')).toBe(true);
    expect(demoHostAllowed('http://localhost:5173')).toBe(true);
    expect(demoHostAllowed('http://127.0.0.1:8787')).toBe(true);
  });

  it('rejects tenant sites, lookalikes, the widget * fallback, garbage, and absence', () => {
    expect(demoHostAllowed('https://sunnypawssitting.com')).toBe(false);
    expect(demoHostAllowed('https://pawservation.com.evil.example')).toBe(false);
    expect(demoHostAllowed('https://notpawservation.com')).toBe(false);
    expect(demoHostAllowed('*')).toBe(false);
    expect(demoHostAllowed('not a url')).toBe(false);
    expect(demoHostAllowed('')).toBe(false);
    expect(demoHostAllowed(undefined)).toBe(false);
  });
});

it('DEMO_EMAIL is the reserved lowercase address', () => {
  expect(DEMO_EMAIL).toBe('demo@pawservation.com');
});
