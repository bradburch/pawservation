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
    // A2, VERIFIED: updateBookingForEdit (server/db/repo.ts:1134) writes the new dates, pet count
    // and estimate together with Status='pending' in ONE statement, applied before the capacity
    // re-check, and editBooking then moves + retitles the Google event. So the change is already in
    // force when she sees it; her approval is retroactive. "Comes straight back to you as pending"
    // read as though it waited for her.
    expect(body).toMatch(/drops it straight back to pending/i);
    expect(body).toContain('the change itself is already in effect');
    expect(body).toContain('Your approval comes after the change rather than before it');
    expect(body).not.toMatch(/comes straight back to you as pending/i);
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
    // …and that half holds only on the NUMBERED settings. VERIFIED in
    // src/shared/booking/capacity.ts: all three whereabouts checks in `rangeConflictReason` sit
    // behind `overlapAllowance !== null`, and `whereaboutsDayBlocked` returns false on a null
    // allowance, so "No limit" — a real one-click option in the admin dropdown that stores NULL
    // (app/admin/sections/BusinessSection.tsx) — stops the rule running: a boarding in the middle
    // of a house sit, or a SECOND HOUSE SIT in the middle of one, is then quoted, painted and
    // accepted. The page used to say it was refused "however high you set the number", which is
    // false for the one value that is not a number.
    expect(body).toContain('On any of the numbered settings a shared day only ever counts as a');
    expect(body).toContain('No limit works differently');
    expect(body).toContain('It switches the check off');
    expect(body).not.toContain('refused however high you set the number');
  });

  it('says the whereabouts rule DOES hold two house sits apart, and drops the pet-cap workaround', async () => {
    const body = await howItWorksBody();
    // The rule now runs same-kind for house sits as well as across kinds: a night holds at most
    // one house sit, judged on EXISTENCE rather than on pet count, through the same handover
    // machinery that already governed a house sit against a boarding. So the page must say the
    // limit is about houses, and must say the pet cap is not what enforces it — a sitter who
    // reads "cap" here would set one and think she had bought the guarantee.
    expect(body).toContain('a night holds one house sit');
    expect(body).toContain('That is about houses, not animals');
    expect(body).toMatch(/no cap you set makes room for a second/i);
    // Both stays are judged, so the verdict cannot depend on booking order.
    expect(body).toContain('Both stays are judged');
    // The pet-count reading of the old rule must be gone in every form it was written in.
    expect(body).not.toContain(
      'What the rule does not do is hold two house sits apart from each other',
    );
    expect(body).not.toContain('counts pets, not houses');
    // The cap-of-one-pet workaround is now ACTIVELY BAD advice: it buys nothing the rule does not
    // already give, and it costs the sitter every client arriving with two dogs (capacity.ts's
    // `units > request.cap` → 'over_cap' refuses a two-pet booking outright). It must not appear
    // anywhere on the page in any wording.
    expect(body).not.toMatch(/cap of one pet/i);
    expect(body).not.toContain('turns away every client arriving with two dogs');
    expect(body).not.toContain('there is no setting that separates the two');
    // Boarding is NOT swept up by this: boarders are at her own home, so several a night is
    // normal and stays governed by MaxConcurrentPets alone. Saying otherwise would describe a
    // refusal the engine never makes.
    expect(body).toContain('Boarding is not affected by any of this');
  });

  it('says which Google calendar it syncs to, and that the default is her main one', async () => {
    const body = await howItWorksBody();
    // VERIFIED: the OAuth callback stores CalendarId: 'primary' (server/routes/oauth.ts:117), and
    // every read treats NULL and 'primary' alike (calendar-sync.ts:566). Because the connected
    // calendar is also READ, the default means her dentist appointment blocks bookings — which the
    // admin UI already warns about (AppsSection.tsx:69) but the marketing pages did not. Moving off
    // it is an affirmative second step: POST .../create-calendar (admin.ts:1667) makes
    // "Pawservation — Pet bookings" (google-calendar.ts:24), or she pastes an existing id
    // (admin.ts:1719). There is no picker of existing calendars.
    expect(body).toContain('Connecting starts you on your main calendar');
    expect(body).toContain('Pawservation &mdash; Pet bookings');
    expect(body).toContain('paste in the id of one you already made');
    // The claim that survives unchanged, and is still true: only the connected calendar is touched.
    expect(body).toContain('every other calendar in your account is never read and never touched');
  });

  it('says what a NON-CLIENT sees at the embedded widget', async () => {
    const body = await howItWorksBody();
    // VERIFIED in app/embed/App.tsx:120-142 — the `!authed` branch returns before BookTab is
    // mounted (:168), so a stranger gets a greeting, a three-step explainer, the email box and an
    // invite-only note; no services, no calendar, no prices. An unknown address gets 403 "This
    // provider books by invitation only." (server/routes/auth.ts:85) rather than an account.
    expect(body).toContain('Anyone can load the page, but only your clients can book it');
    expect(body).toContain('no services, no dates, no prices');
    // …true of the rendered page, and NOT true of the tenant document beside it: buildLlmsTxt
    // (server/lib/llms.ts) writes `$<Rate>/<RateUnit>` for every option of every enabled service,
    // served unauthenticated from GET /embed/:slug/llms.txt. A sitter must not read the sentence
    // above as "my rates are private".
    expect(body).toContain(
      'Your rates are public, though: the same booking address also publishes a plain-text summary of your services and prices that anyone can read without signing in.',
    );
    expect(body).toContain('booking is invite-only');
    expect(body).toContain('rather than signed up');
  });

  it('runs the walk case in the sentence that names the per-slot walk limit', async () => {
    const body = await howItWorksBody();
    // The sentence names "how many pets you'll take in that time slot" and then illustrated it with
    // a boarding date RANGE. It has to run both shapes or it argues past the walker it just named.
    expect(body).toContain('can you do Tuesday at ten?');
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
      /your own caps, your notice period, your booking horizon and, on a walk or a drop-in, how many pets you&rsquo;ll take in that time slot/,
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
    expect(body).toContain('retries every fifteen minutes until the event lands');
    // VERIFIED against wrangler.jsonc `triggers.crons: ["*/15 * * * *"]` — the sweep interval is
    // the real bound, so the page states it instead of claiming "a few minutes".
    expect(body).toContain(
      'the mirror lags for however long Google is unreachable, plus up to fifteen minutes for the next sweep after it recovers',
    );
    expect(body).not.toContain('never loses a frame');
    expect(body).not.toContain('the mirror lags a few minutes');
  });

  it("distinguishes deleting a time-off block from deleting a booking's own event", async () => {
    const body = await howItWorksBody();
    expect(body).toContain('blocks those dates automatically');
    expect(body).toMatch(/deleting it in Google cancels the booking/i);
    // …except for an ADOPTED stay, which listSyncedBookingIds excludes outright
    // (server/db/repo.ts:3777, `Source IS NOT 'calendar-backfill'`), so reconcile's cancel pass
    // can never see it. Same qualification as the landing page's move/delete answer.
    expect(body).toContain('a stay you adopted from this calendar, whose event was always yours');
    expect(body).toContain('you cancel the booking in your dashboard instead');
  });

  it('is truthful that the connected calendar is read back and blocks dates', async () => {
    const body = await howItWorksBody();
    // WS-G: external events on the connected calendar are materialized and block capacity.
    expect(body).toContain('blocks those dates automatically');
    expect(body).not.toContain('One way, on purpose');
    expect(body).not.toContain('unless you enter it as time off');
    // …but only inside the window reconcile actually reads. VERIFIED: reconcileWindow
    // (server/lib/calendar-sync.ts:521) is [today-1, max(today+180d, horizon+1d)), and pass (b)
    // materializes a foreign event only if it came back inside that window, so an unbounded
    // "blocks those dates" promise is false for a sitter who cleared her horizon.
    expect(body).toContain('It reads six months ahead');
    expect(body).toContain('clearing the horizon doesn&rsquo;t extend it, so an event further');
  });

  it('describes adopting past stays from the calendar, which now ships', async () => {
    const body = await howItWorksBody();
    // VERIFIED: server/lib/calendar-backfill.ts + POST /:slug/admin/calendar/backfill/{preview,
    // import} (server/routes/admin.ts:3722, :3817) write real BookingRequests rows stamped
    // Source = 'calendar-backfill' (repo.ts:731), surfaced by app/admin/CalendarBackfillPanel.tsx
    // inside EarningsSection. The page used to answer this question with a flat "you can't type an
    // old booking in yourself" and send the sitter to ask her client to rebook.
    expect(body).toContain('Adopt past bookings from your calendar');
    expect(body).toContain('prices each stay off today&rsquo;s rate card');
    expect(body).toContain('nothing is recorded until you press the button');
    // The half that is still true: nothing types a booking in from nothing.
    expect(body).toContain('type an old booking in from nothing');
    expect(body).not.toContain('you can&rsquo;t type an old booking in yourself');
  });

  it('discloses the one thing that is not built: repeating bookings', async () => {
    const body = await howItWorksBody();
    // No recurring/series support anywhere in the repo.
    expect(body).toContain('repeat weekly');
  });

  it('tells a sitter in the setup section how her data comes back out, and no more than that', async () => {
    const body = await howItWorksBody();
    // The setup section is where a sitter decides whether to put eleven years of client records
    // into this, so it is where the way back out belongs — beside the other "before you start"
    // answer (the stays she has already agreed to) rather than in the under-the-hood section,
    // which is explicitly about software her clients might use.
    expect(body).toContain('What if you want to take your book elsewhere?');
    expect(body.indexOf('take your book elsewhere')).toBeGreaterThan(body.indexOf('id="setup"'));
    expect(body.indexOf('take your book elsewhere')).toBeLessThan(body.indexOf('id="next"'));
    // The four datasets of EXPORT_DATASETS, and the file format buildExportCsv actually writes.
    expect(body).toContain('Export your data gives you four downloads');
    expect(body).toContain('ordinary CSVs');
    // Every claim about what is IN them is a column data-export.ts really emits, including the
    // rows a tidier export would have dropped.
    expect(body).toContain('Cancelled bookings, declined requests and pets who have died');
    // The limits, stated where the reader is deciding: she presses the button, and nothing reads
    // one of these files back into her account.
    expect(body).toContain('It goes one way only');
    // …and the same SCOPE the in-app panel states (app/admin/ExportPanel.tsx: "blocked days are
    // in none of these files"). VERIFIED: listBookingsForTenant excludes ServiceType = 'blocked',
    // so time off is in no dataset. The panel said so and the marketing copy did not, which is
    // the drift that lets a sitter export before she leaves and find her calendar missing.
    expect(body).toContain('your time off, which is in none of the four files');
    for (const overclaim of [
      'automatic backup',
      'automatic export',
      'scheduled export',
      'nightly',
      'api key',
      'full account backup',
      'download everything as a zip',
      'import it back',
      'back into pawservation',
    ])
      expect(body.toLowerCase(), overclaim).not.toContain(overclaim);
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
    // The bold answer is a plain "No." again, and now earns it. It carried a headline exception
    // for as long as two house sits on one night were held apart only by a pet cap, which IS
    // being double-booked; the whereabouts rule covers that case itself now, so the warning would
    // send a skimmer looking for a hole that is closed.
    expect(body).toContain('<strong>No.</strong> Your caps and your time off hold the day');
    expect(body).not.toContain('There is one exception, and if you house-sit you should read it');
  });

  it('tells sitters their clients can reschedule and cancel without going through them', async () => {
    const body = await landingBody();
    expect(body).toContain('Can a client change or cancel a booking themselves?');
    // The two facts that make it safe for the sitter: re-approval, and a fee she never negotiates.
    expect(body).toContain('A change takes effect straight away');
    expect(body).toContain('your approval comes after the change, not before it');
    expect(body).not.toMatch(/comes back to you as pending, so you re-approve/i);
    expect(body).toMatch(/not typed in by them/i);
  });

  it('gives the monthly-payer household balance its own FAQ item, not a tail on card payments', async () => {
    const body = await landingBody();
    // It is the fix for a real problem — a client who settles a month at a time — and nobody
    // scanning for billing looks under "Do customers pay by card here?".
    expect(body).toContain('My clients pay me monthly, not per booking');
    expect(body).toMatch(/one (payment|running balance) for (the |a )?(whole |entire )?household/i);
    expect(body).toContain('one running balance rather than a figure stuck to each booking');
    // The card answer keeps only the card answer.
    const cardAnswer = body.slice(
      body.indexOf('Do customers pay by card here?'),
      body.indexOf('My clients pay me monthly'),
    );
    expect(cardAnswer).not.toContain('household');
    // VERIFIED (unchanged from round 2): GET /:slug/account exists, but app/embed/App.tsx mounts
    // only BookTab and MineTab, so there is no client-facing balance screen and no email carrying
    // one. The page may claim the sitter's side only.
    expect(body).toContain('nothing about it is emailed to your client');
    expect(body).not.toMatch(/invoice|statement/i);
  });

  it('states the whereabouts limit as part of the "No.", and names the one setting that lifts it', async () => {
    const body = await landingBody();
    // The strongest absolute on the page. Two house sits on one night used to be the case it did
    // not cover; the rule holds them apart now, on existence rather than on pet count, so the
    // answer states that as a reason the "No." holds rather than as an exception to it.
    expect(body).toContain('A night holds one house sit, whatever its pet count');
    expect(body).toContain('you can only sleep in one house');
    // "No limit" really does stop the check running, so an unqualified absolute would be false
    // for any sitter who picked it. It is the one caveat left, and it is a choice she makes.
    expect(body).toMatch(/switches that whereabouts check off/i);
    expect(body).toContain('&ldquo;No limit&rdquo;');
    // The retired pet-cap framing, in every wording it shipped in.
    expect(body).not.toContain('The exception is that it does not keep you in one house at a time');
    expect(body).not.toContain('that cap counts pets rather than houses');
    expect(body).not.toContain('so is any client bringing two dogs');
    expect(body).not.toContain('There is no setting that does the first without the second');
  });

  it('tells a sitter what the public sees before she pastes the embed on a live site', async () => {
    const body = await landingBody();
    // Half a sitter's traffic is referrals not yet on her list; without this she cannot judge
    // whether the widget is safe on a public page. VERIFIED in app/embed/App.tsx:120-142.
    expect(body).toContain('Safe on a public page');
    expect(body).toContain('no services, no dates, no prices');
    // Same qualification as the tour's embed section — see the llms.txt note there.
    expect(body).toContain(
      'Your rates are public, though: the same booking address also publishes a plain-text list of your services and prices that anyone can read without signing in, the way the prices on your own website already are.',
    );
    expect(body).toContain('booking is invite-only');
  });

  it('does not label the workflow column five unchanging things when one of them changes', async () => {
    const body = await landingBody();
    // The fifth item is "The dates question stops being a text." — the one thing that DOES change.
    expect(body).toContain(
      'Four things that don&rsquo;t change on the day you start, and one that does.',
    );
    expect(body).not.toContain('Five things that don&rsquo;t change');
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

  it('gives moving AND deleting a booking event in Google its own answer', async () => {
    const body = await landingBody();
    // It used to be a throwaway clause inside "Can it double-book me? No." — read by a sitter who
    // lives in her calendar and drags things. VERIFIED in server/lib/calendar-sync.ts: reconcile
    // has no pass that reads a moved (but still present) event's dates back onto its booking —
    // pass (a) only asks whether the id is still live, and pass (b) skips anything carrying a
    // bookingId — and the outbox only pushes SyncPending=1 rows, rebuilding the whole event from
    // the DB row when it eventually does.
    expect(body).toContain('What if I move or delete a booking&rsquo;s event in Google Calendar?');
    expect(body).toMatch(/deleting a booking&rsquo;s event in Google cancels/i);
    expect(body).toContain('Moving doesn&rsquo;t move it');
    expect(body).toContain('the event is rewritten back to them');
    // The drag that DOES have an effect: outside reconcileWindow the event is simply absent from
    // Google's response, which pass (a) reads as a hand-deletion. The window is NAMED, because
    // "the months Pawservation checks" is not a number a sitter can act on. VERIFIED in
    // reconcileWindow (server/lib/calendar-sync.ts:521): [today-1, max(today+180d, horizon+1d)).
    // The horizon term is NULL when MaxAdvanceMonths is NULL, so a CLEARED horizon (which the
    // page itself invites: "Clear it and there's no horizon at all") leaves the bound at exactly
    // 180 days. The old sentence promised the opposite in precisely that case — it said the
    // window stretched "if you let clients book beyond" six months, which is the one setting
    // under which it does not stretch at all.
    expect(body).toContain('leaves the window Pawservation checks');
    expect(body).toContain('yesterday to six months out');
    expect(body).toContain('stretches further only when your booking horizon is set further');
    expect(body).toContain('clearing the horizon doesn&rsquo;t stretch it');
    expect(body).not.toContain(
      'as far as your own booking horizon if you let clients book beyond that',
    );
    // P1-1: the cancel-on-delete promise does NOT hold for an adopted stay. VERIFIED in
    // listSyncedBookingIds (server/db/repo.ts:3777) — `Source IS NOT 'calendar-backfill'` keeps
    // every adopted booking out of pass (a)'s candidate set, permanently, because its
    // GCalEventId was stamped by the backfill and never carries private.bookingId.
    expect(body).toContain('a stay you adopted from this calendar');
    expect(body).toContain('the booking stays confirmed until you cancel it in your dashboard');
    // A6, VERIFIED: updateBookingStatus guards `Status NOT IN ('cancelled','declined')`
    // (repo.ts:1023) and no admin route writes a booking back to 'confirmed', so the dashboard
    // offers a cancelled row no lifecycle action at all. Warning about the action without saying
    // it cannot be undone left the sitter to find that out at the worst moment.
    expect(body).toContain('A cancellation is final');
    expect(body).toContain('there is no un-cancel in your dashboard');
    // …and it must never claim the move is honoured.
    for (const lie of ['the booking follows', 'the dates update', 'moves the booking'])
      expect(body, lie).not.toContain(lie);
  });

  it('describes a household as one balance, never as a bill that gets sent', async () => {
    const body = await landingBody();
    // VERIFIED: nothing is ever sent to a client showing a household balance — every template in
    // server/lib/email.ts is a login code, a booking status, an invite, or the sitter-facing
    // cancellation notice. GET /:slug/account exists, but the embed widget renders no balance
    // screen (app/embed has only BookTab and MineTab, both per-booking), so the page may not
    // claim a client-facing view of it either.
    expect(body).toMatch(/one (payment|running balance) for (the |a )?(whole |entire )?household/i);
    expect(body).toContain('one running balance rather than a figure stuck to each booking');
    // Scoped to the PAGE, not to the client: GET /:slug/account is live, end-user-authed and
    // advertised in every tenant's llms.txt (server/lib/llms.ts:50), so the honest claim is that
    // the booking page renders no total — not that the client can never reach one.
    expect(body).toContain('your booking page still shows her only her own bookings');
    expect(body).not.toContain('their own page still shows them their bookings rather than a');
    expect(body).not.toContain('send one bill');
    expect(body).not.toContain('one bill for a whole household');
    // The two words /how-it-works is banned from, banned here too: they name documents that exist
    // nowhere in this product.
    expect(body).not.toMatch(/invoice|statement/i);
  });

  it('says who is actually asked when a pet group has no rate', async () => {
    const body = await howItWorksBody();
    // VERIFIED: under PetRateMode 'exact' an unpriced set is refused (booking-ops.ts:747,
    // code 'unpriced_pet_set') and app/embed/BookTab.tsx:725-757 renders the message to the
    // CLIENT — "Ask about a rate for these N pets at <contact>", plus "book one pet at a time".
    // Nothing emails the sitter and nothing lands in her dashboard, so the old "the widget asks
    // you for a rate" put her at the wrong end of the conversation.
    expect(body).toContain('it&rsquo;s your client who gets told');
    expect(body).toContain('offers to book one pet at a time');
    expect(body).toContain('Nothing about it reaches your dashboard');
    expect(body).not.toContain('the widget asks you for a rate');
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
