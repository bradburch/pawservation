import { useEffect, useState } from 'react';
import { api, ApiError, isAuthExpired, type TenantConfig } from '../shared-ui/api.js';
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
 *   - MANAGE PLAN renders on `premium.origin`, `settings.hasBillingAccount`,
 *     `settings.planActive` and a tenant that is switched on — and on NEITHER of the deployment's
 *     other two flags. Not `pricing.subscribe`, because a sitter who already pays must be able to
 *     change her card and cancel after a deployment stops taking new subscriptions. `planActive`
 *     IS in the gate, and the argument for leaving it out ("a sitter whose card died is precisely
 *     who needs the portal") does not survive the fact that `StripeCustomerId` is never cleared:
 *     on `hasBillingAccount` alone the button stood for years after a cancellation, pointed at a
 *     subscription that no longer existed. A dying card is not an instant lapse either — the
 *     processor retries for days and `BilledUntil` is paid-through, not last-charged.
 *
 * SUBSCRIBE AND MANAGE ARE MUTUALLY EXCLUSIVE BY CONSTRUCTION, on `planActive` — negated on one
 * side, plain on the other — which is the UI half of the double-subscription question. The other
 * half is a server-side refusal on the checkout route, which is the paid surface's to build: a UI
 * is not a guard, because that route is reachable with curl and an admin token.
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
 *  rendered as one. */
const CHECKOUT_FAILED = 'Could not start checkout — try again.';

/** The sibling of CHECKOUT_FAILED, for the other hosted page. Same rule: this is the ONE message
 *  this panel is willing to show for a failure it does not recognise — the browser's own
 *  "Failed to fetch" is not a plan problem and must not be rendered as one. */
const PORTAL_FAILED = 'Could not open plan management — try again.';

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
  handleError,
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
  /** The dashboard's own failure path (App.tsx's `handle`). A 401 or 403 from the checkout call
   *  means the session this panel needs has gone, and signing her out is the only response that
   *  leads anywhere. */
  handleError: (e: unknown) => void;
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
  /** What the row says, in the sitter's own terms. `null` is not "free" and not an error — it is a
   *  sitter who has never subscribed, which is most of them. */
  const planName = settings.plan === null ? 'No plan yet' : PLAN_NAMES[settings.plan];
  /** RENDERED, never compared. `planActive` is the server's answer to "is it live"; this string is
   *  only ever the date beside it. */
  const paidThrough = settings.billedUntil === null ? null : formatTimestamp(settings.billedUntil);
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
        // An ApiError rather than a plain one, so a 401 reaches `isAuthExpired` below and signs her
        // out instead of reading as "the button is broken".
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
      if (isAuthExpired(e)) return handleError(e);
      // ONLY an ApiError's message, which is the free product's or the billing worker's own words.
      // Anything else is the browser's — "Failed to fetch", "NetworkError when attempting to fetch
      // resource" — and rendering it tells a sitter her plan is broken when her wifi is.
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
   * string-and-https check on the returned URL, the top-level navigation, and an ApiError so a
   * 401 signs her out instead of reading as "the button is broken".
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
        throw new ApiError(res.status, body.error ?? PORTAL_FAILED);
      }
      const { url } = (await res.json()) as { url?: unknown };
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(PORTAL_FAILED);
      navigated = true;
      openAtTopLevel(url);
    } catch (e) {
      if (isAuthExpired(e)) return handleError(e);
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
   * MANAGE PLAN renders on the published origin, a billing account, a LIVE plan and an account that
   * is switched on — and on neither of the deployment's other two flags. Not `pricing.subscribe`:
   * that switch is about SELLING, and a sitter who already pays must be able to change her card and
   * cancel after a deployment stops taking new subscriptions. Not `premium.assistant`: that is the
   * tenant's entitlement, false for a Solo subscriber who nonetheless has a plan to manage — the
   * same distinction the Subscribe half above draws.
   *
   * `planActive` AS WELL AS `hasBillingAccount`, and that pair is the whole of the gate ruling. The
   * earlier reading was `hasBillingAccount` alone, on the argument that a sitter whose card died is
   * precisely who needs the portal. The flaw is that `StripeCustomerId` is never cleared once
   * written — `applyBillingEvent` COALESCEs it and no route in this product clears it — so a billing
   * account outlives every subscription it ever had. A sitter who cancelled a year ago therefore
   * kept a Manage-plan button pointed at a subscription that no longer exists, AND never saw
   * Subscribe again, which is the one control she actually wanted. A live plan is the thing there is
   * something to manage; a lapsed one is something to buy, and `planActive` is what tells them
   * apart. Her card dying is not a lapse on the instant either: the processor retries for days, and
   * `BilledUntil` is paid-through, not last-charged.
   */
  const canManage =
    origin !== null && settings.hasBillingAccount && settings.planActive && !settings.disabled;

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
      <p>
        <strong>{planName}</strong>
        {paidThrough !== null && ` — ${paidThroughWord} ${paidThrough}`}
      </p>
      {/* SUBSCRIBE AND MANAGE ARE MUTUALLY EXCLUSIVE, on `planActive` — negated here, plain in
          `canManage` — so there is no state in which both render and none in which neither does for
          a sitter a deployment is selling to. This is the UI half of the double-subscription
          question; the other half is a server-side refusal on the checkout route, which is the paid
          surface's to build — a UI is not a guard, because that route is reachable with curl and an
          admin token. A LAPSED sitter is offered Subscribe whether or not she has an old billing
          account, because a customer record at the processor is not a subscription. */}
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
        <p>
          <button type="button" disabled={busy !== null} onClick={() => void openPortal()}>
            {busy === 'portal' ? 'Opening…' : 'Manage plan'}
          </button>
        </p>
      )}
      {configLoaded && settings.hasBillingAccount && settings.planActive && origin === null && (
        <p className="pb-hint">{PORTAL_UNAVAILABLE}</p>
      )}
      {error && <p className="pb-error">{error}</p>}
    </>
  );
}
