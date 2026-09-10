import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTestEnv } from './helpers';

const IMG_DIR = join(import.meta.dirname, '..', '..', 'public', 'img', 'landing');

// Per-file byte budgets from the landing-marketing-redesign spec — the weight budget is a
// failing test, not a convention. Regeneration recipe lives in
// docs/superpowers/specs/2026-07-19-landing-marketing-redesign.md.
const IMG_BUDGETS_KB: Record<string, number> = {
  'widget-hero.webp': 90,
  'step-services.webp': 40,
  'step-calendar.webp': 40,
  'step-request.webp': 40,
};
const TOTAL_BUDGET_KB = 210;

async function landingBody(): Promise<string> {
  const { env } = createTestEnv();
  const res = await app.request('/', {}, env);
  expect(res.status).toBe(200);
  return res.text();
}

describe('GET / — landing page', () => {
  it('serves an HTML page linking the admin dashboard and the demo', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('href="/admin"');
    expect(body).toContain('href="/demo"');
    expect(body).toContain('Pawservation');
    // Case-sensitive on purpose: no "Pawbook" string should remain anywhere on the landing
    // page, including the repo URLs (swept after the Phase 2 repo rename).
    expect(body).not.toContain('Pawbook');
  });

  it('mentions the Venmo CSV import on the Payments card', async () => {
    const { env } = createTestEnv();
    const body = await (await app.request('/', {}, env)).text();
    expect(body).toContain('Upload the CSV from Venmo');
    // This card is about reading a file INTO Pawservation; taking data back OUT is answered on
    // /how-it-works, and the two must not be blurred into one claim here.
    expect(body).not.toContain('export button');
  });

  it('is script-free (safe under the locked CSP) and refuses framing', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/', {}, env);
    const body = await res.text();
    // The homepage's identity graph is an inert `application/ld+json` DATA block: `ld+json` is not
    // a script type, so the browser never executes it and CSP never evaluates it — the same
    // exemption the embed page's LocalBusiness block relies on. What LOCKED_CSP protects against is
    // EXECUTABLE script, so pin that: every script tag on the page must be the data block, and the
    // assertion fails the moment a real one appears.
    expect(body.match(/<script[^>]*>/g)).toEqual(['<script type="application/ld+json">']);
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('shows the embed snippet as escaped text only', async () => {
    const body = await landingBody();
    expect(body).toContain('&lt;script');
    expect(body).toContain('data-pawservation-tenant');
  });

  it('has exactly one on-page invite-request form posting to /request-invite, no mailto anywhere', async () => {
    const body = await landingBody();
    expect(body).not.toMatch(/href="mailto:/);
    expect(body.match(/<form\b/g)?.length).toBe(1);
    expect(body).toContain('<form class="invite-form" method="post" action="/request-invite">');
    expect(body).toContain('name="business"');
    expect(body).toContain('name="fax"'); // honeypot field
  });

  it('makes no multi-pet pricing claim (rates ship with pet-mix-rates)', async () => {
    const body = await landingBody();
    expect(body).not.toContain('Can I charge more for a second dog?');
    expect(body).not.toContain('multi-pet pricing is on the way');
  });

  it('leaves the data-export answer on the tour, and claims no more than the export does', async () => {
    const body = await landingBody();
    // The owner removed the landing FAQ on 2026-09-04; the answer now lives on /how-it-works,
    // under "What if you want to take your book elsewhere?".
    expect(body).not.toContain('Can I get my data out?');
    // Nothing buildExportCsv does not do may be claimed. There is no cron, no whole-account
    // archive, no key to issue, and no path that imports an exported file into Pawservation.
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
    // The guarantee moved rather than went: the tour still names the four datasets of
    // EXPORT_DATASETS, says where the panel lives, and states the two limits a reader deciding on
    // lock-in would otherwise find out the hard way.
    const { env } = createTestEnv();
    const tour = await (await app.request('/how-it-works', {}, env)).text();
    const askedAt = tour.indexOf('What if you want to take your book elsewhere?');
    expect(askedAt).toBeGreaterThan(-1);
    const answer = tour.slice(askedAt, tour.indexOf('</section>', askedAt)).toLowerCase();
    expect(answer).toContain('export your data gives you four downloads');
    for (const dataset of ['clients', 'pets', 'bookings', 'payments'])
      expect(answer, dataset).toContain(dataset);
    // …and the same SCOPE the in-app panel states (app/admin/ExportPanel.tsx: "blocked days are
    // in none of these files"). VERIFIED: listBookingsForTenant excludes ServiceType = 'blocked',
    // so no dataset carries time off.
    expect(answer).toContain('your time off, which is in none of the four files');
    // …and the two limits out loud: it runs when she presses the button, nothing reads a file back.
    expect(answer).toContain('nothing scheduled to set up');
    expect(answer).toContain('no way to load one of these files back in');
  });

  it('drops the CSV row cap from copy', async () => {
    const body = await landingBody();
    // The client-and-pet line ("You add each client, and their pets") lived in the "What you do"
    // column of "You and your clients". The owner cut that whole two-column grid on 2026-09-09,
    // so the landing page no longer states who adds a client at all and there is nothing here to
    // pin. The WHO half survives elsewhere and is pinned there — the tour's "Only clients you
    // have added can book", and since the four rules moved off /about on 2026-09-09, its "You add
    // each client before they can book" as well, both in how-it-works.test.ts — but the
    // AND-THEIR-PETS half is now stated on no marketing page at all. That is a gap in disclosure,
    // not a false claim: no page says a client adds her own pets either, so there is nothing here
    // for a ban to protect.
    // MAX_IMPORT_ROWS=500 stays in code (server/routes/admin.ts); marketing stops quoting it.
    expect(body).not.toContain('up to 500');
  });

  it('never implies Solo runs a team, and keeps the limit stated on the tour', async () => {
    // The owner removed "Can my whole team use it?" from the landing page: it is a question a
    // sitter asks once she is interested, and the page's job is to get her to ask for an invite.
    // The limit itself did not go anywhere — /how-it-works now states it beside the other thing
    // that isn't built (the repeating schedule), which is where the honesty pages live. What the
    // landing page must still never do is claim the thing it can't do.
    const body = await landingBody();
    expect(body).not.toContain('Can my whole team use it?');
    for (const unbuilt of ['your team can', 'add your sitters', 'invite your team', 'per seat'])
      expect(body.toLowerCase(), unbuilt).not.toContain(unbuilt);
    // The owner repriced on 2026-09-04: Pro is sold, so the unbuilt framing is gone from the card.
    expect(body).not.toContain('Not available yet');
    expect(body).not.toContain('it isn&rsquo;t built yet');
    // …and the tour still names the tier the one-sitter limit belongs to.
    const { env } = createTestEnv();
    const tour = await (await app.request('/how-it-works', {}, env)).text();
    expect(tour).toContain('Solo runs one sitter per account');
  });

  it('tells visitors the demo costs them nothing to try', async () => {
    const body = await landingBody();
    // 2026-09-10: the owner replaced "a made-up sitter's account...nothing to sign up for and
    // nothing you can break" with the same framing /about's wayfinding line moved to first, so
    // the two surfaces agree. Pinned on the surviving wording rather than the retired phrase.
    expect(body).toContain('without signing up for anything');
  });

  it('states the Solo price in the hero, above the fold', async () => {
    const body = await landingBody();
    // Shoppers in this category arrive holding an incumbent's monthly figure, and the page used to
    // let them hold it until the pricing section. The chip is the first thing read and it spent
    // itself restating the product category, which the h1 and the sub both also say, so the price
    // took it over. Pinned to the exact wording: the chip is the ONE place the hero states this,
    // and a second copy in the sub would be the same idea twice on one screen.
    // Owner repriced on 2026-09-04: the chip is $15 with a 30-day trial, interpolated from PRICING.
    expect(body).toContain('<p class="chip">$15 a month for one sitter. 30-day free trial.</p>');
    // Above the fold means the safe zone: before the h1, and well before the demo/invite note,
    // which is borderline on a phone.
    const chip = body.indexOf('<p class="chip">');
    expect(chip).toBeGreaterThan(-1);
    expect(chip).toBeLessThan(body.indexOf('<h1>'));
    expect(chip).toBeLessThan(body.indexOf('<p class="note">'));
    // The hero says what the pricing section says. "for one sitter" is the price card's own
    // qualifier, so the hero cannot promise a tier section five then walks back.
    expect(body).toContain('<h2 id="pricing-h">$15 a month for one sitter</h2>');
    expect(body).toContain('<span class="price-per">for one sitter</span>');
    // $15 is a standing price, not a discount with a clock on it. The 30-day trial the owner added
    // on 2026-09-04 is a trial, not an offer, so 'free trial' left this list and the rest stayed.
    for (const offer of ['limited time', '% off', 'was $']) {
      expect(body.toLowerCase(), `hero must not read as a discount: ${offer}`).not.toContain(offer);
    }
  });

  it('carries the relationship framing: care conversations stay the sitter\u2019s', async () => {
    const body = await landingBody();
    // The two-column grid this section used to carry was cut by the owner on 2026-09-09 ("a lot of
    // text and it reads as AI slop"), taking the "dates question stops being a text" pair and the
    // "not about the dog" line with it. What survives is the claim that mattered and the bans that
    // protected it: the page must NAME the category feature it doesn't have. Time To Pet's
    // headline is the visit report; a page arguing that software improves the client relationship,
    // which never mentions the one incumbent feature actually about the animal, argues against
    // itself.
    expect(body).toContain('doesn&rsquo;t do visit reports or photos');
    // Round 1 wrote "The only texts left are about the pets.", which three readers called an
    // overclaim: there is no messaging, no photo and no visit report in this product, so every
    // care conversation still happens on her phone. The replacement is narrower on purpose.
    expect(body).toContain('What they send you now is about the dog.');
    expect(body).not.toContain('The only texts left are about the pets.');
    // The owner removed the "more of what's left is about the animal" sentence on 2026-09-04, so
    // its pin goes with it; the ban it protected stays, because gate codes and "running late"
    // still arrive by text and "what reaches you is a care question" was falsifiable in week one.
    expect(body).not.toContain('a care question');
    // ...and it must never read as instant confirmation. The sitter's yes is still the gate, and
    // the client's OWN screen says so too, so nobody tells their spouse it's booked at 11pm.
    expect(body).toContain('Every request waits as pending until you confirm it');
    expect(body).toContain('their screen says so');
    for (const lie of ['confirmed instantly', 'instant confirmation', 'confirms automatically'])
      expect(body, lie).not.toContain(lie);
    // 2026-09-09: cutting the two-column grid left this section as a .section-head and nothing
    // else, which is a centred 60ch intro block, so it rendered half the height and half the
    // width of every section around it. It gets a body again, and the body is the .features grid
    // #dashboard already uses rather than new markup. Pinned because the fix is the layout: the
    // three claims above are still the WHOLE of what this section says, and a future edit that
    // drops the grid takes the section back to reading unfinished.
    const clients = body.slice(body.indexOf('id="clients"'), body.indexOf('id="dashboard"'));
    // .features-3, not bare .features: the shared grid's 640-959px band is two columns, which
    // left the third of these three cards alone with an empty cell beside it. Same defect
    // .features-4 already exists for, and pinned for the same reason the grid itself is.
    expect(clients).toContain('<div class="features features-3">');
    expect(clients.match(/<div class="feature">/g)?.length).toBe(3);
  });

  it('never re-acquires the time-audit arithmetic the owner cut', async () => {
    const body = await landingBody();
    // These bans were written against a "do the sum yourself" block that invited a sitter to
    // multiply an invented request count by an invented per-request cost. Five of seven readers
    // objected ("two hours a month is not why anyone changes software", "eight requests a month
    // tells me who you think your customer is, I run thirty"), and the "these are illustrative"
    // disclaimer only ever existed to prop the number up. The block's own positive pins went with
    // the workflow section the owner deleted on 2026-09-09, but the BANS are not about that
    // section: they are about a fabricated measurement, which is exactly the kind of claim that
    // comes back one convenient parenthetical at a time. Nothing on this page may state a
    // measured saving, because nothing in this repo measures one.
    expect(body).not.toContain('the sum comes out somewhere else');
    expect(body).not.toContain('class="wf-sum"');
    expect(body).not.toContain('do the sum yourself');
    expect(body).not.toContain('illustrative numbers rather than a measured finding');
    for (const sum of ['At eight requests a month', 'a couple of hours back'])
      expect(body, sum).not.toContain(sum);
  });

  it('never claims a change notifies her, and never claims silence either', async () => {
    const body = await landingBody();
    // VERIFIED: cancelBooking fires sendCancellationNoticeToSitter (server/lib/booking-ops.ts:1000)
    // - the only send*() call in that whole file - while editBooking's only side effects are the
    // saved-answer write and the calendar push. So a cancellation DOES email her and a change does
    // not. The two sentences that said so out loud ("A cancellation emails you" / "A change
    // doesn't email you") were in the two-column grid the owner cut on 2026-09-09, so the page now
    // says neither; the bans are what must survive that cut, because round 2's blanket "Nothing
    // pings you" sat directly under a list that opened with "a cancelled Wednesday".
    expect(body).not.toContain('Nothing pings you');
    // The old ambiguous clause read as "a change or a cancellation emails you"; only the second
    // one does, and only that one may be claimed.
    expect(body).not.toContain('and emails you either way');
    for (const lie of ['emails you when they change', 'notifies you of the change'])
      expect(body, lie).not.toContain(lie);
  });

  it('never gets the direction of an edit backwards; approval is retroactive', async () => {
    const body = await landingBody();
    // VERIFIED in updateBookingForEdit (server/db/repo.ts:1134): ONE statement writes the new
    // StartDate/EndDate/StartTime/DepartureTime/PetCount/EstCost/Answers together with
    // Status='pending' and SyncPending=1, and editBooking calls it BEFORE the capacity re-check
    // (booking-ops.ts:1249, "apply optimistically") and then moves + retitles the Google event.
    // From that moment the new dates are the ones listCapacityRows counts. Nothing waits for the
    // sitter, so round 2's "you re-approve it rather than discovering it" was exactly backwards:
    // discovering it is precisely what she does. The three sentences that stated it lived in the
    // two-column grid the owner cut on 2026-09-09; /how-it-works still carries the mechanic, and
    // what must survive here is the ban, since the section still tells a client she can change
    // her own booking.
    expect(body).toContain('they do it on the page');
    for (const backwards of [
      're-approve it rather than discovering it',
      'comes back to you as pending, so you re-approve',
      'waiting for your approval',
      'waits for your approval',
      'before it takes effect',
    ])
      expect(body, backwards).not.toContain(backwards);
    // The tour is where the mechanic is still spelled out in full.
    const { env } = createTestEnv();
    const tour = await (await app.request('/how-it-works', {}, env)).text();
    expect(tour).toContain('takes effect');
  });

  it('never offers a repeating booking, and keeps that disclosure on the tour', async () => {
    // "Do you handle weekly regulars?" was removed from the landing page by the owner along with
    // the team question: both are things a sitter asks after she is interested, and this page is
    // asking her to request an invite rather than talking her out of it. The disclosure is NOT
    // dropped — /how-it-works has carried it all along ("One thing that isn't here yet: a
    // repeating schedule"), which is the page the tests hold to full candour.
    const body = await landingBody();
    expect(body).not.toContain('Do you handle weekly regulars?');
    expect(body).not.toContain('a weekly Tuesday is booked one Tuesday at a time');
    // The ban is what must survive the removal: no repeating support exists anywhere in the
    // repo, so nothing on this page may offer one under any name.
    for (const unbuilt of [
      'repeat weekly',
      'recurring booking',
      'standing booking',
      'repeating booking',
      'every tuesday',
    ])
      expect(body.toLowerCase(), unbuilt).not.toContain(unbuilt);
    const { env } = createTestEnv();
    const tour = await (await app.request('/how-it-works', {}, env)).text();
    expect(tour).toContain('repeat weekly');
  });

  it('claims nothing finer than whole-day time off here', async () => {
    const body = await landingBody();
    // The owner removed the landing FAQ on 2026-09-04, and with it the only place this page
    // claimed time off at all. VERIFIED unchanged: time off is a whole-day 'blocked'
    // BookingRequests row and nothing anywhere closes part of a day, so no finer control may be
    // offered here under any name.
    expect(body).not.toContain('Can I take a Tuesday off?');
    // owner removed the whole-days item from the tour, 2026-09-04
    for (const overclaim of ['by the hour', 'part of a day', 'block a single walk', 'hourly'])
      expect(body.toLowerCase(), overclaim).not.toContain(overclaim);
  });

  it('every image is a same-origin landing screenshot with informative alt text (brand mark excepted)', async () => {
    const body = await landingBody();
    const imgTags = body.match(/<img\b[^>]*>/g) ?? [];
    expect(imgTags.length).toBeGreaterThanOrEqual(4);
    for (const tag of imgTags) {
      const src = /src="([^"]+)"/.exec(tag)?.[1];
      const alt = /alt="([^"]*)"/.exec(tag)?.[1];
      if (src === '/brand/calendar.svg') {
        // The nav brand mark is DECORATIVE next to the visible "Pawservation" text — its alt
        // must be empty so screen readers don't hear the name twice.
        expect(alt, tag).toBe('');
        continue;
      }
      expect(src, tag).toMatch(/^\/img\/landing\/[a-z-]+\.webp$/);
      // Informative, not decorative: a real sentence, not "" or "screenshot".
      expect(alt, tag).toBeTruthy();
      expect(alt!.length, tag).toBeGreaterThan(20);
    }
  });

  it('every referenced screenshot exists in public/img/landing under budget (total ≤210KB)', async () => {
    const body = await landingBody();
    const referenced = new Set(
      [...body.matchAll(/src="\/img\/landing\/([^"]+)"/g)].map((m) => m[1]),
    );
    // The page must use exactly the four budgeted shots — no unbudgeted strays.
    expect([...referenced].sort()).toEqual(Object.keys(IMG_BUDGETS_KB).sort());
    let total = 0;
    for (const [file, kb] of Object.entries(IMG_BUDGETS_KB)) {
      const size = statSync(join(IMG_DIR, file)).size; // throws if missing — that IS the test
      total += size;
      expect(size, `${file} over its ${kb}KB budget`).toBeLessThanOrEqual(kb * 1024);
    }
    expect(total, 'total image weight').toBeLessThanOrEqual(TOTAL_BUDGET_KB * 1024);
  });

  it('footer carries no open-source / self-host block, only the created-by line', async () => {
    const body = await landingBody();
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
