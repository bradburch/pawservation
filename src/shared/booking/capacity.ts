import type { RequestType } from '../types/booking.js';
import { addDays } from '../util/dates.js';

// Single source of truth for the booking calendar's capacity + conflict rules,
// shared between the web client (calendar UX) and the web server (validation).
//
// Capacity rules: max 2 boarding/day, max 1 house-sit/day, any block = full.
// Boundary (bookend) sharing: the start/end day of an existing booking may be
// shared by a new booking's endpoint, EXCEPT for blocked events.

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
   * measured in PETS (max 2/day): a single 2-dog boarding fills both slots. Defaults to 1.
   * House-sit (no pet limit) and blocked (binary) ignore it.
   */
  petCount?: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
      // Boarding capacity is counted in PETS (max 2/day): a 2-dog boarding fills both slots.
      else if (event.type === 'boarding') capacity.boarding += boardingPets;
      else capacity.blocked += 1;
    }
  }

  return byDate;
}

/** A day is unavailable at 2 boarding, 1 house sit, or any block. */
export function isUnavailableDate(capacity: DayCapacity): boolean {
  return capacity.houseSits >= 1 || capacity.boarding >= 2 || capacity.blocked >= 1;
}

/**
 * Can't a request of `requestPets` pets occupy this day IN ISOLATION? Any block or house-sit
 * is a hard stop. For a boarding request the day is full when existing boarding pets + the
 * request's pets exceed 2 (boarding capacity is counted in PETS, max 2/day); for a house-sit
 * request (no pet limit) two boardings already fill the day.
 *
 * This is the raw per-day capacity decision WITHOUT the range-level boundary/bookend
 * exemptions — exported so per-day cell displays (calendar) and per-day availability probes
 * (check_availability) ask the SAME count-aware question the range conflict check does,
 * instead of re-implementing it. `requestPets` defaults to 1 (min-floored).
 */
export function dayBlocksRequest(
  capacity: DayCapacity,
  requestType: 'boarding' | 'house-sit',
  requestPets = 1,
): boolean {
  const pets = Math.max(1, requestPets);
  if (capacity.blocked >= 1 || capacity.houseSits >= 1) return true;
  return requestType === 'boarding' ? capacity.boarding + pets > 2 : capacity.boarding >= 2;
}

/**
 * Does a boarding/house-sit request over [startDate, endDateExclusive) conflict
 * with existing bookings? `endDateExclusive` is the checkout day (no overnight),
 * matching `requestDateRange`. House sits may overlap boarding by at most one day.
 * The request's own endpoints (check-in and last night) may share a boundary day.
 */
export function rangeHasConflict(
  startDate: string,
  endDateExclusive: string,
  requestType: 'boarding' | 'house-sit',
  capacityByDate: Map<string, DayCapacity>,
  requestPetCount = 1,
): boolean {
  const requestEnd = addDays(endDateExclusive, -1); // last occupied night
  // Boarding is counted in pets (max 2/day): adding this request's pets must not exceed 2.
  const requestPets = Math.max(1, requestPetCount);
  let houseSitBoardingOverlapDays = 0;

  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    const capacity = capacityByDate.get(date);
    if (!capacity) continue;

    if (requestType === 'house-sit' && capacity.boarding > 0) {
      houseSitBoardingOverlapDays += 1;
      if (houseSitBoardingOverlapDays > 1) return true;
    }

    if (!dayBlocksRequest(capacity, requestType, requestPets)) continue;

    const isRequestEndpoint = date === startDate || date === requestEnd;
    if (isRequestEndpoint && capacity.isBoundary) continue;

    // Soft bookend: an unavailable (non-blocked) endpoint is allowed when the next day has
    // room for this request — the existing booking is ending here. The look-ahead is
    // count-aware too, so a multi-pet request isn't waved through a still-occupied next day.
    if (isRequestEndpoint && capacity.blocked === 0) {
      const next = capacityByDate.get(addDays(date, 1));
      if (!next || !dayBlocksRequest(next, requestType, requestPets)) continue;
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
          opts.petCount,
        )
      ) {
        result.push({ startDate: start, endDate: end });
      }
    }
  }

  return result;
}
