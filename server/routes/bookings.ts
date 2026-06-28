import { Hono } from 'hono';
import {
  deleteBookingRequest,
  insertBookingRequest,
  listBookingsForUser,
  listPetTypes,
  listServiceOptions,
  listServices,
} from '../db/repo';
import { checkAvailability, estimateCost } from '../lib/availability';
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

    // Re-validate dates at submit time with the same logic the widget used (PRD FR13).
    const shape = SERVICE_CATALOG[type].shape;
    const dateError =
      shape === 'range'
        ? validateBoardingRange(start, end, tenant.MaxStayNights, tenant.Timezone ?? undefined)
        : validateSingleDate(start, tenant.Timezone ?? undefined);
    if (dateError) return c.json({ error: dateError.error }, dateError.status);
    const endDate = shape === 'range' ? end : null;

    // Price is computed server-side (never trusted from the client) and is pure — no DB read.
    const estCost = estimateCost(type, option, start, end);

    // Optimistic insert, then a single capacity check that excludes our own just-inserted row.
    // The check covers both "those dates were already full" and the check-then-insert race (a
    // concurrent booking taking the last slot); either way we delete and 409. Two simultaneous
    // racers may both roll back — fail-safe, never an overbooking. This is the ONLY capacity read.
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

    let check;
    try {
      check = await checkAvailability(c.env, tenant, type, option, start, end, pets, id);
    } catch (err) {
      // The optimistic row is already persisted; if the capacity check fails, don't leave it
      // orphaned (a pending row counts against capacity and never expires). Best-effort cleanup,
      // then surface the original error.
      await deleteBookingRequest(c.env.PAWBOOK_DB, tenant.Id, id).catch(() => {});
      throw err;
    }
    if (!check.available) {
      await deleteBookingRequest(c.env.PAWBOOK_DB, tenant.Id, id);
      return c.json({ error: 'Sorry — those dates just filled up.' }, 409);
    }

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
