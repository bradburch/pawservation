import { useEffect, useState } from 'react';
import { api, ApiError, isAuthExpired, type TenantConfig } from '../shared-ui/api.js';
import type { Session } from './shared.js';
import { Hint } from './Hint';

/**
 * SUBSCRIBE TO A PLAN. Two plans, the published figures, and one control per plan that starts a
 * hosted checkout.
 *
 * THE GATE IS `premium.origin`, NOT the entitlement flag published beside it, and the difference is
 * the whole point. `assistant` is the tenant's entitlement — false for exactly the sitter who has
 * not bought yet, which is everyone this panel is for. `origin` is a property of the DEPLOYMENT: it
 * says a checkout exists to be started at all. The audit card in ServicesSection gates on
 * `assistant` because it embeds a paid surface; this one gates on `origin` because it sells one. Do
 * not make them match. (The pin in `server/__tests__/plan-panel.test.ts` reads this file, so the
 * two-word form of that flag is not written here even in prose.)
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
 * later stories, and they read an authenticated route rather than this public one.
 */

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

  const subscribe = async (offer: PlanOffer) => {
    if (busy || !origin) return;
    setError('');
    setBusy(`${offer.key}-${offer.interval}`);
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
        throw new ApiError(res.status, body.error ?? 'Could not start checkout — try again.');
      }
      const { url } = (await res.json()) as { url?: string };
      if (!url) throw new Error('Could not start checkout — try again.');
      // Top-level, not this frame: a hosted checkout page refuses to be framed.
      window.top!.location.assign(url);
    } catch (e) {
      if (isAuthExpired(e)) return handleError(e);
      setError(e instanceof Error ? e.message : 'Could not start checkout — try again.');
    } finally {
      setBusy(null);
    }
  };

  if (!origin || !pricing) return null;

  return (
    <>
      <h3>
        Your plan
        <Hint label="Your plan">
          Payment is handled by Stripe on their own page — we never see your card. Your{' '}
          {pricing.trialDays}-day free trial starts when you subscribe, and you can cancel from here
          before it ends.
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
            <button type="button" disabled={busy !== null} onClick={() => void subscribe(offer)}>
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
