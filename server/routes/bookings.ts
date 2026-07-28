import { Hono } from 'hono';
import {
  addBookingPets,
  deleteBookingRequest,
  findBookingByIdempotencyKey,
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
import { DEMO_EMAIL } from '../lib/demo';
import { isUniqueViolation } from '../lib/db-errors';
import { endUserAuth } from '../lib/middleware';
import {
  isValidPetCount,
  isValidTimeString,
  validateBoardingRange,
  validateSingleDate,
} from '../lib/validation';
import {
  addDays,
  isWeekend,
  nightsBetween,
  validateAnswers,
  validatePetTypeAcceptance,
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
        startTime?: unknown;
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
    const rawStartTime =
      typeof body.startTime === 'string' && body.startTime !== '' ? body.startTime : null;

    const tenantId = tenant.Id;
    const endUserId = c.get('endUserId');

    // The reserved demo identity books like a real customer right up to persistence. One extra
    // indexed read; every other request pays it too, which keeps the two paths byte-identical
    // through validation and pricing.
    const requester = await getEndUserById(c.env.PAWBOOK_DB, tenantId, endUserId);
    const isDemo = requester?.Email === DEMO_EMAIL;

    const idemKey = c.req.header('Idempotency-Key')?.trim() || null;
    if (idemKey && idemKey.length > 128) {
      return c.json(
        {
          error: 'Idempotency-Key must be 128 characters or fewer.',
          code: 'invalid_idempotency_key',
        },
        400,
      );
    }
    if (idemKey) {
      const prior = await findBookingByIdempotencyKey(
        c.env.PAWBOOK_DB,
        tenantId,
        endUserId,
        idemKey,
      );
      if (prior) return c.json({ id: prior.Id, estCost: prior.EstCost, status: prior.Status }, 201);
    }

    const services = await listServices(c.env.PAWBOOK_DB, tenant.Id);
    const service = services.find((s) => s.ServiceType === type);
    if (!service)
      return c.json({ error: 'Unknown service type.', code: 'unknown_service_type' }, 400);
    if (petIds.length === 0)
      return c.json({ error: 'Choose at least one pet.', code: 'no_pets_selected' }, 400);

    const myPets = await listEndUserPets(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId'));
    const chosen = petIds.map((id) => myPets.find((p) => p.Id === id));
    if (chosen.some((p) => !p)) return c.json({ error: 'Unknown pet.', code: 'unknown_pet' }, 400);
    const pets = chosen.length;
    if (!isValidPetCount(pets))
      return c.json({ error: 'Too many pets.', code: 'too_many_pets' }, 400);
    const acceptedTypes = await listPetTypes(c.env.PAWBOOK_DB, tenant.Id);
    // Registry membership: a pet whose slug isn't a TenantPetTypes row at all is corrupt data.
    // The BEHAVIORAL gate is the per-service acceptance check below (0015 — the tenant-level
    // enabled switch is retired).
    for (const p of chosen) {
      if (!acceptedTypes.find((pt) => pt.PetType === p!.PetType))
        return c.json(
          { error: 'That pet type is not accepted.', code: 'pet_type_not_accepted' },
          400,
        );
    }
    const petType = chosen[0]!.PetType;

    // The service's OWN restriction — the single behavioral gate. A type is bookable iff some
    // enabled service accepts it, enforced per booking by that service's list (NULL = accepts
    // every registry type). Checks EVERY selected pet, not the denormalized single PetType.
    const labelBySlug = new Map(acceptedTypes.map((r) => [r.PetType, r.Label]));
    const acceptanceError = validatePetTypeAcceptance(
      service.AcceptedPetTypes,
      service.Label,
      chosen.map((p) => ({ name: p!.Name, petType: p!.PetType })),
      (petSlug) => labelBySlug.get(petSlug) ?? petSlug,
    );
    if (acceptanceError)
      return c.json({ error: acceptanceError, code: 'pet_type_not_accepted' }, 400);

    if (!service.Enabled)
      return c.json({ error: 'Service not offered.', code: 'service_not_offered' }, 400);

    const options = await listServiceOptions(c.env.PAWBOOK_DB, tenant.Id);

    // Select by optionKey when provided; fall back to first option for the service type.
    let option: (typeof options)[number] | undefined;
    if (body.optionKey !== undefined) {
      option = options.find((o) => o.ServiceType === type && o.OptionKey === body.optionKey);
      if (!option) return c.json({ error: 'Unknown service option.', code: 'unknown_option' }, 400);
    } else {
      option = options.find((o) => o.ServiceType === type);
      if (!option)
        return c.json({ error: 'Service not configured.', code: 'service_not_configured' }, 400);
    }

    // Re-validate dates at submit time with the same logic the widget used (PRD FR13).
    const shape = service.Shape;
    const dateError =
      shape === 'range'
        ? validateBoardingRange(start, end, service.MaxNights, tenant.Timezone ?? undefined)
        : validateSingleDate(start, tenant.Timezone ?? undefined);
    if (dateError)
      return c.json({ error: dateError.error, code: dateError.code }, dateError.status);

    // Optional customer-chosen arrival time — range stays only. Timed (single-day) services take
    // their clock from the option, so a client-supplied time there is a bug, not a preference.
    if (rawStartTime !== null) {
      if (shape !== 'range')
        return c.json(
          { error: 'An arrival time only applies to multi-day stays.', code: 'invalid_start_time' },
          400,
        );
      if (!isValidTimeString(rawStartTime))
        return c.json(
          {
            error: 'Arrival time must look like 14:30 (24-hour HH:MM).',
            code: 'invalid_start_time',
          },
          400,
        );
    }
    // One resolved value feeds BOTH the insert and the calendar sync so they can never disagree.
    const bookingStartTime = shape === 'range' ? rawStartTime : option.StartTime;

    // Weekday-only options (set per-option in admin) are never bookable on Sat/Sun. The flag is
    // settable on ANY option, including range-shaped services (boarding/housesitting) — a stay
    // can start and end on weekdays yet still cross a weekend in between — so every date in the
    // span must be checked, not just the start. Ranges are already bounded by max-stay
    // validation above, so a plain day-by-day loop is fine.
    if (option.WeekdaysOnly) {
      const spanNights = shape === 'range' ? nightsBetween(start, end) : 1;
      for (let i = 0; i < spanNights; i++) {
        if (isWeekend(addDays(start, i)))
          return c.json(
            {
              error: 'That option is only available on weekdays — pick a Monday–Friday date.',
              code: 'weekdays_only',
            },
            400,
          );
      }
    }
    const endDate = shape === 'range' ? end : null;

    const nights = shape === 'range' ? nightsBetween(start, end) : null;

    const answersError = validateAnswers(service.Questions, answers);
    if (answersError) return c.json({ error: answersError, code: 'invalid_answers' }, 400);

    const constraintsError = validateServiceConstraints(
      { maxNights: service.MaxNights, maxPetCount: service.MaxPetCount },
      { nights, petCount: pets },
    );
    if (constraintsError)
      return c.json({ error: constraintsError, code: 'service_constraint' }, 400);

    // Price is computed server-side (never trusted from the client) and is pure — no DB read.
    const estCost = estimateCost(service, option, start, end);

    if (isDemo) {
      // Zero-pollution demo: the FULL validation pipeline above already ran; now check capacity
      // against real bookings (the exclude id matches no row) and stop short of persisting
      // anything — no BookingRequests row, no BookingRequestPets, no calendar sync, so the
      // sitter's dashboard, capacity math, analytics, and emails never see this request. A
      // genuinely full date still 409s exactly like a real booking would.
      const demoCheck = await checkAvailability(
        c.env,
        tenant,
        service,
        option,
        start,
        end,
        pets,
        'demo-excludes-no-row',
      );
      if (!demoCheck.available)
        return c.json(
          { error: 'Sorry — those dates just filled up.', code: 'capacity_conflict' },
          409,
        );
      return c.json(
        {
          id: `demo_${crypto.randomUUID()}`,
          estCost,
          status: 'pending',
          demo: true,
          note: 'This was a demo — no booking was created.',
        },
        201,
      );
    }

    // Optimistic insert, then a single capacity check that excludes our own just-inserted row.
    // The check covers both "those dates were already full" and the check-then-insert race (a
    // concurrent booking taking the last slot); either way we delete and 409. Two simultaneous
    // racers may both roll back — fail-safe, never an overbooking. This is the ONLY capacity read.
    let id: string;
    try {
      id = await insertBookingRequest(c.env.PAWBOOK_DB, tenant.Id, {
        endUserId: c.get('endUserId'),
        serviceType: service.ServiceType,
        startDate: start,
        endDate,
        optionKey: option.OptionKey,
        petType,
        petCount: pets,
        startTime: bookingStartTime,
        estCost,
        status: 'pending',
        answers,
        idempotencyKey: idemKey,
      });
    } catch (e) {
      if (idemKey && isUniqueViolation(e)) {
        const prior = await findBookingByIdempotencyKey(
          c.env.PAWBOOK_DB,
          tenantId,
          endUserId,
          idemKey,
        );
        if (prior)
          return c.json({ id: prior.Id, estCost: prior.EstCost, status: prior.Status }, 201);
      }
      throw e;
    }

    let check;
    try {
      check = await checkAvailability(c.env, tenant, service, option, start, end, pets, id);
      if (!check.available) {
        await deleteBookingRequest(c.env.PAWBOOK_DB, tenant.Id, id);
        return c.json(
          { error: 'Sorry — those dates just filled up.', code: 'capacity_conflict' },
          409,
        );
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
      startTime: bookingStartTime,
      durationMinutes: option.DurationMinutes,
      petCount: pets,
      petNames: chosen.map((p) => p!.Name),
      estCost,
      status: 'pending',
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
        cancellationFee: r.CancellationFee,
        status: r.Status,
      })),
    });
  });
