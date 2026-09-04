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

  it('cites two real refusal reasons', async () => {
    const body = await howItWorksBody();
    // The pack-walk/solo-walk worked example went on 2026-09-04, when the owner asked for "What
    // you set on each one" to be a plain list of settings; the per-option limit is still stated
    // there ("counted in animals rather than bookings") and explained under Your rules.
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
    expect(body).toContain('A shared day there only ever counts as a');
    expect(body).toContain('No limit works differently');
    expect(body).toContain('it switches the check off');
    expect(body).not.toContain('refused however high you set the number');
    // …and the number is now described as governing the CROSS-KIND pair only. Same-kind is not on
    // the scale at all, so the page must not offer the number as the thing that permits or refuses
    // a second house sit.
    expect(body).toContain('The number is what you allow between a house sit and a boarding');
  });

  it('says a stay starting the day another ends has not overlapped at all', async () => {
    const body = await howItWorksBody();
    // THE LOAD-BEARING SENTENCE. Back-to-back is the only same-kind adjacency left, and it is a
    // sitter's normal working pattern. VERIFIED in src/shared/booking/capacity.ts: `EventSpan`
    // records `lastOccupied = end_date - 1`, so the first stay's last night is the day BEFORE the
    // second's first, they share no day of occupancy, and the rule never runs on them (pinned in
    // capacity.test.ts, 'BACK-TO-BACK is not an overlap at all, at every allowance including 0').
    // Both bookings show that Friday on her calendar, so without this sentence she reads the
    // strict same-kind rule as killing her business.
    expect(body).toContain(
      '<strong>A stay that starts on the day another one ends has not overlapped at all.</strong>',
    );
    expect(body).toMatch(/out of the Smiths on Friday morning and into the/i);
    expect(body).toMatch(/at every setting on this page/i);
  });

  it('says two house sits never share a night, on ANY numbered setting', async () => {
    const body = await howItWorksBody();
    // VERIFIED: `sameKindSpans` withholds the handover concession from a same-kind pair, so
    // `rangeConflictReason` returns 'same_kind_overlap' on any shared day at allowance 0, 1 or 2.
    // The old copy offered the numbered settings as buying a house-sit handover, which they never
    // should have and no longer do.
    expect(body).toContain('<strong>Two house sits never share a night</strong>');
    expect(body).toMatch(/on any of the numbered settings/i);
    expect(body).not.toMatch(/so is a second house sit dropped into the middle of the first/i);
    // A one-night stay can never share its night with anything: she takes single overnights
    // constantly and would otherwise hit refusals the page gave her no way to predict.
    expect(body).toMatch(/a one-night house sit can never share its night with anything/i);
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
    expect(body).toContain('Boarding on its own is not affected by any of this');
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
    // The owner removed the landing FAQ on 2026-09-04, so the shared footer no longer carries a
    // /#faq link; those answers now live on this page (time off under Rules, the export under Money).
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

  it('gives moving a booking event in Google its own answer, next to deleting one', async () => {
    const body = await howItWorksBody();
    // It was a landing-page FAQ answer until the September 2026 trim, which moved the whole
    // calendar-mechanics family onto the tour; this half of it (a DRAG, as against a delete) was
    // the one claim the tour did not already carry, so it arrived here as its own card rather
    // than being lost. It is read by a sitter who lives in her calendar and drags things. VERIFIED in server/lib/calendar-sync.ts: reconcile
    // has no pass that reads a moved (but still present) event's dates back onto its booking —
    // pass (a) only asks whether the id is still live, and pass (b) skips anything carrying a
    // bookingId — and the outbox only pushes SyncPending=1 rows, rebuilding the whole event from
    // the DB row when it eventually does.
    expect(body).toContain('Dragging an event doesn&rsquo;t move the booking');
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
    // The adopted-stay exception to cancel-on-delete is the neighbouring card's claim and is
    // pinned by 'distinguishes deleting a time-off block from deleting a booking&rsquo;s own
    // event' above, in the tour's own wording; it is not restated here.
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
 * ("Only your clients can book."), which is exactly why they want pinning: an absolute is either
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

  // The 251-word "Can it double-book me?" answer left the landing page in the September 2026
  // trim. It was whereabouts-rule, pool-cap, per-slot-cap and reconcile-window mechanics on a
  // page whose job is the relationship between a sitter and her clients, and /how-it-works
  // carries every one of those claims already, pinned by the four tour tests above
  // ('describes the house-sit/boarding handover…' through 'runs the walk case in the sentence
  // that names the per-slot walk limit'). What is pinned HERE is what the landing page may never
  // say in its place: the mechanics went, the retired framings must not come back with them, and
  // an unqualified promise is worse than the long answer it replaced. VERIFIED unchanged:
  // `walkHasConflict` refuses a single-day request only on a BLOCKED day, nothing anywhere models
  // travel time, and a single-day service draws no whereabouts pool at all, so a landing page
  // claiming daytime visits are held apart would be false on the day it shipped.
  it('leaves the double-booking mechanics to the tour, and makes no bare promise instead', async () => {
    const body = await landingBody();
    expect(body).not.toContain('Can it double-book me?');
    expect(body).not.toContain('<strong>No.</strong> Your caps and your time off hold the day');
    expect(body).not.toContain('There is one exception, and if you house-sit you should read it');
    for (const overclaim of ['never double-book', 'travel time', 'no clashes'])
      expect(body.toLowerCase(), overclaim).not.toContain(overclaim);
  });

  it('tells sitters their clients can reschedule and cancel without going through them', async () => {
    const body = await landingBody();
    // The FAQ item this used to open on is gone: the September 2026 trim moved the whole
    // change-and-cancel rule into the "You and your clients" section, which is where a reader
    // looking for "what is this like for my clients" actually looks, and made that the ONE place
    // on the page it is stated (it had been in a feature card, the workflow block and this FAQ
    // answer at once). The promise itself is unchanged and still pinned, word for word.
    // The two facts that make it safe for the sitter: re-approval, and a fee she never negotiates.
    expect(body).toContain('A change takes effect straight away');
    expect(body).toContain('your approval comes after the change, not before it');
    expect(body).not.toMatch(/comes back to you as pending, so you re-approve/i);
    // The fee is the sitter's stored policy applied server-side (feeToCancelToday), and the
    // cancel route reads NO request body at all, so the client cannot name a figure. The page
    // said that as "worked out here and not typed in by them"; the copy pass replaced the
    // negative half with the positive claim, which asserts the same fact about the same code.
    // What must never appear is the opposite: a client choosing or proposing what she owes.
    expect(body).toMatch(/the fee your own policy sets/i);
    for (const lie of ['they enter the fee', 'they choose the fee', 'agree a fee'])
      expect(body.toLowerCase(), lie).not.toContain(lie);
  });

  it('keeps the household claim to one line, and still never turns it into a bill', async () => {
    const body = await landingBody();
    // The 109-word household-semantics answer went in the September 2026 trim: union-find over
    // co-owned pets is not what a sitter is deciding on at the landing page, and the fact she
    // needs from it survives as a clause on the Payments card and in the Solo tier's own bullet.
    expect(body).toContain('one running balance per household');
    // What the long answer was PROTECTING her from is what stays pinned. VERIFIED (unchanged):
    // nothing is ever sent to a client showing a household balance — every template in
    // server/lib/email.ts is a login code, a booking status, an invite, or the sitter-facing
    // cancellation notice, and app/embed mounts only BookTab and MineTab, so there is no
    // client-facing balance screen. A landing page that said otherwise would be selling a
    // billing product this one is not.
    expect(body).not.toContain('send one bill');
    expect(body).not.toContain('one bill for a whole household');
    // The two words /how-it-works is banned from, banned here too: they name documents that exist
    // nowhere in this product.
    expect(body).not.toMatch(/invoice|statement/i);
  });

  it('keeps the retired pet-cap framing of the whereabouts rule off the landing page', async () => {
    const body = await landingBody();
    // The whereabouts rule went to the tour with the rest of the double-booking answer (see the
    // note above), where it is pinned in full — including the "No limit" caveat and the
    // back-to-back sentence — by 'says the whereabouts rule DOES hold two house sits apart'.
    // What must never come back to the landing page is the framing that rule REPLACED: it read
    // as a guarantee a pet cap does not give, and a sitter who believed it would set a cap of one
    // and turn away every client arriving with two dogs.
    expect(body).not.toContain('The exception is that it does not keep you in one house at a time');
    expect(body).not.toContain('that cap counts pets rather than houses');
    expect(body).not.toContain('so is any client bringing two dogs');
    expect(body).not.toContain('There is no setting that does the first without the second');
  });

  it('tells a sitter what the public sees before she pastes the embed on a live site', async () => {
    const body = await landingBody();
    // Half a sitter's traffic is referrals not yet on her list; without this she cannot judge
    // whether the widget is safe on a public page. VERIFIED in app/embed/App.tsx:120-142.
    expect(body).toContain('safe on a public page, because only your clients can book');
    // The paragraph that itemised what a stranger sees, and the countervailing fact that her
    // RATES are published unauthenticated at the same address (buildLlmsTxt), moved to the tour
    // in the September 2026 trim, where 'says what a NON-CLIENT sees at the embedded widget'
    // pins both. The short line that stays behind must therefore not make the privacy claim the
    // long one had to qualify: it says who can BOOK, and nothing about what is visible.
    expect(body).not.toContain('no services, no dates, no prices');
    for (const overclaim of ['nobody else sees', 'your rates stay private', 'nothing is visible'])
      expect(body.toLowerCase(), overclaim).not.toContain(overclaim);
  });

  it('does not label the workflow column five unchanging things when one of them changes', async () => {
    const body = await landingBody();
    // The fifth item WAS "The dates question stops being a text." — the one thing that does
    // change — which is why the label had to carry "and one that does". In the September 2026
    // trim that item was promoted out of the column into the "You and your clients" section it
    // had always been the argument for, so the column holds only things that genuinely stay put
    // and the label stopped counting them at all. The miscount it existed to prevent is what
    // stays pinned: a label that counts must never count an item the column no longer holds.
    expect(body).toContain('Nothing about how you work has to change.');
    expect(body).not.toContain('Five things that don&rsquo;t change');
    expect(body).not.toContain('Four things that don&rsquo;t change');
    // …and the promoted line is still on the page, once, where landing.test.ts pins it.
    expect(body).toContain('The dates question stops being a text.');
  });

  it('presents both tiers as products, and neither as a checkout', async () => {
    const body = await landingBody();
    // Owner repriced on 2026-09-04: Solo replaced the free tier and Pro is sold, so the unbuilt
    // framing went from the Pro card and the "Available now" badge went from both. A badge that
    // says the same thing on every card carries no information.
    expect(body).not.toContain('In development');
    expect(body).not.toContain('Not available yet');
    expect(body).not.toContain('Available now');
    expect(body).toContain('<h3>Solo</h3>');
    expect(body).toContain('<h3>Pro</h3>');
    // There is no billing code in this repo. The invite form is the only call to action either
    // card offers, so nothing here may read as a purchase the visitor can complete. The trial is
    // stated as a fact and never offered as a flow, for the same reason: "start your free trial"
    // and "no credit card required" are both promises about a checkout that does not exist, and
    // the second one describes a card step nothing in this repo could ask for or skip.
    expect(body).not.toMatch(
      /upgrade now|buy now|subscribe|enter your card|start (your |a )?free trial|no credit card|no card required/i,
    );
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

  it('keeps the MCP/assistant-booking bullet on the Pro card', async () => {
    const body = await landingBody();
    expect(body).toMatch(/connect an ai assistant.*check availability and book/i);
    // Owner repriced on 2026-09-04: the bullet's card is a product now, and the only thing the
    // page still may not do is offer a checkout it has no code for.
    expect(body).not.toMatch(/upgrade now|buy now|subscribe|enter your card/i);
  });

  it('keeps the back-office assistant bullet on the Pro card', async () => {
    const body = await landingBody();
    // The "which pet combinations have no price" clause went with the September 2026 landing
    // trim: it is codebase vocabulary on a pricing card. The bullet itself is what stays pinned.
    expect(body).toMatch(/back-office assistant.*who owes you.*your week/i);
    // Owner repriced on 2026-09-04: same rule as the sibling test above, no checkout on the page.
    expect(body).not.toMatch(/upgrade now|buy now|subscribe|enter your card/i);
  });
});
