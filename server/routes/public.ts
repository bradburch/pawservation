import { Hono } from 'hono';
import { listPetTypes, listServiceOptions, listServices } from '../db/repo';
import { isPremiumActive, planSubscribeEnabled, premiumOrigin } from '../lib/premium';
import { PRICING } from '../lib/plan-pricing';
import { UNKNOWN_TENANT } from '../lib/middleware';
import type { AppEnv } from '../types';

export const publicRoutes = new Hono<AppEnv>().get('/:slug/config', async (c) => {
  /**
   * NO TENANT RESOLVED, and it is reachable. `tenantMiddleware` calls `next()` for any word in
   * `RESERVED_SLUGS` without setting one, so `/api/billing/config` — and `/api/owner/config`, and
   * the other three — arrive here with nothing on the context. Dereferencing it is a TypeError,
   * which surfaces as a 500 and tells a prober that the word is special. Answered as the unknown
   * tenant it is, the same guard `adminAuth` and `routes/billing.ts` already carry.
   */
  const tenant = c.get('tenant');
  if (!tenant) return c.json(UNKNOWN_TENANT, 404);
  const [services, options, petTypes] = await Promise.all([
    listServices(c.env.PAWSERVATION_DB, tenant.Id),
    listServiceOptions(c.env.PAWSERVATION_DB, tenant.Id),
    listPetTypes(c.env.PAWSERVATION_DB, tenant.Id),
  ]);
  // All three flags are the SAME derived boolean — `isPremiumActive` (server/lib/premium.ts),
  // computed server-side and never here: since 0017 it is an owner comp OR a paid Pro plan, and a
  // route that spelled the comparison out would be a second copy of a rule that has two halves —
  // published under three names because a surface asks "should I mount?" about itself, not about
  // the subscription. They are separate keys so that if they ever stop being the same answer, the
  // shape does not have to change under a consumer that already reads them. Nothing here knows what
  // any of them enables; that belongs to whatever reads the flag.
  const premiumActive = isPremiumActive(tenant);
  return c.json({
    slug: tenant.Slug,
    disabled: tenant.DisabledAt != null,
    premium: {
      assistant: premiumActive,
      chat: premiumActive,
      mcp: premiumActive,
      // A setting of the DEPLOYMENT, not of the tenant, so it is published whether or not this
      // tenant is entitled: an embed on a `*.workers.dev` host has no route matching and cannot
      // resolve a relative path, so the absolute origin has to come from somewhere it can read.
      // NULL when this deployment configures no `PREMIUM_ORIGIN` — there is no default, because a
      // free, public codebase naming the paid product's domain would hand every other deployment
      // somebody else's host. Null means "no premium surface here", which is what an unentitled
      // tenant already renders.
      origin: premiumOrigin(c.env),
    },
    // THE PUBLISHED PLAN FIGURES — the same `PRICING` the landing page, llms.txt and the JSON-LD
    // offers interpolate (server/lib/plan-pricing.ts), carried on the wire so that two consumers
    // which cannot import a server module can still state them: the admin dashboard's plan panel,
    // and whatever runs a checkout, which needs `trialDays` and must not hold a second copy of it.
    //
    // FIGURES ONLY. Nothing here is about THIS tenant, deliberately: this endpoint is
    // unauthenticated and is fetched by every widget on every sitter's public website, so a plan,
    // a renewal date or a processor id published here would be a business's commercial position in
    // front of its own visitors. Plan state belongs on the admin settings read, behind a session.
    pricing: {
      soloMonthly: PRICING.soloMonthly,
      proMonthly: PRICING.proMonthly,
      proAnnual: PRICING.proAnnual,
      trialDays: PRICING.trialDays,
      // NOT A FIGURE, and the one field here that is about this DEPLOYMENT rather than the product:
      // is selling switched on (`PLAN_SUBSCRIBE`, unset = off). It rides on `pricing` because its
      // only consumer is the one that reads the figures — the dashboard's plan panel, which renders
      // a Subscribe control only when a checkout route is live to receive the press. It says
      // nothing about this tenant, so it is as publishable as the figures beside it.
      subscribe: planSubscribeEnabled(c.env),
    },
    displayName: tenant.DisplayName,
    accentColor: tenant.AccentColor,
    timezone: tenant.Timezone,
    contactEmail: tenant.ContactEmail,
    contactPhone: tenant.ContactPhone,
    petTypes: petTypes.map((p) => ({ slug: p.PetType, label: p.Label })),
    services: services
      .filter((s) => s.Enabled)
      .map((svc) => ({
        type: svc.ServiceType,
        label: svc.Label,
        icon: svc.Icon,
        description: svc.Description,
        shape: svc.Shape,
        rateUnit: svc.RateUnit,
        hasDuration: Boolean(svc.HasDuration),
        questions: svc.Questions,
        maxNights: svc.MaxNights,
        maxPetCount: svc.MaxPetCount,
        acceptedPetTypes: svc.AcceptedPetTypes,
        cancellationTiers: svc.CancellationTiers,
        // Published so the widget can LABEL holiday days and show the rate — it never prices
        // with it. The quote's estimate remains the only money the widget renders.
        holidayRate: svc.HolidayRate,
        options: options
          .filter((o) => o.ServiceType === svc.ServiceType)
          .map((o) => ({
            optionKey: o.OptionKey,
            label: o.Label,
            durationMinutes: o.DurationMinutes,
            rate: o.Rate,
            startTime: o.StartTime,
            endTime: o.EndTime,
            capacity: o.Capacity,
            weekdaysOnly: Boolean(o.WeekdaysOnly),
          })),
      })),
  });
});
