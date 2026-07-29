import { Hono } from 'hono';
import {
  addBookingPets,
  cancelBookingForUser,
  deleteBookingRequest,
  findBookingByIdempotencyKey,
  getBookingForUser,
  getBookingSyncData,
  getEndUserById,
  insertBookingRequest,
  listBookingPetsForUser,
  listBookingsForUser,
  listChargesForTenant,
  listEndUserPets,
  listPetNamesForBooking,
  listPetTypes,
  listServiceOptions,
  listServices,
} from '../db/repo';
import {
  checkAvailability,
  estimateCost,
  loadPetSetRates,
  monthAvailability,
} from '../lib/availability';
import {
  deleteBookingCalendarEvent,
  keepsCalendarEventOnCancel,
  reconcileIfStale,
  syncBookingToCalendar,
  updateBookingCalendarEvent,
} from '../lib/calendar-sync';
import { DEMO_EMAIL } from '../lib/demo';
import { isUniqueViolation } from '../lib/db-errors';
import { endUserAuth } from '../lib/middleware';
import {
  isValidPetCount,
  isValidTimeString,
  validateBoardingRange,
  validateBookingWindow,
  validateSingleDate,
} from '../lib/validation';
import {
  addDays,
  cancellationFee,
  DEFAULT_TIMEZONE,
  getPacificDateStr,
  isWeekend,
  nightsBetween,
  validateAnswers,
  validatePetTypeAcceptance,
  validateServiceConstraints,
  type CancellationTier,
} from '../../src/shared/index.js';
import type { AppEnv, BookingRow } from '../types';

/**
 * Can this customer still cancel this booking themselves? Terminal rows and stays that have
 * already finished are history, not actions. A stay ALREADY IN PROGRESS stays cancellable on
 * purpose: the fee schedule already prices a cancellation on or after the start date (0 days
 * out → the tightest tier), so refusing here would only push the customer to the phone.
 *
 * The server owns this rule and ships the answer as a boolean on `/bookings/mine`, so the widget
 * never does date math to decide whether to offer the action.
 */
function isCustomerCancellable(
  status: BookingRow['Status'],
  startDate: string,
  endDate: string | null,
  today: string,
): boolean {
  return (status === 'pending' || status === 'confirmed') && (endDate ?? startDate) >= today;
}

/**
 * What this customer would owe to cancel TODAY, in whole dollars. Computed here and nowhere else:
 * `/bookings/mine` sends it so the confirm step can state a figure, and the cancel route stamps
 * the same rule onto the row — the widget never computes money and never sends one.
 *
 * A PENDING request is always free. The tiers price breaking a commitment the SITTER has made,
 * and on a pending request she has not made it — the cancellation design already says declines
 * never charge, and a customer withdrawing a request the sitter never accepted is the same event
 * seen from the other side.
 */
function feeToCancelToday(
  status: BookingRow['Status'],
  estCost: number | null,
  startDate: string,
  tiers: CancellationTier[] | null,
  today: string,
): number {
  if (status !== 'confirmed' || estCost == null || !tiers) return 0;
  return cancellationFee(tiers, estCost, startDate, today);
}

export const bookingRoutes = new Hono<AppEnv>()
  // Scoped tightly to the booking paths so the merged middleware never guards public routes.
  .use('/:slug/me', endUserAuth)
  .use('/:slug/availability', endUserAuth)
  .use('/:slug/availability/month', endUserAuth)
  .use('/:slug/bookings', endUserAuth)
  .use('/:slug/bookings/*', endUserAuth)

  /**
   * The quote. Authenticated and pet-IDENTIFIED (design spec §5): it receives the caller's real
   * pet ids, validates every one against the PetOwners authority, and derives both rate keys from
   * that set — so the quote and the cost later stamped on the booking are computed from the same
   * pets and cannot diverge. It used to live in `publicRoutes` with a `pets` COUNT; a count can
   * neither be owned nor looked up, which is exactly why it is gone.
   */
  .get('/:slug/availability', async (c) => {
    const tenant = c.get('tenant');
    const type = c.req.query('type');
    const optionKey = c.req.query('option') ?? '';
    const start = c.req.query('start') ?? '';
    const end = c.req.query('end') ?? '';
    // Comma-joined: pet ids are crypto.randomUUID() values and so comma-free by construction —
    // the same property that makes `buildGroupKey`'s comma join unambiguous.
    const requestedPetIds = [
      ...new Set(
        (c.req.query('petIds') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];

    if (typeof type !== 'string' || !type) return c.json({ error: 'Unknown service type.' }, 400);
    if (requestedPetIds.length === 0) return c.json({ error: 'Choose at least one pet.' }, 400);
    // Bounds the ownership scan; same defensive cap the booking POST uses.
    if (!isValidPetCount(requestedPetIds.length)) return c.json({ error: 'Too many pets.' }, 400);

    const [services, options, myPets, acceptedTypes] = await Promise.all([
      listServices(c.env.PAWBOOK_DB, tenant.Id),
      listServiceOptions(c.env.PAWBOOK_DB, tenant.Id),
      // PetOwners-backed: a CO-OWNER may quote a pet they co-own, and a pet outside this
      // customer's ownership graph is simply not in the list.
      listEndUserPets(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId')),
      listPetTypes(c.env.PAWBOOK_DB, tenant.Id),
    ]);

    const chosen = requestedPetIds.map((id) => myPets.find((p) => p.Id === id));
    if (chosen.some((p) => !p)) return c.json({ error: 'Unknown pet.' }, 400);
    const pets = chosen.map((p) => ({ id: p!.Id, petType: p!.PetType }));

    const service = services.find((s) => s.ServiceType === type);
    if (!service) return c.json({ error: 'Unknown service type.' }, 400);
    if (!service.Enabled) return c.json({ error: 'Service not offered.' }, 400);
    const serviceOptions = options.filter((o) => o.ServiceType === type);
    const option = optionKey
      ? serviceOptions.find((o) => o.OptionKey === optionKey)
      : serviceOptions[0];
    if (!option) return c.json({ error: 'Unknown service option.' }, 400);

    // Mirrors the POST's acceptance gate (validatePetTypeAcceptance, run before pricing there
    // too): a cat quoted against a dogs-only service must get the acceptance message, not
    // "unpriced-pet-set" — the two are different refusals and the customer needs the right one.
    const labelBySlug = new Map(acceptedTypes.map((r) => [r.PetType, r.Label]));
    const acceptanceError = validatePetTypeAcceptance(
      service.AcceptedPetTypes,
      service.Label,
      chosen.map((p) => ({ name: p!.Name, petType: p!.PetType })),
      (petSlug) => labelBySlug.get(petSlug) ?? petSlug,
    );
    if (acceptanceError) return c.json({ error: acceptanceError }, 400);

    if (service.Shape === 'range') {
      const rangeError = validateBoardingRange(
        start,
        end,
        service.MaxNights,
        tenant.Timezone ?? undefined,
      );
      if (rangeError) return c.json({ error: rangeError.error }, rangeError.status);
      const windowError = validateBookingWindow(
        start,
        service.MinLeadDays,
        tenant.MaxAdvanceMonths,
        tenant.Timezone ?? undefined,
      );
      if (windowError) return c.json({ error: windowError.error }, windowError.status);
      // Same rule the POST applies (validateServiceConstraints) — a quote for more pets than the
      // service allows must refuse with the same friendly, structured shape the widget already
      // renders (bp-result.bp-no), not fall through to capacity/pricing.
      const constraintsError = validateServiceConstraints(
        { maxNights: service.MaxNights, maxPetCount: service.MaxPetCount },
        { nights: nightsBetween(start, end), petCount: pets.length },
      );
      if (constraintsError) return c.json({ error: constraintsError }, 400);
      // Read only once date/constraint validation has passed, saving two D1 reads on the 400
      // paths above — behavior is identical since checkAvailability is the only consumer.
      const rates = await loadPetSetRates(c.env, tenant.Id, service.ServiceType);
      return c.json(
        await checkAvailability(c.env, tenant, service, option, start, end, pets, rates),
      );
    }
    const dateError = validateSingleDate(start, tenant.Timezone ?? undefined);
    if (dateError) return c.json({ error: dateError.error }, dateError.status);
    const windowError = validateBookingWindow(
      start,
      service.MinLeadDays,
      tenant.MaxAdvanceMonths,
      tenant.Timezone ?? undefined,
    );
    if (windowError) return c.json({ error: windowError.error }, windowError.status);
    const constraintsError = validateServiceConstraints(
      { maxNights: service.MaxNights, maxPetCount: service.MaxPetCount },
      { nights: null, petCount: pets.length },
    );
    if (constraintsError) return c.json({ error: constraintsError }, 400);
    const rates = await loadPetSetRates(c.env, tenant.Id, service.ServiceType);
    return c.json(await checkAvailability(c.env, tenant, service, option, start, '', pets, rates));
  })

  .get('/:slug/availability/month', async (c) => {
    const tenant = c.get('tenant');
    const type = c.req.query('type');
    const month = c.req.query('month') ?? '';
    const optionKey = c.req.query('option');
    // The pets the grid is being painted FOR — same comma-joined ids the quote takes, and taken
    // as IDS rather than a count for the same reason: a count can neither be owned nor looked up,
    // so it could describe pets that don't exist and paint a grid the quote would then contradict.
    // Absent = 1 pet, which is exactly the pre-change behaviour.
    const requestedPetIds = [
      ...new Set(
        (c.req.query('petIds') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (!isValidPetCount(Math.max(1, requestedPetIds.length)))
      return c.json({ error: 'Too many pets.' }, 400);
    // Read concurrently: the ownership check must not add a serial round-trip to the widget's
    // hottest path (this GET refires on every month page AND every pet-selection change).
    const [services, myPets] = await Promise.all([
      listServices(c.env.PAWBOOK_DB, tenant.Id),
      requestedPetIds.length > 0
        ? listEndUserPets(c.env.PAWBOOK_DB, tenant.Id, c.get('endUserId'))
        : Promise.resolve(null),
    ]);
    const service = services.find((s) => s.ServiceType === type);
    if (!service) return c.json({ error: 'Unknown service type.' }, 400);
    if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'Bad month.' }, 400);
    // An id the caller doesn't own is refused rather than dropped: silently painting for fewer
    // pets than were asked about is the same class of lie the count-based grid was.
    if (myPets && requestedPetIds.some((id) => !myPets.some((p) => p.Id === id)))
      return c.json({ error: 'Unknown pet.' }, 400);
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
    // Pull Google's reality INTO the DB, throttled on the widget's own key (~10 min). Availability
    // itself still reads only D1 — reconcile is what writes a hand-deleted event or a foreign busy
    // day into BookingRequests, so the grid sees it as an ordinary row on a later load.
    //
    // Deliberately NOT awaited. `listCalendarEvents` has no timeout, so awaiting it would let a
    // HANGING Google block a customer-facing first paint until the platform kills the request —
    // "Couldn't load availability" caused by a third party the grid doesn't even read. Correctness
    // never depended on the ordering: the grid and the booking POST both read D1, so they agree
    // whenever the pull lands. The cost is at most a one-page-load lag on freshness, which the
    // 600s throttle already licenses away. (waitUntil in production; awaited in tests, which have
    // no ExecutionContext — the same dance as the booking POST and the OAuth callback.)
    // Suppressed for a disabled tenant: read-only, no GET-side writes.
    if (!tenant.DisabledAt) {
      // reconcileIfStale is documented as never throwing; the guard is insurance against a future
      // edit turning an unhandled rejection loose in a waitUntil task.
      const pull = reconcileIfStale(c.env, tenant, 'widget').catch((err) => {
        console.error('widget calendar pull failed', err);
      });
      try {
        c.executionCtx.waitUntil(pull);
      } catch {
        await pull;
      }
    }
    const result = await monthAvailability(
      c.env,
      tenant,
      service,
      month,
      c.get('endUserId'),
      option,
      Math.max(1, requestedPetIds.length),
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

    // The booking window (0004): per-service minimum notice + the business-wide horizon —
    // same rule the quote and the month grid enforce, so the three can never disagree.
    const windowError = validateBookingWindow(
      start,
      service.MinLeadDays,
      tenant.MaxAdvanceMonths,
      tenant.Timezone ?? undefined,
    );
    if (windowError)
      return c.json({ error: windowError.error, code: windowError.code }, windowError.status);

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

    // Price is computed server-side (never trusted from the client) — the request body carries no
    // cost field at all. The rate rows are read once here and reused by the capacity check's
    // pricing below, so the quote, this stamp, and the row that lands in D1 all come from ONE
    // resolution of ONE pet set.
    const pricedPets = chosen.map((p) => ({ id: p!.Id, petType: p!.PetType }));
    const rates = await loadPetSetRates(c.env, tenant.Id, service.ServiceType);
    const price = estimateCost(service, option, start, end, pricedPets, rates);
    if (!price.priced) {
      // Refused BEFORE the optimistic insert: an unpriced booking must not exist even briefly,
      // and there is no fallback number to write — a `?? 0` here would be the whole feature
      // defeated in four characters.
      return c.json(
        {
          error: `Ask ${tenant.DisplayName} for a price for this group of pets — they haven't set one yet.`,
          code: 'unpriced_pet_set',
        },
        400,
      );
    }
    const estCost = price.cost;

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
        pricedPets,
        rates,
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
      check = await checkAvailability(
        c.env,
        tenant,
        service,
        option,
        start,
        end,
        pricedPets,
        rates,
        id,
      );
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

  /**
   * Owner-initiated cancellation. The booking row is NEVER deleted — `BookingRequestPets` has no
   * ON DELETE CASCADE (D1 enforces FKs, so the DELETE would fail outright) and a deleted row with
   * a live GCalEventId orphans its Google event forever, since reconcile skips any event that
   * still carries a bookingId. `Status = 'cancelled'` gives the same visible outcome with none of
   * that.
   *
   * The fee is computed here, from the sitter's stored policy — the request body is not read at
   * all, so there is no dollar figure for a client to supply. Fee-free cancellations store a real
   * 0 and DELETE the Google event; a fee-bearing one stores the amount and RETITLES the event
   * `[CANCELLED] …` (keepsCalendarEventOnCancel — the same predicate the outbox re-drive consults,
   * or the next sweep would delete the event this route just retitled).
   */
  .post('/:slug/bookings/:id/cancel', async (c) => {
    const tenant = c.get('tenant');
    const endUserId = c.get('endUserId');
    const id = c.req.param('id');

    // Ownership is in the SQL, not in a check around it: another customer's id, an unknown id, and
    // a 'blocked'/'external' sentinel are all one indistinguishable 404 — no existence oracle.
    const booking = await getBookingForUser(c.env.PAWBOOK_DB, tenant.Id, endUserId, id);
    if (!booking) return c.json({ error: 'Not found.', code: 'unknown_booking' }, 404);

    const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
    const notCancellable = {
      error: `That booking can no longer be cancelled here — please contact ${tenant.DisplayName}.`,
      code: 'not_cancellable',
    } as const;
    if (!isCustomerCancellable(booking.Status, booking.StartDate, booking.EndDate, today))
      return c.json(notCancellable, 409);

    const services = await listServices(c.env.PAWBOOK_DB, tenant.Id);
    const service = services.find((s) => s.ServiceType === booking.ServiceType);
    const fee = feeToCancelToday(
      booking.Status,
      booking.EstCost,
      booking.StartDate,
      service?.CancellationTiers ?? null,
      today,
    );

    // The Status guard lives inside this UPDATE and matches the status the fee was PRICED from,
    // so two simultaneous cancels change one row and stamp the fee once, and a sitter confirming
    // in the gap above cannot have a request-priced (free) cancellation land on her now-confirmed
    // booking. Either loser arrives here with `false` and is told what a stale tab is told.
    const cancelled = await cancelBookingForUser(
      c.env.PAWBOOK_DB,
      tenant.Id,
      endUserId,
      id,
      fee,
      booking.Status as 'pending' | 'confirmed', // narrowed by isCustomerCancellable above
    );
    if (!cancelled) return c.json(notCancellable, 409);

    // Best-effort calendar mirror — never blocks or fails the cancellation. SyncPending is already
    // set by the UPDATE above, so a Google failure just leaves the push for the next cron sweep.
    if (booking.GCalEventId) {
      const eventId = booking.GCalEventId;
      const task = (
        keepsCalendarEventOnCancel('cancelled', fee)
          ? (async () => {
              const sync = await getBookingSyncData(c.env.PAWBOOK_DB, tenant.Id, id);
              if (!sync) return;
              const petNames = await listPetNamesForBooking(c.env.PAWBOOK_DB, tenant.Id, id);
              await updateBookingCalendarEvent(c.env, tenant, eventId, {
                bookingId: id,
                endUserId: sync.EndUserId,
                serviceType: sync.ServiceType,
                serviceLabel: sync.ServiceLabel,
                startDate: sync.StartDate,
                endDate: sync.EndDate,
                startTime: sync.StartTime,
                durationMinutes: sync.DurationMinutes,
                petCount: sync.PetCount,
                petNames,
                estCost: sync.EstCost,
                status: 'cancelled',
              });
            })()
          : deleteBookingCalendarEvent(c.env, tenant, eventId, id, 'cancelled')
      ).catch((err) => {
        console.error('calendar cancel sync failed', err);
      });
      try {
        c.executionCtx.waitUntil(task);
      } catch {
        await task;
      }
    }

    return c.json({ status: 'cancelled', cancellationFee: fee });
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
    // Charges for THIS caller's bookings only — scoped by the tenant read plus the row filter
    // below, so a charge can never appear under a booking the caller does not own.
    const chargeRows = await listChargesForTenant(c.env.PAWBOOK_DB, tenant.Id);
    const chargesByBooking = new Map<string, { label: string; amount: number }[]>();
    for (const ch of chargeRows) {
      const list = chargesByBooking.get(ch.BookingRequestId) ?? [];
      list.push({ label: ch.Label, amount: ch.Amount });
      chargesByBooking.set(ch.BookingRequestId, list);
    }
    // Cancellation policy per service, so each row can carry what cancelling it TODAY would cost.
    // Server-computed for the same reason the quote is: the widget renders money, never derives it.
    const tiersByType = new Map<string, CancellationTier[] | null>(
      (await listServices(c.env.PAWBOOK_DB, tenant.Id)).map((s) => [
        s.ServiceType,
        s.CancellationTiers,
      ]),
    );
    const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
    return c.json({
      bookings: rows.map((r) => {
        const cancellable = isCustomerCancellable(r.Status, r.StartDate, r.EndDate, today);
        return {
          id: r.Id,
          type: r.ServiceType,
          startDate: r.StartDate,
          endDate: r.EndDate,
          petCount: r.PetCount,
          pets: petsByBooking.get(r.Id) ?? [],
          estCost: r.EstCost,
          charges: chargesByBooking.get(r.Id) ?? [],
          chargesTotal: (chargesByBooking.get(r.Id) ?? []).reduce((sum, ch) => sum + ch.amount, 0),
          cancellationFee: r.CancellationFee,
          /** Whether THIS customer may still cancel it — the server's answer, not a client rule. */
          cancellable,
          /** What cancelling today would cost, whole dollars; null when it isn't cancellable. */
          feeIfCancelledToday: cancellable
            ? feeToCancelToday(
                r.Status,
                r.EstCost,
                r.StartDate,
                tiersByType.get(r.ServiceType) ?? null,
                today,
              )
            : null,
          status: r.Status,
        };
      }),
    });
  });
