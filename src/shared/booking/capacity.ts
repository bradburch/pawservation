import type { RequestType } from '../types/booking.js';
import { addDays, DATE_RE } from '../util/dates.js';

// Single source of truth for the booking calendar's capacity + conflict rules,
// shared between the web client (calendar UX) and the web server (validation).
//
// Capacity is per-tenant config via CapacityLimits: a `null` dimension is UNLIMITED
// (auto pass-through) and is never compared. Admin-blocked dates always block.
// House-sit/boarding may overlap by at most one day (structural rule, not a number).
// Boundary (bookend) sharing: the start/end day of an existing booking may be
// shared by a new booking's endpoint, EXCEPT for blocked events.

/** Per-tenant capacity limits. `null` means no limit (auto pass-through). */
export type CapacityLimits = {
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
};

export type DayCapacity = {
  boarding: number;
  houseSits: number;
  blocked: number;
  isBoundary: boolean;
};

/** A normalized all-day calendar event for capacity building. `end_date` is exclusive. */
export type CapacityEvent = {
  start_date: string;
  end_date?: string;
  type: 'boarding' | 'house-sit' | 'blocked';
  /**
   * Number of pets the event covers — only meaningful for `boarding`, where capacity is
   * measured in PETS: a single 2-dog boarding fills both slots. Defaults to 1.
   * House-sit (no pet limit) and blocked (binary) ignore it.
   */
  petCount?: number;
};

const emptyDay = (): DayCapacity => ({ boarding: 0, houseSits: 0, blocked: 0, isBoundary: false });

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
    if (event.type !== 'blocked') {
      getOrCreate(start).isBoundary = true;
      getOrCreate(end).isBoundary = true;
    }

    const boardingPets = Math.max(1, event.petCount ?? 1);
    for (let d = start; d < end; d = addDays(d, 1)) {
      const capacity = getOrCreate(d);
      if (event.type === 'house-sit') capacity.houseSits += 1;
      // Boarding capacity is counted in PETS: a 2-dog boarding fills both slots.
      else if (event.type === 'boarding') capacity.boarding += boardingPets;
      else capacity.blocked += 1;
    }
  }

  return byDate;
}

/** A day is unavailable when blocked, or a configured boarding/house-sit limit is met. */
export function isUnavailableDate(capacity: DayCapacity, limits: CapacityLimits): boolean {
  return (
    capacity.blocked >= 1 ||
    (limits.maxHouseSitsPerDay !== null && capacity.houseSits >= limits.maxHouseSitsPerDay) ||
    (limits.maxBoardingPets !== null && capacity.boarding >= limits.maxBoardingPets)
  );
}

/**
 * Can a request of `requestPets` pets NOT occupy this day in isolation? A block is always a
 * hard stop. Otherwise each request type is governed only by its OWN configured limit; a `null`
 * limit never blocks (auto pass-through). Cross-type interaction (a house-sit may not overlap
 * occupied boarding by more than one day) is enforced at the range level, not here.
 */
export function dayBlocksRequest(
  capacity: DayCapacity,
  requestType: 'boarding' | 'house-sit',
  limits: CapacityLimits,
  requestPets = 1,
): boolean {
  if (capacity.blocked >= 1) return true;
  if (requestType === 'boarding') {
    const pets = Math.max(1, requestPets);
    return limits.maxBoardingPets !== null && capacity.boarding + pets > limits.maxBoardingPets;
  }
  return limits.maxHouseSitsPerDay !== null && capacity.houseSits + 1 > limits.maxHouseSitsPerDay;
}

export function rangeHasConflict(
  startDate: string,
  endDateExclusive: string,
  requestType: 'boarding' | 'house-sit',
  capacityByDate: Map<string, DayCapacity>,
  limits: CapacityLimits,
  requestPetCount = 1,
): boolean {
  const requestEnd = addDays(endDateExclusive, -1); // last occupied night
  const requestPets = Math.max(1, requestPetCount);
  let houseSitBoardingOverlapDays = 0;

  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    const capacity = capacityByDate.get(date);
    if (!capacity) continue;

    // Structural rule: a house-sit may overlap existing boarding by at most one day.
    if (requestType === 'house-sit' && capacity.boarding > 0) {
      houseSitBoardingOverlapDays += 1;
      if (houseSitBoardingOverlapDays > 1) return true;
    }

    if (!dayBlocksRequest(capacity, requestType, limits, requestPets)) continue;

    const isRequestEndpoint = date === startDate || date === requestEnd;
    if (isRequestEndpoint && capacity.isBoundary) continue;

    // Soft bookend: an unavailable (non-blocked) endpoint is allowed when the next day has
    // room for this request — the existing booking is ending here.
    if (isRequestEndpoint && capacity.blocked === 0) {
      const next = capacityByDate.get(addDays(date, 1));
      if (!next || !dayBlocksRequest(next, requestType, limits, requestPets)) continue;
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
  endDate?: string; // exclusive checkout, for boarding/house-sit only
}

/**
 * Scan the prebuilt capacity map for available slots of `requestType`, between
 * `from` (inclusive) and `to` (inclusive candidate start dates), returning up to
 * `limit` openings. Reuses rangeHasConflict / walkHasConflict — NO new rules.
 * For boarding/house-sit, `nights` (default 1) defines the span [start, start+nights);
 * for walk/check-in, nights is ignored (single-day).
 */
export function findOpenings(
  capacity: Map<string, DayCapacity>,
  opts: {
    requestType: RequestType;
    from: string;
    to: string;
    nights?: number;
    limit?: number;
    petCount?: number;
    limits: CapacityLimits;
  },
): Opening[] {
  const limit = opts.limit ?? 3;
  const isTimed = opts.requestType === 'walk' || opts.requestType === 'check-in';
  const result: Opening[] = [];

  for (
    let start = opts.from;
    start <= opts.to && result.length < limit;
    start = addDays(start, 1)
  ) {
    if (isTimed) {
      if (!walkHasConflict(start, capacity)) {
        result.push({ startDate: start });
      }
    } else {
      const nights = Math.max(1, opts.nights ?? 1);
      const end = addDays(start, nights);
      if (
        !rangeHasConflict(
          start,
          end,
          opts.requestType as 'boarding' | 'house-sit',
          capacity,
          opts.limits,
          opts.petCount,
        )
      ) {
        result.push({ startDate: start, endDate: end });
      }
    }
  }

  return result;
}
