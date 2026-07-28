import { describe, expect, it } from 'vitest';
import { SERVICE_TEMPLATES } from '../../src/shared/index.js';
import app from '../index';
import { createTestEnv } from './helpers';

async function howItWorksBody(): Promise<string> {
  const { env } = createTestEnv();
  const res = await app.request('/how-it-works', {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

describe('GET /how-it-works — the in-depth tour page', () => {
  it('serves an HTML page', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/how-it-works', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('How it works');
    expect(body).toContain('Pawservation');
    // Case-sensitive: the pre-rebrand name must not reappear on a new marketing page.
    expect(body).not.toContain('Pawbook');
  });

  it('is script-free and served under the locked CSP (no framing)', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/how-it-works', {}, env);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The embed snippet is displayed as escaped text, so the served body has no real script tag.
    expect(body).not.toContain('<script');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('shows the embed snippet as escaped text only', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('&lt;script');
    expect(body).toContain('data-pawservation-tenant');
    // The iframe fallback for hosts that strip scripts is escaped the same way.
    expect(body).toContain('&lt;iframe');
  });

  it('covers every service template, each paired with its own billing unit', async () => {
    const body = await howItWorksBody();
    // Derived from SERVICE_TEMPLATES, not hardcoded: changing a template's rateUnit (or adding a
    // template) must fail here rather than leave the page quietly claiming the wrong unit.
    for (const t of Object.values(SERVICE_TEMPLATES)) {
      expect(body, t.label).toContain(`${t.label} &middot; per ${t.rateUnit}`);
    }
  });

  it('states the confirm-first promise and server-computed pricing', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('pending until you confirm');
    expect(body).toContain('never processes');
  });

  it('is truthful that a pending request DOES reach the calendar', async () => {
    const body = await howItWorksBody();
    // Pending bookings sync immediately as "[REQUEST] …" events (server/lib/google-calendar.ts),
    // so what the confirm step protects is confirmation, not calendar absence. Saying otherwise
    // would contradict the calendar section further down the same page.
    expect(body).toContain('[REQUEST]');
    expect(body).not.toContain('nothing reaches your calendar');
  });

  it('ends with a way to ask for access, since the product is invite-only', async () => {
    const body = await howItWorksBody();
    expect(body).not.toMatch(/href="mailto:/);
    expect(body).toContain('href="/#invite-h"');
  });

  it('describes multi-pet pricing as SHIPPED, and as rates the sitter typed', async () => {
    const body = await howItWorksBody();
    // >>> These two pins deliberately REPLACE the pre-PR-3 pins `toContain('being built')` and
    // `toContain('never auto-multiplied')`. The first became false the moment enforcement
    // shipped; the second was a promise about a feature that did not exist and is now a
    // property of one that does, so it is re-pinned as behaviour rather than as intent.
    expect(body).not.toContain('being built');
    // The two rate kinds a sitter can actually set:
    expect(body).toContain('two dogs');
    expect(body).toContain('Fido');
    // The refusal is stated out loud — the page must not imply a fallback price exists.
    expect(body).toMatch(/asks? you for a rate|won&rsquo;t quote|no price/i);
    // And the multiplier is still ruled out, now as a description of shipped behaviour.
    expect(body).toMatch(/never multiplied|not a multiplier|nothing is multiplied/i);
  });

  it('teaches capacity with a worked example and cites two real refusal reasons', async () => {
    const body = await howItWorksBody();
    // The per-option capacity example walks a concrete Tuesday, not an abstract listing.
    expect(body).toContain('the solo walk still shows');
    // Both refusal examples correspond to real stable codes on POST /bookings:
    // "those dates are full" -> capacity_conflict, "that stay is too long" -> service_constraint.
    expect(body).toContain('those dates are full');
    expect(body).toContain('that stay is too long');
    expect(body).not.toContain('that pet isn&rsquo;t yours');
    // MAX_IMPORT_ROWS stays in code; the tour stops quoting it.
    expect(body).not.toContain('up to 500');
  });

  it('never claims an unbuilt capability as available', async () => {
    const body = await howItWorksBody();
    // Forbidden nouns: nothing on this page may promise invoicing, AI, or SMS features.
    for (const banned of [/\bAI\b/, /invoice/i, /statement/i, /\bSMS\b/, /text message/i]) {
      expect(body, String(banned)).not.toMatch(banned);
    }
  });

  it('links back to the landing page, the demo, and pricing', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('href="/#pricing"');
    expect(body).toContain('href="/#faq"');
    expect(body).toContain('href="/demo"');
    expect(body).toContain('href="/admin"');
  });

  it('navigates its own sections instead of bouncing back to the landing page', async () => {
    const body = await howItWorksBody();
    // A reader who came here for the tour should be able to move around the tour; the old nav
    // sent every click back to "/", abandoning the page they had just chosen.
    for (const id of ['services', 'rules', 'booking', 'money', 'calendar', 'embed', 'setup']) {
      expect(body, id).toContain(`href="#${id}"`);
      expect(body, id).toContain(`id="${id}"`);
    }
    expect(body).not.toContain('href="/#how"');
    expect(body).not.toContain('href="/#dashboard"');
  });

  it('is honest that Google Calendar is a mirror, not the record', async () => {
    const body = await howItWorksBody();
    // Sync is best-effort (routes/bookings.ts waitUntil + catch): a Google outage must never be
    // described, or experienced, as losing the booking.
    expect(body).toContain('the calendar is a mirror');
    expect(body).toContain('the booking still lands in Pawservation');
  });

  it('discloses the two things that are not built: repeats, and typing in an old stay', async () => {
    const body = await howItWorksBody();
    // No recurring/series support anywhere in the repo, and no admin route creates a booking
    // (server/routes/admin.ts only inserts 'blocked' sentinel rows).
    expect(body).toContain('repeat weekly');
    expect(body).toContain('type an old booking in yourself');
  });

  it('offers the demo without jargon or a signup scare, everywhere it offers it', async () => {
    const body = await howItWorksBody();
    expect(body.match(/nothing to sign up for/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('keeps the under-the-hood section in sitter language', async () => {
    const body = await howItWorksBody();
    // The concepts stay; the developer nouns do not. This page is read by pet sitters.
    for (const jargon of [/idempotenc/i, /machine-readable/i, /llms\.txt/i]) {
      expect(body, String(jargon)).not.toMatch(jargon);
    }
  });

  it('tells sitters they can import the CSV Venmo gives them, and that the file is not kept', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('Paid on Venmo? Upload the CSV.');
    expect(body).toContain('read in memory and never stored');
    // The banned-words test above covers this paragraph too: it may not say "statement" (so not
    // "Venmo statement") and may not say "invoice".
    expect(body).not.toMatch(/statement/i);
  });

  it('carries no images (no new weight budget to police)', async () => {
    const body = await howItWorksBody();
    expect(body).not.toContain('<img');
  });

  it('footer carries no open-source / self-host block, only the created-by line', async () => {
    const body = await howItWorksBody();
    for (const gone of [
      'MIT license',
      'Self-hostable',
      'Technical docs',
      'Source on GitHub',
      'github.com/bradburch/pawservation',
    ]) {
      expect(body, gone).not.toContain(gone);
    }
    expect(body).toContain('Brad Burch');
  });
});

describe('the landing page points at /how-it-works', () => {
  it('links the tour from the nav and the footer', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    const body = await res.text();
    expect(body).toContain('href="/how-it-works"');
    // Nav link + footer Product column entry.
    expect(body.match(/href="\/how-it-works"/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
