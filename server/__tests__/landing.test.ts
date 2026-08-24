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
    // Still no data-export claim: this is about importing a file INTO Pawservation.
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

  it('makes no multi-pet pricing claim (the FAQ item is gone; rates ship with pet-mix-rates)', async () => {
    const body = await landingBody();
    expect(body).not.toContain('Can I charge more for a second dog?');
    expect(body).not.toContain('multi-pet pricing is on the way');
  });

  it('no longer advertises data export (no export route exists; the FAQ item is gone)', async () => {
    const body = await landingBody();
    expect(body).not.toContain('Can I get my data out?');
    expect(body).not.toContain('export button');
  });

  it('tells the client-AND-pet truth and drops the CSV row cap from copy', async () => {
    const body = await landingBody();
    // Post-#73 a client is a client-and-pet record; the FAQ must say pets are added too.
    expect(body).toContain('and their pets');
    // MAX_IMPORT_ROWS=500 stays in code (server/routes/admin.ts); marketing stops quoting it.
    expect(body).not.toContain('up to 500');
  });

  it('is honest that an account is one sitter today, with teams behind the unbuilt Pro tier', async () => {
    const body = await landingBody();
    expect(body).toContain('Can my whole team use it?');
    expect(body).toContain('one sitter per account today');
    expect(body).toContain('which isn&rsquo;t built yet');
  });

  it('tells visitors the demo costs them nothing to try', async () => {
    const body = await landingBody();
    expect(body).toContain('nothing to sign up for');
  });

  it('carries the relationship framing: care conversations for the sitter, an immediate answer for the owner', async () => {
    const body = await landingBody();
    // The workflow "texts" pair leads with the win, and the win is LATENCY, not an absolute about
    // what is left on the thread. Round 1 wrote "The only texts left are about the pets.", which
    // three readers called an overclaim: there is no messaging, no photo and no visit report in
    // this product, so every care conversation still happens on her phone — the thread loses the
    // booking part, it does not become about care.
    expect(body).toContain('The dates question stops being a text.');
    expect(body).not.toContain('The only texts left are about the pets.');
    // …and the page must NAME the category feature it doesn't have. Time To Pet's headline is the
    // visit report; a page arguing that software improves the client relationship, which never
    // mentions the one incumbent feature actually about the animal, argues against itself.
    expect(body).toContain('doesn&rsquo;t do visit reports or photos');
    // The sharpest sentence on the page, promoted out of the sum box (which a skimmer never
    // reaches) into the pair a skimmer actually reads.
    expect(body).toContain('They were about dates and prices, not about the dog.');
    // What's left is stated as a tendency, not an absolute: gate codes and "running late" still
    // arrive by text, so "what reaches you is a care question" was falsifiable in week one.
    expect(body).toContain('more of what&rsquo;s left is about the animal');
    expect(body).not.toContain('a care question');
    // The owner's half survives exactly once — restating it was the third pass at one idea.
    expect(body.match(/which dates you can take/g) ?? []).toHaveLength(1);
    expect(body).toContain('waiting on a text back');
    // The examples belong to the workflow pair; repeating them a screen later cheapened them.
    expect(body.match(/pills at six/g) ?? []).toHaveLength(1);
    // …and it must never read as instant confirmation. The sitter's yes is still the gate, and
    // the client's OWN screen says so too, so nobody tells their spouse it's booked at 11pm.
    expect(body).toContain('still pending until you say yes');
    expect(body).toContain('their own screen says awaiting confirmation until then');
    expect(body).toContain('goes out when you confirm, not when they press send');
    for (const lie of ['confirmed instantly', 'instant confirmation', 'confirms automatically'])
      expect(body, lie).not.toContain(lie);
  });

  it('sets the two business shapes side by side instead of correcting one with the other', async () => {
    const body = await landingBody();
    // Round 1 led the block with a boarding time-audit and made the walk/drop-in case its
    // CORRECTION ("the sum comes out somewhere else") — so a walker was invited to do arithmetic
    // that argues against the product and only then told it was the wrong arithmetic. The two
    // shapes are now peers, each in its own wf-pair.
    expect(body).toContain('Boarding and house sitting: a few long threads.');
    expect(body).toContain('Walks and drop-ins: a lot of short ones.');
    expect(body).not.toContain('the sum comes out somewhere else');
    // The strongest sentence in the block was buried third; it now leads the walker's pair.
    expect(body).toContain('a cancelled Wednesday, a swapped Thursday, an extra dog on Friday');
    // The pull-quote is gone: two hours a month set in display type is a small number in big
    // letters, which reads as an argument against the product. The multiplication survives only
    // demoted into prose, and the "these are illustrative" honesty device stays SCOPED to the
    // boarding shape it applies to.
    expect(body).not.toContain('class="wf-sum"');
    expect(body).not.toContain('do the sum yourself');
    expect(body).toContain('illustrative numbers rather than a measured finding');
  });

  it('says what actually reaches the sitter when a client changes a booking', async () => {
    const body = await landingBody();
    // VERIFIED: editBooking (server/lib/booking-ops.ts) sends NO email — the cancel path calls
    // sendCancellationNoticeToSitter, the edit path only re-stamps Status='pending' and
    // SyncPending=1 and pushes the moved/retitled event. Round 1's "they wait to be read between
    // walks" implied a notification that does not exist.
    expect(body).toContain('Nothing pings you');
    expect(body).toContain('goes back to pending and waits in your dashboard');
    expect(body).toContain('A change doesn&rsquo;t email you');
    // The old ambiguous clause read as "a change or a cancellation emails you"; only the second
    // one does, and only that one may be claimed.
    expect(body).not.toContain('and emails you either way');
    for (const lie of ['emails you when they change', 'notifies you of the change'])
      expect(body, lie).not.toContain(lie);
  });

  it('answers the weekly-regular question in the FAQ, where a decider will hit it', async () => {
    const body = await landingBody();
    // Two round-2 readers said half their book is standing weekly work, and that this decides
    // whether they can use the product at all — a caveat buried in the time-saved box is not
    // where that gets read.
    expect(body).toContain('Do you handle weekly regulars?');
    expect(body).toContain('no repeating booking yet, so each Tuesday is its own request');
    // Said once at full length (the FAQ) and once in a trimmed clause (the workflow block) — the
    // repetition of a full statement is what round 1 was pulled up on.
    expect(
      body.match(/no repeating booking yet, so each Tuesday is its own request/g) ?? [],
    ).toHaveLength(1);
    expect(body).toContain('a weekly Tuesday is booked one Tuesday at a time');
    // Nothing on the page may offer the thing the caveat says isn't built.
    for (const unbuilt of ['repeat weekly', 'recurring booking', 'standing booking'])
      expect(body.toLowerCase(), unbuilt).not.toContain(unbuilt);
  });

  it('discloses that time off is whole days, where the landing page claims time off', async () => {
    const body = await landingBody();
    // For a timed-walk book this is a bigger gap than repeats: a 10am dentist appointment costs
    // the whole Thursday. It was admitted only on /how-it-works; the wording tracks that page.
    expect(body).toContain('Time off is whole days only');
    expect(body).toContain('no way to close just the 10am walk');
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
