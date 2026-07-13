import { Hono } from 'hono';
import {
  addBookingPets,
  deleteBookingRequest,
  getEndUserById,
  insertBookingRequest,
  listBookingPetsForUser,
  listBookingsForUser,
  listEndUserPets,
  listPetTypes,
  listServiceOptions,
  listServices,
} from '../db/repo';
import { checkAvailability, estimateCost, monthAvailability } from '../lib/availability';
import { syncBookingToCalendar } from '../lib/calendar-sync';
import { endUserAuth } from '../lib/middleware';
import { isValidPetCount, validateBoardingRange, validateSingleDate } from '../lib/validation';
import {
  nightsBetween,
  validateAnswers,
  validateServiceConstraints,
} from '../../src/shared/index.js';
import type { AppEnv } from '../types';

export const bookingRoutes = new Hono<AppEnv>()
  // Scoped tightly to the booking paths so the merged middleware never guards public routes.
  .use('/:slug/me', endUserAuth)
  .use('/:slug/availability/month', endUserAuth)
  .use('/:slug/bookings', endUserAuth)
  .use('/:slug/bookings/*', endUserAuth)

  .get('/:slug/availability/month', async (c) => {
    const tenant = c.get('tenant');
    const type = c.req.query('type');
    const month = c.req.query('month') ?? '';
    const optionKey = c.req.query('option');
    const services = await listServices(c.env.PAWBOOK_DB, tenant.Id);
    const service = services.find((s) => s.ServiceType === type);
    if (!service) return c.json({ error: 'Unknown service type.' }, 400);
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'Bad month.' }, 400);
    const options = await listServiceOptions(c.env.PAWBOOK_DB, tenant.Id);
    const serviceOptions = options.filter((o) => o.ServiceType === type);
    let option = serviceOptions[0] ?? null;
    if (optionKey) {
      // An unmatched key must error, not silently drop the capacity filter — a stale key (e.g.
      // a customer's widget holding one from before the sitter renamed the option) would
      // otherwise show every day as available, ignoring the option's real capacity.
      const found = serviceOptions.find((o) => o.OptionKey === optionKey);
      if (!found) return c.json({ error: 'Unknown service option.' }, 400);
      option = found;
    }
    const result = await monthAvailability(
      c.env,
      tenant,
      service,
      month,
      c.get('endUserId'),
      option,
    );
    return c.json(result);
  })

  .get('/:slug/me', async (c) => {
    const tenant = c.get('tenant');
    const user = await getEndUserById(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId'));
    const pets = await listEndUserPets(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId'));
    return c.json({
      name: user?.Name ?? null,
      pets: pets.map((p) => ({ id: p.Id, name: p.Name, petType: p.PetType })),
    });
  })

  .post('/:slug/bookings', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{
        type?: string;
        startDate?: string;
        endDate?: string;
        optionKey?: string;
        petIds?: unknown;
        answers?: unknown;
      }>()
      .catch(() => ({}) as Record<string, never>);
    const type = body.type;
    const start = typeof body.startDate === 'string' ? body.startDate : '';
    const end = typeof body.endDate === 'string' ? body.endDate : '';
    const rawPetIds = Array.isArray(body.petIds)
      ? body.petIds.filter((x): x is string => typeof x === 'string')
      : [];
    const petIds = [...new Set(rawPetIds)];
    const rawAnswers = body.answers;
    const answers: Record<string, string> =
      rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)
        ? Object.fromEntries(
            Object.entries(rawAnswers as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {};

    const services = await listServices(c.env.PAWBOOK_DB, tenant.Id);
    const service = services.find((s) => s.ServiceType === type);
    if (!service) return c.json({ error: 'Unknown service type.' }, 400);
    if (petIds.length === 0) return c.json({ error: 'Choose at least one pet.' }, 400);

    const myPets = await listEndUserPets(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId'));
    const chosen = petIds.map((id) => myPets.find((p) => p.Id === id));
    if (chosen.some((p) => !p)) return c.json({ error: 'Unknown pet.' }, 400);
    const pets = chosen.length;
    if (!isValidPetCount(pets)) return c.json({ error: 'Too many pets.' }, 400);
    const acceptedTypes = await listPetTypes(c.env.PAWBOOK_DB, tenant.Id);
    for (const p of chosen) {
      if (!acceptedTypes.find((pt) => pt.PetType === p!.PetType && pt.Enabled))
        return c.json({ error: 'That pet type is not accepted.' }, 400);
    }
    const petType = chosen[0]!.PetType;

    if (!service.Enabled) return c.json({ error: 'Service not offered.' }, 400);

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

    // Re-validate dates at submit time with the same logic the widget used (PRD FR13).
    const shape = service.Shape;
    const dateError =
      shape === 'range'
        ? validateBoardingRange(start, end, tenant.MaxStayNights, tenant.Timezone ?? undefined)
        : validateSingleDate(start, tenant.Timezone ?? undefined);
    if (dateError) return c.json({ error: dateError.error }, dateError.status);
    const endDate = shape === 'range' ? end : null;

    const nights = shape === 'range' ? nightsBetween(start, end) : null;

    const answersError = validateAnswers(service.Questions, answers);
    if (answersError) return c.json({ error: answersError }, 400);

    const constraintsError = validateServiceConstraints(
      {
        minNights: service.MinNights,
        maxNights: service.MaxNights,
        minPetCount: service.MinPetCount,
        maxPetCount: service.MaxPetCount,
      },
      { nights, petCount: pets },
    );
    if (constraintsError) return c.json({ error: constraintsError }, 400);

    // Price is computed server-side (never trusted from the client) and is pure — no DB read.
    const estCost = estimateCost(service, option, start, end);

    // Optimistic insert, then a single capacity check that excludes our own just-inserted row.
    // The check covers both "those dates were already full" and the check-then-insert race (a
    // concurrent booking taking the last slot); either way we delete and 409. Two simultaneous
    // racers may both roll back — fail-safe, never an overbooking. This is the ONLY capacity read.
    const id = await insertBookingRequest(c.env.PAWBOOK_DB, tenant.Id, {
      endUserId: c.get('endUserId'),
      serviceType: service.ServiceType,
      startDate: start,
      endDate,
      optionKey: option.OptionKey,
      petType,
      petCount: pets,
      startTime: option.StartTime,
      estCost,
      status: 'pending',
      answers,
    });

    let check;
    try {
      check = await checkAvailability(c.env, tenant, service, option, start, end, pets, id);
      if (!check.available) {
        await deleteBookingRequest(c.env.PAWBOOK_DB, tenant.Id, id);
        return c.json({ error: 'Sorry — those dates just filled up.' }, 409);
      }
      await addBookingPets(c.env.PAWBOOK_DB, tenant.Id, id, petIds);
    } catch (err) {
      // The optimistic row is already persisted; if the capacity check or pet insert fails,
      // don't leave it orphaned (a pending row counts against capacity and never expires).
      // Best-effort cleanup, then surface the original error.
      await deleteBookingRequest(c.env.PAWBOOK_DB, tenant.Id, id).catch(() => {});
      throw err;
    }

    // Best-effort calendar sync — never blocks or fails the booking. Use waitUntil in production;
    // in tests (no ExecutionContext) await it so behavior is deterministic.
    const sync = syncBookingToCalendar(c.env, tenant, {
      bookingId: id,
      endUserId: c.get('endUserId'),
      serviceType: service.ServiceType,
      serviceLabel: service.Label,
      startDate: start,
      endDate,
      startTime: option.StartTime,
      durationMinutes: option.DurationMinutes,
      petCount: pets,
      estCost,
    }).catch((err) => {
      console.error('calendar sync failed', err);
    });
    try {
      c.executionCtx.waitUntil(sync);
    } catch {
      await sync;
    }

    return c.json({ id, estCost, status: 'pending' }, 201);
  })

  .get('/:slug/bookings/mine', async (c) => {
    const tenant = c.get('tenant');
    const rows = await listBookingsForUser(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId'));
    const petRows = await listBookingPetsForUser(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId'));
    const petsByBooking = new Map<string, string[]>();
    for (const pr of petRows) {
      const list = petsByBooking.get(pr.BookingRequestId) ?? [];
      list.push(pr.Name);
      petsByBooking.set(pr.BookingRequestId, list);
    }
    return c.json({
      bookings: rows.map((r) => ({
        id: r.Id,
        type: r.ServiceType,
        startDate: r.StartDate,
        endDate: r.EndDate,
        petCount: r.PetCount,
        pets: petsByBooking.get(r.Id) ?? [],
        estCost: r.EstCost,
        status: r.Declined ? 'declined' : r.Status,
      })),
    });
  });
