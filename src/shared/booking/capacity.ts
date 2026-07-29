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
 * One booking's occupied span, as the overlap rule needs to see it: `lastOccupied` is the final
 * OCCUPIED day (`end_date - 1`), not the exclusive checkout. The SAME object is pushed into every
 * day the event occupies, so identity (`Set<EventSpan>`) recovers the distinct bookings behind a
 * run of days — which is what lets the rule reason about the OTHER stay, not just the incoming one.
 */
export type EventSpan = { start: string; lastOccupied: string };

/**
 * One pool KIND's footprint on one day, tenant-wide (every service of that kind summed). Feeds the
 * structural cross-kind overlap rule ONLY — per-service capacity is `byService`.
 */
export type KindOccupancy = {
  /** Pets of this kind occupying the day. */
  total: number;
  /**
   * The events of this kind occupying the day. Spans, not counters: the rule has to ask whether the
   * booking on the OTHER side of a handover keeps a day of its own, and a per-day tally can never
   * answer that. `arriving`/`departing` are derived from these (see `allArriveOn`/`allDepartOn`).
   */
  spans: EventSpan[];
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
   * occupancy, and only ever as a HANDOVER (see `rangeConflictReason`). 0 = never; 1 = the
   * product default; NULL = no limit, the rule stops running. REQUIRED on purpose: a defaulted
   * field is how the quote and the booking POST would silently disagree, so every construction
   * site must name the tenant's value.
   */
  overlapAllowance: number | null;
};

const emptyDay = (): DayCapacity => ({
  byService: new Map(),
  boarding: { total: 0, spans: [] },
  housesit: { total: 0, spans: [] },
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

    // The last day this event OCCUPIES (end is exclusive). Recorded as a SPAN shared by every day
    // the event covers, so the overlap rule can ask about the whole booking — where it arrives,
    // where it departs, and whether it keeps a day of its own — from any one of its days. A
    // one-night stay occupies a single day and both arrives and departs on it. An event with no
    // `end_date` (or one equal to its start) occupies NOTHING at all — the loop below never runs —
    // which is how single-day services stay invisible to pool occupancy.
    const span: EventSpan = { start, lastOccupied: addDays(end, -1) };

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
      occupancy.spans.push(span);
    }
  }

  return byDate;
}

/**
 * Can a request NOT occupy this day in isolation? A block is always a hard stop. Otherwise the
 * request is governed only by its OWN service's cap over its OWN service's occupancy; a `null`
 * cap never blocks (auto pass-through). Cross-KIND interaction (the house-sit/boarding handover
 * rule) is enforced at the range level, not here — it is a property of a range, not of a day.
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
/** See the comment in `rangeConflictReason`: null passes through, a number passes through, and
 * anything else (only reachable from an untyped caller) reads as 0 — never as "no limit". */
function normalizeAllowance(value: number | null): number | null {
  if (value === null) return null;
  return Number.isFinite(value) ? value : 0;
}

export type RangeConflict = 'over_cap' | 'cross_kind_overlap' | 'blocked_or_full';

/** Every one of these bookings has `date` as its LAST occupied day — they are all leaving. */
const allDepartOn = (spans: EventSpan[], date: string): boolean =>
  spans.every((span) => span.lastOccupied === date);

/** Every one of these bookings has `date` as its FIRST occupied day — they are all arriving. */
const allArriveOn = (spans: EventSpan[], date: string): boolean =>
  spans.every((span) => span.start === date);

/**
 * The SOUNDLY PAINTABLE half of the cross-kind handover rule: is this day unusable by EVERY range
 * request of `kind`, whatever its dates?
 *
 * The rule itself is a property of a RANGE — really of a PAIR of ranges — so a per-day grid can
 * never paint it exactly, and `rangeConflictReason` stays the authority (CALENDAR_LOGIC.md §9). But
 * a caller that paints days (the month grid) must not claim a day is available when no request of
 * that kind could arrive on it, depart on it, or span it. That much IS a fact about the day alone,
 * and it lives here — beside the rule — rather than being re-derived by the caller.
 *
 * Three grounds, each one a rule the range walk would apply to any request touching this day:
 *
 *  1. `allowance` 0 — the two kinds may never share a day at all, so any opposite-kind occupancy is
 *     final. (`null` switches the whole rule off; nothing is paintable.)
 *  2. The DIRECTIONAL half of rule 2. A request's only three options for a day are to arrive on it,
 *     depart on it, or span it, and spanning is never a handover — so if the day's opposite-kind
 *     bookings are neither all departing nor all arriving, no request can use it.
 *  3. A ONE-NIGHT neighbour. Its single occupied day is both its arrival and its departure, so it
 *     passes the directional test from either side — but any handover doubles the only night it
 *     has, so `neighborsViolated` refuses every request that touches it (rule 3, seen from the
 *     other stay).
 *
 * Deliberately NOT decided here, because none of it is a property of one day: rule 3 for the
 * REQUEST (needs the request's length), the allowance BUDGET across a multi-day request, and a
 * multi-day neighbour's own budget/free-day count (which needs that neighbour's whole span in the
 * map, and a one-month read cannot promise it). Those stay with the range walk, which is why a span
 * of days this predicate leaves open can still be refused.
 */
export function crossKindDayBlocked(
  day: DayCapacity,
  date: string,
  kind: PoolKind,
  allowance: number | null,
): boolean {
  const normalized = normalizeAllowance(allowance);
  if (normalized === null) return false;
  const opposite = kind === 'housesit' ? day.boarding : day.housesit;
  if (opposite.spans.length === 0) return false;
  if (normalized < 1) return true;
  if (opposite.spans.some((span) => span.start === span.lastOccupied)) return true;
  return !(allDepartOn(opposite.spans, date) || allArriveOn(opposite.spans, date));
}

/** The opposite-kind bookings the request's own days touch, de-duplicated by span identity (the
 *  same object sits on every day its event occupies, which is what makes identity meaningful). */
function touchedSpans(
  startDate: string,
  endDateExclusive: string,
  kind: PoolKind,
  capacityByDate: Map<string, DayCapacity>,
): EventSpan[] {
  const seen = new Set<EventSpan>();
  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    const day = capacityByDate.get(date);
    if (!day) continue;
    for (const span of kind === 'housesit' ? day.boarding.spans : day.housesit.spans)
      seen.add(span);
  }
  return [...seen];
}

/**
 * The calendar window a correct verdict needs: the union of the request's own span with every
 * opposite-kind booking it touches. Those neighbours routinely reach OUTSIDE the request's dates —
 * a house sit departing on our arrival day started days earlier — and `neighborsViolated` has to
 * see their whole span to know whether they keep a day of their own. `null` when nothing is
 * touched, which is the common case and the reason a caller can skip the widened read entirely.
 */
export function overlapReadWindow(
  startDate: string,
  endDateExclusive: string,
  kind: PoolKind,
  capacityByDate: Map<string, DayCapacity>,
): { from: string; toExclusive: string } | null {
  const spans = touchedSpans(startDate, endDateExclusive, kind, capacityByDate);
  if (spans.length === 0) return null;
  let from = startDate;
  let last = addDays(endDateExclusive, -1);
  for (const span of spans) {
    if (span.start < from) from = span.start;
    if (span.lastOccupied > last) last = span.lastOccupied;
  }
  return { from, toExclusive: addDays(last, 1) };
}

/**
 * Rules 1 and 3 applied to each booking the request touches, which is what makes the whole rule
 * ORDER-INDEPENDENT: whichever of two stays is booked second, both are judged by the same two
 * questions. For every touched booking, count the days of ITS span that carry request-kind
 * occupancy — the incoming request itself, plus any request-kind booking already on the calendar —
 * and refuse if that exceeds the allowance or leaves it with no day of its own.
 *
 * The walk is bounded by the touched spans, which the caller is expected to have fetched whole
 * (`checkRange` widens its capacity read for exactly this reason). A day outside the map counts as
 * free: it is the permissive direction, and the only thing that can live there is a booking that
 * was itself validated under these same rules.
 */
function neighborsViolated(
  startDate: string,
  endDateExclusive: string,
  kind: PoolKind,
  capacityByDate: Map<string, DayCapacity>,
  allowance: number,
): boolean {
  for (const span of touchedSpans(startDate, endDateExclusive, kind, capacityByDate)) {
    let shared = 0;
    let days = 0;
    for (let date = span.start; date <= span.lastOccupied; date = addDays(date, 1)) {
      days += 1;
      const inRequest = date >= startDate && date < endDateExclusive;
      const day = capacityByDate.get(date);
      const mine =
        day && (kind === 'housesit' ? day.housesit.spans : day.boarding.spans).length > 0;
      if (inRequest || mine) shared += 1;
    }
    if (shared > allowance || shared >= days) return true;
  }
  return false;
}

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
  let requestDays = 0;

  // Defensive normalization of the tenant's allowance: only a number or an explicit null mean
  // anything. Anything else — a caller built against the older CapacityRequest shape, or a tenant
  // row cached before the column existed — reads as 0 (share nothing) rather than as "no limit",
  // because an unrecognised value must take the REFUSING branch. `null` still means the rule does
  // not run at all, which is the tenant saying so.
  const overlapAllowance: number | null = normalizeAllowance(request.overlapAllowance);

  // A request for more units than its own cap can NEVER fit — not even on an empty calendar,
  // where the day-by-day walk below has nothing to inspect. Enforcing it here keeps the engine
  // correct standalone (the single source of truth), so callers need no separate isolation check.
  if (request.cap !== null && units > request.cap) return 'over_cap';

  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    requestDays += 1; // counted before the early-continue: the whole stay, not just its busy days
    const day = capacityByDate.get(date);
    if (!day) continue;

    const isRequestEndpoint = date === startDate || date === requestEnd;

    // Structural rule (TENANT-WIDE, SYMMETRIC): a house sit and boarding may share a day only as a
    // HANDOVER, because the sitter cannot be in two places — this models her whereabouts, not a
    // pool, so it reads occupancy from ANY service of the opposite kind, and governs a boarding
    // laid over a house sit exactly as it governs the reverse.
    //
    // A shared day is legal only when ALL THREE hold, and each is checked for BOTH stays — the
    // incoming request here in the walk, the bookings it touches in `neighborsViolated` below:
    //   1. the count of shared days is within `overlapAllowance`;
    //   2. the day is a handover — either we ARRIVE on it and every opposite-kind booking there
    //      DEPARTS on it, or we DEPART on it and every one of them ARRIVES on it;
    //   3. the stay is not shared END TO END — at least one of its own days is free of the
    //      opposite kind.
    //
    // Rule 2 is directional on purpose. "At the tail ends" is not "at either end of the request":
    // both ends of a two-night request are its endpoints, so an endpoint-only test would let a
    // boarding sit exactly on top of a two-night house sit — a total double booking. Requiring one
    // stay to be leaving as the other arrives is what makes the concession a handover, and it is
    // also what refuses a one-night boarding dropped in the MIDDLE of a ten-day house sit (a
    // single-day stay is trivially "at its own endpoint", so nothing else would). `every one of
    // them`: if two bookings occupy the day and only one is leaving, the other is still there.
    if (overlapAllowance !== null) {
      const opposite = request.kind === 'housesit' ? day.boarding : day.housesit;
      if (opposite.spans.length > 0) {
        overlapDays += 1;
        const weArrive = date === startDate && allDepartOn(opposite.spans, date);
        const weDepart = date === requestEnd && allArriveOn(opposite.spans, date);
        if (overlapDays > overlapAllowance || !(weArrive || weDepart)) return 'cross_kind_overlap';
      }
    }

    if (!dayBlocksRequest(day, request)) continue;

    if (isRequestEndpoint && day.isBoundary) continue;

    // NO "soft bookend" here, deliberately. There used to be a second concession: an over-full
    // non-blocked endpoint was forgiven when the NEXT day had room, on the reading that "the
    // existing booking is ending here". It is not — a stay's CHECKOUT day and its LAST OCCUPIED
    // NIGHT are different days, and only the first of them frees the pool.
    //
    // On a genuine checkout day the departing stay contributes nothing to `byService` at all, so
    // `dayBlocksRequest` never fires for it and no concession is needed (and if another booking
    // makes that day full, the day is a boundary and the branch above already covers it). By
    // elimination the look-ahead could only ever fire on a day INTERIOR to the occupying stay whose
    // next day is free — i.e. on that stay's last occupied night, where its pet is still in the
    // pool. Forgiving it accepted a real double booking: with a cap of 2, one pet on Mar 1→5 and a
    // 2-pet request for Mar 4→7 both quoted and posted successfully, putting 3 pets in a 2-pet pool
    // on the night of Mar 4. So the concession had no sound case left to serve, and is gone.
    return 'blocked_or_full';
  }

  // Rule 3 for the REQUEST, and the reason the count alone is not the guarantee. A doubled day is
  // tolerable as a TRANSITION into or out of a stay the sitter is actually there for; a stay with
  // no such day is not one she is there for at all — the dog is at her house every night she is
  // sleeping at a client's. Rule 2 cannot see this: a one-night stay is its own arrival AND
  // departure, so a chain of one-nighters (or a request exactly as long as the allowance)
  // satisfies the handover test on every single day and doubles the whole stay.
  if (overlapAllowance !== null && overlapDays > 0 && overlapDays >= requestDays) {
    return 'cross_kind_overlap';
  }

  // …and rules 1 and 3 again, from the OTHER stay's point of view. Without this the verdict
  // depends on the order the two bookings arrive in: a one-night boarding on Sep 4, then a house
  // sit Sep 1→5, is accepted (the sit has three free nights and one handover) even though booking
  // the same pair the other way round is refused — and the dog spends its only night alone while
  // the sitter sleeps at a client's. The physical claim is symmetric, so the test has to be.
  if (overlapAllowance !== null && overlapDays > 0) {
    if (
      neighborsViolated(startDate, endDateExclusive, request.kind, capacityByDate, overlapAllowance)
    )
      return 'cross_kind_overlap';
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
