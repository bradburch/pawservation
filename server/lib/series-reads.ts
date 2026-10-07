/**
 * READING SERIES FOR A LIST. What every series read shares, kept apart from the operations so the
 * booking lists (`booking-ops.ts`) and the series reads (`series-ops.ts`) both build on it without
 * importing each other: the stored rows, pets and skips of many series in a fixed number of
 * reads, the terms they describe, and the projected walks a booking list shows when it is asked
 * for a range.
 *
 * Every read is tenant-scoped in its own SQL, and a client's list is handed only her own series —
 * so a projected walk of another tenant's or another client's series can never be built here.
 */
import {
  listSeriesBookingRowsFor,
  listSeriesPetNamesFor,
  listSeriesSkipsFor,
  type SeriesRow,
  type SeriesSkipRow,
  type SeriesStatus,
} from '../db/repo';
import type { BookingRow, Tenant } from '../types';
import {
  parseSeriesAnswers,
  seriesProjector,
  SeriesTermsGone,
  type ProjectedWalk,
  type SeriesProjector,
  type SeriesTerms,
} from './series-walks';

/** The statuses whose walks are projected: everything a client or a sitter may still act on. */
export const LIVE_SERIES_STATUSES: SeriesStatus[] = ['active', 'pending', 'pending_client'];

/** A list's span as a route parsed it (`parseListRange`): both bounds optional. */
export type ReadSpan = { from?: string; to?: string };

export type SeriesBundle = {
  row: SeriesRow;
  pets: { PetId: string; Name: string }[];
  rows: (BookingRow & { SeriesId: string; Answers: string })[];
  skips: SeriesSkipRow[];
};

/** Everything stored for each series, in three reads for the whole list (never one per series). */
export async function loadBundles(db: D1Database, tenantId: string, rows: SeriesRow[]) {
  const ids = rows.map((r) => r.Id);
  const [pets, bookings, skips] = await Promise.all([
    listSeriesPetNamesFor(db, tenantId, ids),
    listSeriesBookingRowsFor(db, tenantId, ids),
    listSeriesSkipsFor(db, tenantId, ids),
  ]);
  const group = <T extends { SeriesId: string }>(items: T[]) => {
    const by = new Map<string, T[]>();
    for (const it of items) by.set(it.SeriesId, [...(by.get(it.SeriesId) ?? []), it]);
    return by;
  };
  const petsBy = group(pets);
  const rowsBy = group(bookings);
  const skipsBy = group(skips);
  return rows.map((row): SeriesBundle => ({
    row,
    pets: petsBy.get(row.Id) ?? [],
    rows: rowsBy.get(row.Id) ?? [],
    skips: skipsBy.get(row.Id) ?? [],
  }));
}

export const termsOf = (b: SeriesBundle): SeriesTerms => ({
  endUserId: b.row.EndUserId,
  serviceType: b.row.ServiceType,
  optionKey: b.row.OptionKey,
  petIds: b.pets.map((p) => p.PetId),
  weekdays: b.row.Weekdays,
  startTime: b.row.StartTime,
  startDate: b.row.StartDate,
  endDate: b.row.EndDate,
});

export const knownOf = (b: SeriesBundle) => ({
  rowDates: new Set(b.rows.map((r) => r.StartDate)),
  skips: new Map(b.skips.map((s) => [s.Date, s.Reason])),
});

/** Project, or nothing when the terms are gone (a pet, option or service no longer bookable). */
export async function projectOrNothing(
  project: SeriesProjector,
  ...args: Parameters<SeriesProjector>
): Promise<ProjectedWalk[]> {
  try {
    return await project(...args);
  } catch (e) {
    if (!(e instanceof SeriesTermsGone)) throw e;
    return [];
  }
}

/** One projected walk as a booking list needs it: the walk, its series, pets and answers. */
export type ListedProjection = {
  series: SeriesRow;
  walk: ProjectedWalk;
  petIds: string[];
  petNames: string[];
  answers: Record<string, string>;
};

/**
 * The walks a booking list shows past its rows when it is asked for a range (`to`): every live
 * series' projected walks in `[max(from ?? today, tomorrow), min(to, projectionCap(today))]`, each
 * with what a list row needs — the series, its pets as named, its intake answers (its earliest
 * row's, which every later walk carries). A recorded skip in the span is a walk carrying `skipped`.
 * The lists project the WHOLE span — unlike `seriesWire`, which starts past the rows — because a
 * list has no `skips` of its own to say why a week has no row. Read once for the whole list.
 */
export async function projectedListWalks(
  env: Env,
  tenant: Tenant,
  seriesRows: SeriesRow[],
  today: string,
  span: ReadSpan & { to: string },
  opts: { allPets?: boolean } = {},
): Promise<ListedProjection[]> {
  const live = seriesRows.filter((r) => LIVE_SERIES_STATUSES.includes(r.Status));
  if (live.length === 0) return [];
  const bundles = await loadBundles(env.PAWSERVATION_DB, tenant.Id, live);
  const project = seriesProjector(
    env,
    tenant,
    today,
    { from: span.from ?? today, to: span.to },
    opts,
  );
  const out = await Promise.all(
    bundles.map(async (b) => {
      const walks = await projectOrNothing(project, b.row, termsOf(b), { known: knownOf(b) });
      const answers = parseSeriesAnswers(b.rows[0]?.Answers ?? null);
      return walks.map((walk): ListedProjection => ({
        series: b.row,
        walk,
        petIds: b.pets.map((p) => p.PetId),
        petNames: b.pets.map((p) => p.Name),
        answers,
      }));
    }),
  );
  return out
    .flat()
    .sort((a, b) => (a.walk.date < b.walk.date ? -1 : a.walk.date > b.walk.date ? 1 : 0));
}
