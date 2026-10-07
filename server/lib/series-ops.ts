/**
 * The SERIES operations layer: "quote a repeating booking", "request one", and the one wire shape
 * every series read answers with. Plain callable functions returning an `OpResult`, exactly as
 * `booking-ops.ts` is, so the route is an adapter and an agent could call the same operation.
 *
 * A series is checked ONCE, over its terms, with the single booking's own rules and codes: the
 * service, the pets, the option, the time, the notice. What a single booking checks per stay is
 * checked here per date by the walk engine (`series-walks.ts`) — price and capacity for that date
 * — and a date that fails is a skip, not a refusal. Only when NO date would book is the request
 * refused (`no_bookable_dates`, or `unpriced_pet_set` when the price is missing on every date).
 *
 * Order is evaluate → refuse → write: the span is judged on a read, the request refused before
 * anything exists, and only then is the series written — the series, its pets, its rows and its
 * skips in ONE batch (`materializeSpan` with the series as its prelude), all or nothing.
 *
 * The booking window does not refuse a series (`too_far_ahead` never answers here): it bounds the
 * ROWS. A start past the window is judged from its start up to the 24-month projection cap and,
 * when anything there would book, accepted with no row yet — its walks are projected until the
 * window reaches them.
 */
import {
  findSeriesByIdempotencyKey,
  getEndUserById,
  getSeries,
  insertSeriesPetStatements,
  insertSeriesStatement,
  listEndUserPets,
  listPetTypes,
  listSeriesBookingRows,
  listSeriesPetNames,
  listSeriesSkips,
  listServiceOptions,
  listServices,
  type SeriesRow,
  type SeriesStatus,
} from '../db/repo';
import type { Tenant, TenantService, TenantServiceOption } from '../types';
import {
  feeToCancelTodayForList,
  isCustomerCancellable,
  unpricedRefusal,
  type BookingOpsContext,
  type OpFailure,
  type OpResult,
  type OpStatus,
} from './booking-ops';
import { extraTimeSurcharges, isTimesError, resolveBookingTimes } from './booking-times';
import { isUniqueViolation } from './db-errors';
import { DEMO_EMAIL } from './demo';
import { phoneOnFile } from './phone';
import {
  datesIn,
  maskFromNames,
  namesFromMask,
  patternWords,
  projectedId,
  projectionCap,
  skipWords,
  windowEnd,
  type SeriesRule,
  type SkipReason,
  type WeekdayName,
} from './series-rule';
import {
  estCostCentsEach,
  evaluateWalks,
  materializeSpan,
  projectSeries,
  SeriesTermsGone,
  type SeriesTerms,
  type WalkEval,
} from './series-walks';
import { tenantToday } from './tenant-today';
import {
  isRealDate,
  isValidPetCount,
  validateBookingWindow,
  validateSingleDate,
} from './validation';
import {
  addDays,
  validateAnswers,
  validatePetTypeAcceptance,
  validateServiceConstraints,
} from '../../src/shared/index.js';

const ok = <T>(data: T, status: OpStatus = 200): OpResult<T> => ({ ok: true, status, data });
const fail = (status: OpStatus, error: string, code: string): OpFailure => ({
  ok: false,
  status,
  error,
  code,
});

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** A client's series request, as untrusted as it arrived. `optionKey` undefined = not supplied. */
export type SeriesInput = {
  type: unknown;
  optionKey?: unknown;
  petIds: string[];
  weekdays: unknown;
  startTime: string | null;
  startDate: unknown;
  endDate: unknown;
  answers: Record<string, string>;
};

export type SeriesQuoteWalk =
  { date: string; estCostCents: number } | { date: string; skipped: SkipReason; words: string };

export type SeriesQuote = {
  walks: SeriesQuoteWalk[];
  estCostCentsEach: number | null;
  openEnded: boolean;
  pattern: string;
  windowEnd: string;
};

export type SeriesWalkWire = {
  /** The row's id, or `series:<id>:<date>` when the walk is projected. */
  id: string;
  date: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'declined' | 'offered';
  projected: boolean;
  estCostCents: number | null;
  feeIfCancelledTodayCents: number | null;
};

export type SeriesWire = {
  id: string;
  status: SeriesStatus;
  version: number;
  createdBy: 'client' | 'sitter';
  type: string;
  optionKey: string | null;
  petIds: string[];
  pets: string[];
  weekdays: WeekdayName[];
  startTime: string | null;
  startDate: string;
  endDate: string | null;
  openEnded: boolean;
  pattern: string;
  offerExpiresAt: string | null;
  windowEnd: string;
  estCostCentsEach: number | null;
  walks: SeriesWalkWire[];
  skips: { date: string; reason: SkipReason; words: string }[];
};

// ─── Validation (the single booking's checks, once, over the terms) ─────────

type ValidSeries = {
  service: TenantService;
  option: TenantServiceOption;
  petNames: string[];
  terms: SeriesTerms;
};

/**
 * Every check a series request answers before its dates are judged, in this order, each with the
 * single booking's own code unless named: unknown service; `series_single_day_only` (a range
 * service repeats as overnights, a different design); no pets; unknown pet; too many pets; pet type
 * not accepted; service not offered; unknown option; the time (`resolveBookingTimes`, then
 * `series_extra_time` when it would attract a surcharge — a walk of a series is owed from its own
 * date, so a surcharge would bill ahead for every week); start and end are real, non-past dates;
 * `invalid_weekdays`; `weekdays_only`; `invalid_answers`; `too_soon` (against the start only —
 * later dates are later); `invalid_end_date`.
 *
 * The option is RESOLVED here as `createBooking` resolves it — named, or the service's first — and
 * the resolved key is what the series stores, so its walks and its terms name one slot.
 *
 * Intake answers are checked as a single booking's are and not stored: a series row carries none.
 */
export async function validateSeriesInput(
  ctx: BookingOpsContext,
  input: SeriesInput,
): Promise<ValidSeries | OpFailure> {
  const { env, tenant, endUserId } = ctx;
  const db = env.PAWSERVATION_DB;
  const tz = tenant.Timezone ?? undefined;

  const services = await listServices(db, tenant.Id);
  const service = services.find((s) => s.ServiceType === input.type);
  if (!service) return fail(400, 'Unknown service type.', 'unknown_service_type');
  if (service.Shape === 'range')
    return fail(
      400,
      'Only single-day services (walks, drop-ins, visits) can repeat every week.',
      'series_single_day_only',
    );
  const petIds = [...new Set(input.petIds)];
  if (petIds.length === 0) return fail(400, 'Choose at least one pet.', 'no_pets_selected');

  const myPets = await listEndUserPets(db, tenant.Id, endUserId);
  const chosen = petIds.map((id) => myPets.find((p) => p.Id === id));
  if (chosen.some((p) => !p)) return fail(400, 'Unknown pet.', 'unknown_pet');
  const pets = chosen.map((p) => p!);
  if (!isValidPetCount(pets.length)) return fail(400, 'Too many pets.', 'too_many_pets');
  const constraintsError = validateServiceConstraints(
    { maxNights: service.MaxNights, maxPetCount: service.MaxPetCount },
    { nights: null, petCount: pets.length },
  );
  if (constraintsError) return fail(400, constraintsError, 'service_constraint');

  const acceptedTypes = await listPetTypes(db, tenant.Id);
  for (const p of pets) {
    if (!acceptedTypes.find((pt) => pt.PetType === p.PetType))
      return fail(400, 'That pet type is not accepted.', 'pet_type_not_accepted');
  }
  const labelBySlug = new Map(acceptedTypes.map((r) => [r.PetType, r.Label]));
  const acceptanceError = validatePetTypeAcceptance(
    service.AcceptedPetTypes,
    service.Label,
    pets.map((p) => ({ name: p.Name, petType: p.PetType })),
    (slug) => labelBySlug.get(slug) ?? slug,
  );
  if (acceptanceError) return fail(400, acceptanceError, 'pet_type_not_accepted');

  if (!service.Enabled) return fail(400, 'Service not offered.', 'service_not_offered');

  const options = await listServiceOptions(db, tenant.Id);
  let option: TenantServiceOption | undefined;
  if (input.optionKey !== undefined) {
    option = options.find(
      (o) => o.ServiceType === service.ServiceType && o.OptionKey === input.optionKey,
    );
    if (!option) return fail(400, 'Unknown service option.', 'unknown_option');
  } else {
    option = options.find((o) => o.ServiceType === service.ServiceType);
    if (!option) return fail(400, 'Service not configured.', 'service_not_configured');
  }

  const times = resolveBookingTimes(service, option, input.startTime, null);
  if (isTimesError(times)) return fail(times.status, times.error, times.code);
  if (extraTimeSurcharges(service, times).length > 0)
    return fail(
      400,
      `That time carries an extra-time fee, so it can't repeat every week — pick a time inside ${tenant.DisplayName}'s usual hours, or book those days one at a time.`,
      'series_extra_time',
    );

  const startDate = typeof input.startDate === 'string' ? input.startDate : '';
  const startError = validateSingleDate(startDate, tz);
  if (startError) return fail(startError.status, startError.error, startError.code);
  let endDate: string | null = null;
  if (input.endDate !== null && input.endDate !== undefined) {
    endDate = typeof input.endDate === 'string' ? input.endDate : '';
    const endError = validateSingleDate(endDate, tz);
    if (endError) return fail(endError.status, endError.error, endError.code);
  }

  const weekdays = Array.isArray(input.weekdays)
    ? input.weekdays.every((d): d is string => typeof d === 'string')
      ? maskFromNames(input.weekdays)
      : null
    : null;
  if (weekdays === null || weekdays < 1 || weekdays > 127)
    return fail(400, 'Choose which days of the week to repeat on.', 'invalid_weekdays');
  // Saturday is bit 5, Sunday bit 6.
  if (option.WeekdaysOnly && (weekdays & (32 | 64)) !== 0)
    return fail(
      400,
      'That option is only available on weekdays — pick days from Monday to Friday.',
      'weekdays_only',
    );

  const answersError = validateAnswers(service.Questions, input.answers);
  if (answersError) return fail(400, answersError, 'invalid_answers');

  // The notice half of the booking window only: the horizon bounds a series' rows, it never
  // refuses one, so `too_far_ahead` is not asked.
  const leadError = validateBookingWindow(startDate, service.MinLeadDays, null, tz);
  if (leadError) return fail(leadError.status, leadError.error, leadError.code);

  if (endDate !== null && endDate < startDate)
    return fail(400, 'The last date has to be on or after the first.', 'invalid_end_date');

  return {
    service,
    option,
    petNames: pets.map((p) => p.Name),
    terms: {
      endUserId,
      serviceType: service.ServiceType,
      optionKey: option.OptionKey,
      petIds,
      weekdays,
      startTime: times.startTime,
      startDate,
      endDate,
    },
  };
}

// ─── The span a request is judged over ───────────────────────────────────────

const earlier = (a: string, b: string): string => (a < b ? a : b);

/**
 * The dates judged for a quote or a request: tomorrow through the window (or `to`, capped at the
 * 24-month projection cap). A series whose every date lies past the window is judged from its
 * start up to the cap instead — the window not having reached it yet is not "nothing would book".
 * Every span is bounded: nothing iterates to a raw client date.
 */
function judgedDates(rule: SeriesRule, today: string, wEnd: string, to?: string): string[] {
  const tomorrow = addDays(today, 1);
  const cap = projectionCap(today);
  const end = to === undefined ? wEnd : earlier(to, cap);
  const dates = datesIn(rule, tomorrow, end);
  if (dates.length > 0 || to !== undefined || rule.startDate <= wEnd) return dates;
  return datesIn(rule, tomorrow, cap);
}

/** `SeriesTermsGone` from the engine — a term changed between the checks and the write. */
function termsGoneFailure(e: SeriesTermsGone): OpFailure {
  switch (e.what) {
    case 'service':
      return fail(409, 'Service not offered.', 'service_not_offered');
    case 'option':
      return fail(400, 'Unknown service option.', 'unknown_option');
    case 'pet':
      return fail(400, 'Unknown pet.', 'unknown_pet');
  }
}

async function judge(
  ctx: BookingOpsContext,
  terms: SeriesTerms,
  dates: string[],
): Promise<WalkEval[] | OpFailure> {
  try {
    return await evaluateWalks(ctx.env, ctx.tenant, terms, dates, {});
  } catch (e) {
    if (e instanceof SeriesTermsGone) return termsGoneFailure(e);
    throw e;
  }
}

const isFailure = (x: unknown): x is OpFailure =>
  typeof x === 'object' && x !== null && 'ok' in x && (x as OpFailure).ok === false;

/** Refuse a span in which no date would book. Null when at least one would. */
function nothingBooks(evals: WalkEval[], tenant: Tenant): OpFailure | null {
  if (evals.some((w) => 'estCostCents' in w)) return null;
  const reasons = new Set(evals.map((w) => ('skipped' in w ? w.skipped : null)));
  if (evals.length > 0 && reasons.size === 1 && reasons.has('unpriced_pet_set'))
    return unpricedRefusal('unpriced-pet-set', tenant.DisplayName);
  if (evals.length > 0 && reasons.size === 1 && reasons.has('cost_out_of_range'))
    return unpricedRefusal('cost-out-of-range', tenant.DisplayName);
  return fail(
    409,
    `None of those dates can be booked with ${tenant.DisplayName} — try other days or a later start.`,
    'no_bookable_dates',
  );
}

// ─── Quote ───────────────────────────────────────────────────────────────────

/**
 * What a series would book, date by date, through the window (or `to`, never past 24 months):
 * each walk's price for its own date, or the reason it would be skipped. Writes nothing and holds
 * nothing. `estCostCentsEach` is a figure only when every priced date states the same one.
 */
export async function quoteSeries(
  ctx: BookingOpsContext,
  input: SeriesInput,
  span: { to?: string } = {},
): Promise<OpResult<SeriesQuote>> {
  if (span.to !== undefined && !isRealDate(span.to))
    return fail(400, 'Invalid date.', 'invalid_date');
  const v = await validateSeriesInput(ctx, input);
  if (isFailure(v)) return v;
  const today = tenantToday(ctx.tenant);
  const wEnd = windowEnd(today, ctx.tenant.MaxAdvanceMonths, v.terms.endDate);
  const evals = await judge(ctx, v.terms, judgedDates(v.terms, today, wEnd, span.to));
  if (isFailure(evals)) return evals;
  return ok({
    walks: evals.map((w): SeriesQuoteWalk =>
      'skipped' in w
        ? { date: w.date, skipped: w.skipped, words: skipWords(w.skipped) }
        : { date: w.date, estCostCents: w.estCostCents },
    ),
    estCostCentsEach: estCostCentsEach(evals),
    openEnded: v.terms.endDate === null,
    pattern: patternWords(v.terms),
    windowEnd: wEnd,
  });
}

// ─── Request ─────────────────────────────────────────────────────────────────

/**
 * Create the series `pending`, with a `pending` row for every date that books through the window
 * and a recorded skip for every date that does not — one batch. The sitter confirms or declines it
 * as a whole. Replays an `Idempotency-Key` the way `createBooking` does; the demo identity is
 * answered as if it were created and nothing persists.
 */
export async function requestSeries(
  ctx: BookingOpsContext,
  input: SeriesInput,
  idempotencyKey: string | null,
): Promise<OpResult<SeriesWire>> {
  const { env, tenant, endUserId } = ctx;
  const db = env.PAWSERVATION_DB;

  if (idempotencyKey && idempotencyKey.length > 128)
    return fail(400, 'Idempotency-Key must be 128 characters or fewer.', 'invalid_idempotency_key');
  const today = tenantToday(tenant);
  const replay = async (): Promise<OpResult<SeriesWire> | null> => {
    if (!idempotencyKey) return null;
    const prior = await findSeriesByIdempotencyKey(db, tenant.Id, endUserId, idempotencyKey);
    return prior ? ok(await seriesWire(env, tenant, prior, today), 201) : null;
  };
  const prior = await replay();
  if (prior) return prior;

  const requester = await getEndUserById(db, tenant.Id, endUserId);
  const v = await validateSeriesInput(ctx, input);
  if (isFailure(v)) return v;
  const { terms } = v;
  const wEnd = windowEnd(today, tenant.MaxAdvanceMonths, terms.endDate);

  if (requester?.Email === DEMO_EMAIL) {
    // Zero-pollution demo, as `createBooking`'s: everything above ran; nothing below persists.
    const evals = await judge(ctx, terms, judgedDates(terms, today, wEnd));
    if (isFailure(evals)) return evals;
    const refused = nothingBooks(evals, tenant);
    if (refused) return refused;
    return ok(demoWire(v, wEnd, evals), 201);
  }

  if (!requester) return fail(404, 'Not found.', 'unknown_customer');
  if (phoneOnFile(requester.Phone) === null)
    return fail(
      400,
      `Add a phone number so ${tenant.DisplayName} can reach you, then send your request again.`,
      'phone_required',
    );

  const evals = await judge(ctx, terms, judgedDates(terms, today, wEnd));
  if (isFailure(evals)) return evals;
  const refused = nothingBooks(evals, tenant);
  if (refused) return refused;

  const series: SeriesRow = {
    Id: crypto.randomUUID(),
    TenantId: tenant.Id,
    EndUserId: endUserId,
    ServiceType: terms.serviceType,
    OptionKey: terms.optionKey,
    Weekdays: terms.weekdays,
    StartTime: terms.startTime,
    StartDate: terms.startDate,
    EndDate: terms.endDate,
    Status: 'pending',
    CreatedBy: 'client',
    OfferExpiresAt: null,
    MaterializedThrough: null,
    Version: 1,
    GCalEventId: null,
    SyncPending: 0,
    CreatedAt: '',
    UpdatedAt: '',
  };
  try {
    await materializeSpan(env, tenant, series, terms, wEnd, today, 'pending', [
      insertSeriesStatement(db, tenant.Id, { ...series, IdempotencyKey: idempotencyKey }),
      ...insertSeriesPetStatements(db, tenant.Id, series.Id, terms.petIds),
    ]);
  } catch (e) {
    if (e instanceof SeriesTermsGone) return termsGoneFailure(e);
    // A lost race on the key: replay the winner — but only a series found BY THAT KEY. Any other
    // unique violation is not a replay and is not answered as one.
    if (idempotencyKey && isUniqueViolation(e)) {
      const winner = await replay();
      if (winner) return winner;
    }
    throw e;
  }
  const saved = await getSeries(db, tenant.Id, series.Id);
  if (!saved) throw new Error('series vanished after its own write');
  return ok(await seriesWire(env, tenant, saved, today), 201);
}

// ─── The wire ────────────────────────────────────────────────────────────────

/**
 * One series as every read answers it, over a span — today through the window by default, `to`
 * widening it up to the 24-month cap. `walks` are its rows in the span, then its projected walks
 * for dates past where its rows stop; `skips` are its recorded skips in the span and the skips
 * projection computes. Every figure is a stored row's or `estimateCost`'s — none derived here.
 */
export async function seriesWire(
  env: Env,
  tenant: Tenant,
  row: SeriesRow,
  today: string,
  span: { to?: string } = {},
): Promise<SeriesWire> {
  const db = env.PAWSERVATION_DB;
  const wEnd = windowEnd(today, tenant.MaxAdvanceMonths, row.EndDate);
  const to = span.to === undefined ? wEnd : earlier(span.to, projectionCap(today));
  const [pets, rows, recorded, services] = await Promise.all([
    listSeriesPetNames(db, tenant.Id, row.Id),
    listSeriesBookingRows(db, tenant.Id, row.Id),
    listSeriesSkips(db, tenant.Id, row.Id),
    listServices(db, tenant.Id),
  ]);
  const tiers = services.find((s) => s.ServiceType === row.ServiceType)?.CancellationTiers ?? null;
  const terms: SeriesTerms = {
    endUserId: row.EndUserId,
    serviceType: row.ServiceType,
    optionKey: row.OptionKey,
    petIds: pets.map((p) => p.PetId),
    weekdays: row.Weekdays,
    startTime: row.StartTime,
    startDate: row.StartDate,
    endDate: row.EndDate,
  };
  const projectFrom =
    row.MaterializedThrough !== null && row.MaterializedThrough >= today
      ? addDays(row.MaterializedThrough, 1)
      : today;
  let projected: Awaited<ReturnType<typeof projectSeries>> = [];
  try {
    projected = await projectSeries(env, tenant, row, terms, projectFrom, to, today);
  } catch (e) {
    // Terms no longer bookable (a pet, option or service gone): nothing can be projected; the
    // rows that exist are still shown.
    if (!(e instanceof SeriesTermsGone)) throw e;
  }

  const inSpan = (date: string) => date >= today && date <= to;
  const walks: SeriesWalkWire[] = [
    ...rows
      .filter((r) => inSpan(r.StartDate))
      .map((r): SeriesWalkWire => {
        const cancellable = isCustomerCancellable(r.Status, r.StartDate, r.EndDate, today);
        return {
          id: r.Id,
          date: r.StartDate,
          status: r.Status as SeriesWalkWire['status'],
          projected: false,
          estCostCents: r.EstCost,
          feeIfCancelledTodayCents: cancellable
            ? feeToCancelTodayForList(r.Id, r.Status, r.EstCost, r.StartDate, tiers, today)
            : null,
        };
      }),
    ...projected
      .filter((p) => p.skipped === undefined)
      .map((p): SeriesWalkWire => ({
        id: p.id,
        date: p.date,
        status: p.status,
        projected: true,
        estCostCents: p.estCostCents,
        // An offer is not the client's booking yet, so there is nothing to cancel; a pending or
        // confirmed projected walk previews its fee the way its row would.
        feeIfCancelledTodayCents:
          p.status === 'offered'
            ? null
            : feeToCancelTodayForList(p.id, p.status, p.estCostCents, p.date, tiers, today),
      })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const skipByDate = new Map<string, SkipReason>();
  for (const s of recorded) if (inSpan(s.Date)) skipByDate.set(s.Date, s.Reason);
  for (const p of projected)
    if (p.skipped !== undefined && !skipByDate.has(p.date)) skipByDate.set(p.date, p.skipped);
  const skips = [...skipByDate]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, reason]) => ({ date, reason, words: skipWords(reason) }));

  const live: WalkEval[] = walks.flatMap((w) =>
    (w.status === 'pending' || w.status === 'confirmed' || w.status === 'offered') &&
    w.estCostCents !== null
      ? [{ date: w.date, estCostCents: w.estCostCents }]
      : [],
  );

  return {
    id: row.Id,
    status: row.Status,
    version: row.Version,
    createdBy: row.CreatedBy,
    type: row.ServiceType,
    optionKey: row.OptionKey,
    petIds: terms.petIds,
    pets: pets.map((p) => p.Name),
    weekdays: namesFromMask(row.Weekdays),
    startTime: row.StartTime,
    startDate: row.StartDate,
    endDate: row.EndDate,
    openEnded: row.EndDate === null,
    pattern: patternWords({
      weekdays: row.Weekdays,
      startDate: row.StartDate,
      endDate: row.EndDate,
    }),
    offerExpiresAt: row.OfferExpiresAt,
    windowEnd: wEnd,
    estCostCentsEach: estCostCentsEach(live),
    walks,
    skips,
  };
}

/** The demo identity's answer: what the request would have created, with nothing behind it. */
function demoWire(v: ValidSeries, wEnd: string, evals: WalkEval[]): SeriesWire {
  const id = 'demo-series';
  const shown = evals.filter((w) => w.date <= wEnd);
  return {
    id,
    status: 'pending',
    version: 1,
    createdBy: 'client',
    type: v.terms.serviceType,
    optionKey: v.terms.optionKey,
    petIds: v.terms.petIds,
    pets: v.petNames,
    weekdays: namesFromMask(v.terms.weekdays),
    startTime: v.terms.startTime,
    startDate: v.terms.startDate,
    endDate: v.terms.endDate,
    openEnded: v.terms.endDate === null,
    pattern: patternWords(v.terms),
    offerExpiresAt: null,
    windowEnd: wEnd,
    estCostCentsEach: estCostCentsEach(shown),
    walks: shown.flatMap((w): SeriesWalkWire[] =>
      'estCostCents' in w
        ? [
            {
              id: projectedId(id, w.date),
              date: w.date,
              status: 'pending',
              projected: true,
              estCostCents: w.estCostCents,
              feeIfCancelledTodayCents: 0,
            },
          ]
        : [],
    ),
    skips: shown.flatMap((w) =>
      'skipped' in w ? [{ date: w.date, reason: w.skipped, words: skipWords(w.skipped) }] : [],
    ),
  };
}
