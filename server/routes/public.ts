import { Hono } from 'hono';
import { listPetTypes, listServiceOptions, listServices } from '../db/repo';
import { checkAvailability } from '../lib/availability';
import { isValidPetCount, validateBoardingRange, validateSingleDate } from '../lib/validation';
import type { AppEnv } from '../types';

export const publicRoutes = new Hono<AppEnv>()
  .get('/:slug/config', async (c) => {
    const tenant = c.get('tenant');
    const [services, options, petTypes] = await Promise.all([
      listServices(c.env.PAWBOOK_DB, tenant.Id),
      listServiceOptions(c.env.PAWBOOK_DB, tenant.Id),
      listPetTypes(c.env.PAWBOOK_DB, tenant.Id),
    ]);
    return c.json({
      slug: tenant.Slug,
      displayName: tenant.DisplayName,
      accentColor: tenant.AccentColor,
      maxBoardingPets: tenant.MaxBoardingPets,
      maxHouseSitsPerDay: tenant.MaxHouseSitsPerDay,
      maxStayNights: tenant.MaxStayNights,
      timezone: tenant.Timezone,
      contactEmail: tenant.ContactEmail,
      contactPhone: tenant.ContactPhone,
      petTypes: petTypes.filter((p) => p.Enabled).map((p) => p.PetType),
      services: services
        .filter((s) => s.Enabled)
        .map((svc) => ({
          type: svc.ServiceType,
          label: svc.Label,
          icon: svc.Icon,
          shape: svc.Shape,
          rateUnit: svc.RateUnit,
          hasDuration: Boolean(svc.HasDuration),
          questions: svc.Questions,
          minNights: svc.MinNights,
          maxNights: svc.MaxNights,
          minPetCount: svc.MinPetCount,
          maxPetCount: svc.MaxPetCount,
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
            })),
        })),
    });
  })

  .get('/:slug/availability', async (c) => {
    const tenant = c.get('tenant');
    const type = c.req.query('type');
    const optionKey = c.req.query('option') ?? '';
    const start = c.req.query('start') ?? '';
    const end = c.req.query('end') ?? '';
    const pets = Number(c.req.query('pets') ?? '1');

    if (typeof type !== 'string' || !type) return c.json({ error: 'Unknown service type.' }, 400);
    if (!isValidPetCount(pets)) return c.json({ error: 'Invalid pet count.' }, 400);

    const [services, options] = await Promise.all([
      listServices(c.env.PAWBOOK_DB, tenant.Id),
      listServiceOptions(c.env.PAWBOOK_DB, tenant.Id),
    ]);
    const service = services.find((s) => s.ServiceType === type);
    if (!service) return c.json({ error: 'Unknown service type.' }, 400);
    if (!service.Enabled) return c.json({ error: 'Service not offered.' }, 400);
    const serviceOptions = options.filter((o) => o.ServiceType === type);
    const option = optionKey
      ? serviceOptions.find((o) => o.OptionKey === optionKey)
      : serviceOptions[0];
    if (!option) return c.json({ error: 'Unknown service option.' }, 400);

    if (service.Shape === 'range') {
      const rangeError = validateBoardingRange(
        start,
        end,
        tenant.MaxStayNights,
        tenant.Timezone ?? undefined,
      );
      if (rangeError) return c.json({ error: rangeError.error }, rangeError.status);
      return c.json(await checkAvailability(c.env, tenant, service, option, start, end, pets));
    }
    const dateError = validateSingleDate(start, tenant.Timezone ?? undefined);
    if (dateError) return c.json({ error: dateError.error }, dateError.status);
    return c.json(await checkAvailability(c.env, tenant, service, option, start, ''));
  });
