import { addDays, DATE_RE } from '../util/dates.js';

// Single source of truth for the booking calendar's capacity + conflict rules,
// shared between the web client (calendar UX) and the web server (validation).
//
// Capacity is PER SERVICE (0015): each pool-drawing service carries its own cap
// (MaxConcurrentPets for boarding-kind, MaxPerDay for housesit-kind); a `null` cap is
// UNLIMITED (auto pass-through) and is never compared. Other services' occupancy is
// invisible to a request's cap check. Admin-blocked dates always block.
// The house-sit/boarding ≤1-day overlap rule stays TENANT-WIDE (all boarding-kind
// services): it models the sitter's physical absence, not a pool.
// Boundary (bookend) sharing: the start/end day of an existing booking may be
// shared by a new booking's endpoint, EXCEPT for blocked events.

export type PoolKind = 'boarding' | 'housesit';

/** A normalized all-day calendar event for capacity building. `end_date` is exclusive. */
export type CapacityEvent = {
  start_date: string;
  end_date?: string;
  kind: PoolKind | 'blocked';
  /** Pool identity — the service's slug. Required unless kind='blocked'. */
  serviceType?: string;
  /**
   * Number of pets the event covers — only meaningful for boarding-kind, where capacity is
   * measured in PETS: a single 2-dog boarding fills both slots. Defaults to 1.
   * Housesit-kind (day-counted) and blocked (binary) ignore it.
   */
  petCount?: number;
};

export type DayCapacity = {
  /** Occupancy per service: pets (boarding-kind) / bookings (housesit-kind). */
  byService: Map<string, number>;
  /** ALL boarding-kind pets on this day — drives the structural house-sit rule only. */
  boardingTotal: number;
  blocked: number;
  isBoundary: boolean;
};

/** What the caller wants to book, carrying its own service's cap. */
export type CapacityRequest = {
  serviceType: string;
  kind: PoolKind;
  /** The service's MaxConcurrentPets / MaxPerDay; null = unlimited. */
  cap: number | null;
  /** Boarding-kind only; default 1. */
  petCount?: number;
};

const emptyDay = (): DayCapacity => ({
  byService: new Map(),
  boardingTotal: 0,
  blocked: 0,
  isBoundary: false,
});

/** Units a request/event occupies in its own pool: pets for boarding-kind, 1 for housesit-kind. */
const unitsOf = (kind: PoolKind, petCount: number | undefined): number =>
  kind === 'boarding' ? Math.max(1, petCount ?? 1) : 1;

/** Build a per-day capacity map from normalized events (end date exclusive). */
export function buildCapacity(events: CapacityEvent[]): Map<string, DayCapacity> {
  const byDate = new Map<string, DayCapacity>();
  const getOrCreate = (dateStr: string): DayCapacity => {
    let state = byDate.get(dateStr);
    if (!state) {
      state = emptyDay();
      byDate.set(dateStr, state);
    }
    return state;
  };

  for (const event of events) {
    const start = event.start_date;
    const end = event.end_date || event.start_date;
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) continue;

    // Blocked events get no boundary — no bookend sharing.
    if (event.kind !== 'blocked') {
      getOrCreate(start).isBoundary = true;
      getOrCreate(end).isBoundary = true;
    }

    for (let d = start; d < end; d = addDays(d, 1)) {
      const day = getOrCreate(d);
      if (event.kind === 'blocked') {
        day.blocked += 1;
        continue;
      }
      const units = unitsOf(event.kind, event.petCount);
      const key = event.serviceType ?? '';
      day.byService.set(key, (day.byService.get(key) ?? 0) + units);
      if (event.kind === 'boarding') day.boardingTotal += units;
    }
  }

  return byDate;
}

/**
 * Can a request NOT occupy this day in isolation? A block is always a hard stop. Otherwise the
 * request is governed only by its OWN service's cap over its OWN service's occupancy; a `null`
 * cap never blocks (auto pass-through). Cross-service interaction (a house-sit may not overlap
 * occupied boarding by more than one day) is enforced at the range level, not here.
 */
export function dayBlocksRequest(day: DayCapacity, request: CapacityRequest): boolean {
  if (day.blocked >= 1) return true;
  if (request.cap === null) return false;
  const units = unitsOf(request.kind, request.petCount);
  return (day.byService.get(request.serviceType) ?? 0) + units > request.cap;
}

export function rangeHasConflict(
  startDate: string,
  endDateExclusive: string,
  request: CapacityRequest,
  capacityByDate: Map<string, DayCapacity>,
): boolean {
  const requestEnd = addDays(endDateExclusive, -1); // last occupied night
  const units = unitsOf(request.kind, request.petCount);
  let houseSitBoardingOverlapDays = 0;

  // A request for more units than its own cap can NEVER fit — not even on an empty calendar,
  // where the day-by-day walk below has nothing to inspect. Enforcing it here keeps the engine
  // correct standalone (the single source of truth), so callers need no separate isolation check.
  if (request.cap !== null && units > request.cap) return true;

  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    const day = capacityByDate.get(date);
    if (!day) continue;

    // Structural rule (TENANT-WIDE): a house-sit may overlap existing boarding — on ANY
    // boarding-kind service — by at most one day. Models the sitter's absence, not a pool.
    if (request.kind === 'housesit' && day.boardingTotal > 0) {
      houseSitBoardingOverlapDays += 1;
      if (houseSitBoardingOverlapDays > 1) return true;
    }

    if (!dayBlocksRequest(day, request)) continue;

    const isRequestEndpoint = date === startDate || date === requestEnd;
    if (isRequestEndpoint && day.isBoundary) continue;

    // Soft bookend: an unavailable (non-blocked) endpoint is allowed when the next day has
    // room for this request — the existing booking is ending here.
    if (isRequestEndpoint && day.blocked === 0) {
      const next = capacityByDate.get(addDays(date, 1));
      if (!next || !dayBlocksRequest(next, request)) continue;
    }

    return true;
  }

  return false;
}

/** Walks/check-ins only conflict with fully-blocked days. */
export function walkHasConflict(date: string, capacityByDate: Map<string, DayCapacity>): boolean {
  return (capacityByDate.get(date)?.blocked ?? 0) >= 1;
}

export interface Opening {
  startDate: string; // YYYY-MM-DD
  endDate?: string; // exclusive checkout, for range services only
}

/**
 * Scan the prebuilt capacity map for available slots between `from` (inclusive) and `to`
 * (inclusive candidate start dates), returning up to `limit` openings. Reuses
 * rangeHasConflict / walkHasConflict — NO new rules. Range requests carry a full
 * CapacityRequest; `timed` requests (walk/check-in style) are single-day, block-only.
 *
 * NOTE: no in-repo callers — kept because it is exported engine API whose semantics external
 * consumers (e.g. the deployed booking MCP) mirror. Do not delete.
 */
export function findOpenings(
  capacity: Map<string, DayCapacity>,
  opts:
    | { request: CapacityRequest; from: string; to: string; nights?: number; limit?: number }
    | { timed: true; from: string; to: string; limit?: number },
): Opening[] {
  const limit = opts.limit ?? 3;
  const result: Opening[] = [];

  for (
    let start = opts.from;
    start <= opts.to && result.length < limit;
    start = addDays(start, 1)
  ) {
    if ('timed' in opts) {
      if (!walkHasConflict(start, capacity)) {
        result.push({ startDate: start });
      }
    } else {
      const nights = Math.max(1, opts.nights ?? 1);
      const end = addDays(start, nights);
      if (!rangeHasConflict(start, end, opts.request, capacity)) {
        result.push({ startDate: start, endDate: end });
      }
    }
  }

  return result;
}
