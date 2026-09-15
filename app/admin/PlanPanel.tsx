import { useEffect, useState } from 'react';
import { api, ApiError, isAuthExpired, type TenantConfig } from '../shared-ui/api.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/**
 * SUBSCRIBE TO A PLAN. Two plans, the published figures, and one control per plan that starts a
 * hosted checkout.
 *
 * THE GATE IS TWO PROPERTIES OF THE DEPLOYMENT, and never the entitlement flag published beside
 * them. `assistant` is the tenant's entitlement — false for exactly the sitter who has not bought
 * yet, which is everyone this panel is for. The audit card in ServicesSection gates on it because
 * it embeds a paid surface; this one sells one, so it must not. Do not make them match.
 *
 *   - `premium.origin` — a checkout worker EXISTS to be reached at all, and where.
 *   - `pricing.subscribe` — selling is switched ON (`PLAN_SUBSCRIBE`, unset = off). `PREMIUM_ORIGIN`
 *     is already set in production, so `origin` alone would put a live Subscribe button in front of
 *     every sitter the day this merges and every press would 404 against a checkout route Story
 *     10.2 has not shipped. The operator flips the flag when that route is live.
 *
 * And a DISABLED tenant is never offered a plan: her account cannot take a booking, so asking her
 * for a card is worse than showing nothing.
 *
 * A `fetch` AND NOT AN ANCHOR: the admin session is a JWT in localStorage and an anchor carries no
 * Authorization header — `app/shared-ui/api.ts`'s `exportCsv` docblock is where this repo already
 * writes that down. The returned URL is then opened on `window.top`, because a hosted checkout sets
 * its own frame-ancestors and will not render inside a frame.
 *
 * It fetches `/config` itself, exactly as SettingsReviewEmbed does: one more read of a cached public
 * endpoint is cheaper than threading new state through App.tsx, and it keeps the panel
 * self-contained. A failed read renders NOTHING — absence, not an error — because a dashboard that
 * shows a broken plan box is worse than one that shows no plan box.
 *
 * No plan STATE is shown here yet: what she is on, when it renews, and what to do when it lapses are
 * later stories, and they read an authenticated route rather than this public one. NOTHING HERE
 * PROMISES A CANCELLATION CONTROL for the same reason — FR-62's Manage-plan surface is Story 10.3,
 * and the moment a sitter is asked for a card is the expensive place to promise a thing that is not
 * built.
 */

/** The one message this panel is willing to put in front of a sitter for a failure it does not
 *  recognise. The browser's own `TypeError: Failed to fetch` is not a plan problem and must not be
 *  rendered as one. */
const CHECKOUT_FAILED = 'Could not start checkout — try again.';

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

export function PlanPanel({
  session,
  handleError,
}: {
  session: Session;
  /** The dashboard's own failure path (App.tsx's `handle`). A 401 or 403 from the checkout call
   *  means the session this panel needs has gone, and signing her out is the only response that
   *  leads anywhere. */
  handleError: (e: unknown) => void;
}) {
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api
      .config(session.slug)
      .then((c) => {
        if (active) setConfig(c);
      })
      .catch(() => {
        /* absence, not an error — the section just renders without this panel */
      });
    return () => {
      active = false;
    };
  }, [session.slug]);

  const origin = config?.premium?.origin ?? null;
  const pricing = config?.pricing ?? null;
  /** Selling is switched on for this DEPLOYMENT (`PLAN_SUBSCRIBE`), not for this tenant. */
  const sellingIsOn = pricing?.subscribe === true;
  const disabled = config?.disabled === true;

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

  if (!origin || !sellingIsOn || disabled || !pricing) return null;

  return (
    <>
      <h3>
        Your plan
        <Hint label="Your plan">
          Payment is handled by Stripe on their own page — we never see your card. Your{' '}
          {pricing.trialDays}-day free trial starts when you subscribe.
        </Hint>
      </h3>
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
      {error && <p className="pb-error">{error}</p>}
      <p className="pb-hint">
        Every plan starts with a {pricing.trialDays}-day free trial. Nothing about your bookings,
        clients or pets changes when you subscribe — a plan only decides which extras are switched
        on.
      </p>
    </>
  );
}
