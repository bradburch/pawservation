import { Hono } from 'hono';
import { listPetTypes, listServiceOptions, listServices } from '../db/repo';
import type { AppEnv } from '../types';

export const publicRoutes = new Hono<AppEnv>().get('/:slug/config', async (c) => {
  const tenant = c.get('tenant');
  const [services, options, petTypes] = await Promise.all([
    listServices(c.env.PAWBOOK_DB, tenant.Id),
    listServiceOptions(c.env.PAWBOOK_DB, tenant.Id),
    listPetTypes(c.env.PAWBOOK_DB, tenant.Id),
  ]);
  return c.json({
    slug: tenant.Slug,
    disabled: tenant.DisabledAt != null,
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
