import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_LAPSED, writeFailureMessage } from '../../app/admin/shared.js';
import { ApiError, isAuthExpired, isPlanLapsed } from '../../app/shared-ui/api.js';
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

/**
 * The source span of every JSX block in `FLAT` that opens with `needle`, found by matching braces
 * from it. This is what lets a pin say "that markup is not INSIDE this condition" rather than
 * "that markup comes before this condition" — position in the file is not the claim, nesting is,
 * and the Subscribe Hint legitimately opens an offers block above the status line.
 */
function blocksOpeningWith(needle: string): [number, number][] {
  const spans: [number, number][] = [];
  for (let at = FLAT.indexOf(needle); at !== -1; at = FLAT.indexOf(needle, at + 1)) {
    let depth = 0;
    let end = at;
    for (; end < FLAT.length; end += 1) {
      if (FLAT[end] === '{') depth += 1;
      else if (FLAT[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push([at, end]);
  }
  return spans;
}
const RAW_APP = readFileSync(join(ADMIN, 'App.tsx'), 'utf8');
const APP = liveSource(RAW_APP);
/** `APP` collapsed like `FLAT`, for the banner pin that binds condition, markup and class. */
const FLAT_APP = APP.replace(/\s+/g, ' ');
/** Comments stripped, literals kept — for the one App.tsx pin whose subject is a key name. */
const APP_TEXT = liveSource(RAW_APP, { keepLiterals: true });
/**
 * `app/shared-ui/api.ts`, literals kept: the 402 PREDICATE lives there, beside `isAuthExpired`,
 * because it is status logic and both dashboards' error routers read it.
 */
const API_TEXT = liveSource(
  readFileSync(join(import.meta.dirname, '..', '..', 'app', 'shared-ui', 'api.ts'), 'utf8'),
  { keepLiterals: true },
);
/**
 * `app/admin/shared.ts`, literals kept: the lapse SENTENCES and the write-failure mapper live HERE
 * and not in `api.ts`, because `api.ts` is in the EMBED bundle's import graph — the dashboard's
 * "your dashboard is read-only" sentence was shipping to every booking widget (verified in
 * `dist/assets/icons-*.js`). `shared.ts` is the admin app's own module and nothing under
 * `app/embed` imports it. Still not `App.tsx`: `handle` is not the only place a write can fail —
 * TokensPanel keeps its failures beside the control that caused them and SetupWizard is a modal
 * with no `handleError` prop at all, so a constant private to `App.tsx` could only have been copied.
 */
const SHARED_TEXT = liveSource(readFileSync(join(ADMIN, 'shared.ts'), 'utf8'), {
  keepLiterals: true,
});
/** The three write surfaces that do NOT share `handle`, collapsed like `FLAT` — their sinks are long
 *  enough that Prettier wraps them, and where it wraps is not the claim. */
const TOKENS = liveSource(readFileSync(join(ADMIN, 'TokensPanel.tsx'), 'utf8')).replace(
  /\s+/g,
  ' ',
);
const RAW_WIZARD = readFileSync(join(ADMIN, 'SetupWizard.tsx'), 'utf8');
const WIZARD = liveSource(RAW_WIZARD).replace(/\s+/g, ' ');
/** Literals kept, for the one wizard sink that lives INSIDE a template literal. */
const WIZARD_TEXT = liveSource(RAW_WIZARD, { keepLiterals: true }).replace(/\s+/g, ' ');
const BACKFILL = liveSource(readFileSync(join(ADMIN, 'CalendarBackfillPanel.tsx'), 'utf8')).replace(
  /\s+/g,
  ' ',
);

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
    // merges and every Subscribe press would 404 against a checkout route that is not yet
    // answering. `PLAN_SUBSCRIBE` is the deployment's own answer to "is selling switched on".
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

  it('keeps the status line OUTSIDE every condition — pinned structurally', () => {
    // THE PIN THIS REPLACES was `not.toContain('return null')`, which is a check on one SPELLING of
    // one regression. Two independent probes hid the whole status line and stayed green: one wrapped
    // the status `<p>` in `{!offersHidden && ( … )}`, the other put `return <></>` above the real
    // return. `return false`, `return undefined` and a wrapper all evaded it too. The rule is that
    // a sitter whose plan lapsed, whose deployment stopped selling, whose account is switched off
    // or whose paid surface is unreachable is still told what she is on — so what has to be pinned
    // is the POSITION of that markup, not the absence of one keyword.
    const statusAt = FLAT.indexOf('<strong>{planName}</strong>');
    expect(statusAt).toBeGreaterThan(-1);

    // Not nested inside any `{!offersHidden …}` block, wherever in the markup that block sits — the
    // Hint legitimately opens one above the status line, so ordering alone would not say this.
    for (const [start, end] of blocksOpeningWith('{!offersHidden')) {
      expect(statusAt < start || statusAt > end, `offers block ${start}..${end}`).toBe(true);
    }
    // Nor inside the switched-off block, which withholds the DATE from her and not her plan's name.
    for (const [start, end] of blocksOpeningWith('{settings.disabled')) {
      expect(statusAt < start || statusAt > end, `disabled block ${start}..${end}`).toBe(true);
    }

    // And reached by the component's single JSX return, with no early exit of any spelling above it.
    // The optional `\(?` closes a gap a parenthesised early return evaded: `return (<></>);` and
    // `return (null);` both read as a plain `return` followed by `(` to a naive reader but are
    // exactly the kind of hidden exit this pin exists to catch, and neither is the real, final
    // `return (` that opens the component's JSX (that one is excluded by `returnAt` itself, since
    // the slice below stops before it).
    const returnAt = FLAT.lastIndexOf('return (');
    expect(statusAt).toBeGreaterThan(returnAt);
    expect(FLAT.slice(0, returnAt)).not.toMatch(/\breturn\s*\(?\s*(?:null|undefined|false|<)/);
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
    // AND THAT BOTH NAVIGATIONS GO THROUGH IT. Every assertion above reads the helper's DEFINITION;
    // replacing either call site with `window.location.assign(url)` left the helper standing unused
    // and the suite green, with both navigations happening inside the dashboard's own iframe — which
    // is the exact failure the helper exists to prevent, since Stripe's hosted pages set their own
    // `frame-ancestors` and will not render there. The definition reads `(url: string)`, so this
    // count is the two CALLS.
    expect(PANEL.match(/openAtTopLevel\(url\)/g)).toHaveLength(2);
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

  it('checks res.ok on all THREE calls, and throws on a non-2xx rather than reading the body', () => {
    // DELETING THE WHOLE `if (!res.ok)` BLOCK was green on either path. Three things went with it:
    // the server's own sentence was never shown, and a non-2xx body that happened to carry an https
    // `url` was navigated to. `res.ok` and `res.status` appeared nowhere in this file.
    //
    // THREE `!res.ok` blocks: the checkout, the portal, and the sync — `syncWithStripe` is the third
    // occurrence. The three are NAMED, as path templates on the published origin, by the "makes
    // exactly three calls" case below; an integer here without that name beside it is what let the
    // portal's addition break a green suite.
    expect(PANEL.match(/if \(!res\.ok\)/g)).toHaveLength(3);
    // TWO `ApiError(res.status, …)`: the checkout and the portal, which relay the server's sentence
    // for every status but 401/403. The sync is NOT a third: it relays one status only, and writes
    // it as the literal `new ApiError(409, …)` — pinned by name in the sync's own case — so that
    // no other status's body can ever reach the screen through it.
    expect(PANEL.match(/throw new ApiError\(res\.status,/g)).toHaveLength(2);
    // THREE `body.error ??`: all three read the server's sentence with this panel's own as the
    // fallback — the sync on its one relayed status.
    expect(PANEL.match(/body\.error \?\?/g)).toHaveLength(3);
  });

  it('never lets a CROSS-ORIGIN 401 or 403 sign her out of this dashboard', () => {
    // `isAuthExpired` (app/shared-ui/api.ts) reads any 401 or 403 as THIS session having expired,
    // and the dashboard's answer to that is to sign her out. But these two statuses come from
    // another worker judging its own credential: a shared secret rotated there, a tenant it does not
    // know, or a refusal of its own answers 401/403 with the sitter's dashboard session perfectly
    // good. So those two throw a plain Error carrying this panel's copy, which cannot reach
    // `isAuthExpired` at all — and the panel therefore holds no sign-out path and takes no
    // `handleError`. TWO paths, counted — the checkout and the portal — because one of them missing
    // is the whole bug. The sync has NO such line, and that is not the bug: it throws a plain Error
    // for every status but 409, so a 401 or 403 there cannot become an ApiError to begin with. Its
    // own case pins that shape; a `401 || 403` line appearing in the sync would mean some OTHER
    // status had started reaching `ApiError`, and this count would say so.
    expect(PANEL.match(/res\.status === 401 \|\| res\.status === 403/g)).toHaveLength(2);
    expect(PANEL.match(/throw new Error\(CHECKOUT_FAILED\)/g)).toHaveLength(2);
    expect(PANEL.match(/throw new Error\(PORTAL_FAILED\)/g)).toHaveLength(2);
    expect(PANEL).not.toContain('isAuthExpired');
    expect(PANEL).not.toContain('handleError');
  });

  it('sends her somewhere to cancel, and states no terms of its own', () => {
    // The old pin here said this panel promised NO cancellation control, which was true before
    // the Manage-plan control existed and is not now. What must stay true is that it promises it
    // ELSEWHERE: the control opens a hosted page, and the panel states no notice period, no refund
    // position and no proration of its own. Those belong on the terms page.
    expect(PANEL_TEXT).toContain('/portal');
    // ELSEWHERE is the half that was unpinned: a "Cancel plan" button added to this panel kept every
    // assertion here green, and an in-app cancellation control is a cancellation flow this product
    // would then own — the terms, the proration and the refund position with it.
    expect(PANEL_TEXT).not.toMatch(/Cancel (?:plan|subscription)/i);
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
    // AND ONE POSITIVE ASSERTION, because every line above this one is green against an EMPTY file.
    // Measured: stubbing the panel to `return null` failed 22 of this file's cases and left three
    // standing, of which this was one. A wholly-negative case is not harmful beside positive pins,
    // but it is the one assertion here that would pass with the production code deleted.
    expect(PANEL_TEXT).toMatch(/pricing\.(?:soloMonthly|proMonthly|proAnnual|trialDays)/);
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
    // seven fields the page has in hand.
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

  it('hangs the live word on planActive and the lapsed word on its negation', () => {
    // SWAPPING THE TWO WORDS was green: a paying sitter read "lapsed" and a lapsed one read "paid
    // through". The case above asserts only that both words are PRESENT, and no text pin can see
    // which branch they hang off — so the ternary is pinned verbatim instead. This is the one
    // sentence `planActive` reaches her through, and the structural ceiling of a file with no DOM
    // harness lands exactly on it.
    expect(FLAT_TEXT).toContain("settings.planActive ? 'paid through' : 'lapsed'");
  });

  it('prints no date at all for a sitter who has none', () => {
    // DROPPING THE `paidThrough !== null &&` GUARD was green, and a sitter who never subscribed read
    // "No plan yet — lapsed null".
    expect(FLAT).toContain('paidThrough !== null &&');
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
    // what the one-expression rule forbids, which is why `planActive` arrives already answered.
    expect(PANEL).toContain('formatTimestamp(settings.billedUntil)');
  });
});

describe('the Manage plan control', () => {
  it('renders on a BILLING ACCOUNT, live plan or lapsed, and on neither other flag', () => {
    // `hasBillingAccount` WITHOUT `planActive`, which reverses the pairing this case used to pin.
    // The sitter whose card died is in the processor's dunning: the subscription still exists, the
    // retries are still running, and the Billing Portal is the only place she can put a working
    // card on it — so `planActive` in this gate locked her out of the fix at exactly the moment
    // she needed it. `hasBillingAccount` is the honest question for this control, because it asks
    // whether there is an account at the processor to open at all.
    expect(PANEL).toContain('settings.hasBillingAccount');
    expect(FLAT).toContain('origin !== null && settings.hasBillingAccount && !settings.disabled');
    // NOT the old pairing. Re-adding `planActive` here is a silent regression: the control simply
    // stops rendering for the one sitter it was reopened for.
    expect(FLAT).not.toContain('settings.hasBillingAccount && settings.planActive');
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
    expect(PANEL_TEXT).toMatch(/never see your card/);
    expect(PANEL_TEXT).toMatch(/on Stripe’s own page/);
    // AND RENDERED, inside the Manage block. Deleting the markup and leaving the constant standing
    // kept both pins above green — a sentence declared and never shown is the failure, and this file
    // has already lost that exact mutation twice. `{MANAGE_ON_STRIPE}` is the interpolation, never
    // the declaration.
    expect(FLAT).toContain('{MANAGE_ON_STRIPE}');
    const assuranceAt = FLAT.indexOf('{MANAGE_ON_STRIPE}');
    const manage = blocksOpeningWith('{canManage');
    expect(manage).toHaveLength(1);
    expect(assuranceAt).toBeGreaterThan(manage[0][0]);
    expect(assuranceAt).toBeLessThan(manage[0][1]);
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

  it('shows each state exactly the controls that state has something to press', () => {
    // THE TWO GATES ARE NO LONGER ONE FLAG NEGATED. They are two different questions — "is there
    // an account at the processor" and "is there no live plan" — and the five states a sitter can
    // be in (deployment selling, origin published) fall out of that pair:
    //
    //   never subscribed (no account, no live plan) → SUBSCRIBE alone
    //   live plan (account, live plan)              → MANAGE alone
    //   lapsed with an account (account, no plan)   → BOTH, plus the line below
    //   cancelled-in-grace (account, still live)    → MANAGE alone, as the live plan is
    //   disabled                                    → NEITHER
    //
    // So exclusivity now holds through the COMBINATION and not through one flag: Manage is hidden
    // from the sitter with no billing account, Subscribe from the sitter whose plan is live, and
    // the one state both answer is the lapsed sitter who has an account — which is deliberate,
    // because fixing a card and starting a new plan are both real answers for her.
    expect(FLAT).toContain('origin !== null && settings.hasBillingAccount && !settings.disabled');
    expect(FLAT).toContain('!offersHidden && !settings.planActive && pricing');
    // A PAYING SITTER IS STILL NEVER OFFERED A SECOND SUBSCRIPTION — `planActive` is plain on the
    // Subscribe side and appears nowhere in the Manage gate, so nothing here re-opens the
    // double-subscription question the server-side refusal on the checkout route answers.
    expect(FLAT).not.toContain('settings.hasBillingAccount && settings.planActive');
  });

  it('gives a switched-off account neither control', () => {
    // Both gates name it, from the settings payload: Subscribe through `offersHidden`, Manage in
    // its own condition. A disabled account cannot take a booking, so neither asking her for a card
    // nor sending her to a portal is something this panel should do — and the dashboard's own
    // banner has already told her why. This is the one state the gate ruling did NOT widen: a
    // switched-off sitter has a billing account and a lapsed plan too, and she still gets nothing.
    expect(FLAT).toContain('!origin || !sellingIsOn || settings.disabled || !pricing');
    expect(FLAT).toContain('settings.hasBillingAccount && !settings.disabled');
  });

  it('tells the lapsed sitter what the two controls in front of her are for', () => {
    // The state that did not exist before the ruling: two controls at once, one of which sends her
    // to a page that belongs to another company. One line says which is which — fix a card or read
    // an invoice under Manage plan, start again under Subscribe — and it states no price, no card
    // form, no invoice and no cancellation control of this product's own, which the whole-file
    // pins above already enforce over this constant too.
    expect(PANEL).toContain('LAPSED_WITH_ACCOUNT');
    // PHRASES ONLY THIS SENTENCE HAS. `Manage plan` alone is the button's own label and `lapsed` is
    // the status line's word, so either would stay green against a constant emptied to `''` —
    // which is a sentence declared and never read, the mutation this file has already lost twice.
    expect(PANEL_TEXT).toMatch(/under Manage plan/);
    expect(PANEL_TEXT).toMatch(/start a new plan/);
    // RENDERED, and rendered ONLY where both controls are. A line that appears beside Manage alone
    // tells a paying sitter her plan has lapsed; beside Subscribe alone it points her at a button
    // that is not on the page. Both halves of the condition, and the markup that uses it.
    expect(FLAT).toContain(
      'const bothControls = canManage && !offersHidden && !settings.planActive',
    );
    expect(FLAT).toContain('{bothControls && ');
  });

  it('says one sentence when the paid surface is not there, and offers no retry', () => {
    expect(PANEL).toContain('PORTAL_UNAVAILABLE');
    expect(PANEL_TEXT).toMatch(/unavailable right now/);
    // And that it is RENDERED, on the narrower condition. A mutation that deleted the markup and
    // left the constant standing kept both pins above green — a sentence declared and never shown
    // is the failure this case exists for. The condition is narrower than the spec's literal
    // `origin === null` on purpose: a sitter who never subscribed is not told that changing a plan
    // she does not have is unavailable. It says what the MANAGE control would have said, so it
    // tracks that control exactly, minus the origin — which is why `planActive` left this
    // condition in the same ruling that took it out of the gate above.
    expect(FLAT).toContain('settings.hasBillingAccount && origin === null');
    // AND on the request having FINISHED. `origin` is null until the `/config` effect resolves and
    // `settings` is already in hand when the panel paints, so without this every paying sitter was
    // told "changing your plan is unavailable right now" on every dashboard load, for as long as
    // that request took. Absence-until-loaded is harmless for a control; a positive false sentence
    // is not.
    expect(FLAT).toContain('configLoaded && settings.hasBillingAccount && origin === null');
    // A `/config` that FAILED is not "not asked yet": it is a deployment whose paid surface this
    // panel cannot reach, which is exactly when the notice belongs on screen. So the flag flips on
    // both arms of the effect — a `setConfigLoaded` only in the success arm would trade the flash
    // for silence in the one state the sentence is true.
    expect(PANEL.match(/setConfigLoaded\(true\)/g)).toHaveLength(2);
    expect(PANEL).toMatch(/\.catch\([\s\S]{0,160}setConfigLoaded\(true\)/);
    // No retry, no spinner, no second control: her booking page, her clients and the rest of her
    // dashboard are unaffected, which is the whole of the claim: nothing on the dashboard depends
    // on the paid surface being up.
    expect(PANEL_TEXT).not.toMatch(/\bretry\b/i);
    expect(PANEL).not.toContain('setInterval');
  });
});
describe('the Sync with Stripe control', () => {
  it('makes exactly three calls to the published origin, and these are their paths', () => {
    // THE NAME EVERY COUNT IN THIS FILE REFERS TO. Four pins above count the checkout/portal
    // machinery — `if (!res.ok)`, `throw new ApiError(res.status,`, `body.error ??`, the 401/403
    // refusal — and each is 3 because a third call reuses it. An integer without a name beside it
    // is what let the portal's addition break a green suite: this case is the name. A fourth
    // template, or a second origin, fails here before it fails anywhere else.
    for (const path of ['checkout', 'portal', 'resync']) {
      expect(PANEL_TEXT).toContain(`\`\${origin}/premium/billing/\${session.slug}/${path}\``);
    }
    expect(PANEL_TEXT.match(/\/premium\/billing\//g)).toHaveLength(3);
  });

  it('renders beside Manage plan, on canManage and never on planCurrent', () => {
    // The same gate as Manage plan, and INSIDE its block — not a second `{canManage` block and not a
    // narrower one. Not `planCurrent === false`, though a lapsed row is the usual case: a comped
    // ex-subscriber is `planCurrent: true` and can hold a row that stopped matching the processor
    // too, and the route it presses reads `planCurrent` for nothing. The cost is a button a healthy
    // row sees as well; the hint beneath says when to press it. Containment by brace matching, the
    // way the assurance line is pinned, because position in the file is not the claim.
    const manage = blocksOpeningWith('{canManage');
    expect(manage).toHaveLength(1);
    const [start, end] = manage[0];
    const buttonAt = FLAT.indexOf('void syncWithStripe()');
    expect(buttonAt).toBeGreaterThan(start);
    expect(buttonAt).toBeLessThan(end);
    const hintAt = FLAT.indexOf('{SYNC_HINT}');
    expect(hintAt).toBeGreaterThan(start);
    expect(hintAt).toBeLessThan(end);
    expect(FLAT.slice(start, buttonAt)).not.toContain('planCurrent');
    // The whole opening tag, not the label alone: every button in this panel is
    // `disabled={busy !== null}`, so a sync in flight disables Subscribe and Manage plan and a
    // checkout or portal call in flight disables this one. Dropping the attribute leaves the guard
    // below making a second press a no-op — a button that looks live and is not.
    expect(FLAT_TEXT).toContain(
      '<button type="button" disabled={busy !== null} onClick={() => void syncWithStripe()}> ' +
        "{busy === 'sync' ? 'Syncing…' : 'Sync with Stripe'}",
    );
    // The handler's own guard, the third of three: a press with no origin, or with another call
    // in flight, does nothing — exactly as the other two.
    expect(PANEL.match(/if \(busy \|\| !origin\) return;/g)).toHaveLength(3);
  });

  it('syncs with a POST carrying the admin Bearer, no body, and no Content-Type', () => {
    // Anchored on the `/resync` template and closed on `});`, the way the portal pin is, so it is
    // THIS call's init object being read and a `body:` line cannot hide behind the headers. The
    // route reads no body — it resolves everything from the slug and the credential.
    expect(PANEL_TEXT).toMatch(
      /\/resync`, \{\s*method: 'POST',\s*headers: \{ Authorization: `Bearer \$\{session\.token\}` \},\s*\}\);/,
    );
    // Still ONE in the file, and it is still the checkout's.
    expect(PANEL_TEXT.match(/'Content-Type'/g)).toHaveLength(1);
    expect(PANEL_TEXT).not.toMatch(/<a\s[^>]*href/);
    // No navigation: the answer is a verdict, not a URL. The navigation machinery — the `navigated`
    // latch, the scheme check, `openAtTopLevel` — is counted at TWO elsewhere in this file, and a
    // sync must not become a third; those pins are the assertion, and this comment is the reason.
  });

  it('renders Synced only after applied:true AND the re-read, and treats any other 2xx as a failed sync', () => {
    // `applied` is the route's own derivation from the billing endpoint's answer. TRUE means the
    // endpoint took the payment the caller copied from the processor — whether or not the date on
    // the row changed, because the endpoint answers true on identical values. So "Synced with
    // Stripe." claims the copy happened and nothing about the date having moved: the status line
    // beneath says the date. Anything else 2xx — `applied: false`, a body with no `applied`, a
    // non-boolean — is the endpoint DECLINING the copy, and a decline rendered as "up to date"
    // would be a false sentence for the one case that reaches it. It is a failed sync: the panel's
    // own "try again", no notice, and no re-read, because nothing changed to re-read.
    // `!== true`, not falsiness: a stale bundle/API pair lands in the honest arm.
    //
    // THEN THE RE-READ, AWAITED, and only then the notice — one ordered string, because the order
    // is the behaviour. `busy` is held until the status line has had its chance to catch up, so a
    // sitter never reads "Synced with Stripe." above a line still saying "lapsed". The await sits in
    // its own swallowing `try`: the re-read is the dashboard's request to its OWN API, routed
    // through the dashboard's own `run`, which reports its failures through the dashboard's own
    // banner — and a failure there is a different fact with a different owner, so it must never
    // land in this handler's `catch` and be reported beside the button as a sync that failed. The
    // notice still renders after a failed re-read, because the sync itself did succeed.
    expect(FLAT).toContain(
      'const { applied } = (await res.json()) as { applied?: unknown }; ' +
        'if (applied !== true) throw new Error(SYNC_FAILED); ' +
        'try { await onPlanChanged(); } catch { } setNotice(SYNCED); } catch (e) {',
    );
    expect(PANEL_TEXT).toMatch(/Synced with Stripe\./);
    expect(PANEL).not.toContain('ALREADY_SYNCED');
    expect(PANEL_TEXT).not.toMatch(/up to date/i);
    // ONE call, awaited, inside the `applied === true` path and never in a `finally` or after the
    // main `catch` — where it would run for a failed sync too, or run after `busy` was released.
    expect(PANEL.match(/onPlanChanged\(\)/g)).toHaveLength(1);
    expect(PANEL).toContain('await onPlanChanged()');
    expect(PANEL).not.toContain('void onPlanChanged()');
    expect(FLAT.indexOf('await onPlanChanged()')).toBeGreaterThan(
      FLAT.indexOf('if (applied !== true)'),
    );
    expect(FLAT.indexOf('await onPlanChanged()')).toBeLessThan(FLAT.indexOf('setNotice(SYNCED)'));
    expect(FLAT.indexOf('setNotice(SYNCED)')).toBeLessThan(
      FLAT.indexOf('} finally { setBusy(null); }'),
    );
    // RENDERED, in the dashboard's own success class and as a live region — the way the dashboard's
    // other notices announce themselves — and not left as a declared constant, the mutation this
    // file has lost twice.
    expect(FLAT).toContain('{notice && ( <p role="" className=""> {notice} </p> )}');
    expect(PANEL_TEXT).toMatch(/<p role="status" className="pb-ok">\s*\{notice\}\s*<\/p>/);
    // And it IS the dashboard's mid-session re-read — the one the calendar popup uses, which merges
    // the plan fields into both the state and the saved snapshot — handed down through the section
    // that renders the panel, not a second fetch of the same payload.
    expect(BUSINESS).toMatch(/<PlanPanel[^>]*onPlanChanged=\{onPlanChanged\}/);
    expect(FLAT_APP).toMatch(/<BusinessSection [^>]*onPlanChanged=\{refreshCalendarStatus\}/);
  });

  it('relays a 409’s own sentence and no other status’s, and never lets a cross-origin 401/403 sign her out', () => {
    // THE TWO THROWS AS ONE ORDERED STRING, because the order is the behaviour. 409 first, as an
    // ApiError carrying the server's own words: the route's 409s are written for her and are worth
    // more than ours. EVERYTHING ELSE second, as a plain Error with this panel's own sentence — a
    // 401 or 403 from another origin judging its own credential, which must never become an
    // ApiError and reach `isAuthExpired` (the hazard the checkout and portal paths document); a
    // 503, which is that deployment's sentence and not one about her plan; a 404 from an origin
    // that does not serve the route yet; a 429 from a shared rate bucket, whose body may be a
    // machine code rather than a sentence; a 500. "Try again" is true of all of them, and none of
    // their bodies may render. The literal `409` in the constructor is the pin that no other
    // status's body can be relayed by this handler: `ApiError(res.status, …)` here would be a
    // third occurrence of the checkout's shape and the count above would say so.
    expect(FLAT).toContain(
      'if (res.status === 409) throw new ApiError(409, body.error ?? SYNC_FAILED); ' +
        'throw new Error(SYNC_FAILED); }',
    );
    expect(PANEL.match(/new ApiError\(409,/g)).toHaveLength(1);
    // 409 is the ONLY status the sync names. Sliced to the handler, so a status added to the
    // checkout or the portal is their cases' business and a status added here is this one's.
    const sync = FLAT.slice(
      FLAT.indexOf('const syncWithStripe'),
      FLAT.indexOf('const offersHidden'),
    );
    expect(sync.match(/res\.status === \d+/g)).toEqual(['res.status === 409']);
    expect(sync).not.toMatch(/\b(?:40[0-8]|41\d|42\d|5\d\d)\b/);
    // TWO plain-Error throws in the handler: the non-409 refusal above, and the 2xx that is not
    // `applied: true`.
    expect(PANEL.match(/throw new Error\(SYNC_FAILED\)/g)).toHaveLength(2);
    // And the catch renders only an ApiError's message, as the other two do — never the browser's.
    expect(PANEL).toContain('e instanceof ApiError ? e.message : SYNC_FAILED');
    expect(PANEL_TEXT).toMatch(/try again\./);
    expect(PANEL).not.toContain('isAuthExpired');
    expect(PANEL).not.toContain('handleError');
  });

  it('clears both sentences and takes busy on press, and releases busy however the call ends', () => {
    // THE HANDLER'S BOOKKEEPING, pinned as two ordered strings because each line of it survived
    // deletion under every other case here. The press preamble first: `setError('')` and
    // `setNotice('')` together, because the panel now has two sentences and a press must displace
    // both — a second press answering 409 beneath a still-standing "Synced with Stripe." is two
    // sentences that contradict each other, and a stale error beside a fresh notice is the same
    // fault the other way. Then `setBusy('sync')`, the key by its literal, because it is what
    // disables every button in the panel for the duration and turns this one's label.
    expect(FLAT_TEXT).toContain(
      "const syncWithStripe = async () => { if (busy || !origin) return; setError(''); " +
        "setNotice(''); setBusy('sync'); try {",
    );
    // And the release, UNCONDITIONAL and in a `finally`. The other two handlers keep `busy` set on
    // the success path because they are navigating away; this one navigates nowhere, so `busy`
    // must come back on every exit or one press leaves the panel reading "Syncing…" with every
    // button disabled for the rest of the session. Anchored on the catch so it is THIS handler's
    // `finally` and not the checkout's or the portal's `if (!navigated)` shape.
    expect(FLAT).toContain(
      'setError(e instanceof ApiError ? e.message : SYNC_FAILED); } finally { setBusy(null); }',
    );
  });

  it('states no price, no period and no refund beside the control', () => {
    // The whole-file pins above already cover every literal in the panel; this one reads the THREE
    // constants by name, so a figure or a term that joined one of them is named in the failure
    // rather than found by a regex over five hundred lines. Each negative rides on a positive: an
    // extraction that matched nothing passes every `not.toMatch`, and the positive is what makes
    // them bite. "period" is banned outright — not only "billing period" — because a sentence about
    // syncing is one word away from promising when the next one starts.
    for (const name of ['SYNC_FAILED', 'SYNCED', 'SYNC_HINT']) {
      const sentence = new RegExp(`const ${name} =([\\s\\S]*?);`).exec(PANEL_TEXT)?.[1] ?? '';
      expect(sentence, name).toMatch(/[a-z]/);
      expect(sentence, name).not.toMatch(/\d/);
      expect(sentence, name).not.toMatch(/\$/);
      expect(sentence, name).not.toMatch(/period/i);
      expect(sentence, name).not.toMatch(/refund|pro-?rat|notice period/i);
      expect(sentence, name).not.toMatch(/Cancel (?:plan|subscription)/i);
      expect(sentence, name).not.toMatch(/\bretry\b/i);
    }
    // The hint says WHEN and WHAT, and names the processor so a sitter knows whose answer she is
    // asking for — and nothing about how, and no date, plan or figure: the status line above is
    // re-read and says those.
    const hint = /const SYNC_HINT =([\s\S]*?);/.exec(PANEL_TEXT)?.[1] ?? '';
    expect(hint).toMatch(/looks wrong/);
    expect(hint).toMatch(/Stripe/);
    expect(PANEL_TEXT).toContain('Sync with Stripe');
    expect(FLAT).toContain('{SYNC_HINT}');
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

  it('names the seven fields explicitly, rather than spreading the fresh payload', () => {
    // Field by field, which is the same discipline `save()` uses for the PUT body: a field added to
    // `Settings` does not silently join this merge, and spreading `fresh` wholesale would be the
    // staged-edit bug `refreshCalendarStatus` exists to avoid. `planCurrent` joined the list in
    // the same commit that added it, and `planEnforced` in the one that made the banner require
    // it — or the banner is right on a fresh load and stale for the rest of the session, the
    // exact failure the first five were added to fix.
    for (const field of [
      'plan:',
      'billedUntil:',
      'planActive:',
      'hasBillingAccount:',
      'planCurrent:',
      'planEnforced:',
    ]) {
      expect(APP, field).toContain(`  ${field} s.${field.slice(0, -1)},`);
    }
    // `stripeCustomerId` is spread conditionally, because the key is ABSENT — not null — for a
    // `pawsa_` credential, and turning that absence into an `undefined` would make the client type
    // lie about the payload it mirrors.
    expect(APP_TEXT).toContain("'stripeCustomerId' in s");
  });
});

describe('a lapsed plan is a read-only dashboard, and the dashboard says so', () => {
  it('puts the banner on planCurrent === false AND planEnforced, never beside the disabled one', () => {
    // The disabled banner's own slot, whose comment already establishes the right model: this is
    // UX, and the server's non-GET guard is the actual enforcement. `!settings.disabled` is what
    // keeps the two from stacking — a switched-off account is `planCurrent: false` too, and she has
    // already been told why her account is off and who to ask.
    //
    // CONDITION, MARKUP AND CLASS IN ONE STRING, so a banner rendered unconditionally beside a
    // condition that still guards something else cannot pass — three independent `toContain`s
    // could. `=== false` and not `!`: an older worker's payload has no such field, and the banner
    // must show NOTHING on a stale bundle/API pair rather than "read-only" to every sitter for the
    // length of a deploy. And `planEnforced`: on the shipped default every save succeeds, and a
    // banner about a refusal that does not happen is one nobody believes on the day it is true.
    expect(FLAT_APP).toContain(
      '{settings.planCurrent === false && settings.planEnforced && !settings.disabled && ( ' +
        '<p className="" role=""> {offersOn ? PLAN_LAPSED : PLAN_LAPSED_CONTACT} </p> )}',
    );
    expect(APP_TEXT).toContain('pb-lapsed-banner');
    // The retired shapes, so neither term can be dropped back out.
    expect(APP).not.toContain('{!settings.planCurrent && !settings.disabled');
    expect(APP).not.toContain('settings.planCurrent === false && !settings.disabled && (');
  });

  it('names Subscribe only where the offers render, and says "contact us" where they do not', () => {
    // The panel's own `offersHidden` narrowing, applied to the banner's second sentence: on a
    // deployment that is not selling, or one with no paid surface, "start a plan under Business"
    // points at a control that is not there. `offersOn` is the deployment's half of that condition
    // — the published origin and `pricing.subscribe` — read from the same `/config` the panel
    // reads; `disabled` is already excluded by the banner's own condition.
    expect(FLAT_APP).toContain(
      'const offersOn = config?.premium?.origin != null && config?.pricing?.subscribe === true',
    );
    const contact = /const PLAN_LAPSED_CONTACT =([\s\S]*?);/.exec(SHARED_TEXT)?.[1] ?? '';
    expect(contact).toMatch(/read-only/);
    expect(contact).toMatch(/contact us/i);
    expect(contact).not.toMatch(/Subscribe|Start a plan/);
  });

  it('flips planCurrent to false on the 402 itself, so the banner appears mid-session', () => {
    // The settings read said current at load; the plan lapsed while the tab sat open; the next save
    // is refused. Without this the sentence is in the error slot and the banner is not, and the two
    // disagree until she reloads. Into BOTH the state and the saved snapshot, for the reason
    // `refreshCalendarStatus` gives: a field changed in one and not the other puts the save bar up.
    expect(FLAT_APP).toContain('markPlanLapsed()');
    expect(FLAT_APP).toContain('prev ? { ...prev, planCurrent: false } : prev');
    expect(FLAT_APP).toContain('JSON.stringify({ ...parsed, planCurrent: false })');
  });

  it('routes a 402 plan_lapsed BEFORE isAuthExpired, so it can never sign her out', () => {
    // 402 cannot be mistaken for an expired session by any client, which is why the status is 402
    // and not 403 — but the branch order is still pinned, because the cost of getting it wrong for
    // the NEXT literal is ejecting a sitter from the dashboard she is trying to read. The
    // `account_disabled` branch already carries that lesson one line above.
    expect(APP_TEXT).toContain('isPlanLapsed(e)');
    const lapsedAt = APP_TEXT.indexOf('isPlanLapsed(e)');
    const authAt = APP_TEXT.indexOf('isAuthExpired(e)');
    expect(lapsedAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(-1);
    expect(lapsedAt).toBeLessThan(authAt);
    // AND THE PREDICATE ACCEPTS A BARE 402 as well as the code — the status is the gate's own
    // answer, and a client that needed the body word too would print a raw code at a sitter the
    // day a route answered 402 with a sentence. The code is matched from `ApiError.code` when the
    // response carries one and from the message otherwise, never from the message alone.
    expect(API_TEXT).toContain("e.status === 402 || (e.code ?? e.message) === 'plan_lapsed'");
    // And it is NOT folded into `isAuthExpired`: her session is fine.
    expect(API_TEXT).toContain(
      'return e instanceof ApiError && (e.status === 401 || e.status === 403);',
    );
  });

  it('says it on the write surfaces that do not share `handle`, in the same words', () => {
    // `handle` is the error router nine panels are handed. These are not among them: TokensPanel
    // keeps a failure beside the control that caused it, SetupWizard is a modal that takes no
    // `handleError` at all, and CalendarBackfillPanel reports per row — so each printed the wire's
    // bare `plan_lapsed` at a sitter. One mapper, reading the one constant, rather than a second
    // sentence per surface.
    expect(TOKENS).toContain('setCreateError(writeFailureMessage(e,');
    expect(TOKENS).toContain('setRevokeError(writeFailureMessage(e,');
    expect(WIZARD.match(/setError\(writeFailureMessage\(e,/g)).toHaveLength(3);
    // THE SIXTH SINK, inside the per-preset catch that strips the `ApiError` before the aggregate
    // ever sees it: `new Error(`${label}: ${e.message}`)` printed "Dog boarding: plan_lapsed". The
    // mapper is applied INSIDE that catch, where the ApiError still is — not at the aggregate,
    // which only ever sees plain Errors.
    expect(WIZARD_TEXT).toContain(
      "`${ps.preset.label}: ${writeFailureMessage(e, 'could not be created')}`",
    );
    expect(BACKFILL).toContain('const message = writeFailureMessage(e,');
    // AND THE RAW SINKS ARE GONE from each, which is the half a bare `toContain` leaves open: adding
    // the mapper somewhere and leaving the old branch beside it satisfies every line above. The
    // earlier pin said "the raw sink is gone" of the wizard while the per-preset catch still read
    // `e.message`; this one names that shape too.
    expect(TOKENS).not.toContain('setCreateError(e instanceof Error');
    expect(TOKENS).not.toContain('setRevokeError(e instanceof Error');
    expect(WIZARD).not.toContain('setError(e instanceof Error');
    expect(WIZARD_TEXT).not.toContain('e instanceof Error ? e.message :');
    expect(BACKFILL).not.toContain('e instanceof ApiError ? e.message :');
  });

  it('maps a 402 plan_lapsed to the sentence and everything else to its own words', () => {
    // The MAPPING itself, as a unit, beside the call-site pins above: an `ApiError` 402 with the
    // gate's body code is the sentence; a bare 402 is the sentence too; any other error keeps the
    // server's own words, and a non-Error gets the fallback the sink named.
    expect(writeFailureMessage(new ApiError(402, 'plan_lapsed'), 'fallback')).toBe(PLAN_LAPSED);
    expect(writeFailureMessage(new ApiError(402, 'Payment required.'), 'fallback')).toBe(
      PLAN_LAPSED,
    );
    expect(writeFailureMessage(new ApiError(400, 'Provide a valid date range.'), 'x')).toBe(
      'Provide a valid date range.',
    );
    expect(writeFailureMessage(new Error('boom'), 'fallback')).toBe('boom');
    expect(writeFailureMessage('not an error', 'fallback')).toBe('fallback');
    // `isPlanLapsed` on its own: a 403 carrying the code is the session predicate's, not this one's
    // — and `isAuthExpired` does NOT accept a 402.
    expect(isPlanLapsed(new ApiError(402, 'anything'))).toBe(true);
    expect(isPlanLapsed(new ApiError(400, 'plan_lapsed'))).toBe(true);
    expect(isPlanLapsed(new ApiError(400, 'Something else.', 'plan_lapsed'))).toBe(true);
    expect(isPlanLapsed(new ApiError(400, 'plan_lapsed', 'other_code'))).toBe(false);
    expect(isPlanLapsed(new ApiError(403, 'account_disabled'))).toBe(false);
    expect(isAuthExpired(new ApiError(402, 'plan_lapsed'))).toBe(false);
    expect(isAuthExpired(new ApiError(401, 'x'))).toBe(true);
  });

  it('holds the banner’s sentences to the copy rules the panel’s is held to', () => {
    // Every no-figure / no-terms pin in this file reads `PANEL_TEXT`, which is `PlanPanel.tsx`. The
    // lapse sentences live in `shared.ts`, so each was covered by one positive match and nothing
    // else — "for the next 3 days" or a price could have joined it and stayed green. Scoped to the
    // constant's own text, which is where a bare `\d` is exactly right and over a whole file is
    // not. The negatives each ride on the positive guard beside them: an extraction that matched
    // nothing would pass every `not.toMatch`, and the positive is what makes them bite.
    for (const name of ['PLAN_LAPSED', 'PLAN_LAPSED_CONTACT']) {
      const sentence = new RegExp(`const ${name} =([\\s\\S]*?);`).exec(SHARED_TEXT)?.[1] ?? '';
      // NOT VACUOUS: the sentence says what it is for, and how to get back.
      expect(sentence, name).toMatch(/read-only/);
      expect(sentence, name).toMatch(/bring it back/);
      expect(sentence, name).not.toMatch(/\d/);
      expect(sentence, name).not.toMatch(/\$/);
      expect(sentence, name).not.toMatch(/Cancel (?:plan|subscription)/i);
      expect(sentence, name).not.toMatch(/refund|pro-?rat|notice period/i);
      expect(sentence, name).not.toMatch(/end of (?:the |your )?(?:billing )?period/i);
      // No "again": a never-subscribed business is not starting a plan AGAIN, and once signup
      // comps the trial that is exactly who a lapsed business often is.
      expect(sentence, name).not.toMatch(/\bagain\b/);
    }
    // AND NOT IN THE EMBED GRAPH: `api.ts` is imported by the booking widget, and the sentence was
    // shipping to every widget from there. The predicate stays; the copy does not.
    expect(API_TEXT).not.toContain('PLAN_LAPSED');
    expect(API_TEXT).not.toMatch(/read-only/);
    expect(API_TEXT).not.toContain('writeFailureMessage');
    // The sentence that names the control names WHERE it is: the plan panel is under Business.
    expect(PLAN_LAPSED).toBe(
      'Your plan has lapsed and your dashboard is read-only. Start a plan under Business to bring it back.',
    );
  });

  it('has a stylesheet rule of its own, so the class the banner names is not a bare word', () => {
    // THE REPO'S FIRST CSS PIN, and a deliberately small one. No test reads `admin.css`, so the
    // banner's own class — pinned above so it cannot share the disabled banner's — could be named
    // in the markup and defined nowhere, and a banner with no rule is an unstyled paragraph nobody
    // reads as a banner. One assertion that the block exists; what it looks like is not a claim.
    const css = readFileSync(join(ADMIN, 'admin.css'), 'utf8');
    expect(css).toContain('.pb-lapsed-banner {');
  });

  it('says the lapse beside the portal-unavailable notice on a lapsed tenant', () => {
    // A lapsed sitter with a billing account on a deployment whose paid surface is down read only
    // "changing your plan is unavailable right now" — true, and not the half that explains her
    // read-only dashboard. The notice names the lapse for her, on the same condition as the
    // banner's tenant half, and says nothing about a lapse to a sitter who is current.
    expect(PANEL).toContain('PORTAL_UNAVAILABLE_LAPSED');
    expect(FLAT).toContain(
      '{settings.planCurrent === false && !settings.disabled ? PORTAL_UNAVAILABLE_LAPSED : PORTAL_UNAVAILABLE}',
    );
    const sentence = /const PORTAL_UNAVAILABLE_LAPSED =([\s\S]*?);/.exec(PANEL_TEXT)?.[1] ?? '';
    expect(sentence).toMatch(/lapsed/);
    expect(sentence).toMatch(/unavailable right now/);
    expect(sentence).not.toMatch(/Subscribe/);
  });

  it('keys the lapsed-with-account sentence on planCurrent, not on planActive', () => {
    // A comped ex-subscriber has an account and no live subscription, so she sees both controls —
    // and she is NOT lapsed. The sentence that says "your plan has lapsed" hangs on the server's
    // `planCurrent`, the way `LAPSED_NO_ACCOUNT` already did; `bothControls` stays about the
    // controls.
    expect(FLAT).toContain('{bothControls && settings.planCurrent === false && ');
    expect(FLAT).not.toContain('{bothControls && <p');
  });

  it('tells the lapsed sitter with NO billing account what Subscribe does for her', () => {
    // The sitter `LAPSED_WITH_ACCOUNT` does not reach: lapsed on a comp that ran out, or never
    // subscribed at all. She has no portal to open, so the sentence names the one control she has.
    expect(PANEL).toContain('LAPSED_NO_ACCOUNT');
    // A PHRASE ONLY THIS SENTENCE HAS. `Subscribe` is the button's own label and `lapsed` is the
    // status line's word, so either would stay green against a constant emptied to `''` — a
    // sentence declared and never read is the mutation this file has already lost twice.
    expect(PANEL_TEXT).toMatch(/brings it back/);
    // RENDERED, and only where it is true — condition and markup in ONE string, the way the
    // `bothControls` case above binds them, so a sentence rendered unconditionally beside a
    // condition that still guards something else cannot pass. `!offersHidden` is the term that
    // makes the copy honest: it is exactly where the offers grid renders, so the Subscribe the
    // sentence names is on the page. Without it she read "Subscribe starts a plan and brings it
    // back" on a deployment that is not selling, on one with no paid surface at all, and — every
    // load — for as long as the `/config` request took, which is the flash `configLoaded` exists
    // to prevent one element below. `=== false`, like the banner: a stale pair shows nothing.
    expect(FLAT).toContain(
      '{!offersHidden && settings.planCurrent === false && !settings.hasBillingAccount && ' +
        '!settings.disabled && <p className="">{LAPSED_NO_ACCOUNT}</p>}',
    );
    // AND IT STATES NO LENGTH FOR THE GRACE, in numerals or in words, beside the no-figure and
    // no-terms pins above that already cover this constant too. Scoped to a period noun rather
    // than a bare `\d`: `PANEL_TEXT` keeps executable literals, and this panel's own `401`/`403`
    // are two of them — a pin that reads an HTTP status as a grace length is the crying-wolf pin
    // the dollar-figure case above is already scoped to avoid.
    expect(PANEL_TEXT).not.toMatch(/\b\d+\s*-?\s*(?:hour|day|week|month|year)s?\b/i);
    expect(PANEL_TEXT).not.toMatch(
      /\b(?:one|two|three|four|five|six|seven|ten|fourteen|thirty)\s*-?\s*(?:\w+\s+)?(?:hour|day|week|month|year)s?\b/i,
    );
  });
});
