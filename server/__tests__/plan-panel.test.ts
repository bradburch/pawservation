import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { liveSource } from './helpers/live-source';

/**
 * THE PLAN PANEL'S PROMISES, pinned at its own source.
 *
 * There is no DOM harness for the admin bundle in this suite — every test here is a worker or route
 * test, and UI promises are pinned the way `data-export.test.ts` pins the export panel's copy: by
 * reading the component and asserting on what it contains. Ugly, and honest: the alternative is
 * standing up jsdom and a component runner as new infrastructure for a handful of assertions, and a
 * promise nobody checks is how the gate silently becomes the wrong one.
 *
 * Every assertion below reads `liveSource` (`helpers/live-source.ts`) rather than the raw file:
 * three mutation probes survived this file by deleting the real code and leaving the pinned string
 * in a comment. `keepLiterals` is used only where the SUBJECT of the pin is itself a literal — the
 * request method, the URL the checkout is built from — because stripping those makes the assertion
 * unsatisfiable rather than stricter.
 */

const ADMIN = join(import.meta.dirname, '..', '..', 'app', 'admin');
const RAW = readFileSync(join(ADMIN, 'PlanPanel.tsx'), 'utf8');
/** Executable structure only: no comments, no string or template literals. */
const PANEL = liveSource(RAW);
/** Comments stripped, literals kept — for the pins whose subject is a literal. */
const PANEL_TEXT = liveSource(RAW, { keepLiterals: true });
const BUSINESS = liveSource(readFileSync(join(ADMIN, 'sections', 'BusinessSection.tsx'), 'utf8'));

describe('the plan panel gates on the DEPLOYMENT, not on the entitlement', () => {
  it('renders on premium.origin and never on premium.assistant', () => {
    expect(PANEL).toContain('premium?.origin');
    // `assistant` is false for exactly the sitter who has not bought yet — i.e. for everyone this
    // panel exists for. The audit card's gate (ServicesSection) is a different condition in KIND:
    // `origin` is a property of the deployment, `assistant` of the tenant. Do not "fix" this into a
    // match with that one. Asserted over executable text, so the docblock is free to explain the
    // difference in the words a reader needs.
    expect(PANEL).not.toContain('premium?.assistant');
    expect(PANEL).not.toContain('premium.assistant');
  });

  it('also requires pricing.subscribe, the flag that says a checkout route exists', () => {
    // `PREMIUM_ORIGIN` is already set in production, so `origin` alone is true on the day this
    // merges and every Subscribe press would 404 against a checkout route Story 10.2 has not
    // shipped. `PLAN_SUBSCRIBE` is the deployment's own answer to "is selling switched on".
    expect(PANEL).toContain('pricing?.subscribe === true');
  });

  it('never offers a plan to a switched-off sitter', () => {
    // A disabled account cannot take a booking; asking it for a card is worse than showing nothing.
    expect(PANEL).toContain('config?.disabled === true');
  });

  // Replaced in the next commit; the panel no longer returns null at all, and its replacement pin
  // lands with the Manage control.
  it.todo('renders nothing unless all three hold');

  it('starts checkout with a fetch carrying the admin Bearer, never an anchor', () => {
    expect(PANEL_TEXT).toContain('/premium/billing/');
    expect(PANEL_TEXT).toContain('Authorization: `Bearer ${session.token}`');
    expect(PANEL_TEXT).toContain("method: 'POST'");
    // An anchor carries no Authorization header — `app/shared-ui/api.ts`'s exportCsv docblock is
    // where this repo already says so. Whitespace-tolerant: `<a  href` and `<a\n href` are anchors.
    expect(PANEL_TEXT).not.toMatch(/<a\s[^>]*href/);
  });

  it('builds the checkout URL from the published origin, with the whole path', () => {
    expect(PANEL_TEXT).toContain('`${origin}/premium/billing/${session.slug}/checkout`');
  });

  it('sends the plan and the interval as the body', () => {
    expect(PANEL).toContain('JSON.stringify({ plan: offer.key, interval: offer.interval })');
  });

  it('navigates the TOP-LEVEL window, because a hosted checkout refuses to be framed', () => {
    expect(PANEL).toContain('window.top');
    // `window.top!` asserts away two real states: null in a detached frame, and a SecurityError on
    // the property read when the dashboard is framed cross-origin.
    expect(PANEL).not.toContain('window.top!');
    expect(PANEL).toContain('window.top ?? window');
    expect(PANEL_TEXT).toContain("window.open(url, '_blank', 'noopener')");
  });

  it('navigates only to an https URL it was actually given a string for', () => {
    // `if (!url)` admits any truthy non-string, and no scheme check at all admits `javascript:`.
    expect(PANEL_TEXT).toContain("typeof url !== 'string'");
    expect(PANEL_TEXT).toContain("url.startsWith('https://')");
  });

  it('keeps the buttons disabled once the top window is navigating', () => {
    // `location.assign` does not unload synchronously; a second press in that gap starts a second
    // checkout session for one sitter.
    expect(PANEL).toContain('let navigated = false');
    expect(PANEL).toMatch(/if \(!navigated\) setBusy\(null\)/);
  });

  it('renders only its own copy or an ApiError message, never the browser’s', () => {
    // `e instanceof Error ? e.message` puts "Failed to fetch" / "NetworkError when attempting to
    // fetch resource" in the sitter's dashboard as if it were a plan problem.
    expect(PANEL).toContain('e instanceof ApiError ? e.message : CHECKOUT_FAILED');
    expect(PANEL).not.toContain('e instanceof Error ? e.message');
  });

  it('promises no cancellation control, because there is not one yet', () => {
    // FR-62's Manage-plan surface is Story 10.3. Promising it at the moment she is asked for a card
    // is the one place the promise is expensive.
    expect(PANEL_TEXT).not.toContain('cancel from here');
    expect(PANEL_TEXT).not.toMatch(/you can cancel/i);
  });

  it('states the figures from the published pricing rather than restating them', () => {
    for (const field of ['soloMonthly', 'proMonthly', 'proAnnual', 'trialDays']) {
      expect(PANEL_TEXT).toContain(`pricing.${field}`);
    }
  });

  it('types no plan figure, no dollar amount and no trial length of its own', () => {
    // The figures are a property of the PRODUCT and are published on `/config`. A number typed here
    // is a second copy that cannot be repriced, and would go stale silently — the panel would keep
    // saying $29 long after the price moved. Scoped to price-shaped contexts: a bare `15` in a
    // slice index or an HTTP status is not a price, and a regex that says otherwise is one refactor
    // away from being deleted for crying wolf.
    expect(PANEL_TEXT).not.toMatch(/\$\s*\d/);
    expect(PANEL_TEXT).not.toMatch(
      /\b\d+\s*(?:-day|\/month|\/mo\b|\/year|\/yr\b| a month| a year)/,
    );
    expect(PANEL_TEXT).not.toMatch(/\b(?:15|29|290|30)\b\s*(?:dollars|a month|a year|per month)/i);
  });
});

describe('where the panel sits', () => {
  it('is rendered by BusinessSection, after TokensPanel', () => {
    expect(BUSINESS).toContain('<PlanPanel');
    expect(BUSINESS.indexOf('<PlanPanel')).toBeGreaterThan(BUSINESS.indexOf('<TokensPanel'));
  });

  it('is handed the settings payload it reads plan state from', () => {
    // The dashboard fetches `/api/:slug/admin/settings` once per load and BusinessSection already
    // holds it — so plan status costs the panel zero extra requests, and is already loaded before
    // the panel paints. A panel that fetched it again would be a second authenticated read for
    // four fields the page has in hand.
    expect(BUSINESS).toMatch(/<PlanPanel[^>]*settings=\{settings\}/);
  });
});

describe('the plan status line', () => {
  it('reads the three status fields from the settings payload, and no others', () => {
    // Through the NAME LOOKUP, not a bare `settings.plan`: `toContain('settings.plan')` is
    // satisfied by `settings.planActive` on the line below it, so the plan-name read could be
    // deleted outright and this case would stay green on the strength of a different field.
    expect(PANEL).toContain('PLAN_NAMES[settings.plan]');
    expect(PANEL).toContain('settings.billedUntil');
    expect(PANEL).toContain('settings.planActive');
    // The processor's ids are not status. Neither is needed to say what she is on and until when,
    // and both would be ids handed to a browser for nothing.
    expect(PANEL).not.toContain('stripeSubscriptionId');
    expect(PANEL).not.toContain('settings.stripeCustomerId');
  });

  it('says all three states in words, not just in fields', () => {
    // PANEL strips string and template literals, so every pin above is blind to the text a sitter
    // actually reads — the status could render three empty strings and stay green. PANEL_TEXT is
    // the tool that sees it (comments are still stripped, so a docblock cannot satisfy this).
    // `null` is a sitter who never subscribed and must not read as an error or as "free"; and the
    // live/lapsed pair is the only place `planActive` reaches her, so both words are pinned.
    for (const word of ['No plan yet', 'paid through', 'lapsed']) {
      expect(PANEL_TEXT).toContain(word);
    }
  });

  it('renders the stored instant through the dashboard’s own formatter', () => {
    // The column's shape is "YYYY-MM-DD HH:MM:SS" UTC, with no 'T' and no 'Z' — not something
    // every engine parses the same way unlabelled. Rendering the date is fine; DECIDING from it is
    // what AD-13 forbids, which is why `planActive` arrives already answered.
    expect(PANEL).toContain('formatTimestamp(settings.billedUntil)');
  });
});
