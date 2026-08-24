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

  it("describes multi-pet pricing as SHIPPED, and as the sitter's own CHOICE", async () => {
    const body = await howItWorksBody();
    // >>> This pin has now been rewritten TWICE, and the history is the point. Pre-PR-3 it read
    // `toContain('being built')` + `toContain('never auto-multiplied')`. PR 3 shipped enforcement
    // and re-pinned the second as behaviour: "nothing is multiplied, ever". 0005 shipped
    // `PetRateMode`, and that absolute became a LIE the moment any service sat on 'linear' — a
    // page telling a sitter nothing is ever multiplied while her own services double the bill for
    // a second dog is the worst failure this file exists to prevent. So the absolute is retired
    // and something stronger replaces it: the page must say the sitter CHOOSES, name both
    // choices, and never re-acquire the absolute.
    expect(body).not.toContain('being built');
    // The two rate kinds a sitter can actually set:
    expect(body).toContain('two dogs');
    expect(body).toContain('Fido');
    // Both halves of the choice are named, in the sitter's own money language.
    expect(body).toMatch(/twice your one-dog rate|times the number of pets/i);
    expect(body).toMatch(/only the combinations you have priced/i);
    // …and the choice is attributed to the sitter, not to us.
    expect(body).toMatch(/you choose|you decide/i);
    // The refusal survives, but as one BRANCH of the choice rather than as the only behaviour.
    expect(body).toMatch(/asks? you for a rate|won&rsquo;t quote|no price/i);
    // A stored combination beats the multiplier — the promise that keeps "a rate you typed" true.
    expect(body).toMatch(/beat the doubling|beats the doubling|wins over/i);
    // >>> THE REGRESSION GUARD: the retired absolutes must never come back. Each of these
    // sentences shipped on this page and is now false for any service on 'linear'.
    for (const lie of [
      'nothing is multiplied',
      'never from a multiplier',
      'does not quietly double the bill',
      'multiply behind your back',
      'not because we multiplied',
      'Nothing else multiplies it',
    ])
      expect(body).not.toContain(lie);
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

  it('describes customer self-cancellation accurately, fee and all', async () => {
    const body = await howItWorksBody();
    // POST /:slug/bookings/:id/cancel: server-priced from the stored tiers, row kept, sitter mailed.
    expect(body).toMatch(/the fee is worked out here/i);
    expect(body).toContain('always free to withdraw');
    expect(body).toContain('stays on the record as cancelled');
    // isCustomerCancellable allows an in-progress stay on purpose (booking-ops.ts).
    expect(body).toMatch(/already under way can be cancelled/i);
  });

  it('describes customer self-editing accurately, including what an edit may NOT change', async () => {
    const body = await howItWorksBody();
    // PUT /:slug/bookings/:id — dates, pets, arrival time, answers; never the service.
    expect(body).toContain('cannot change is which service it is');
    // A confirmed booking returns to pending for re-approval, and no fee is assessed.
    expect(body).toMatch(/comes straight back to you as pending/i);
    expect(body).toMatch(/[Rr]escheduling is not cancelling/);
    // Every create-time rule is re-run on the edit (booking-ops.ts editBooking).
    expect(body).toMatch(/can&rsquo;t squeeze past a cap/i);
  });

  it('is truthful that a fee-bearing cancellation KEEPS its calendar event', async () => {
    const body = await howItWorksBody();
    // keepsCalendarEventOnCancel (server/lib/calendar-sync.ts): fee > 0 retitles, fee 0 deletes.
    expect(body).toContain('[CANCELLED]');
    // The old absolute claimed every cancellation removed the event, which fee-bearing ones do not.
    expect(body).not.toContain('Cancelled means gone');
    expect(body).not.toContain('Cancel or decline in Pawservation and the event is removed');
  });

  it('claims no MINIMUM stay, because there is no MinNights column to set one with', async () => {
    const body = await howItWorksBody();
    // sql/schema.sql: "There is deliberately NO MinNights and NO MinPetCount". Both retired
    // sentences promised a dial the settings PUT would reject.
    expect(body).not.toContain('shortest and longest stay');
    expect(body).not.toContain('set a minimum and a maximum number of nights');
    expect(body).toMatch(/no minimum/i);
  });

  it('describes the house-sit/boarding handover as the sitter&rsquo;s own setting (0006)', async () => {
    const body = await howItWorksBody();
    // Tenants.HousesitBoardingOverlapDays: 0 / 1 (default) / 2 / NULL, not a hardcoded one day.
    expect(body).not.toContain('won&rsquo;t overlap an occupied boarding stay by more than a day');
    expect(body).toContain('one handover day (the default)');
    expect(body).toMatch(/never overlap/i);
    // The directional half of the rule: a shared day must be a genuine handover.
    expect(body).toMatch(/one thing ending as the other begins/i);
  });

  it('covers the booking window: per-service notice and the business-wide horizon (0004)', async () => {
    const body = await howItWorksBody();
    expect(body).toMatch(/days of notice/i);
    // createTenantFromSignup stamps MaxAdvanceMonths = 12 for a new tenant.
    expect(body).toContain('twelve months');
  });

  it('covers saved intake answers and per-service species defaults', async () => {
    const body = await howItWorksBody();
    // SavedAnswers (0007): pre-fill only, and a reworded question drops its stale answer.
    expect(body).toMatch(/already filled in the next time/i);
    expect(body).toMatch(/stale answer is dropped/i);
    // SERVICE_TEMPLATES.defaultAcceptedPetTypes — a create-time default, not a rule.
    expect(body).toContain('walks and daycare start dogs-only');
    expect(body).toContain('check-ins start cats-only');
  });

  it('never claims an unbuilt capability as available', async () => {
    const body = await howItWorksBody();
    // Forbidden nouns: nothing on this page may promise invoicing, AI, or SMS features.
    for (const banned of [/\bAI\b/, /invoice/i, /statement/i, /\bSMS\b/, /text message/i]) {
      expect(body, String(banned)).not.toMatch(banned);
    }
  });

  it('tells the client side of the booking section: a real answer straight away, still pending on the sitter', async () => {
    const body = await howItWorksBody();
    // "an answer" scanned as "a yes", which the paragraph then had to take back two sentences
    // later. Every other wf-keep line on this page is self-limiting; so is this one now.
    expect(body).toContain('Your client sees your open dates without waiting on you.');
    expect(body).not.toContain('Your client gets an answer without waiting on you.');
    // The answer is computed from the sitter's OWN rules — named, so the claim stays checkable.
    // The per-option slot cap is named too: for a walk or a drop-in it is what decides whether
    // the day is offered at all (checkSingle / monthAvailability vs TenantServiceOptions.Capacity),
    // so caps + notice + horizon alone was an incomplete list for half the businesses here.
    expect(body).toMatch(
      /your own caps, your notice period, your booking horizon and &mdash; on a walk or a drop-in &mdash; how many pets you&rsquo;ll take in that time slot/,
    );
    // Shown, not guaranteed — and never mistakable for an auto-confirm.
    expect(body).toContain('not a promise');
    expect(body).toContain('the request is still pending until you confirm it');
    expect(body).toContain('What it removes is the wait for a text back.');
    for (const lie of [
      'confirmed instantly',
      'instant confirmation',
      'confirms automatically',
      'guaranteed',
    ])
      expect(body, lie).not.toContain(lie);
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
    // Pushes retry until they land (outbox + cron): an outage delays the mirror, never loses it.
    expect(body).toContain('the calendar is a mirror');
    expect(body).toContain('the booking still lands in Pawservation');
    expect(body).toContain('keeps retrying until the event lands');
  });

  it("distinguishes deleting a time-off block from deleting a booking's own event", async () => {
    const body = await howItWorksBody();
    expect(body).toContain('blocks those dates automatically');
    expect(body).toMatch(/deleting it in Google cancels the booking/i);
  });

  it('is truthful that the connected calendar is read back and blocks dates', async () => {
    const body = await howItWorksBody();
    // WS-G: external events on the connected calendar are materialized and block capacity.
    expect(body).toContain('blocks those dates automatically');
    expect(body).not.toContain('One way, on purpose');
    expect(body).not.toContain('unless you enter it as time off');
    // The old stays-section workaround ("block those dates as time off instead") is retired.
    expect(body).toContain('type an old booking in yourself'); // still true, still disclosed
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

  it('carries no images beyond the brand calendar mark (no new weight budget to police)', async () => {
    const body = await howItWorksBody();
    const imgTags = body.match(/<img\b[^>]*>/g) ?? [];
    // The single decorative brand mark in the nav is the one allowed image; screenshots and
    // other weight stay banned.
    for (const tag of imgTags) {
      expect(tag).toContain('src="/brand/calendar.svg"');
    }
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

describe('the footer links to the legal pages', () => {
  it('landing page footer links /privacy and /terms', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    const body = await res.text();
    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/terms"');
  });

  it('how-it-works page footer links /privacy and /terms', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/how-it-works', {}, env);
    const body = await res.text();
    expect(body).toContain('href="/privacy"');
    expect(body).toContain('href="/terms"');
  });
});

/**
 * The landing page makes fewer claims than the tour, but the ones it does make are absolutes
 * ("No.", "Just your clients."), which is exactly why they want pinning: an absolute is either
 * true or it is a lie, with no middle reading a reader could charitably take.
 */
describe('the landing page claims only what ships', () => {
  async function landingBody(): Promise<string> {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    return res.text();
  }

  it('is script-free under the locked CSP, with the embed snippet escaped', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    const body = await res.text();
    // The homepage's identity graph is an inert `application/ld+json` DATA block: `ld+json` is not
    // a script type, so the browser never executes it and CSP never evaluates it — the same
    // exemption the embed page's LocalBusiness block relies on. What LOCKED_CSP protects against is
    // EXECUTABLE script, so pin that: every script tag on the page must be the data block, and the
    // assertion fails the moment a real one appears.
    expect(body.match(/<script[^>]*>/g)).toEqual(['<script type="application/ld+json">']);
    expect(body).toContain('&lt;script');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('backs the "can it double-book me? No." answer with what actually holds a day', async () => {
    const body = await landingBody();
    // A pending request occupies capacity (repo.ts's capacity reads include 'pending'), and both
    // the pool path and the per-option slot path now ask whether the whole SET fits.
    expect(body).toContain('Can it double-book me?');
    expect(body).toMatch(/holds its space from the moment it arrives/i);
    expect(body).toMatch(/three dogs needs three spaces/i);
  });

  it('tells sitters their clients can reschedule and cancel without going through them', async () => {
    const body = await landingBody();
    expect(body).toContain('Can a client change or cancel a booking themselves?');
    // The two facts that make it safe for the sitter: re-approval, and a fee she never negotiates.
    expect(body).toMatch(/comes back to you as pending/i);
    expect(body).toMatch(/not typed in by them/i);
  });

  it('still shows Pro as unbuilt, and never badges it available', async () => {
    const body = await landingBody();
    // The Pro tier does not exist. Nothing about it may read as purchasable.
    expect(body).toContain('In development');
    expect(body).toContain('Not available yet');
    expect(body.match(/Available now/g)!.length).toBe(1); // the Free card, and only the Free card
    expect(body).not.toMatch(/start (your |a )?free trial/i);
    expect(body).not.toMatch(/upgrade now|buy now|subscribe/i);
  });

  it('discloses that deleting a booking event in Google cancels the booking', async () => {
    const body = await landingBody();
    expect(body).toMatch(/deleting a booking&rsquo;s event in Google cancels/i);
  });

  it('mentions paying once for a whole household instead of per booking', async () => {
    const body = await landingBody();
    expect(body).toMatch(/one (bill|payment) for (the |a )?(whole |entire )?household/i);
  });

  it('adds an MCP/assistant-booking bullet to the Pro card without changing its unbuilt framing', async () => {
    const body = await landingBody();
    expect(body).toMatch(/connect an ai assistant.*check availability and book/i);
    // Still exactly one live badge (Free card only) and the Pro card is still unpurchasable.
    expect(body.match(/Available now/g)!.length).toBe(1);
    expect(body).toContain('Not available yet');
    expect(body).not.toMatch(/start (your |a )?free trial/i);
    expect(body).not.toMatch(/upgrade now|buy now|subscribe/i);
  });

  it('adds a back-office assistant bullet to the Pro card without changing its unbuilt framing', async () => {
    const body = await landingBody();
    expect(body).toMatch(/back-office assistant.*pet combinations.*no price/i);
    // Still exactly one live badge (Free card only) and the Pro card is still unpurchasable.
    expect(body.match(/Available now/g)!.length).toBe(1);
    expect(body).toContain('Not available yet');
    expect(body).not.toMatch(/start (your |a )?free trial/i);
    expect(body).not.toMatch(/upgrade now|buy now|subscribe/i);
  });
});
