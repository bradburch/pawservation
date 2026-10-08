import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pickTimezone } from '../../app/admin/timezones.js';
import app from '../index';
import { adminToken, createTestEnv, TENANT_A } from './helpers';
import { liveSource } from './helpers/live-source';

/**
 * The sitter's first ten minutes after self-serve signup, pinned at the source the way
 * plan-panel.test.ts pins the plan panel (no DOM harness for the React bundles in this suite).
 */

const APP = join(import.meta.dirname, '..', '..', 'app');
const read = (...p: string[]) => readFileSync(join(APP, ...p), 'utf8');
/** Comments stripped, literals kept: most subjects here are copy and hrefs. */
const text = (...p: string[]) =>
  liveSource(read(...p), { keepLiterals: true }).replace(/\s+/g, ' ');

describe('/setup', () => {
  const SETUP = text('setup', 'App.tsx');

  it('sends an expired SIGNUP link to /signup to get a new one, not to the sign-in page', () => {
    expect(SETUP).toContain('href="/signup"');
    expect(SETUP).toContain('Get a new link');
  });

  it('puts the password fields in a real <form> that submits on Enter', () => {
    expect(SETUP).toMatch(/<form [^>]*onSubmit=/);
    expect(SETUP).toContain('type="submit"');
  });
});

describe('/admin sign-in', () => {
  const ADMIN = text('admin', 'App.tsx');

  it('offers ONE way in for a new sitter: "New here? Sign up" to /signup', () => {
    expect(ADMIN).toContain('New here? Sign up');
    expect(ADMIN).not.toContain('Not invited yet?');
    expect(ADMIN).not.toContain('Enter your email to get set up');
    expect(ADMIN).not.toContain("'/api/signup/start'");
  });
});

describe('the setup wizard', () => {
  const WIZARD = text('admin', 'SetupWizard.tsx');

  it('names the booking link on the done screen, for a sitter with no website', () => {
    expect(WIZARD).toMatch(/booking link/);
    expect(WIZARD).toContain('/embed/');
  });

  it('prefills the browser timezone for a business that has none', () => {
    expect(WIZARD).toContain('browserTimezone()');
  });

  it('pickTimezone takes the browser zone only when the list knows it', () => {
    expect(pickTimezone('America/Chicago', ['America/Chicago', 'UTC'])).toBe('America/Chicago');
    expect(pickTimezone('Mars/Olympus', ['America/Chicago'])).toBe('');
    expect(pickTimezone(undefined, ['America/Chicago'])).toBe('');
  });
});

describe('the plan panel during the signup trial', () => {
  const PANEL = text('admin', 'PlanPanel.tsx');

  it('says "Free trial" until the comp date instead of "No plan yet"', () => {
    expect(PANEL).toContain("'Free trial'");
    expect(PANEL).toContain('settings.compedUntil');
    expect(PANEL).toMatch(/until \$\{trialUntil\}/);
  });

  it('says the trial is Solo, and Pro features need Pro', () => {
    expect(PANEL).toMatch(/need Pro/);
    expect(PANEL).toContain('Pro features are switched on for your account.');
  });

  it('the settings read publishes CompedUntil verbatim', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare('UPDATE Tenants SET CompedUntil = ? WHERE Id = ?')
      .run('2030-01-02 03:04:05', TENANT_A);
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${await adminToken(TENANT_A)}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { compedUntil: string | null }).compedUntil).toBe(
      '2030-01-02 03:04:05',
    );
  });
});
