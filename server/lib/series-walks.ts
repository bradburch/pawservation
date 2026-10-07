/**
 * THE WALK ENGINE. Every series date is judged here and nowhere else: priced by `estimateCost` for
 * its own date (holiday rates apply), checked against capacity for its own date, and either written
 * as an ordinary booking row carrying SeriesId or recorded as a skip with its reason. Projection is
 * the same judgement on read, written nowhere and holding nothing.
 *
 * It never calls `createBooking`: that function reads the real clock, has a demo arm, an
 * idempotency key, a phone gate and a per-row calendar push — none of which a walk may arm. `today`
 * is always an argument.
 *
 * Every span is bounded here, not by the caller: nothing iterates past `projectionCap(today)`,
 * whatever date it is handed, so a client-supplied `to` can never make a request walk decades.
 */
import { addDays, type GroupRate, type MixRate, type PricedPet } from '../../src/shared/index.js';
import {
  listEndUserPets,
  listServiceOptions,
  listServices,
  listSeriesBookingDates,
  listSeriesSkips,
  deleteBookingRequestsStatements,
  getSeriesEarliestRowAnswers,
  insertSeriesRowStatements,
  insertSeriesSkipStatement,
  runSeriesBatch,
  setMaterializedThroughStatement,
  setSeriesOptionKeyStatement,
  type OccupancyScope,
  type SeriesRow,
} from '../db/repo';
import type { Tenant, TenantService, TenantServiceOption } from '../types';
import {
  estimateCost,
  loadPetSetRates,
  walkConflictsForSpan,
  type WalkConflict,
} from './availability';
import { datesIn, projectedId, projectionCap, type SkipReason } from './series-rule';

export type SeriesTerms = {
  endUserId: string;
  serviceType: string;
  optionKey: string | null;
  petIds: string[];
  weekdays: number;
  startTime: string | null;
  startDate: string;
  endDate: string | null;
  /** Intake answers written on every walk this call creates; `{}` when absent. */
  answers?: Record<string, string>;
};
export type WalkEval =
  { date: string; estCostCents: number } | { date: string; skipped: SkipReason };
export type ProjectedWalk = {
  id: string;
  date: string;
  status: 'confirmed' | 'pending' | 'offered';
  estCostCents: number | null;
  skipped?: SkipReason;
};

/**
 * The series' terms no longer describe something bookable: its service or option is gone, or one
 * of its pets is no longer the client's living pet. Thrown rather than priced around — pricing the
 * pets that remain would quote a one-dog walk for a two-dog series, a price nobody asked for.
 * Callers turn it into a skip of every date as `unavailable` (the cron) or a 409 (routes).
 */
export class SeriesTermsGone extends Error {
  constructor(readonly what: 'service' | 'option' | 'pet') {
    super(`series terms gone: ${what}`);
    this.name = 'SeriesTermsGone';
  }
}

/** One table from every refusal code to a skip reason — matched, and anything else `unavailable`. */
export function skipReasonOf(
  c: WalkConflict | 'unpriced-pet-set' | 'cost-out-of-range',
): SkipReason {
  switch (c) {
    case 'time_off':
      return 'time_off';
    case 'external':
    case 'slot_full':
    case 'slot_no_room':
      return 'full';
    case 'unpriced-pet-set':
      return 'unpriced_pet_set';
    case 'cost-out-of-range':
      return 'cost_out_of_range';
    case 'other':
    default:
      return 'unavailable';
  }
}

/** The one figure every priced walk states, or null when they differ (a holiday) or none is priced. */
export function estCostCentsEach(walks: WalkEval[]): number | null {
  const figures = new Set(walks.flatMap((w) => ('estCostCents' in w ? [w.estCostCents] : [])));
  return figures.size === 1 ? [...figures][0] : null;
}

type LoadedTerms = {
  service: TenantService;
  option: TenantServiceOption;
  pets: PricedPet[];
  rates: { groupRates: GroupRate[]; mixRates: MixRate[] };
};

/**
 * The service, option, priced pets and rate rows the terms name — read live, the way
 * `createBooking` does, and ONCE per engine call: everything after (the plan, the write, the
 * re-check) uses this one reading, so terms changing mid-call can never skip a step.
 *
 * `'switched_off'` is a service that exists but she has turned off: gone for new walks, exactly as
 * a single booking of it is refused (`service_not_offered`). Kept apart from a THROW only so
 * projection can show nothing (and show the walks again when she turns it back on) without an
 * error; every writer turns it into `SeriesTermsGone('service')`.
 */
async function loadTerms(
  env: Env,
  tenant: Tenant,
  terms: SeriesTerms,
): Promise<LoadedTerms | 'switched_off'> {
  const db = env.PAWSERVATION_DB;
  const [services, options, myPets] = await Promise.all([
    listServices(db, tenant.Id),
    listServiceOptions(db, tenant.Id),
    listEndUserPets(db, tenant.Id, terms.endUserId),
  ]);
  const service = services.find((s) => s.ServiceType === terms.serviceType);
  if (!service) throw new SeriesTermsGone('service');
  if (!service.Enabled) return 'switched_off';
  // No option named → the service's first, the same fallback `createBooking` resolves. Whatever is
  // resolved here is what gets WRITTEN, so the row is counted against the slot it was priced in.
  const option =
    terms.optionKey === null
      ? options.find((o) => o.ServiceType === terms.serviceType)
      : options.find((o) => o.ServiceType === terms.serviceType && o.OptionKey === terms.optionKey);
  if (!option) throw new SeriesTermsGone('option');
  // `listEndUserPets` returns only this client's LIVING pets, so a pet that died, was deleted or
  // was moved to another owner is simply not found — one check for all three.
  const pets: PricedPet[] = [];
  for (const id of new Set(terms.petIds)) {
    const p = myPets.find((m) => m.Id === id);
    if (!p) throw new SeriesTermsGone('pet');
    pets.push({ id: p.Id, petType: p.PetType });
  }
  const rates = await loadPetSetRates(env, tenant.Id, service.ServiceType);
  return { service, option, pets, rates };
}

async function requireTerms(env: Env, tenant: Tenant, terms: SeriesTerms): Promise<LoadedTerms> {
  const loaded = await loadTerms(env, tenant, terms);
  if (loaded === 'switched_off') throw new SeriesTermsGone('service');
  return loaded;
}

const petCountOf = (t: LoadedTerms): number => Math.max(t.pets.length, 1);

async function judge(
  env: Env,
  tenant: Tenant,
  t: LoadedTerms,
  dates: string[],
  opts: { excludeSeriesId?: string; recorded?: Map<string, SkipReason>; scope?: OccupancyScope },
): Promise<WalkEval[]> {
  const open = dates.filter((d) => !opts.recorded?.has(d));
  const conflicts = await walkConflictsForSpan(
    env,
    tenant,
    t.service,
    t.option,
    open,
    petCountOf(t),
    opts.excludeSeriesId ?? null,
    opts.scope,
  );
  return dates.map((date): WalkEval => {
    const recorded = opts.recorded?.get(date);
    if (recorded) return { date, skipped: recorded };
    const price = estimateCost(t.service, t.option, date, date, t.pets, t.rates);
    if (!price.priced) return { date, skipped: skipReasonOf(price.reason) };
    const c = conflicts.get(date);
    if (c) return { date, skipped: skipReasonOf(c) };
    return { date, estCostCents: price.cost };
  });
}

/**
 * Judge each date: a recorded skip stands; otherwise the price for that date (refused → its
 * reason, never a figure), then capacity for that date. Capacity is read once for the span. A
 * switched-off service is `SeriesTermsGone('service')`.
 */
export async function evaluateWalks(
  env: Env,
  tenant: Tenant,
  terms: SeriesTerms,
  dates: string[],
  opts: {
    excludeSeriesId?: string;
    recorded?: Map<string, SkipReason>;
    scope?: OccupancyScope;
  },
): Promise<WalkEval[]> {
  if (dates.length === 0) return [];
  return judge(env, tenant, await requireTerms(env, tenant, terms), dates, opts);
}

const earlier = (a: string, b: string): string => (a < b ? a : b);

/**
 * Write the series' walks from where it last stopped (or from its start, never earlier than
 * tomorrow) through `through` — capped at `projectionCap(today)` — in ONE batch: `prelude` first
 * (a new series and its pets), then a row or a skip per date, then the MaterializedThrough mark.
 * Dates that already have a row (any status) or a recorded skip are not judged again, so a second
 * pass over the same span writes nothing. Gone terms — a switched-off or deleted service, a
 * missing option, a pet no longer the client's — throw `SeriesTermsGone` before anything, the
 * prelude included, is written. Every row carries the RESOLVED option, and a series that named
 * none is fixed to it in the same batch.
 *
 * THE RE-CHECK. The plan was judged on a read; a concurrent writer may have filled a day since.
 * After the batch, every row this call inserted is asked again "do I still fit, ignoring this
 * series' own walks?" — against the terms read at the start of the call, so a change since cannot
 * skip it. A row that no longer fits is deleted and recorded with the reason it no longer fits.
 * Only rows THIS call inserted are ever deleted — the existing fail-safe direction: two racers may
 * both lose, neither double-books.
 */
export async function materializeSpan(
  env: Env,
  tenant: Tenant,
  series: SeriesRow,
  terms: SeriesTerms,
  through: string,
  today: string,
  rowStatus: 'pending' | 'confirmed',
  prelude: D1PreparedStatement[] = [],
): Promise<{
  added: { id: string; date: string }[];
  skipped: { date: string; reason: SkipReason }[];
}> {
  const db = env.PAWSERVATION_DB;
  const t = await requireTerms(env, tenant, terms);
  const end = earlier(through, projectionCap(today));
  // Today's walk is never created late: a series asked for today starts tomorrow; an existing row
  // for today stays. (Same-day lead is MinLeadDays' job at request time.)
  const tomorrow = addDays(today, 1);
  const resume =
    series.MaterializedThrough === null ? terms.startDate : addDays(series.MaterializedThrough, 1);
  const from = resume > tomorrow ? resume : tomorrow;
  const [existing, recordedSkips] = await Promise.all([
    listSeriesBookingDates(db, tenant.Id, series.Id),
    listSeriesSkips(db, tenant.Id, series.Id),
  ]);
  const recorded = new Set(recordedSkips.map((s) => s.Date));
  const dates = datesIn(terms, from, end).filter((d) => !existing.has(d) && !recorded.has(d));
  const plan = await judge(env, tenant, t, dates, { excludeSeriesId: series.Id });

  const statements = [...prelude];
  if (terms.optionKey === null)
    statements.push(setSeriesOptionKeyStatement(db, tenant.Id, series.Id, t.option.OptionKey));
  const added: { id: string; date: string }[] = [];
  const skipped: { date: string; reason: SkipReason }[] = [];
  for (const w of plan) {
    if ('skipped' in w) {
      statements.push(insertSeriesSkipStatement(db, tenant.Id, series.Id, w.date, w.skipped));
      skipped.push({ date: w.date, reason: w.skipped });
      continue;
    }
    const id = crypto.randomUUID();
    statements.push(
      ...insertSeriesRowStatements(db, tenant.Id, series.Id, {
        id,
        endUserId: terms.endUserId,
        serviceType: terms.serviceType,
        date: w.date,
        optionKey: t.option.OptionKey,
        petIds: terms.petIds,
        startTime: terms.startTime,
        estCostCents: w.estCostCents,
        status: rowStatus,
        answers: terms.answers,
      }),
    );
    added.push({ id, date: w.date });
  }
  const armed = added.length > 0 || skipped.length > 0;
  statements.push(setMaterializedThroughStatement(db, tenant.Id, series.Id, end, armed));
  await runSeriesBatch(db, statements); // all or nothing

  if (added.length > 0) {
    const after = await walkConflictsForSpan(
      env,
      tenant,
      t.service,
      t.option,
      added.map((a) => a.date),
      petCountOf(t),
      series.Id,
    );
    const lost = added.flatMap((a) => {
      const c = after.get(a.date);
      return c ? [{ ...a, reason: skipReasonOf(c) }] : [];
    });
    if (lost.length > 0) {
      await runSeriesBatch(db, [
        ...deleteBookingRequestsStatements(
          db,
          tenant.Id,
          lost.map((l) => l.id),
        ),
        ...lost.map((l) => insertSeriesSkipStatement(db, tenant.Id, series.Id, l.date, l.reason)),
      ]);
      const lostIds = new Set(lost.map((l) => l.id));
      const kept = added.filter((a) => !lostIds.has(a.id));
      added.splice(0, added.length, ...kept);
      skipped.push(...lost.map((l) => ({ date: l.date, reason: l.reason })));
      skipped.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
  }
  return { added, skipped };
}

/**
 * The intake answers a series' walks carry: its earliest row's, so a walk added by a later pass
 * (the window moving on) carries the same answers the request gave. `{}` when the series has no
 * row yet or the stored value is unreadable — never a throw, as every other answers read.
 */
export async function seriesAnswers(
  db: D1Database,
  tenantId: string,
  seriesId: string,
): Promise<Record<string, string>> {
  const raw = await getSeriesEarliestRowAnswers(db, tenantId, seriesId);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

const PROJECTED_STATUS: Partial<Record<SeriesRow['Status'], ProjectedWalk['status']>> = {
  active: 'confirmed',
  pending: 'pending',
  pending_client: 'offered',
};

/**
 * The series' walks from `from` to `to` (capped at `projectionCap(today)`, never today or earlier)
 * that have no row yet: each judged as `evaluateWalks` judges it, at today's rates, with a recorded
 * skip read rather than computed. Projection holds no capacity — each date is judged against rows
 * only, never against another projected walk — so two series projected onto one full day both
 * read as booked until the window reaches them. A series in any other status projects nothing.
 */
export async function projectSeries(
  env: Env,
  tenant: Tenant,
  series: SeriesRow,
  terms: SeriesTerms,
  from: string,
  to: string,
  today: string,
): Promise<ProjectedWalk[]> {
  const status = PROJECTED_STATUS[series.Status];
  if (status === undefined) return [];
  const db = env.PAWSERVATION_DB;
  const [rows, skips] = await Promise.all([
    listSeriesBookingDates(db, tenant.Id, series.Id),
    listSeriesSkips(db, tenant.Id, series.Id),
  ]);
  const recorded = new Map(skips.map((s) => [s.Date, s.Reason]));
  const tomorrow = addDays(today, 1);
  const start = from > tomorrow ? from : tomorrow;
  const end = earlier(to, projectionCap(today));
  const dates = datesIn(terms, start, end).filter((d) => !rows.has(d));
  if (dates.length === 0) return [];
  const t = await loadTerms(env, tenant, terms);
  // Switched off: nothing projected, and — projection being computed — the walks reappear the
  // moment she switches the service back on.
  if (t === 'switched_off') return [];
  const evals = await judge(env, tenant, t, dates, { recorded });
  return evals.map((w) => ({
    id: projectedId(series.Id, w.date),
    date: w.date,
    status,
    estCostCents: 'estCostCents' in w ? w.estCostCents : null,
    ...('skipped' in w ? { skipped: w.skipped } : {}),
  }));
}
