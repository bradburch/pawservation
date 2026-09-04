import { describe, expect, it } from 'vitest';
import { SERVICE_TEMPLATES } from '../../src/shared/index.js';
import app from '../index';
import { PRICING } from '../lib/plan-pricing';
import { createTestEnv } from './helpers';

async function howItWorksBody(): Promise<string> {
  const { env } = createTestEnv();
  const res = await app.request('/how-it-works', {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

/**
 * >>> 2026-09-04 MARKETING REWRITE. The tour was a 4,100-word specification, and this file pinned
 * most of it sentence by sentence. The owner rewrote the page as marketing copy: the three things
 * a sitter is deciding about (her clients request on her own website, she confirms or declines,
 * she blocks her own time off) come first, and the mechanics that used to be spelled out here
 * (the whereabouts rule, reconcile windows, event titles, saved intake answers, adopting past
 * stays, the agent-facing plumbing) came off the page.
 *
 * So every pin on prose that no longer exists was DELETED, and nothing was weakened on the way
 * out. What survives, in full:
 *
 *  - every BAN. A sentence that was false when it was retired is still false, whether or not the
 *    paragraph it lived in is still here, and the cheapest way for a retired claim to come back
 *    is a rewrite that no longer remembers why it went. The retired pricing absolutes, the
 *    pet-cap framing of the whereabouts rule, "Cancelled means gone", the Google-drag claims, the
 *    export over-claims and the unbuilt-capability nouns are all still refused.
 *  - every STRUCTURAL pin: script-free under the locked CSP, the escaped embed snippet, the
 *    canonical/footer/section navigation, the images, the invite call to action.
 *  - the pins that guard a TRUTH the new copy still states: only clients she added can book, the
 *    client is emailed when she confirms, the fee comes from her stored policy, the connected
 *    calendar is read back, her rates are public, and the four Good-to-know limits (which
 *    landing.test.ts also reaches across for, since the landing page dropped its FAQ).
 */
describe('GET /how-it-works — the tour page', () => {
  it('serves an HTML page', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/how-it-works', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('How Pawservation works');
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

  it('leads on the three things the page is for: request, confirm or decline, time off', async () => {
    const body = await howItWorksBody();
    // The owner's brief, pinned as three claims rather than as three headings, so the copy can be
    // rewritten again without the page quietly losing what it is about.
    expect(body).toContain('Your clients request on your website');
    expect(body).toContain('You confirm or decline');
    expect(body).toMatch(/Block a day, or a run of days/);
  });

  it('states the confirm-first promise, and that the client hears about it from us', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('pending until you confirm');
    // sendBookingStatusEmail fires on confirm/decline/cancel from the admin status route
    // (server/routes/admin.ts), so the sitter does not have to send the "you're booked" message.
    expect(body).toContain('your client is emailed the moment you do');
    // There is no billing code in this repo, and on Solo the money never touches it: the sitter
    // is paid directly. The page states that as the positive claim a sitter cares about ("the
    // money goes straight to you"), so the pin that used to hold the words "never processes" is
    // now the claim plus a ban on the opposite, which is the half that could ever mislead.
    expect(body).toContain('The money goes straight to you.');
    expect(body).toContain('nothing is taken out of your earnings');
    expect(body).not.toMatch(/we (take|process|handle|collect) (your |the )?payments?/i);
    expect(body).not.toMatch(/payments? (are|is) processed/i);
  });

  it('never claims a request stays off the calendar until it is confirmed', async () => {
    const body = await howItWorksBody();
    // Pending bookings sync immediately as "[REQUEST] …" events (server/lib/google-calendar.ts).
    // The page no longer walks through event titles, but it must never claim the opposite.
    expect(body).not.toContain('nothing reaches your calendar');
  });

  it('ends with a way to ask for access, since the product is invite-only', async () => {
    const body = await howItWorksBody();
    expect(body).not.toMatch(/href="mailto:/);
    expect(body).toContain('href="/#invite-h"');
    expect(body).toContain('invite-only');
  });

  it('never re-acquires a pricing absolute that PetRateMode retired', async () => {
    const body = await howItWorksBody();
    // >>> The positive half of this pin has now been rewritten THREE times, and the history is
    // why the negative half is what stayed. Pre-PR-3 the page said multi-pet pricing was "being
    // built"; PR 3 shipped it and the page said "nothing is multiplied, ever"; 0005 shipped
    // PetRateMode and that absolute became a LIE for any service sitting on 'linear'. The
    // 2026-09-04 rewrite took the whole pricing-mode explanation off the page, so there is no
    // positive claim left to pin — the page now says only that a combination of pets can carry a
    // rate of its own, which is true under both modes. What must never come back is any of the
    // sentences that were retired as false.
    expect(body).toContain('two dogs');
    expect(body).not.toContain('being built');
    for (const lie of [
      'nothing is multiplied',
      'never from a multiplier',
      'does not quietly double the bill',
      'multiply behind your back',
      'not because we multiplied',
      'Nothing else multiplies it',
    ])
      expect(body, lie).not.toContain(lie);
  });

  it('describes customer self-cancellation accurately, fee and all', async () => {
    const body = await howItWorksBody();
    // POST /:slug/bookings/:id/cancel reads NO request body: the fee is priced server-side from
    // the stored tiers (feeToCancelToday), so the client can never name a figure.
    expect(body).toMatch(/worked out here from the windows you wrote/i);
    expect(body).toContain('free to withdraw');
    for (const lie of ['they enter the fee', 'they choose the fee', 'agree a fee'])
      expect(body.toLowerCase(), lie).not.toContain(lie);
  });

  it('describes a customer edit as already in force, with the sitter approving afterwards', async () => {
    const body = await howItWorksBody();
    // VERIFIED: updateBookingForEdit (server/db/repo.ts) writes the new dates, pet count and
    // estimate together with Status='pending' in ONE statement, and editBooking then moves the
    // Google event. So the change is in force when she sees it; her approval is retroactive.
    // "Comes straight back to you as pending" read as though it waited for her.
    expect(body).toContain('The change takes effect straight away');
    expect(body).toContain('drops the booking back to pending');
    expect(body).not.toMatch(/comes straight back to you as pending/i);
    // Every create-time rule is re-run on the edit (booking-ops.ts editBooking).
    expect(body).toContain('Every rule that applied when they booked applies again');
  });

  it('never claims a cancellation always clears its calendar event', async () => {
    const body = await howItWorksBody();
    // keepsCalendarEventOnCancel (server/lib/calendar-sync.ts): a fee > 0 retitles the event
    // "[CANCELLED] …" and keeps it; only a fee-free cancel or a decline deletes it. The page no
    // longer walks through that, and must not claim the absolute it used to.
    expect(body).not.toContain('Cancelled means gone');
    expect(body).not.toContain('Cancel or decline in Pawservation and the event is removed');
  });

  it('offers no dial the settings PUT would reject', async () => {
    const body = await howItWorksBody();
    // sql/schema.sql: "There is deliberately NO MinNights and NO MinPetCount". Both retired
    // sentences promised a minimum a sitter cannot set, and the settings PUT rejects one.
    expect(body).not.toContain('shortest and longest stay');
    expect(body).not.toContain('set a minimum and a maximum number of nights');
    expect(body).toContain('The longest stay you will take.');
  });

  it('keeps the retired framings of the whereabouts rule off the page', async () => {
    const body = await howItWorksBody();
    // The house-sit/boarding mechanics came off the page in the 2026-09-04 rewrite: they are a
    // rule the engine enforces, and a marketing page that walks through them was the owner's
    // main complaint. The BANS survive them, because each of these sentences was retired as
    // FALSE, not as long. VERIFIED unchanged in src/shared/booking/capacity.ts: the rule judges
    // houses rather than pets, so a pet cap buys none of it — a sitter who read the retired
    // framing would set a cap of one and turn away every client arriving with two dogs.
    expect(body).not.toMatch(/cap of one pet/i);
    expect(body).not.toMatch(/so is a second house sit dropped into the middle of the first/i);
    // The overlap allowance is a SETTING (Tenants.HousesitBoardingOverlapDays), never a hardcoded
    // day, so the sentence that promised one stays refused too.
    expect(body).not.toContain('won&rsquo;t overlap an occupied boarding stay by more than a day');
    for (const retired of [
      'counts pets, not houses',
      'refused however high you set the number',
      'What the rule does not do is hold two house sits apart from each other',
      'turns away every client arriving with two dogs',
      'there is no setting that separates the two',
    ])
      expect(body, retired).not.toContain(retired);
  });

  it('says what a NON-CLIENT sees, and never implies her rates are private', async () => {
    const body = await howItWorksBody();
    // VERIFIED in app/embed/App.tsx — the `!authed` branch returns before BookTab is mounted, so
    // a stranger gets a greeting and the email box; an unknown address gets 403 "This provider
    // books by invitation only." (server/routes/auth.ts) rather than an account.
    expect(body).toContain('Only clients you have added can book');
    expect(body).toContain('Anyone else sees your name and a sign-in box');
    // …true of the rendered page, and NOT true of the tenant document beside it: buildLlmsTxt
    // (server/lib/llms.ts) writes `$<Rate>/<RateUnit>` for every option of every enabled service,
    // served unauthenticated from GET /embed/:slug/llms.txt. A sitter must not read the sentence
    // above as "my rates are private", which is why the countervailing fact is on the page.
    expect(body).toContain('Your rates are public.');
    expect(body).toContain(
      'publishes a plain-text summary of your services and prices that anyone can read without signing in',
    );
    for (const overclaim of ['nobody else sees', 'your rates stay private', 'nothing is visible'])
      expect(body.toLowerCase(), overclaim).not.toContain(overclaim);
  });

  it('answers for a walk book as well as a boarding book', async () => {
    const body = await howItWorksBody();
    // The sentence that promises an answer on the page has to run both shapes, or it argues past
    // half the businesses this product is sold to.
    expect(body).toContain('can you do Tuesday at ten?');
    expect(body).toContain('Can you take the 12th to the 15th?');
  });

  it('covers the booking window: per-service notice and the business-wide horizon (0004)', async () => {
    const body = await howItWorksBody();
    expect(body).toMatch(/days of notice/i);
    // createTenantFromSignup stamps MaxAdvanceMonths = 12 for a new tenant.
    expect(body).toContain('twelve months');
  });

  it('never claims an unbuilt capability as available', async () => {
    const body = await howItWorksBody();
    // Forbidden nouns: nothing on this page may promise invoicing, AI, or SMS features.
    for (const banned of [/\bAI\b/, /invoice/i, /statement/i, /\bSMS\b/, /text message/i]) {
      expect(body, String(banned)).not.toMatch(banned);
    }
    // …nor a refusal reason the API does not give, nor a limit marketing stopped quoting.
    expect(body).not.toContain('that pet isn&rsquo;t yours');
    expect(body).not.toContain('up to 500');
    // The adopt-from-calendar flow ships (server/lib/calendar-backfill.ts), so the flat denial
    // that predated it must not come back with a rewrite.
    expect(body).not.toContain('you can&rsquo;t type an old booking in yourself');
  });

  it('promises an answer on the page without promising a booking', async () => {
    const body = await howItWorksBody();
    expect(body).toContain('The request is still pending until you confirm it.');
    // "an answer" scanned as "a yes", which the paragraph then had to take back two sentences
    // later. The line that shipped that reading stays refused.
    expect(body).not.toContain('Your client gets an answer without waiting on you.');
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
    expect(body).toContain('href="/demo"');
    expect(body).toContain('href="/admin"');
  });

  it('navigates its own sections instead of bouncing back to the landing page', async () => {
    const body = await howItWorksBody();
    // A reader who came here for the tour should be able to move around the tour; an early nav
    // sent every click back to "/", abandoning the page they had just chosen.
    for (const id of ['booking', 'confirm', 'calendar', 'services', 'money', 'setup']) {
      expect(body, id).toContain(`href="#${id}"`);
      expect(body, id).toContain(`id="${id}"`);
    }
    // The honesty section is reachable by reading rather than by the nav, but it must exist.
    expect(body).toContain('id="limits"');
    expect(body).not.toContain('href="/#how"');
    expect(body).not.toContain('href="/#dashboard"');
  });

  it('is truthful that the connected calendar is read back and blocks dates', async () => {
    const body = await howItWorksBody();
    // Reconcile materializes foreign events on the connected calendar as capacity-blocking rows.
    expect(body).toContain('blocks those dates too');
    expect(body).not.toContain('One way, on purpose');
    expect(body).not.toContain('unless you enter it as time off');
    // …but only inside the window reconcile actually reads. VERIFIED: reconcileWindow
    // (server/lib/calendar-sync.ts) is [today-1, max(today+180d, horizon+1d)), so an unbounded
    // "blocks those dates" promise is false for a sitter who cleared her horizon. The page states
    // the floor and the horizon term together instead of explaining the window.
    expect(body).toContain('for six months ahead or as far as your booking horizon');
  });

  it('never claims a Google drag moves the booking, or that the mirror is perfect', async () => {
    const body = await howItWorksBody();
    // VERIFIED in server/lib/calendar-sync.ts: reconcile has no pass that reads a moved (but
    // still present) event's dates back onto its booking, and the outbox rebuilds the event from
    // the DB row. The page no longer discusses dragging; these claims stay refused anyway.
    for (const lie of ['the booking follows', 'the dates update', 'moves the booking'])
      expect(body, lie).not.toContain(lie);
    // VERIFIED against wrangler.jsonc `triggers.crons: ["*/15 * * * *"]`: an outage delays the
    // mirror by however long Google is unreachable plus up to fifteen minutes, so neither a
    // perfect mirror nor a few-minute one may be claimed.
    expect(body).not.toContain('never loses a frame');
    expect(body).not.toContain('the mirror lags a few minutes');
  });

  it('discloses the one thing that is not built: repeating bookings', async () => {
    const body = await howItWorksBody();
    // No recurring/series support anywhere in the repo. landing.test.ts reaches across for this
    // same substring, since the landing page's FAQ went and this is where the answer lives.
    expect(body).toContain('repeat weekly');
    expect(body).toContain('No repeating bookings yet.');
  });

  it('states the whole-day limit on time off, and the one-sitter limit on Solo', async () => {
    const body = await howItWorksBody();
    // Both are pinned from landing.test.ts too: time off is a whole-day 'blocked' row and nothing
    // anywhere closes part of a day, and Solo is one sitter per account.
    expect(body).toContain('Time off is whole days only');
    expect(body).toContain('no way to close just the 10am walk');
    expect(body).toContain('Solo runs one sitter per account');
  });

  it('tells a sitter how her data comes back out, and no more than that', async () => {
    const body = await howItWorksBody();
    // The Good-to-know section is where a sitter decides whether to put eleven years of client
    // records into this, so it is where the way back out belongs.
    expect(body).toContain('What if you want to take your book elsewhere?');
    expect(body.indexOf('take your book elsewhere')).toBeGreaterThan(body.indexOf('id="setup"'));
    expect(body.indexOf('take your book elsewhere')).toBeGreaterThan(body.indexOf('id="limits"'));
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

  it('keeps developer nouns out of the copy', async () => {
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

  it('states the plan prices from PRICING, and offers no checkout for them', async () => {
    const body = await howItWorksBody();
    // Five surfaces state these numbers and any two disagreeing is a pricing lie, so the page
    // interpolates rather than hardcodes. There is no billing code in this repo, so the trial is
    // a fact the page states and never a flow it offers.
    expect(body).toContain(`$${PRICING.soloMonthly} per sitter per month`);
    expect(body).toContain(`${PRICING.trialDays}-day free trial`);
    expect(body).toContain(`$${PRICING.proMonthly} per sitter per month`);
    expect(body).toContain(`$${PRICING.proAnnual} a year`);
    expect(body).not.toMatch(
      /upgrade now|buy now|subscribe|enter your card|start (your |a )?free trial|no credit card|no card required/i,
    );
  });

  it('reuses the landing screenshots, with alt text a screen reader can use', async () => {
    const body = await howItWorksBody();
    const imgTags = body.match(/<img\b[^>]*>/g) ?? [];
    // Three step shots plus the brand mark twice (nav and shared footer). The shots are the
    // landing page's own files, so they are inside its weight budget and add no new bytes here.
    expect(imgTags.length).toBe(5);
    for (const tag of imgTags) {
      const src = /src="([^"]+)"/.exec(tag)?.[1];
      const alt = /alt="([^"]*)"/.exec(tag)?.[1];
      if (src === '/brand/calendar.svg') {
        // Decorative next to the visible "Pawservation" text: empty alt, so the name is not
        // announced twice.
        expect(alt, tag).toBe('');
        continue;
      }
      expect(src, tag).toMatch(/^\/img\/landing\/step-[a-z]+\.webp$/);
      expect(alt, tag).toBeTruthy();
      expect(alt!.length, tag).toBeGreaterThan(20);
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

  it('never puts the sitter at the wrong end of the unpriced-pet-group conversation', async () => {
    const body = await howItWorksBody();
    // VERIFIED: under PetRateMode 'exact' an unpriced set is refused (booking-ops.ts:747,
    // code 'unpriced_pet_set') and app/embed/BookTab.tsx:725-757 renders the message to the
    // CLIENT — "Ask about a rate for these N pets at <contact>", plus "book one pet at a time".
    // Nothing emails the sitter and nothing lands in her dashboard, so "the widget asks you for
    // a rate" put her at the wrong end of the conversation.
    //
    // The 2026-09-04 marketing rewrite took the pricing-mode explanation off the tour, so the
    // three sentences that used to be pinned here have no page to sit on. The BAN is what the
    // test was protecting and it stays: no page may put the sitter at the wrong end of that
    // conversation, whether or not it explains the modes at all.
    expect(body).not.toContain('the widget asks you for a rate');
    expect(body).not.toMatch(/we (will )?ask you for a rate/i);
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
