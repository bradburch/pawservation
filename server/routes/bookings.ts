import { Hono } from 'hono';
import {
  insertBookingRequest,
  listBookingsForUser,
  listPetTypes,
  listServiceOptions,
  listServices,
} from '../db/repo';
import { checkAvailability } from '../lib/availability';
import { SERVICE_CATALOG, isServiceType, isPetType } from '../lib/services';
import type { PetType } from '../lib/services';
import { endUserAuth } from '../lib/middleware';
import { isValidPetCount, validateBoardingRange, validateSingleDate } from '../lib/validation';
import type { AppEnv } from '../types';

export const bookingRoutes = new Hono<AppEnv>()
  // Scoped tightly to the booking paths so the merged middleware never guards public routes.
  .use('/:slug/bookings', endUserAuth)
  .use('/:slug/bookings/*', endUserAuth)

  .post('/:slug/bookings', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{
        type?: string;
        startDate?: string;
        endDate?: string;
        optionKey?: string;
        petType?: string;
        petCount?: number;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const type = body.type;
    const start = typeof body.startDate === 'string' ? body.startDate : '';
    const end = typeof body.endDate === 'string' ? body.endDate : '';
    const pets = body.petCount ?? 1;

    if (!isServiceType(type)) return c.json({ error: 'Unknown service type.' }, 400);
    if (!isValidPetCount(pets)) return c.json({ error: 'Invalid pet count.' }, 400);

    // Validate petType against the known set first, then against tenant-accepted types.
    if (body.petType !== undefined && !isPetType(body.petType)) {
      return c.json({ error: 'Unknown pet type.' }, 400);
    }
    const petType = (body.petType as PetType | undefined) ?? null;

    const services = await listServices(c.env.PAWBOOK_DB, tenant.Id);
    const service = services.find((s) => s.ServiceType === type && s.Enabled);
    if (!service) return c.json({ error: 'Service not offered.' }, 400);

    const options = await listServiceOptions(c.env.PAWBOOK_DB, tenant.Id);

    // Select by optionKey when provided; fall back to first option for the service type.
    let option: (typeof options)[number] | undefined;
    if (body.optionKey !== undefined) {
      option = options.find((o) => o.ServiceType === type && o.OptionKey === body.optionKey);
      if (!option) return c.json({ error: 'Unknown service option.' }, 400);
    } else {
      option = options.find((o) => o.ServiceType === type);
      if (!option) return c.json({ error: 'Service not configured.' }, 400);
    }

    // Validate petType against the species this tenant actually accepts.
    if (petType !== null) {
      const tenantPetTypes = await listPetTypes(c.env.PAWBOOK_DB, tenant.Id);
      const accepted = tenantPetTypes.find((pt) => pt.PetType === petType && pt.Enabled);
      if (!accepted) return c.json({ error: 'That pet type is not accepted.' }, 400);
    }

    // Re-validate at submit time with the same logic the widget used (PRD FR13).
    let estCost: number;
    let endDate: string | null;
    const shape = SERVICE_CATALOG[type].shape;
    if (shape === 'range') {
      const rangeError = validateBoardingRange(start, end);
      if (rangeError) return c.json({ error: rangeError.error }, rangeError.status);
      const result = await checkAvailability(c.env, tenant, type, option, start, end, pets);
      if (!result.available) return c.json({ error: 'Sorry — those dates just filled up.' }, 409);
      estCost = result.estCost;
      endDate = end;
    } else {
      const dateError = validateSingleDate(start);
      if (dateError) return c.json({ error: dateError.error }, dateError.status);
      const result = await checkAvailability(c.env, tenant, type, option, start, end, pets);
      if (!result.available) return c.json({ error: 'Sorry — that day just filled up.' }, 409);
      estCost = result.estCost;
      endDate = null;
    }

    const id = await insertBookingRequest(c.env.PAWBOOK_DB, tenant.Id, {
      endUserId: c.get('endUserId'),
      serviceType: type,
      startDate: start,
      endDate,
      optionKey: option.OptionKey,
      petType,
      petCount: pets,
      estCost,
      status: 'pending',
    });
    return c.json({ id, estCost, status: 'pending' }, 201);
  })

  .get('/:slug/bookings/mine', async (c) => {
    const tenant = c.get('tenant');
    const rows = await listBookingsForUser(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId'));
    return c.json({
      bookings: rows.map((r) => ({
        id: r.Id,
        type: r.ServiceType,
        startDate: r.StartDate,
        endDate: r.EndDate,
        petCount: r.PetCount,
        estCost: r.EstCost,
        status: r.Status,
      })),
    });
  });
