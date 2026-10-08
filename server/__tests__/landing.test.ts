import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { testimonialsHtml } from '../lib/testimonials';
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

  it('reads top to bottom in the order the spec sets', async () => {
    const body = await landingBody();
    const ids = ['fit', 'ways', 'how', 'pro', 'clients', 'dashboard', 'story', 'pricing', 'faq'];
    let last = body.indexOf('<h1>');
    for (const id of ids) {
      const at = body.indexOf(`id="${id}"`);
      expect(at, id).toBeGreaterThan(last);
      last = at;
    }
    expect(body).toContain(
      '<h1>Spend less time on booking texts and more time with the pets.</h1>',
    );
    expect(body).toContain('No card needed to start.');
  });

  it('shows booking by WhatsApp with a coded, labelled example and no brand assets', async () => {
    const body = await landingBody();
    const pro = body.slice(body.indexOf('id="pro"'), body.indexOf('id="clients"'));
    expect(pro).toContain('<h2 id="pro-h">Let clients book you on WhatsApp</h2>');
    expect(pro).toMatch(
      /<div class="phone" role="img" aria-label="Example WhatsApp conversation\./,
    );
    expect(pro).toContain('Confirm and Decline');
    expect(pro).toContain('href="/getting-started/whatsapp"');
    expect(pro).toContain('<h3>Card payments through your own Stripe account</h3>');
    expect(pro).toContain('<h3>A helper for your back office</h3>');
    expect(pro).toContain('href="https://stripe.com/pricing"');
    expect(pro.toLowerCase()).not.toContain('whatsapp logo');
    expect(pro).not.toMatch(/<img[^>]+whatsapp/i);
  });

  it('tells one boarding story: the phone example, the hero card and its screenshot agree', async () => {
    const body = await landingBody();
    // The hero screenshot is a three-night stay quoted at $150, and the coded card over it says
    // so. The WhatsApp example is the same stay told by message, so a reader never meets two
    // boarding rates on one page.
    expect(body).toContain('a three-night boarding stay selected and a $150 quote');
    expect(body).toContain(
      '<span class="req-what">Boarding &middot; 3 nights &middot; $150</span>',
    );
    const pro = body.slice(body.indexOf('id="pro"'), body.indexOf('id="clients"'));
    expect(pro).toContain('Boarding for Biscuit is $150 for 3 nights.');
    expect(pro).toContain('the price is $150 for three nights');
    expect(pro).not.toMatch(/2 nights|two nights/);
  });

  it('answers six objections in closed details, the website one reachable by its own id', async () => {
    const body = await landingBody();
    const faq = body.slice(body.indexOf('id="faq"'), body.indexOf('class="cta-band"'));
    expect(faq.match(/<details\b/g)?.length).toBe(6);
    expect(faq).not.toMatch(/<details[^>]*\bopen\b/);
    // The id is ON the details element: Safari does not open a closed details for a fragment that
    // targets its contents, so an id inside it would scroll to nothing visible.
    expect(faq).toMatch(/<details[^>]*id="faq-website"/);
    const website = faq.slice(faq.indexOf('id="faq-website"'));
    expect(website.slice(0, website.indexOf('</details>'))).toContain('&lt;script');
    expect(body).toContain('href="#faq-website"');
  });

  it('carries proof only when it is real', async () => {
    const body = await landingBody();
    const story = body.slice(body.indexOf('id="story"'), body.indexOf('id="pricing"'));
    expect(story).toContain('href="/about"');
    expect(story).toContain('href="/demo"');
    // TESTIMONIALS is empty in this branch, and an empty list emits no quote markup.
    expect(story).not.toContain('<figure');
    expect(story).not.toContain('<blockquote');
  });

  it('escapes a testimonial the day one is added', () => {
    const html = testimonialsHtml([
      { quote: 'Fewer texts <b>at last</b> & more walks', name: 'Ana', business: 'A&B Walks' },
    ]);
    expect(html).toContain('<figure class="quote"><blockquote>');
    expect(html).toContain('Fewer texts &lt;b&gt;at last&lt;/b&gt; &amp; more walks');
    expect(html).toContain('<figcaption>Ana, A&amp;B Walks</figcaption>');
    expect(html).not.toContain('<b>');
    expect(testimonialsHtml([])).toBe('');
  });

  it('names the trial on the hero button alone; every other button still reads Sign up', async () => {
    const body = await landingBody();
    // Owner decision, 2026-10-08: the hero's primary button may name the trial. The nav, the
    // section buttons, the price cards and the closing band stay "Sign up", because the nav is one
    // row on measured breakpoints and the other buttons sit beside the price that explains them.
    expect(body).toContain(
      '<a class="btn btn-primary" href="/signup">Start your 30-day free trial</a>',
    );
    expect(body.match(/Start your 30-day free trial/g)?.length).toBe(1);
    const nav = body.slice(body.indexOf('<header class="nav">'), body.indexOf('</header>'));
    expect(nav).toContain('<a class="btn btn-primary btn-sm" href="/signup">Sign up</a>');
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

  it('sends every Sign up straight to /signup: no form here, no anchor hop, no mailto', async () => {
    const body = await landingBody();
    expect(body).not.toMatch(/href="mailto:/);
    // One page, one form: a form here made the sitter submit twice (here, then the challenge).
    expect(body).not.toMatch(/<form\b/);
    expect(body).not.toContain('href="#invite-h"');
    expect(body).not.toContain('href="/#invite-h"');
    expect(body).toContain('<a class="btn btn-inverse" href="/signup">Sign up</a>');
    expect(body.match(/href="\/signup"/g)!.length).toBeGreaterThanOrEqual(8);
    // The widget lives on /signup, never here: this page stays script-free.
    expect(body).not.toContain('cf-turnstile');
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

  it('never implies a team product, and keeps one sitter per account stated on the tour', async () => {
    // The owner removed "Can my whole team use it?" from the landing page: it is a question a
    // sitter asks once she is interested, and the page's job is to get her to ask for an invite.
    // The limit itself did not go anywhere: every account is one sitter on every plan, and
    // /how-it-works states it in its "Good to know" section. What the landing page must still
    // never do is claim the thing it can't do.
    const body = await landingBody();
    expect(body).not.toContain('Can my whole team use it?');
    for (const unbuilt of ['your team can', 'add your sitters', 'invite your team', 'per seat'])
      expect(body.toLowerCase(), unbuilt).not.toContain(unbuilt);
    // The owner repriced on 2026-09-04: Pro is sold, so the unbuilt framing is gone from the card.
    expect(body).not.toContain('Not available yet');
    expect(body).not.toContain('it isn&rsquo;t built yet');
    // …and the tour still says every account is one sitter.
    const { env } = createTestEnv();
    const tour = await (await app.request('/how-it-works', {}, env)).text();
    expect(tour).toContain('Pawservation is made for one person running her own book.');
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
    expect(body).toContain('<p class="chip">$15 a month. 30-day free trial.</p>');
    // Above the fold means the safe zone: before the h1, and well before the demo/invite note,
    // which is borderline on a phone.
    const chip = body.indexOf('<p class="chip">');
    expect(chip).toBeGreaterThan(-1);
    expect(chip).toBeLessThan(body.indexOf('<h1>'));
    expect(chip).toBeLessThan(body.indexOf('<p class="note">'));
    // The hero says what the pricing section says. 2026-10-05: one wording everywhere (PRICE_LINE),
    // so Solo is "$15 a month" with no qualifier: every account is one sitter, and no plan sells
    // extra sitters, so nothing is priced "per sitter".
    expect(body).toContain('<h2 id="pricing-h">$15 a month</h2>');
    expect(body).toContain('<span class="price-per">a month</span>');
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
    // "not about the dog" line with it. The 2026-10-08 rewrite then took the "visit reports or
    // photos" line off this page too (the landing loses its "x but not y" lines; the tour keeps
    // the detail). What survives here are the bans.
    // Round 1 wrote "The only texts left are about the pets.", which three readers called an
    // overclaim: there is no photo and no visit report in this product, so every care
    // conversation still happens on her phone.
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
    // The ban is what must survive the removal: the booking page has no repeating control, so
    // nothing on this page may offer one under any name.
    // NARROWED 2026-10-05, on the owner's instruction after persona reviews: Pro's assistant DOES
    // take a repeat request ("every Tuesday and Thursday until the end of November"), expanding it
    // into dated requests she still confirms one by one, and a dog walker needs to read that before
    // signing up. So 'every tuesday' and 'repeating booking' left the list, and the note that says
    // so was pinned here; the names of a booking-page control that does not exist stay banned.
    // 2026-10-08: the one-at-a-time note left the landing page for the tour, which pins it.
    for (const unbuilt of ['repeat weekly', 'recurring booking', 'standing booking'])
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

  it('offers a no-website path beside the website one, as an equal', async () => {
    const body = await landingBody();
    // The booking page on her own site and no website at all are two first-class paths, so they
    // sit side by side right under the hero rather than one being a footnote to the other. The
    // link is /embed/:slug itself, which works on Solo; WhatsApp is the Pro half and says so.
    const ways = body.slice(body.indexOf('id="ways"'), body.indexOf('id="how"'));
    expect(body.indexOf('id="ways"')).toBeLessThan(body.indexOf('id="how"'));
    expect(ways).toContain('<div class="features features-3">');
    expect(ways.match(/<div class="feature">/g)?.length).toBe(3);
    expect(ways).toContain('<h3>On your own website</h3>');
    expect(ways).toContain('<h3>No website needed</h3>');
    expect(ways).toContain('<h3>By WhatsApp, on Pro</h3>');
  });

  it('leads Pro with WhatsApp, keeps her the one who confirms, and keeps card payments', async () => {
    const body = await landingBody();
    const pro = body.slice(body.indexOf('id="pro"'), body.indexOf('id="clients"'));
    expect(body.indexOf('id="pro"')).toBeLessThan(body.indexOf('id="clients"'));
    // The assistant supports the relationship and never replaces the sitter: every request
    // still waits on her, and nothing here may hand her a number or let a message book itself.
    for (const overclaim of [
      'we give you a number',
      'your new number',
      'confirmed instantly',
      'books itself',
      'automation',
      'ai-powered',
      'photo',
      'reminder',
    ])
      expect(pro.toLowerCase(), overclaim).not.toContain(overclaim);
    // On the Pro card, WhatsApp leads directly after "Everything in Solo", and card payments
    // stay on the list as a feature rather than the headline.
    const card = body.slice(body.indexOf('<h3>Pro</h3>'), body.indexOf('id="faq"'));
    const items = [...card.matchAll(/<li>([^<]*)/g)].map((m) => m[1]);
    expect(items[0]).toBe('Everything in Solo');
    expect(items[1]).toMatch(/^Booking by WhatsApp/);
    expect(items.some((t) => t.startsWith('Card payments through your own Stripe account'))).toBe(
      true,
    );
  });

  it('labels the call to action Sign up, and says the link comes by email', async () => {
    const body = await landingBody();
    // The form posts to /signup (routes/signup-page.ts), which emails the link itself in open
    // mode. "Sign up" is truthful only beside the sentence saying we email a sign-up link, and the
    // submit button names what it asks for. The closing band's heading is an invitation now; its
    // button still reads "Sign up", and only the hero's names the trial (owner, 2026-10-08).
    expect(body).not.toContain('Ask for an invite');
    expect(body).toContain('<h2 id="invite-h">Try it with your own clients</h2>');
    expect(body).toContain('email you a sign-up link');
    expect(body).not.toContain('added by hand');
  });

  it('says who it is for: sitters and walkers who run the business themselves', async () => {
    const body = await landingBody();
    const fit = body.slice(body.indexOf('id="fit"'), body.indexOf('id="ways"'));
    expect(body.indexOf('id="fit"')).toBeLessThan(body.indexOf('id="how"'));
    expect(fit).toContain('run the business themselves');
    expect(fit.match(/<div class="feature">/g)?.length).toBe(3);
    // A pricing example must never read as an estimate the product would make.
    expect(fit).toContain('never guessed at');
  });

  it('describes the product as neither open source nor free, and cites no other business', async () => {
    const body = (await landingBody()).toLowerCase();
    for (const legacy of ['open source', 'open-source', 'free tier', 'free plan', 'free forever'])
      expect(body, legacy).not.toContain(legacy);
    expect(body).not.toContain('bradpaws');
  });
});
