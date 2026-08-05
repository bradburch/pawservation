import { Hono } from 'hono';
import { listPetTypes, listServiceOptions, listServices } from '../db/repo';
import { isPremiumActive, premiumOrigin } from '../lib/premium';
import type { AppEnv } from '../types';

export const publicRoutes = new Hono<AppEnv>().get('/:slug/config', async (c) => {
  const tenant = c.get('tenant');
  const [services, options, petTypes] = await Promise.all([
    listServices(c.env.PAWSERVATION_DB, tenant.Id),
    listServiceOptions(c.env.PAWSERVATION_DB, tenant.Id),
    listPetTypes(c.env.PAWSERVATION_DB, tenant.Id),
  ]);
  // All three flags are the SAME derived boolean — `PremiumUntil > now`, computed server-side —
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
        // with it. The quote's estCost remains the only money the widget renders.
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
