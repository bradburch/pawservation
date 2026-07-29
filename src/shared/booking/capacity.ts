import { addDays, DATE_RE } from '../util/dates.js';

// Single source of truth for the booking calendar's capacity + conflict rules,
// shared between the web client (calendar UX) and the web server (validation).
//
// Capacity is PER SERVICE and measured in PETS: each pool-drawing service carries its own cap
// (MaxConcurrentPets, for boarding-kind AND housesit-kind); a `null` cap is UNLIMITED (auto
// pass-through) and is never compared. A booking with three pets consumes three units. Other
// services' occupancy is invisible to a request's cap check. Admin-blocked dates always block.
// The house-sit/boarding overlap rule stays TENANT-WIDE (all boarding-kind services) and is
// SYMMETRIC: it models the sitter's physical whereabouts, not a pool — she cannot sleep at a
// client's house and keep a boarder at her own — so it governs a boarding laid over a house sit
// exactly as it governs a house sit laid over boarding. Its allowance arrives on the request
// (`overlapAllowance`, from Tenants.HousesitBoardingOverlapDays); this module reads no config.
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
   * Number of pets the event covers — capacity is measured in PETS for every pool kind, so a
   * 3-pet booking fills 3 slots. Defaults to 1. Blocked events (binary) ignore it.
   */
  petCount?: number;
};

/**
 * One pool KIND's footprint on one day, tenant-wide (every service of that kind summed). Feeds the
 * structural cross-kind overlap rule ONLY — per-service capacity is `byService`.
 */
export type KindOccupancy = {
  /** Pets of this kind occupying the day. */
  total: number;
  /**
   * How many events of this kind are MID-STAY here — this day is neither their first nor their
   * last occupied day. A spanning day offers no handover: the sitter is committed to it end to
   * end, so nothing of the opposite kind may share it however generous the allowance.
   */
  spanning: number;
};

export type DayCapacity = {
  /** Occupancy per service, in PETS (boarding-kind and housesit-kind alike). */
  byService: Map<string, number>;
  /** ALL boarding-kind pets on this day — drives the structural cross-kind rule only. */
  boarding: KindOccupancy;
  /** ALL housesit-kind pets on this day — the mirror of `boarding`, same rule, other direction. */
  housesit: KindOccupancy;
  blocked: number;
  isBoundary: boolean;
};

/** What the caller wants to book, carrying its own service's cap. */
export type CapacityRequest = {
  serviceType: string;
  kind: PoolKind;
  /** The service's MaxConcurrentPets; null = unlimited. */
  cap: number | null;
  /** Pets in this request; default 1. */
  petCount?: number;
  /**
   * `Tenants.HousesitBoardingOverlapDays` — how many days this request may overlap OPPOSITE-kind
   * occupancy, counted only at the tail ends (see `rangeConflictReason`). 0 = never; 1 = the
   * product default; NULL = no limit, the rule stops running. REQUIRED on purpose: a defaulted
   * field is how the quote and the booking POST would silently disagree, so every construction
   * site must name the tenant's value.
   */
  overlapAllowance: number | null;
};

const emptyDay = (): DayCapacity => ({
  byService: new Map(),
  boarding: { total: 0, spanning: 0 },
  housesit: { total: 0, spanning: 0 },
  blocked: 0,
  isBoundary: false,
});

/** Units a request/event occupies in its own pool: always its pet count (min 1). Capacity is
 * measured in PETS for every pool kind — a booking with three pets consumes three units. */
const unitsOf = (petCount: number | undefined): number => Math.max(1, petCount ?? 1);

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

    // The last day this event OCCUPIES (end is exclusive). Everything strictly between `start` and
    // it is a spanning day — see KindOccupancy.spanning. A single-occupied-day event is its own
    // first and last day, so it spans nothing.
    const lastOccupied = addDays(end, -1);

    for (let d = start; d < end; d = addDays(d, 1)) {
      const day = getOrCreate(d);
      if (event.kind === 'blocked') {
        day.blocked += 1;
        continue;
      }
      const units = unitsOf(event.petCount);
      const key = event.serviceType ?? '';
      day.byService.set(key, (day.byService.get(key) ?? 0) + units);
      const occupancy = event.kind === 'boarding' ? day.boarding : day.housesit;
      occupancy.total += units;
      if (d !== start && d !== lastOccupied) occupancy.spanning += 1;
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
  const units = unitsOf(request.petCount);
  return (day.byService.get(request.serviceType) ?? 0) + units > request.cap;
}

/**
 * Why a range was refused, or `null` when it was not. `rangeHasConflict` is the boolean view of
 * this exact walk — one implementation, so a caller that wants to TELL the customer why can never
 * disagree with the caller that only asks yes/no.
 *
 * - `over_cap` — more pets than the request's own service cap could ever seat.
 * - `cross_kind_overlap` — the house-sit/boarding rule below.
 * - `blocked_or_full` — an admin block, or the service's own pool with no room.
 */
export type RangeConflict = 'over_cap' | 'cross_kind_overlap' | 'blocked_or_full';

export function rangeHasConflict(
  startDate: string,
  endDateExclusive: string,
  request: CapacityRequest,
  capacityByDate: Map<string, DayCapacity>,
): boolean {
  return rangeConflictReason(startDate, endDateExclusive, request, capacityByDate) !== null;
}

export function rangeConflictReason(
  startDate: string,
  endDateExclusive: string,
  request: CapacityRequest,
  capacityByDate: Map<string, DayCapacity>,
): RangeConflict | null {
  const requestEnd = addDays(endDateExclusive, -1); // last occupied night
  const units = unitsOf(request.petCount);
  let overlapDays = 0;

  // A request for more units than its own cap can NEVER fit — not even on an empty calendar,
  // where the day-by-day walk below has nothing to inspect. Enforcing it here keeps the engine
  // correct standalone (the single source of truth), so callers need no separate isolation check.
  if (request.cap !== null && units > request.cap) return 'over_cap';

  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    const day = capacityByDate.get(date);
    if (!day) continue;

    const isRequestEndpoint = date === startDate || date === requestEnd;

    // Structural rule (TENANT-WIDE, SYMMETRIC): a house sit and boarding may share a day only at
    // the TAIL ENDS, because the sitter cannot be in two places — this models her whereabouts, not
    // a pool, so it reads occupancy from ANY service of the opposite kind. `overlapAllowance` is
    // the tenant's own number (null = the rule is off entirely). A shared day is legal only when
    // ALL THREE hold: the running count is within the allowance; the day is an endpoint of THIS
    // request; and no opposite-kind booking is mid-stay on it. The third is what refuses a
    // one-night boarding dropped inside a ten-day house sit — a stay with a single occupied day is
    // trivially "at its own endpoint", and without the existing booking's side of the handover
    // the allowance would legalise exactly the double-booking it exists to prevent.
    if (request.overlapAllowance !== null) {
      const opposite = request.kind === 'housesit' ? day.boarding : day.housesit;
      if (opposite.total > 0) {
        overlapDays += 1;
        if (overlapDays > request.overlapAllowance) return 'cross_kind_overlap';
        if (!isRequestEndpoint || opposite.spanning > 0) return 'cross_kind_overlap';
      }
    }

    if (!dayBlocksRequest(day, request)) continue;

    if (isRequestEndpoint && day.isBoundary) continue;

    // Soft bookend: an unavailable (non-blocked) endpoint is allowed when the next day has
    // room for this request — the existing booking is ending here.
    if (isRequestEndpoint && day.blocked === 0) {
      const next = capacityByDate.get(addDays(date, 1));
      if (!next || !dayBlocksRequest(next, request)) continue;
    }

    return 'blocked_or_full';
  }

  return null;
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
