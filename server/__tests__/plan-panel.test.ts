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
/**
 * `PANEL` with every run of whitespace collapsed to one space. The gate conditions are long enough
 * that Prettier wraps them, and WHERE it wraps is not a property worth pinning — a pin that fails
 * because a clause moved to the next line is a pin that gets deleted for crying wolf.
 */
const FLAT = PANEL.replace(/\s+/g, ' ');
/** `PANEL_TEXT` collapsed the same way, for the wrapped conditions whose subject IS a literal. */
const FLAT_TEXT = PANEL_TEXT.replace(/\s+/g, ' ');
const BUSINESS = liveSource(readFileSync(join(ADMIN, 'sections', 'BusinessSection.tsx'), 'utf8'));
const RAW_APP = readFileSync(join(ADMIN, 'App.tsx'), 'utf8');
const APP = liveSource(RAW_APP);
/** Comments stripped, literals kept — for the one App.tsx pin whose subject is a key name. */
const APP_TEXT = liveSource(RAW_APP, { keepLiterals: true });

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
    // From the SETTINGS payload, not from `/config`: it is in hand before the panel paints (so no
    // control flashes on for a switched-off sitter while one request is in flight), it is the same
    // source the dashboard's own disabled banner already reads (`app/admin/App.tsx`), and it is the
    // only copy the panel now keeps.
    expect(PANEL).toContain('settings.disabled');
    expect(PANEL).not.toContain('config?.disabled');
  });

  it('no longer renders nothing — the status line survives every one of those conditions', () => {
    // This replaces the pin that required `return null` when any of the three failed. NFR-2: a
    // sitter whose plan lapsed, whose deployment stopped selling, or whose paid surface is
    // unreachable must still be told what she is on and when it runs out.
    expect(PANEL).not.toContain('return null');
  });

  it('keeps the offers behind the four conditions of the deployment and the account', () => {
    expect(FLAT).toContain('!origin || !sellingIsOn || settings.disabled || !pricing');
  });

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

  it('checks res.ok on BOTH calls, and throws on a non-2xx rather than reading the body', () => {
    // DELETING THE WHOLE `if (!res.ok)` BLOCK was green on either path. Three things went with it:
    // the server's own sentence was never shown, and a non-2xx body that happened to carry an https
    // `url` was navigated to. `res.ok` and `res.status` appeared nowhere in this file.
    expect(PANEL.match(/if \(!res\.ok\)/g)).toHaveLength(2);
    expect(PANEL.match(/throw new ApiError\(res\.status,/g)).toHaveLength(2);
    expect(PANEL.match(/body\.error \?\?/g)).toHaveLength(2);
  });

  it('never lets a CROSS-ORIGIN 401 or 403 sign her out of this dashboard', () => {
    // `isAuthExpired` (app/shared-ui/api.ts) reads any 401 or 403 as THIS session having expired,
    // and the dashboard's answer to that is to sign her out. But these two statuses come from
    // another worker judging its own credential: a shared secret rotated there, a tenant it does not
    // know, or a refusal of its own answers 401/403 with the sitter's dashboard session perfectly
    // good. So those two throw a plain Error carrying this panel's copy, which cannot reach
    // `isAuthExpired` at all — and the panel therefore holds no sign-out path and takes no
    // `handleError`. BOTH paths, counted, because one of them missing is the whole bug.
    expect(PANEL.match(/res\.status === 401 \|\| res\.status === 403/g)).toHaveLength(2);
    expect(PANEL.match(/throw new Error\(CHECKOUT_FAILED\)/g)).toHaveLength(2);
    expect(PANEL.match(/throw new Error\(PORTAL_FAILED\)/g)).toHaveLength(2);
    expect(PANEL).not.toContain('isAuthExpired');
    expect(PANEL).not.toContain('handleError');
  });

  it('sends her somewhere to cancel, and states no terms of its own', () => {
    // The old pin here said this panel promised NO cancellation control, which was true until
    // Story 10.3 and is not after it. What must stay true is that it promises it ELSEWHERE: the
    // control opens a hosted page, and the panel states no notice period, no refund position and
    // no proration of its own. Those belong on the terms page (FR-60, FR-64).
    expect(PANEL_TEXT).toContain('/portal');
    expect(PANEL_TEXT).not.toMatch(/refund/i);
    expect(PANEL_TEXT).not.toMatch(/pro-?rat/i);
    expect(PANEL_TEXT).not.toMatch(/notice period/i);
    expect(PANEL_TEXT).not.toMatch(/end of (?:the |your )?(?:billing )?period/i);
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

  it('matches the plan name rather than indexing the lookup blind', () => {
    // A `Plan` value this bundle does not know — a column that grew a third tier, a cached row from
    // a newer worker — must read as "No plan yet". `PLAN_NAMES[settings.plan]` on an unmatched key
    // is `undefined`, React renders nothing for it, and the line says only a date with no plan in
    // front of it. A render on a stale bundle/API pair must degrade, never throw and never lie.
    expect(FLAT_TEXT).toContain("settings.plan === 'solo' || settings.plan === 'pro'");
  });

  it('renders no date at all for a billedUntil that is not a non-empty string', () => {
    // `formatTimestamp` takes a string and calls `.replace` on it. A stale bundle against a newer
    // API — or the other way round — can hand this panel a null, a number or `''`, and a throw in
    // render takes her whole dashboard down rather than this one line.
    expect(FLAT_TEXT).toContain(
      "typeof settings.billedUntil === 'string' && settings.billedUntil !== ''",
    );
  });

  it('tells a switched-off account it is switched off, and says nothing about a date', () => {
    // Neither "paid through" nor "lapsed" is true of an account that cannot take a booking, and a
    // paid-through date printed beside a switched-off account reads as a promise. One line, the plan
    // name, and no controls. She would otherwise have read "lapsed": `planActive` is false for her
    // whatever the date says, because `isSoloActive` refuses a `DisabledAt` before it looks at one.
    expect(FLAT).toContain('{!settings.disabled && paidThrough !== null &&');
    expect(FLAT).toContain('{settings.disabled &&');
    expect(PANEL).toContain('ACCOUNT_OFF');
    expect(PANEL_TEXT).toMatch(/switched off/);
  });

  it('renders the stored instant through the dashboard’s own formatter', () => {
    // The column's shape is "YYYY-MM-DD HH:MM:SS" UTC, with no 'T' and no 'Z' — not something
    // every engine parses the same way unlabelled. Rendering the date is fine; DECIDING from it is
    // what AD-13 forbids, which is why `planActive` arrives already answered.
    expect(PANEL).toContain('formatTimestamp(settings.billedUntil)');
  });
});

describe('the Manage plan control', () => {
  it('renders on a LIVE plan with a billing account, and on neither other flag', () => {
    // `planActive` as well as `hasBillingAccount`, and that pairing is the ruling this gate was
    // changed by. `StripeCustomerId` is never cleared once written (`applyBillingEvent` COALESCEs
    // it), so "she has a billing account" outlives every subscription she ever had: on
    // `hasBillingAccount` alone, a sitter who cancelled kept a Manage-plan button pointed at a
    // subscription that no longer exists AND never saw Subscribe again. A live plan is the thing
    // there is something to manage.
    expect(PANEL).toContain('settings.hasBillingAccount');
    expect(FLAT).toContain(
      'origin !== null && settings.hasBillingAccount && settings.planActive && !settings.disabled',
    );
    // Not `pricing.subscribe`: that switch is about SELLING, and a sitter who already pays must
    // be able to change her card and cancel after a deployment stops taking new subscriptions.
    // Not `premium.assistant`: that is the tenant's entitlement, false for a Solo subscriber who
    // nonetheless has a plan to manage.
    expect(PANEL).not.toMatch(/canManage[^\n]*sellingIsOn/);
    expect(PANEL).not.toContain('premium?.assistant');
    expect(PANEL).not.toContain('premium.assistant');
    // And that the control is RENDERED on that condition, with the sitter's own word for it. A
    // mutation that deleted the button and left `canManage` computed-and-unused kept every other
    // pin here green, and neither typecheck nor lint objected.
    expect(PANEL).toMatch(/\{canManage && \(/);
    expect(PANEL_TEXT).toContain('Manage plan');
  });

  it('says beside it where a card is changed, and that this product never sees one', () => {
    // The assurance the Subscribe Hint carries for every sitter — "Payment is handled by Stripe on
    // their own page — we never see your card" — stopped reaching her the moment that Hint learned
    // to hide behind the Subscribe gate. It is the sentence that makes pressing an unfamiliar button
    // into a hosted page reasonable, and the sitter being sent there is the one who HAS a card on
    // file. Stated beside the control rather than in it, because the panel states no terms.
    expect(PANEL).toContain('MANAGE_ON_STRIPE');
    expect(PANEL_TEXT).toMatch(/never see your card/);
    expect(PANEL_TEXT).toMatch(/on Stripe’s own page/);
  });

  it('opens the portal with a POST carrying the admin Bearer, and no body', () => {
    expect(PANEL_TEXT).toContain('`${origin}/premium/billing/${session.slug}/portal`');
    expect(PANEL_TEXT).toContain('Authorization: `Bearer ${session.token}`');
    // An anchor carries no Authorization header, and there must not be one anywhere in this file.
    expect(PANEL_TEXT).not.toMatch(/<a\s[^>]*href/);
    // THE METHOD AND THE BODY, pinned distinctly. The `method: 'POST'` pin in the checkout case
    // above is satisfied by `startCheckout` alone, so a portal call switched to GET — or given a
    // body and a Content-Type — left this whole suite green. Anchored on the `/portal` template so
    // it is THIS call's init object being read, and closed on `});` so a `body:` line cannot hide
    // behind the headers.
    expect(PANEL_TEXT).toMatch(
      /\/portal`, \{\s*method: 'POST',\s*headers: \{ Authorization: `Bearer \$\{session\.token\}` \},\s*\}\);/,
    );
    // A Content-Type here would mean a body, and the server resolves which subscription this is
    // from the slug in the path and the credential in the header. One occurrence in the file, and
    // it belongs to the checkout.
    expect(PANEL_TEXT.match(/'Content-Type'/g)).toHaveLength(1);
  });

  it('reuses the checkout path’s own safety, rather than a second, looser copy of it', () => {
    // Two navigations built from a response body, and only one of them scheme-checked, is how the
    // second one navigates a sitter's TOP-LEVEL window to `javascript:`.
    expect(PANEL_TEXT.match(/url\.startsWith\('https:\/\/'\)/g)).toHaveLength(2);
    expect(PANEL_TEXT.match(/typeof url !== 'string'/g)).toHaveLength(2);
    expect(PANEL.match(/let navigated = false/g)).toHaveLength(2);
    expect(PANEL.match(/if \(!navigated\) setBusy\(null\)/g)).toHaveLength(2);
    expect(PANEL).toContain('e instanceof ApiError ? e.message : PORTAL_FAILED');
    expect(PANEL).not.toContain('e instanceof Error ? e.message');
  });

  it('hides Subscribe once her plan is LIVE, and shows it again when it lapses', () => {
    // The UI half of the double-subscription question, and `planActive` is the half of it that is
    // true only while there is a subscription to double. The other half is a server-side refusal on
    // the checkout route, which is the paid surface's to build: a UI is not a guard, because the
    // route is reachable with curl and an admin token.
    expect(FLAT).toContain('!offersHidden && !settings.planActive && pricing');
    // TWICE: the offers grid and the Hint above it. That Hint is Subscribe's own copy — "your
    // N-day free trial starts when you subscribe" — and on the offers condition alone it stayed on
    // screen beside the Manage plan button, promising a trial to a sitter who is already paying.
    expect(FLAT.match(/!offersHidden && !settings\.planActive && pricing/g)).toHaveLength(2);
  });

  it('offers Subscribe to a LAPSED sitter, old billing account or none', () => {
    // THE GATE CHANGE, stated as the case that moved it. `hasBillingAccount` appears nowhere in the
    // Subscribe condition: the processor's customer record survives a cancellation forever, so
    // gating on it hid the only control that could start a plan from exactly the sitter who wanted
    // one. Her old customer id is not a reason to refuse her a second subscription.
    expect(FLAT).toContain('!offersHidden && !settings.planActive && pricing');
    expect(FLAT).not.toContain('!offersHidden && !settings.hasBillingAccount');
  });

  it('keeps Subscribe and Manage mutually exclusive BY CONSTRUCTION', () => {
    // Not by two conditions that happen to disagree today: `planActive` decides, negated on one
    // side and plain on the other, so there is no state in which both render and none in which a
    // paying sitter is offered a second subscription.
    expect(FLAT).toContain('!settings.planActive && pricing');
    expect(FLAT).toContain('settings.hasBillingAccount && settings.planActive');
  });

  it('gives a switched-off account neither control', () => {
    // Both gates name it, from the settings payload: Subscribe through `offersHidden`, Manage in
    // its own condition. A disabled account cannot take a booking, so neither asking her for a card
    // nor sending her to a portal is something this panel should do — and the dashboard's own
    // banner has already told her why.
    expect(FLAT).toContain('!origin || !sellingIsOn || settings.disabled || !pricing');
    expect(FLAT).toContain('settings.planActive && !settings.disabled');
  });

  it('says one sentence when the paid surface is not there, and offers no retry', () => {
    expect(PANEL).toContain('PORTAL_UNAVAILABLE');
    expect(PANEL_TEXT).toMatch(/unavailable right now/);
    // And that it is RENDERED, on the narrower condition. A mutation that deleted the markup and
    // left the constant standing kept both pins above green — a sentence declared and never shown
    // is the failure this case exists for. The condition is narrower than the spec's literal
    // `origin === null` on purpose, and in the same two ways the control above it is: a sitter who
    // never subscribed, and a sitter whose plan has lapsed, are not told that changing a plan they
    // do not have is unavailable. It says what the MANAGE control would have said, so it renders
    // for exactly the sitter that control was for, minus the origin.
    expect(FLAT).toContain('settings.hasBillingAccount && settings.planActive && origin === null');
    // AND on the request having FINISHED. `origin` is null until the `/config` effect resolves and
    // `settings` is already in hand when the panel paints, so without this every paying sitter was
    // told "changing your plan is unavailable right now" on every dashboard load, for as long as
    // that request took. Absence-until-loaded is harmless for a control; a positive false sentence
    // is not.
    expect(FLAT).toContain(
      'configLoaded && settings.hasBillingAccount && settings.planActive && origin === null',
    );
    // A `/config` that FAILED is not "not asked yet": it is a deployment whose paid surface this
    // panel cannot reach, which is exactly when the notice belongs on screen. So the flag flips on
    // both arms of the effect — a `setConfigLoaded` only in the success arm would trade the flash
    // for silence in the one state the sentence is true.
    expect(PANEL.match(/setConfigLoaded\(true\)/g)).toHaveLength(2);
    expect(PANEL).toMatch(/\.catch\([\s\S]{0,160}setConfigLoaded\(true\)/);
    // No retry, no spinner, no second control: her booking page, her clients and the rest of her
    // dashboard are unaffected, which is the whole of NFR-2's claim.
    expect(PANEL_TEXT).not.toMatch(/\bretry\b/i);
    expect(PANEL).not.toContain('setInterval');
  });
});

describe('plan state survives a mid-session settings re-read', () => {
  it('merges the plan fields beside calendar, into both the state and the saved snapshot', () => {
    // `refreshCalendarStatus` re-reads the WHOLE settings payload and keeps one field of it, because
    // it must not blow away a sitter's staged edits elsewhere on the page. The plan fields are not
    // staged edits — they are read-only and change only on the server — so discarding them meant the
    // panel's gates held on a fresh load and then went stale for the rest of the session: a sitter
    // who subscribed in the hosted checkout and came back to a dashboard left open kept being
    // offered Subscribe. TWO sites, and the snapshot is the one that is easy to forget: merging into
    // the state alone would make the page look dirty and put the save bar up on its own.
    expect(APP.match(/\.\.\.planFieldsOf\(fresh\)/g)).toHaveLength(2);
  });

  it('names the five fields explicitly, rather than spreading the fresh payload', () => {
    // Field by field, which is the same discipline `save()` uses for the PUT body: a field added to
    // `Settings` does not silently join this merge, and spreading `fresh` wholesale would be the
    // staged-edit bug `refreshCalendarStatus` exists to avoid.
    for (const field of ['plan:', 'billedUntil:', 'planActive:', 'hasBillingAccount:']) {
      expect(APP, field).toContain(`  ${field} s.${field.slice(0, -1)},`);
    }
    // `stripeCustomerId` is spread conditionally, because the key is ABSENT — not null — for a
    // `pawsa_` credential, and turning that absence into an `undefined` would make the client type
    // lie about the payload it mirrors.
    expect(APP_TEXT).toContain("'stripeCustomerId' in s");
  });
});
