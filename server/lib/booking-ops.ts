/**
 * The booking OPERATIONS layer: "quote a booking", "create a booking", "cancel a booking" as
 * plain callable functions rather than as HTTP routes.
 *
 * ## Why this module exists, and why it lives here
 *
 * `src/shared/` holds the pure, dependency-free domain core (capacity, service rules, the pet-set
 * rate resolver, date math). It must stay pure — the client imports it. But an *operation* is not
 * pure: it reads D1, it prices (and money is server-only), it writes rows, it pushes to Google. So
 * it cannot live there. It also must not live in a Hono handler, because a handler is not callable:
 * an MCP tool that wanted "create a booking" would have to re-implement the twenty-odd checks the
 * POST performs, and a second implementation of the booking rules is exactly the drift the rest of
 * this codebase is built to prevent. `server/lib/` is where server-only logic lives, so this is
 * where the orchestration goes.
 *
 * ## The contract
 *
 * Every function takes plain typed inputs plus a {@link BookingOpsContext} and returns a
 * DISCRIMINATED {@link OpResult} — never a `Response`, never a Hono `Context`, never a thrown
 * control-flow error. Failures carry the human `error` string AND, where the route already had
 * one, the stable snake_case `code` that CLAUDE.md documents as the agent-ready surface. The routes
 * in `server/routes/bookings.ts` are thin adapters that turn an `OpResult` into `c.json(...)`; an
 * MCP tool would turn the same value into a tool result. Neither owns a rule.
 *
 * `code` is OPTIONAL on the failure arm because the quote route has never sent one — its 400s are
 * `{ error }` only. Making it required here would have changed the wire, which this extraction is
 * not allowed to do; adding codes to the quote is a separate, deliberate change.
 *
 * ## Background work without an ExecutionContext
 *
 * Calendar pushes, sitter emails and the saved-answer write are best-effort and must never block or
 * fail the operation. In a Worker they belong in `executionCtx.waitUntil`; in tests (and in an MCP
 * process) there is no ExecutionContext and they must simply be awaited so behaviour is
 * deterministic. That choice is the CALLER's, so it arrives as {@link BookingOpsContext.defer};
 * absent, the task is awaited. This is the same `try { waitUntil } catch { await }` dance the
 * routes used to do inline, moved behind one seam.
 */
import {
  addBookingPets,
  cancelBookingForUser,
  deleteBookingRequest,
  findBookingByIdempotencyKey,
  getBookingForUser,
  getBookingSyncData,
  getEndUserById,
  getSitterNotificationEmail,
  insertBookingRequest,
  listBookingPetsForUser,
  listBookingsForUser,
  listChargesForTenant,
  listEndUserPets,
  listPetNamesForBooking,
  listPetTypes,
  listSavedAnswers,
  listServiceOptions,
  listServices,
  replaceSavedAnswers,
} from '../db/repo';
import { buildSavedAnswerMap, savedAnswerEntries } from './saved-answers';
import {
  checkAvailability,
  estimateCost,
  loadPetSetRates,
  monthAvailability,
  type AvailabilityResult,
  type MonthAvailability,
} from './availability';
import {
  deleteBookingCalendarEvent,
  keepsCalendarEventOnCancel,
  reconcileIfStale,
  syncBookingToCalendar,
  updateBookingCalendarEvent,
} from './calendar-sync';
import { isEmailConfigured, sendCancellationNoticeToSitter } from './email';
import { DEMO_EMAIL } from './demo';
import { isUniqueViolation } from './db-errors';
import {
  isValidPetCount,
  isValidTimeString,
  validateBoardingRange,
  validateBookingWindow,
  validateSingleDate,
} from './validation';
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
import type { BookingRow, Tenant } from '../types';

// ─── The result contract ─────────────────────────────────────────────────────

/** HTTP-shaped so the route adapter is a one-liner; an MCP adapter simply ignores it. */
export type OpStatus = 200 | 201 | 400 | 401 | 403 | 404 | 409;

export type OpSuccess<T> = { ok: true; status: OpStatus; data: T };
export type OpFailure = { ok: false; status: OpStatus; error: string; code?: string };
export type OpResult<T> = OpSuccess<T> | OpFailure;

const ok = <T>(data: T, status: OpStatus = 200): OpSuccess<T> => ({ ok: true, status, data });
const fail = (status: OpStatus, error: string, code?: string): OpFailure =>
  code === undefined ? { ok: false, status, error } : { ok: false, status, error, code };

/**
 * Everything an operation needs that is not part of the request itself. `endUserId` is the
 * authenticated customer — every op is customer-scoped, and the scoping is enforced in SQL (the
 * repo functions carry `EndUserId = ?`), never by a caller-side pre-check.
 */
export type BookingOpsContext = {
  env: Env;
  tenant: Tenant;
  endUserId: string;
  /**
   * Hand a best-effort background task to the host. A Worker route passes
   * `(t) => { try { c.executionCtx.waitUntil(t); } catch { return t; } }`; a test or an MCP
   * process passes nothing and the task is awaited. The task is ALWAYS already `.catch()`-ed by
   * the operation, so this can never surface an unhandled rejection.
   */
  defer?: (task: Promise<void>) => void | Promise<void>;
};

async function background(ctx: BookingOpsContext, task: Promise<void>): Promise<void> {
  if (!ctx.defer) {
    await task;
    return;
  }
  await ctx.defer(task);
}

// ─── Shared predicates (also read by the "my bookings" list) ─────────────────

/**
 * Can this customer still cancel this booking themselves? Terminal rows and stays that have
 * already finished are history, not actions. A stay ALREADY IN PROGRESS stays cancellable on
 * purpose: the fee schedule already prices a cancellation on or after the start date (0 days
 * out → the tightest tier), so refusing here would only push the customer to the phone.
 *
 * The server owns this rule and ships the answer as a boolean on `/bookings/mine`, so the widget
 * never does date math to decide whether to offer the action.
 */
export function isCustomerCancellable(
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
export function feeToCancelToday(
  status: BookingRow['Status'],
  estCost: number | null,
  startDate: string,
  tiers: CancellationTier[] | null,
  today: string,
): number {
  if (status !== 'confirmed' || estCost == null || !tiers) return 0;
  return cancellationFee(tiers, estCost, startDate, today);
}

/**
 * The 409 body for a capacity refusal, in ONE place so the demo path and the real path answer
 * identically. `capacity_conflict` + "those dates just filled up" stays the default because it is
 * true of a full pool and every reader (widget, tests, agents) already knows it. A refusal the
 * availability layer labelled — today only the house-sit/boarding overlap rule, whose dates are
 * NOT full — forwards its own `code` and its own sentence instead of being flattened into a
 * misleading one.
 */
function conflictFailure(check: { reason: string; code?: string }): OpFailure {
  return check.code
    ? fail(409, check.reason, check.code)
    : fail(409, 'Sorry — those dates just filled up.', 'capacity_conflict');
}

// ─── Quote ───────────────────────────────────────────────────────────────────

export type QuoteInput = {
  /** Service slug. Anything but a non-empty string is "Unknown service type." */
  type: unknown;
  /** Option key; `''`/absent selects the service's first option. */
  optionKey?: string;
  start?: string;
  end?: string;
  /** The caller's own pet ids, already de-duplicated by the adapter. */
  petIds: string[];
};

/**
 * The quote. Authenticated and pet-IDENTIFIED (design spec §5): it receives the caller's real
 * pet ids, validates every one against the PetOwners authority, and derives both rate keys from
 * that set — so the quote and the cost later stamped on the booking are computed from the same
 * pets and cannot diverge. It used to be public and take a pet COUNT; a count can neither be owned
 * nor looked up, which is exactly why it is gone.
 */
export async function quoteBooking(
  ctx: BookingOpsContext,
  input: QuoteInput,
): Promise<OpResult<AvailabilityResult>> {
  const { env, tenant } = ctx;
  const type = input.type;
  const optionKey = input.optionKey ?? '';
  const start = input.start ?? '';
  const end = input.end ?? '';
  const requestedPetIds = input.petIds;

  if (typeof type !== 'string' || !type) return fail(400, 'Unknown service type.');
  if (requestedPetIds.length === 0) return fail(400, 'Choose at least one pet.');
  // Bounds the ownership scan; same defensive cap the booking POST uses.
  if (!isValidPetCount(requestedPetIds.length)) return fail(400, 'Too many pets.');

  const [services, options, myPets, acceptedTypes] = await Promise.all([
    listServices(env.PAWBOOK_DB, tenant.Id),
    listServiceOptions(env.PAWBOOK_DB, tenant.Id),
    // PetOwners-backed: a CO-OWNER may quote a pet they co-own, and a pet outside this
    // customer's ownership graph is simply not in the list.
    listEndUserPets(env.PAWBOOK_DB, tenant.Id, ctx.endUserId),
    listPetTypes(env.PAWBOOK_DB, tenant.Id),
  ]);

  const chosen = requestedPetIds.map((id) => myPets.find((p) => p.Id === id));
  if (chosen.some((p) => !p)) return fail(400, 'Unknown pet.');
  const pets = chosen.map((p) => ({ id: p!.Id, petType: p!.PetType }));

  const service = services.find((s) => s.ServiceType === type);
  if (!service) return fail(400, 'Unknown service type.');
  if (!service.Enabled) return fail(400, 'Service not offered.');
  const serviceOptions = options.filter((o) => o.ServiceType === type);
  const option = optionKey
    ? serviceOptions.find((o) => o.OptionKey === optionKey)
    : serviceOptions[0];
  if (!option) return fail(400, 'Unknown service option.');

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
  if (acceptanceError) return fail(400, acceptanceError);

  if (service.Shape === 'range') {
    const rangeError = validateBoardingRange(
      start,
      end,
      service.MaxNights,
      tenant.Timezone ?? undefined,
    );
    if (rangeError) return fail(rangeError.status, rangeError.error);
    const windowError = validateBookingWindow(
      start,
      service.MinLeadDays,
      tenant.MaxAdvanceMonths,
      tenant.Timezone ?? undefined,
    );
    if (windowError) return fail(windowError.status, windowError.error);
    // Same rule the POST applies (validateServiceConstraints) — a quote for more pets than the
    // service allows must refuse with the same friendly, structured shape the widget already
    // renders (bp-result.bp-no), not fall through to capacity/pricing.
    const constraintsError = validateServiceConstraints(
      { maxNights: service.MaxNights, maxPetCount: service.MaxPetCount },
      { nights: nightsBetween(start, end), petCount: pets.length },
    );
    if (constraintsError) return fail(400, constraintsError);
    // Read only once date/constraint validation has passed, saving two D1 reads on the 400
    // paths above — behavior is identical since checkAvailability is the only consumer.
    const rates = await loadPetSetRates(env, tenant.Id, service.ServiceType);
    return ok(await checkAvailability(env, tenant, service, option, start, end, pets, rates));
  }
  const dateError = validateSingleDate(start, tenant.Timezone ?? undefined);
  if (dateError) return fail(dateError.status, dateError.error);
  const windowError = validateBookingWindow(
    start,
    service.MinLeadDays,
    tenant.MaxAdvanceMonths,
    tenant.Timezone ?? undefined,
  );
  if (windowError) return fail(windowError.status, windowError.error);
  const constraintsError = validateServiceConstraints(
    { maxNights: service.MaxNights, maxPetCount: service.MaxPetCount },
    { nights: null, petCount: pets.length },
  );
  if (constraintsError) return fail(400, constraintsError);
  const rates = await loadPetSetRates(env, tenant.Id, service.ServiceType);
  return ok(await checkAvailability(env, tenant, service, option, start, '', pets, rates));
}

// ─── Month grid ──────────────────────────────────────────────────────────────

export type MonthGridInput = {
  type: unknown;
  month: string;
  /** Absent = the service's first option; a key that matches nothing is an error, never a drop. */
  optionKey?: string;
  petIds: string[];
};

export async function monthGrid(
  ctx: BookingOpsContext,
  input: MonthGridInput,
): Promise<OpResult<MonthAvailability>> {
  const { env, tenant } = ctx;
  const { type, month, optionKey, petIds: requestedPetIds } = input;

  if (!isValidPetCount(Math.max(1, requestedPetIds.length))) return fail(400, 'Too many pets.');
  // Read concurrently: the ownership check must not add a serial round-trip to the widget's
  // hottest path (this GET refires on every month page AND every pet-selection change).
  const [services, myPets] = await Promise.all([
    listServices(env.PAWBOOK_DB, tenant.Id),
    requestedPetIds.length > 0
      ? listEndUserPets(env.PAWBOOK_DB, tenant.Id, ctx.endUserId)
      : Promise.resolve(null),
  ]);
  const service = services.find((s) => s.ServiceType === type);
  if (!service) return fail(400, 'Unknown service type.');
  if (!/^\d{4}-\d{2}$/.test(month)) return fail(400, 'Bad month.');
  // An id the caller doesn't own is refused rather than dropped: silently painting for fewer
  // pets than were asked about is the same class of lie the count-based grid was.
  if (myPets && requestedPetIds.some((id) => !myPets.some((p) => p.Id === id)))
    return fail(400, 'Unknown pet.');
  const options = await listServiceOptions(env.PAWBOOK_DB, tenant.Id);
  const serviceOptions = options.filter((o) => o.ServiceType === type);
  let option = serviceOptions[0] ?? null;
  if (optionKey) {
    // An unmatched key must error, not silently drop the capacity filter — a stale key (e.g.
    // a customer's widget holding one from before the sitter renamed the option) would
    // otherwise show every day as available, ignoring the option's real capacity.
    const found = serviceOptions.find((o) => o.OptionKey === optionKey);
    if (!found) return fail(400, 'Unknown service option.');
    option = found;
  }
  // Pull Google's reality INTO the DB, throttled on the widget's own key (~10 min). Availability
  // itself still reads only D1 — reconcile is what writes a hand-deleted event or a foreign busy
  // day into BookingRequests, so the grid sees it as an ordinary row on a later load.
  //
  // Deliberately NOT awaited (in a Worker). `listCalendarEvents` has no timeout, so awaiting it
  // would let a HANGING Google block a customer-facing first paint until the platform kills the
  // request — "Couldn't load availability" caused by a third party the grid doesn't even read.
  // Correctness never depended on the ordering: the grid and the booking POST both read D1, so
  // they agree whenever the pull lands. The cost is at most a one-page-load lag on freshness,
  // which the 600s throttle already licenses away.
  // Suppressed for a disabled tenant: read-only, no GET-side writes.
  if (!tenant.DisabledAt) {
    // reconcileIfStale is documented as never throwing; the guard is insurance against a future
    // edit turning an unhandled rejection loose in a deferred task.
    await background(
      ctx,
      reconcileIfStale(env, tenant, 'widget').catch((err) => {
        console.error('widget calendar pull failed', err);
      }),
    );
  }
  return ok(
    await monthAvailability(
      env,
      tenant,
      service,
      month,
      ctx.endUserId,
      option,
      Math.max(1, requestedPetIds.length),
    ),
  );
}

// ─── "Who am I" (pets + intake pre-fills) ────────────────────────────────────

export type MePayload = {
  name: string | null;
  pets: { id: string; name: string; petType: string }[];
  savedAnswers: Record<string, Record<string, string>>;
};

export async function getMe(ctx: BookingOpsContext): Promise<OpResult<MePayload>> {
  const { env, tenant, endUserId } = ctx;
  const user = await getEndUserById(env.PAWBOOK_DB, tenant.Id, endUserId);
  const pets = await listEndUserPets(env.PAWBOOK_DB, tenant.Id, endUserId);
  // Intake pre-fills, resolved against the questions AS THEY STAND NOW — a saved answer whose
  // question has been reworded, retyped, or narrowed past it never reaches the browser
  // (buildSavedAnswerMap). Read concurrently: neither read depends on the other, and /me is on
  // the widget's first paint.
  const [savedRows, services] = await Promise.all([
    listSavedAnswers(env.PAWBOOK_DB, tenant.Id, endUserId),
    listServices(env.PAWBOOK_DB, tenant.Id),
  ]);
  return ok({
    name: user?.Name ?? null,
    pets: pets.map((p) => ({ id: p.Id, name: p.Name, petType: p.PetType })),
    savedAnswers: buildSavedAnswerMap(savedRows, services),
  });
}

// ─── Create ──────────────────────────────────────────────────────────────────

export type CreateBookingInput = {
  type: unknown;
  startDate?: string;
  endDate?: string;
  /**
   * `undefined` means "not supplied" and falls back to the service's first option — distinct from
   * a supplied key that matches nothing, which is a 400. Preserved as `unknown` because the wire
   * value is untrusted and the lookup below is what rejects a non-string.
   */
  optionKey?: unknown;
  petIds: string[];
  answers: Record<string, string>;
  /** Range services only; `null` = not given. */
  startTime: string | null;
  /** `Idempotency-Key`, already trimmed by the adapter; `null` = none. */
  idempotencyKey: string | null;
};

export type CreateBookingPayload = {
  id: string;
  estCost: number | null;
  status: string;
  demo?: true;
  note?: string;
};

export async function createBooking(
  ctx: BookingOpsContext,
  input: CreateBookingInput,
): Promise<OpResult<CreateBookingPayload>> {
  const { env, tenant, endUserId } = ctx;
  const tenantId = tenant.Id;
  const type = input.type;
  const start = typeof input.startDate === 'string' ? input.startDate : '';
  const end = typeof input.endDate === 'string' ? input.endDate : '';
  const petIds = input.petIds;
  const answers = input.answers;
  const rawStartTime = input.startTime;

  // The reserved demo identity books like a real customer right up to persistence. One extra
  // indexed read; every other request pays it too, which keeps the two paths byte-identical
  // through validation and pricing.
  const requester = await getEndUserById(env.PAWBOOK_DB, tenantId, endUserId);
  const isDemo = requester?.Email === DEMO_EMAIL;

  const idemKey = input.idempotencyKey;
  if (idemKey && idemKey.length > 128) {
    return fail(400, 'Idempotency-Key must be 128 characters or fewer.', 'invalid_idempotency_key');
  }
  if (idemKey) {
    const prior = await findBookingByIdempotencyKey(env.PAWBOOK_DB, tenantId, endUserId, idemKey);
    if (prior) return ok({ id: prior.Id, estCost: prior.EstCost, status: prior.Status }, 201);
  }

  const services = await listServices(env.PAWBOOK_DB, tenant.Id);
  const service = services.find((s) => s.ServiceType === type);
  if (!service) return fail(400, 'Unknown service type.', 'unknown_service_type');
  if (petIds.length === 0) return fail(400, 'Choose at least one pet.', 'no_pets_selected');

  const myPets = await listEndUserPets(env.PAWBOOK_DB, tenant.Id, endUserId);
  const chosen = petIds.map((id) => myPets.find((p) => p.Id === id));
  if (chosen.some((p) => !p)) return fail(400, 'Unknown pet.', 'unknown_pet');
  const pets = chosen.length;
  if (!isValidPetCount(pets)) return fail(400, 'Too many pets.', 'too_many_pets');
  const acceptedTypes = await listPetTypes(env.PAWBOOK_DB, tenant.Id);
  // Registry membership: a pet whose slug isn't a TenantPetTypes row at all is corrupt data.
  // The BEHAVIORAL gate is the per-service acceptance check below (0015 — the tenant-level
  // enabled switch is retired).
  for (const p of chosen) {
    if (!acceptedTypes.find((pt) => pt.PetType === p!.PetType))
      return fail(400, 'That pet type is not accepted.', 'pet_type_not_accepted');
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
  if (acceptanceError) return fail(400, acceptanceError, 'pet_type_not_accepted');

  if (!service.Enabled) return fail(400, 'Service not offered.', 'service_not_offered');

  const options = await listServiceOptions(env.PAWBOOK_DB, tenant.Id);

  // Select by optionKey when provided; fall back to first option for the service type.
  let option: (typeof options)[number] | undefined;
  if (input.optionKey !== undefined) {
    option = options.find((o) => o.ServiceType === type && o.OptionKey === input.optionKey);
    if (!option) return fail(400, 'Unknown service option.', 'unknown_option');
  } else {
    option = options.find((o) => o.ServiceType === type);
    if (!option) return fail(400, 'Service not configured.', 'service_not_configured');
  }

  // Re-validate dates at submit time with the same logic the widget used (PRD FR13).
  const shape = service.Shape;
  const dateError =
    shape === 'range'
      ? validateBoardingRange(start, end, service.MaxNights, tenant.Timezone ?? undefined)
      : validateSingleDate(start, tenant.Timezone ?? undefined);
  if (dateError) return fail(dateError.status, dateError.error, dateError.code);

  // The booking window (0004): per-service minimum notice + the business-wide horizon —
  // same rule the quote and the month grid enforce, so the three can never disagree.
  const windowError = validateBookingWindow(
    start,
    service.MinLeadDays,
    tenant.MaxAdvanceMonths,
    tenant.Timezone ?? undefined,
  );
  if (windowError) return fail(windowError.status, windowError.error, windowError.code);

  // Optional customer-chosen arrival time — range stays only. Timed (single-day) services take
  // their clock from the option, so a client-supplied time there is a bug, not a preference.
  if (rawStartTime !== null) {
    if (shape !== 'range')
      return fail(400, 'An arrival time only applies to multi-day stays.', 'invalid_start_time');
    if (!isValidTimeString(rawStartTime))
      return fail(400, 'Arrival time must look like 14:30 (24-hour HH:MM).', 'invalid_start_time');
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
        return fail(
          400,
          'That option is only available on weekdays — pick a Monday–Friday date.',
          'weekdays_only',
        );
    }
  }
  const endDate = shape === 'range' ? end : null;

  const nights = shape === 'range' ? nightsBetween(start, end) : null;

  const answersError = validateAnswers(service.Questions, answers);
  if (answersError) return fail(400, answersError, 'invalid_answers');

  const constraintsError = validateServiceConstraints(
    { maxNights: service.MaxNights, maxPetCount: service.MaxPetCount },
    { nights, petCount: pets },
  );
  if (constraintsError) return fail(400, constraintsError, 'service_constraint');

  // Price is computed server-side (never trusted from the client) — the request body carries no
  // cost field at all. The rate rows are read once here and reused by the capacity check's
  // pricing below, so the quote, this stamp, and the row that lands in D1 all come from ONE
  // resolution of ONE pet set.
  const pricedPets = chosen.map((p) => ({ id: p!.Id, petType: p!.PetType }));
  const rates = await loadPetSetRates(env, tenant.Id, service.ServiceType);
  const price = estimateCost(service, option, start, end, pricedPets, rates);
  if (!price.priced) {
    // Refused BEFORE the optimistic insert: an unpriced booking must not exist even briefly,
    // and there is no fallback number to write — a `?? 0` here would be the whole feature
    // defeated in four characters.
    return fail(
      400,
      `Ask ${tenant.DisplayName} for a price for this group of pets — they haven't set one yet.`,
      'unpriced_pet_set',
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
      env,
      tenant,
      service,
      option,
      start,
      end,
      pricedPets,
      rates,
      'demo-excludes-no-row',
    );
    if (!demoCheck.available) return conflictFailure(demoCheck);
    return ok(
      {
        id: `demo_${crypto.randomUUID()}`,
        estCost,
        status: 'pending',
        demo: true as const,
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
    id = await insertBookingRequest(env.PAWBOOK_DB, tenant.Id, {
      endUserId,
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
      const prior = await findBookingByIdempotencyKey(env.PAWBOOK_DB, tenantId, endUserId, idemKey);
      if (prior) return ok({ id: prior.Id, estCost: prior.EstCost, status: prior.Status }, 201);
    }
    throw e;
  }

  try {
    const check = await checkAvailability(
      env,
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
      await deleteBookingRequest(env.PAWBOOK_DB, tenant.Id, id);
      return conflictFailure(check);
    }
    await addBookingPets(env.PAWBOOK_DB, tenant.Id, id, petIds);
  } catch (err) {
    // The optimistic row is already persisted; if the capacity check or pet insert fails,
    // don't leave it orphaned (a pending row counts against capacity and never expires).
    // Best-effort cleanup, then surface the original error.
    await deleteBookingRequest(env.PAWBOOK_DB, tenant.Id, id).catch(() => {});
    throw err;
  }

  // Whatever they just submitted becomes the pre-fill for their next booking of this service
  // (0007). Reached only past the `isDemo` return above, so the demo identity saves nothing,
  // like it persists nothing else. Best-effort on the same terms as the calendar push below:
  // the booking is already committed and the customer is about to be told it worked — failing
  // the response over a convenience write would report a real booking as an error.
  await replaceSavedAnswers(
    env.PAWBOOK_DB,
    tenant.Id,
    endUserId,
    service.ServiceType,
    savedAnswerEntries(service.Questions, answers),
  ).catch((err) => {
    console.error('saving intake answers failed', err);
  });

  // Best-effort calendar sync — never blocks or fails the booking.
  await background(
    ctx,
    syncBookingToCalendar(env, tenant, {
      bookingId: id,
      endUserId,
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
    }),
  );

  return ok({ id, estCost, status: 'pending' }, 201);
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

export type CancelBookingInput = { bookingId: string };
export type CancelBookingPayload = { status: 'cancelled'; cancellationFee: number };

/**
 * Owner-initiated cancellation. The booking row is NEVER deleted — `BookingRequestPets` has no
 * ON DELETE CASCADE (D1 enforces FKs, so the DELETE would fail outright) and a deleted row with
 * a live GCalEventId orphans its Google event forever, since reconcile skips any event that
 * still carries a bookingId. `Status = 'cancelled'` gives the same visible outcome with none of
 * that.
 *
 * The fee is computed here, from the sitter's stored policy — the input carries no dollar figure,
 * so there is nothing for a caller to supply and nothing for it to get wrong. Fee-free
 * cancellations store a real 0 and DELETE the Google event; a fee-bearing one stores the amount
 * and RETITLES the event `[CANCELLED] …` (keepsCalendarEventOnCancel — the same predicate the
 * outbox re-drive consults, or the next sweep would delete the event this just retitled).
 */
export async function cancelBooking(
  ctx: BookingOpsContext,
  input: CancelBookingInput,
): Promise<OpResult<CancelBookingPayload>> {
  const { env, tenant, endUserId } = ctx;
  const id = input.bookingId;

  // Ownership is in the SQL, not in a check around it: another customer's id, an unknown id, and
  // a 'blocked'/'external' sentinel are all one indistinguishable 404 — no existence oracle.
  const booking = await getBookingForUser(env.PAWBOOK_DB, tenant.Id, endUserId, id);
  if (!booking) return fail(404, 'Not found.', 'unknown_booking');

  const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
  const notCancellable = () =>
    fail(
      409,
      `That booking can no longer be cancelled here — please contact ${tenant.DisplayName}.`,
      'not_cancellable',
    );
  if (!isCustomerCancellable(booking.Status, booking.StartDate, booking.EndDate, today))
    return notCancellable();

  const services = await listServices(env.PAWBOOK_DB, tenant.Id);
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
    env.PAWBOOK_DB,
    tenant.Id,
    endUserId,
    id,
    fee,
    booking.Status as 'pending' | 'confirmed', // narrowed by isCustomerCancellable above
  );
  if (!cancelled) return notCancellable();

  // Best-effort calendar mirror — never blocks or fails the cancellation. SyncPending is already
  // set by the UPDATE above, so a Google failure just leaves the push for the next cron sweep.
  if (booking.GCalEventId) {
    const eventId = booking.GCalEventId;
    await background(
      ctx,
      (keepsCalendarEventOnCancel('cancelled', fee)
        ? (async () => {
            const sync = await getBookingSyncData(env.PAWBOOK_DB, tenant.Id, id);
            if (!sync) return;
            const petNames = await listPetNamesForBooking(env.PAWBOOK_DB, tenant.Id, id);
            await updateBookingCalendarEvent(env, tenant, eventId, {
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
        : deleteBookingCalendarEvent(env, tenant, eventId, id, 'cancelled')
      ).catch((err) => {
        console.error('calendar cancel sync failed', err);
      }),
    );
  }

  // Tell the sitter. Best-effort on exactly the terms the calendar push is: the row is written
  // and the customer has already been told their booking is cancelled, so a Resend outage must
  // change nothing about the outcome. Every failure mode — no configured provider, no resolvable
  // recipient, a throwing transport — is swallowed and logged, never surfaced.
  await background(
    ctx,
    (async () => {
      if (!isEmailConfigured(env)) return;
      const sitterEmail = await getSitterNotificationEmail(env.PAWBOOK_DB, tenant.Id);
      if (!sitterEmail) return;
      const customer = await getEndUserById(env.PAWBOOK_DB, tenant.Id, endUserId);
      await sendCancellationNoticeToSitter(env, sitterEmail, {
        displayName: tenant.DisplayName,
        customerName: customer?.Name ?? null,
        customerEmail: customer?.Email ?? null,
        serviceLabel: service?.Label ?? booking.ServiceType,
        whenText: booking.EndDate ? `${booking.StartDate} – ${booking.EndDate}` : booking.StartDate,
        // The status BEFORE the cancel: 'confirmed' means she had committed, 'pending' means the
        // customer withdrew a request she never accepted. Two different messages.
        wasConfirmed: booking.Status === 'confirmed',
        cancellationFee: fee, // the stored number, never recomputed downstream
      });
    })().catch((err) => {
      console.error('cancellation notice to sitter failed', err);
    }),
  );

  return ok({ status: 'cancelled' as const, cancellationFee: fee });
}

// ─── The customer's own bookings ─────────────────────────────────────────────

export type MyBooking = {
  id: string;
  type: string;
  startDate: string;
  endDate: string | null;
  petCount: number;
  pets: string[];
  estCost: number | null;
  charges: { label: string; amount: number }[];
  chargesTotal: number;
  cancellationFee: number | null;
  cancellable: boolean;
  feeIfCancelledToday: number | null;
  status: string;
};

export async function listMyBookings(
  ctx: BookingOpsContext,
): Promise<OpResult<{ bookings: MyBooking[] }>> {
  const { env, tenant, endUserId } = ctx;
  const rows = await listBookingsForUser(env.PAWBOOK_DB, tenant.Id, endUserId);
  const petRows = await listBookingPetsForUser(env.PAWBOOK_DB, tenant.Id, endUserId);
  const petsByBooking = new Map<string, string[]>();
  for (const pr of petRows) {
    const list = petsByBooking.get(pr.BookingRequestId) ?? [];
    list.push(pr.Name);
    petsByBooking.set(pr.BookingRequestId, list);
  }
  // Charges for THIS caller's bookings only — scoped by the tenant read plus the row filter
  // below, so a charge can never appear under a booking the caller does not own.
  const chargeRows = await listChargesForTenant(env.PAWBOOK_DB, tenant.Id);
  const chargesByBooking = new Map<string, { label: string; amount: number }[]>();
  for (const ch of chargeRows) {
    const list = chargesByBooking.get(ch.BookingRequestId) ?? [];
    list.push({ label: ch.Label, amount: ch.Amount });
    chargesByBooking.set(ch.BookingRequestId, list);
  }
  // Cancellation policy per service, so each row can carry what cancelling it TODAY would cost.
  // Server-computed for the same reason the quote is: the widget renders money, never derives it.
  const tiersByType = new Map<string, CancellationTier[] | null>(
    (await listServices(env.PAWBOOK_DB, tenant.Id)).map((s) => [
      s.ServiceType,
      s.CancellationTiers,
    ]),
  );
  const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
  return ok({
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
}
