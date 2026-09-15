import { useEffect, useState } from 'react';
import { api, ApiError, type TenantConfig } from '../shared-ui/api.js';
import { formatTimestamp, type Session, type Settings } from './shared.js';
import { Hint } from './Hint';

/**
 * HER PLAN: what she is on, and the two controls that change it.
 *
 * THREE THINGS RENDER HERE, on three different conditions, and the difference between them is the
 * whole design of this file:
 *
 *   - THE STATUS LINE renders unconditionally. The plan, the paid-through date and live/lapsed are
 *     columns in this product's own database, answered by the same request that drew the rest of
 *     the dashboard — so an outage of the paid surface, an unset `PREMIUM_ORIGIN`, a deployment
 *     that has stopped selling and a lapsed subscription all still show it (NFR-2). It says
 *     nothing about ENTITLEMENT: this repo records who has paid and publishes the fact, and
 *     deciding what a plan buys belongs to whatever consumes it.
 *
 *   - SUBSCRIBE renders on TWO PROPERTIES OF THE DEPLOYMENT and one fact about her plan, and never
 *     on the entitlement flag published beside them. `assistant` is the tenant's entitlement —
 *     false for exactly the sitter who has not bought yet, which is everyone that control is for.
 *     The audit card in ServicesSection gates on it because it embeds a paid surface; this one
 *     sells one, so it must not. Do not make them match.
 *       - `premium.origin` — a checkout worker EXISTS to be reached at all, and where.
 *       - `pricing.subscribe` — selling is switched ON (`PLAN_SUBSCRIBE`, unset = off).
 *       - `!settings.planActive` — she has no live plan. NOT `!hasBillingAccount`: a cancelled
 *         sitter keeps her customer record at the processor forever, and hiding Subscribe from her
 *         hid the only control she wanted.
 *     And a DISABLED tenant is never offered a plan: her account cannot take a booking, so asking
 *     her for a card is worse than showing nothing.
 *
 *   - MANAGE PLAN renders on `premium.origin`, `settings.hasBillingAccount` and a tenant that is
 *     switched on — and on NEITHER of the deployment's other two flags. Not `pricing.subscribe`,
 *     because a sitter who already pays must be able to change her card and cancel after a
 *     deployment stops taking new subscriptions. And NOT `planActive`: a lapsed sitter with a
 *     billing account may be in the processor's dunning — the subscription still exists and the
 *     retries are still running — and the hosted portal is the only place she can put a working
 *     card on it. `planActive` in this gate shut her out of the fix at the moment she needed it.
 *     `hasBillingAccount` is the question that matches the control: is there an account at the
 *     processor to open at all.
 *
 * SUBSCRIBE AND MANAGE ARE NOT ONE FLAG NEGATED. They ask two different questions — "is there an
 * account at the processor" and "is there no live plan" — and the states fall out of the pair:
 * a sitter who never subscribed gets SUBSCRIBE alone; a live plan (a cancelled-in-grace one
 * included, since it is still live) gets MANAGE alone; a LAPSED sitter with a billing account gets
 * BOTH, with one line beneath saying which is which; a switched-off account gets NEITHER. A paying
 * sitter is still never offered a second subscription, which is the UI half of the
 * double-subscription question — the other half is a server-side refusal on the checkout route,
 * which is the paid surface's to build: a UI is not a guard, because that route is reachable with
 * curl and an admin token.
 *
 * BOTH CONTROLS ARE A `fetch` AND NOT AN ANCHOR: the admin session is a JWT in localStorage and an
 * anchor carries no Authorization header — `app/shared-ui/api.ts`'s `exportCsv` docblock is where
 * this repo already writes that down. Each returned URL is opened on `window.top`, because a
 * hosted checkout and a hosted billing page both set their own frame-ancestors and will not render
 * inside a frame. Two path templates on the published origin, and this file states no price, no
 * trial length, no invoice, no cancellation terms and no refund position of its own: the figures
 * come from `/config` and the terms belong on the terms page.
 *
 * IT FETCHES `/config` ITSELF, exactly as SettingsReviewEmbed does: one more read of a cached
 * public endpoint is cheaper than threading new state through App.tsx. A failed read now costs the
 * two controls and NOT the status line, which comes from the settings payload the dashboard passed
 * in — plan state is deliberately not on `/config`, because that endpoint is unauthenticated and
 * embedded on every sitter's public site.
 */

/** The one message this panel is willing to put in front of a sitter for a failure it does not
 *  recognise. The browser's own `TypeError: Failed to fetch` is not a plan problem and must not be
 *  rendered as one — and neither is a 401 or 403 from the other worker, for the reason the `!res.ok`
 *  branch below gives. */
const CHECKOUT_FAILED = 'Could not start checkout — try again.';

/** The sibling of CHECKOUT_FAILED, for the other hosted page. Same rule: this is the ONE message
 *  this panel is willing to show for a failure it does not recognise — the browser's own
 *  "Failed to fetch" is not a plan problem and must not be rendered as one. */
const PORTAL_FAILED = 'Could not open plan management — try again.';

/** Beside Manage plan. The assurance the Subscribe Hint carries for every sitter who has not bought
 *  yet — and which stopped reaching the sitter who HAS, the moment that Hint learned to hide behind
 *  the Subscribe gate. She is the one with a card on file, so she is the one the sentence is for: it
 *  is what makes pressing an unfamiliar button into somebody else's page reasonable. A statement of
 *  FACT about where the card lives, and not a term: no notice, no refund position, no proration. */
const MANAGE_ON_STRIPE = 'Card changes happen on Stripe’s own page — we never see your card.';

/** The one state in which both controls stand together — a lapsed plan with a billing account
 *  still at the processor — and the only state in which two buttons could read as one choice made
 *  twice. It says which is which and nothing else: no price, no card form, no invoice of this
 *  product's own and no cancellation control, because both controls lead to a page that is not
 *  this product's and the terms belong on the terms page.
 *
 *  IT WRAPS BETWEEN CLAUSES, NEVER INSIDE ONE. `plan-panel.test.ts` pins this sentence at the
 *  SOURCE — there is no DOM harness — so a `+` that falls inside a pinned phrase splits it in two
 *  and the pin goes red against copy that reads perfectly on screen. */
const LAPSED_WITH_ACCOUNT =
  'Your plan has lapsed — fix your card or see past invoices under Manage plan, ' +
  'or start a new plan with Subscribe.';

/** The whole of what a switched-off account is told here. Her plan's NAME still renders above it —
 *  it is a column in this product's own database and NFR-2 does not stop applying to her — but
 *  neither "paid through" nor "lapsed" is true of an account that cannot take a booking, and a
 *  paid-through date beside one reads as a promise. The dashboard's own banner has already said why
 *  the account is off and who to ask; this line says only what it means for the plan. */
const ACCOUNT_OFF = 'This account is switched off, so its plan cannot be changed here.';

/** The sitter `LAPSED_WITH_ACCOUNT` cannot reach: her plan has lapsed and she has NO account at the
 *  processor — a comp that ran out, or a business that never subscribed. There is no portal to open
 *  for her, so the sentence names the one control she has and says what it restores.
 *
 *  NO LENGTH FOR THE GRACE, in numerals or in words. `plan-panel.test.ts` forbids a numeral beside a
 *  period noun, and a length written out would go stale silently the moment the grace changed — the
 *  same failure a typed price is banned here for. IT WRAPS BETWEEN CLAUSES, NEVER INSIDE ONE: the
 *  pins read this constant at the SOURCE, so a `+` that falls inside a pinned phrase splits it in
 *  two and the pin goes red against copy that reads perfectly on screen. */
const LAPSED_NO_ACCOUNT =
  'Your plan has lapsed, so your dashboard is read-only. Subscribe starts a plan and ' +
  'brings it back — your bookings, clients and pets are untouched.';

/** When this deployment publishes no paid surface at all, there is nothing to press and nothing
 *  to retry — so the panel says so once, in a sentence that is about the CONTROL and never about
 *  her account. Everything else on her dashboard, her booking page and her clients are unaffected,
 *  because every fact on the status line above came from this product's own row. */
const PORTAL_UNAVAILABLE =
  'Changing your plan is unavailable right now. Your bookings, clients and pets are unaffected.';

/**
 * Open a hosted checkout at the TOP level, because a checkout page sets its own `frame-ancestors`
 * and will not render inside the dashboard's frame.
 *
 * `window.top` is not an assertion-away-able non-null: it is `null` in a detached frame, and
 * reading `.location` on it THROWS a `SecurityError` whenever the dashboard is framed
 * cross-origin. Both end in the same place — a new tab, which the sitter can still complete.
 */
function openAtTopLevel(url: string): void {
  try {
    const top = window.top ?? window;
    top.location.assign(url);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

type PlanOffer = {
  key: 'solo' | 'pro';
  interval: 'month' | 'year';
  name: string;
  price: (pricing: NonNullable<TenantConfig['pricing']>) => string;
  blurb: string;
};

const OFFERS: PlanOffer[] = [
  {
    key: 'solo',
    interval: 'month',
    name: 'Solo',
    price: (pricing) => `$${pricing.soloMonthly} a month`,
    blurb: 'One sitter, unlimited bookings, and everything you are using now.',
  },
  {
    key: 'pro',
    interval: 'month',
    name: 'Pro',
    price: (pricing) => `$${pricing.proMonthly} a month`,
    blurb: 'Everything in Solo, plus card payments through your own Stripe account.',
  },
  {
    key: 'pro',
    interval: 'year',
    name: 'Pro, yearly',
    price: (pricing) => `$${pricing.proAnnual} a year`,
    blurb: 'The same Pro plan, paid once a year.',
  },
];

/** The two plan names, as the sitter sees them. Names, not figures — the figures are published on
 *  `/config` and this panel states none of its own. */
const PLAN_NAMES: Record<'solo' | 'pro', string> = { solo: 'Solo', pro: 'Pro' };

export function PlanPanel({
  session,
  settings,
}: {
  session: Session;
  /**
   * The settings payload the dashboard has already fetched — plan status costs this panel zero
   * extra requests, and it is loaded before the panel paints. The five plan fields on it are
   * READ-ONLY: `save()` builds its PUT body field by field rather than spreading this object, so
   * they never travel back, and the sticky-save `dirty` check compares whole objects, so fields
   * that change only on a reload can never make the save bar appear. That pair is the answer to
   * "why does a read-only field live on the settings type".
   */
  settings: Settings;
  /**
   * NO `handleError`, deliberately, and this panel is the one place in the dashboard that takes
   * none. Every other panel hands its failures to App.tsx's `handle`, which signs the sitter out on
   * a 401 or 403 — the right answer when the refusal came from THIS product judging her session.
   * Both of this panel's calls go to another origin judging its own credential, where those two
   * statuses say nothing about her dashboard session, so there is no failure here that signing her
   * out would answer. The `!res.ok` branches below are where that is enforced.
   */
}) {
  const [config, setConfig] = useState<TenantConfig | null>(null);
  /**
   * The `/config` request has FINISHED, however it finished. Not the same question as
   * `config !== null`: a read that failed is a deployment whose paid surface this panel cannot
   * reach, and the unavailable notice below belongs on screen for it. What must stay silent is
   * "not asked yet" — `origin` is null until this effect resolves and `settings` is already in
   * hand when the panel paints, so without this flag every paying sitter was told her plan could
   * not be changed for as long as one request took, on every dashboard load.
   */
  const [configLoaded, setConfigLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api
      .config(session.slug)
      .then((c) => {
        if (active) {
          setConfig(c);
          setConfigLoaded(true);
        }
      })
      .catch(() => {
        // Absence, not an error — the offers just do not render. The flag still flips: a read that
        // failed is one of the states the notice below is FOR, and flipping it only on success
        // would trade a false sentence for silence in the one case the sentence is true.
        if (active) setConfigLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [session.slug]);

  const origin = config?.premium?.origin ?? null;
  const pricing = config?.pricing ?? null;
  /** Selling is switched on for this DEPLOYMENT (`PLAN_SUBSCRIBE`), not for this tenant. */
  const sellingIsOn = pricing?.subscribe === true;
  /**
   * What the row says, in the sitter's own terms. `null` is not "free" and not an error — it is a
   * sitter who has never subscribed, which is most of them.
   *
   * MATCHED, not indexed blind. A `Plan` this bundle does not know — a column that grew a third
   * tier, a cached row written by a newer worker — would index to `undefined`, which React renders
   * as nothing at all: the line would show a date with no plan in front of it. A render on a stale
   * bundle/API pair must degrade to the honest answer, never throw and never print a blank.
   */
  const planName =
    settings.plan === 'solo' || settings.plan === 'pro' ? PLAN_NAMES[settings.plan] : 'No plan yet';
  /**
   * RENDERED, never compared. `planActive` is the server's answer to "is it live"; this string is
   * only ever the date beside it.
   *
   * A NON-EMPTY STRING OR NOTHING. `formatTimestamp` takes a string and calls `.replace` on it, so a
   * null, a number or a `''` from a stale bundle/API pair would throw inside render — which unmounts
   * her whole dashboard, not this one line. No date is a worse answer than a date; a blank page is
   * worse than both.
   */
  const paidThrough =
    typeof settings.billedUntil === 'string' && settings.billedUntil !== ''
      ? formatTimestamp(settings.billedUntil)
      : null;
  /** The word beside that date, and the panel's ONLY reading of `planActive` — the server's own
   *  answer to "is it live", never re-derived here. Hoisted out of the template literal below
   *  rather than written inline in it, because the source pin in `plan-panel.test.ts` reads
   *  executable text with literals stripped: a promise pinned only inside a literal is not pinned,
   *  which is the evasion `liveSource` exists to close. */
  const paidThroughWord = settings.planActive ? 'paid through' : 'lapsed';

  const startCheckout = async (offer: PlanOffer) => {
    if (busy || !origin) return;
    setError('');
    setBusy(`${offer.key}-${offer.interval}`);
    // Set the moment the top window is told to go. `location.assign` does not unload
    // synchronously, so re-enabling the buttons in `finally` hands a sitter a second press — and a
    // second checkout session — in the gap before the page goes away.
    let navigated = false;
    try {
      const res = await fetch(`${origin}/premium/billing/${session.slug}/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ plan: offer.key, interval: offer.interval }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // A 401 OR 403 FROM THE OTHER WORKER IS NOT THIS SESSION EXPIRING, and a plain Error is how
        // it is kept from saying so. `isAuthExpired` (`app/shared-ui/api.ts`) reads either status on
        // an ApiError as "the dashboard session has gone" and the dashboard's answer is to sign her
        // out — but this response came from a DIFFERENT origin judging its OWN credential: a secret
        // rotated there, a tenant it has no record of, or any refusal of its own answers 401/403
        // with her dashboard session perfectly good. Signing her out of the product she is using
        // because a billing worker said no is the failure; the panel's own sentence is the answer.
        if (res.status === 401 || res.status === 403) throw new Error(CHECKOUT_FAILED);
        // Anything else keeps the server's own words, which are worth more than ours.
        throw new ApiError(res.status, body.error ?? CHECKOUT_FAILED);
      }
      const { url } = (await res.json()) as { url?: unknown };
      // A STRING, and an https one. `if (!url)` admits any truthy non-string, and no scheme check
      // at all would navigate the sitter's top-level window to whatever the response said —
      // `javascript:` included.
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(CHECKOUT_FAILED);
      navigated = true;
      openAtTopLevel(url);
    } catch (e) {
      // ONLY an ApiError's message, which is the free product's or the billing worker's own words.
      // Anything else is the browser's — "Failed to fetch", "NetworkError when attempting to fetch
      // resource" — or this panel's own copy for a 401/403, and rendering the browser's tells a
      // sitter her plan is broken when her wifi is.
      setError(e instanceof ApiError ? e.message : CHECKOUT_FAILED);
    } finally {
      if (!navigated) setBusy(null);
    }
  };

  /**
   * The hosted billing portal — change a card, switch a plan, cancel. A `fetch` and never an
   * anchor, for the reason `app/shared-ui/api.ts`'s `exportCsv` docblock already gives: the admin
   * session is a JWT in localStorage and an anchor carries no Authorization header. Everything
   * else is `startCheckout`'s machinery deliberately unchanged — the `navigated` latch, the
   * string-and-https check on the returned URL, the top-level navigation, and a plain `Error` on
   * a cross-origin 401/403 so it does NOT sign her out — the same refusal `startCheckout` throws,
   * for the same reason the props docblock above gives.
   *
   * No body and no Content-Type: the server resolves which subscription this is from the slug in
   * the path and the credential in the header, and a request that carried a plan here would be a
   * client telling the server what it already knows better.
   */
  const openPortal = async () => {
    if (busy || !origin) return;
    setError('');
    setBusy('portal');
    let navigated = false;
    try {
      const res = await fetch(`${origin}/premium/billing/${session.slug}/portal`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        // Same refusal as the checkout path, for the same reason: a cross-origin 401/403 must not
        // reach `isAuthExpired` and sign her out of this dashboard.
        if (res.status === 401 || res.status === 403) throw new Error(PORTAL_FAILED);
        throw new ApiError(res.status, body.error ?? PORTAL_FAILED);
      }
      const { url } = (await res.json()) as { url?: unknown };
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(PORTAL_FAILED);
      navigated = true;
      openAtTopLevel(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : PORTAL_FAILED);
    } finally {
      if (!navigated) setBusy(null);
    }
  };

  /**
   * THE DEPLOYMENT'S HALF of the Subscribe gate — a checkout worker exists to be reached, the
   * deployment is selling, the tenant is not switched off, and the figures are published. Her own
   * half (`!settings.planActive`) is applied at each of the two render sites, so this name stays
   * about the deployment. It does not hide the PANEL: a sitter whose plan lapsed, whose deployment
   * stopped selling, or whose paid surface is down must still be told what she is on and when it
   * runs out, because every fact on that line is a column in this product's own database, answered
   * by the same request that drew the rest of her dashboard (NFR-2).
   */
  const offersHidden = !origin || !sellingIsOn || settings.disabled || !pricing;

  /**
   * MANAGE PLAN renders on the published origin, a billing account and an account that is switched
   * on — and on neither of the deployment's other two flags. Not `pricing.subscribe`: that switch
   * is about SELLING, and a sitter who already pays must be able to change her card and cancel
   * after a deployment stops taking new subscriptions. Not `premium.assistant`: that is the
   * tenant's entitlement, false for a Solo subscriber who nonetheless has a plan to manage — the
   * same distinction the Subscribe half above draws.
   *
   * `hasBillingAccount` WITHOUT `planActive`, and that is the whole of the gate ruling. The earlier
   * reading paired the two, on the argument that `StripeCustomerId` is never cleared — it is
   * COALESCEd by `applyBillingEvent` and no route in this product clears it — so a billing account
   * outlives every subscription it ever had, and the button stood after a cancellation pointed at a
   * subscription that no longer existed. What that reading cost is the sitter this control matters
   * most to: a LAPSED plan is very often a subscription in the processor's dunning, still alive and
   * still retrying, and the hosted portal is the only place she can put a working card on it. She
   * now gets the portal AND Subscribe, with one line beneath saying which is which — a stale button
   * beside a live one she can read is a smaller failure than no way to fix a card at all.
   */
  const canManage = origin !== null && settings.hasBillingAccount && !settings.disabled;

  /**
   * THE ONE STATE IN WHICH BOTH CONTROLS STAND TOGETHER: a lapsed plan with a billing account. It
   * is derived from the two gates rather than restating either, so it cannot drift from what is
   * actually on screen, and it names no `pricing` because `offersHidden` already does — `!pricing`
   * is one of its four terms, so `!offersHidden` is exactly where the offers grid renders.
   */
  const bothControls = canManage && !offersHidden && !settings.planActive;

  return (
    <>
      <h3>
        Your plan
        {/* The Hint is SUBSCRIBE'S OWN COPY — it promises a free trial that starts when she
            subscribes — so it hides on the same condition as the offers grid below, and not on the
            offers condition alone, which left it standing beside the Manage plan button. */}
        {!offersHidden && !settings.planActive && pricing && (
          <Hint label="Your plan">
            Payment is handled by Stripe on their own page — we never see your card. Your{' '}
            {pricing.trialDays}-day free trial starts when you subscribe.
          </Hint>
        )}
      </h3>
      {/* THE STATUS LINE, outside every condition on this page — NFR-2, and the one structural fact
          about this file's markup. The plan's NAME renders for every sitter there is, including a
          switched-off one; only the date and the word beside it are withheld from her, because
          neither is true of an account that cannot take a booking. */}
      <p>
        <strong>{planName}</strong>
        {!settings.disabled && paidThrough !== null && ` — ${paidThroughWord} ${paidThrough}`}
      </p>
      {settings.disabled && <p className="pb-hint">{ACCOUNT_OFF}</p>}
      {/* SUBSCRIBE HIDES ON A LIVE PLAN, which is the UI half of the double-subscription question;
          the other half is a server-side refusal on the checkout route, which is the paid surface's
          to build — a UI is not a guard, because that route is reachable with curl and an admin
          token. It does NOT hide on `hasBillingAccount`: a customer record at the processor is not
          a subscription, so a LAPSED sitter is offered Subscribe whether or not she has an old one
          — and since the Manage gate no longer reads `planActive`, she is offered the portal too.
          `bothControls` below is that overlap, stated once. */}
      {!offersHidden && !settings.planActive && pricing && (
        <>
          <ul>
            {OFFERS.map((offer) => (
              <li key={`${offer.key}-${offer.interval}`}>
                <span>
                  <strong>
                    {offer.name} — {offer.price(pricing)}
                  </strong>
                  <br />
                  <span className="pb-hint">{offer.blurb}</span>
                </span>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void startCheckout(offer)}
                >
                  {busy === `${offer.key}-${offer.interval}` ? 'Opening…' : 'Subscribe'}
                </button>
              </li>
            ))}
          </ul>
          <p className="pb-hint">
            Every plan starts with a {pricing.trialDays}-day free trial. Nothing about your
            bookings, clients or pets changes when you subscribe — a plan only decides which extras
            are switched on.
          </p>
        </>
      )}
      {canManage && (
        <>
          <p>
            <button type="button" disabled={busy !== null} onClick={() => void openPortal()}>
              {busy === 'portal' ? 'Opening…' : 'Manage plan'}
            </button>
          </p>
          {/* The Subscribe Hint's assurance, for the sitter that Hint no longer reaches. A fact
              about where her card lives, not a term — the terms belong on the terms page. */}
          <p className="pb-hint">{MANAGE_ON_STRIPE}</p>
        </>
      )}
      {/* ONLY where both controls are on screen. Beside Manage alone it would tell a paying sitter
          her plan had lapsed; beside Subscribe alone it would point her at a button that is not
          there. */}
      {bothControls && <p className="pb-hint">{LAPSED_WITH_ACCOUNT}</p>}
      {/* ONLY for the sitter with no billing account. Beside `LAPSED_WITH_ACCOUNT` it would be a
          second sentence about the same lapse; beside a switched-off account it would be a second
          sentence about the same silence, which `ACCOUNT_OFF` above already says better.

          `!offersHidden` FIRST, because the sentence names Subscribe and must not out-run it: it is
          exactly where the offers grid renders, so a deployment that is not selling, one with no
          paid surface at all, and the stretch of every load before `/config` resolves are all
          excluded — the last being the same flash `configLoaded` exists for one element below. It
          subsumes `settings.disabled`; that term stays spelled out because it is the reason
          `ACCOUNT_OFF` gets this position to itself, and a reader should not have to unfold a
          deployment-shaped name to find it. */}
      {!offersHidden &&
        !settings.planCurrent &&
        !settings.hasBillingAccount &&
        !settings.disabled && <p className="pb-hint">{LAPSED_NO_ACCOUNT}</p>}
      {configLoaded && settings.hasBillingAccount && origin === null && (
        <p className="pb-hint">{PORTAL_UNAVAILABLE}</p>
      )}
      {error && <p className="pb-error">{error}</p>}
    </>
  );
}
