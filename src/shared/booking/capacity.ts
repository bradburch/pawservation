import { addDays, DATE_RE } from '../util/dates.js';

// Single source of truth for the booking calendar's capacity + conflict rules,
// shared between the web client (calendar UX) and the web server (validation).
//
// Capacity is PER SERVICE and measured in PETS: each pool-drawing service carries its own cap
// (MaxConcurrentPets, for boarding-kind AND housesit-kind); a `null` cap is UNLIMITED (auto
// pass-through) and is never compared. A booking with three pets consumes three units. Other
// services' occupancy is invisible to a request's cap check. Admin-blocked dates always block.
// The WHEREABOUTS rule stays TENANT-WIDE (every service of the clashing kind) and is SYMMETRIC:
// it models where the sitter physically IS, not a pool. She cannot sleep at a client's house and
// keep a boarder at her own, so it governs a boarding laid over a house sit exactly as it governs
// a house sit laid over boarding — and she cannot sleep at TWO clients' houses either, so a night
// holds at most ONE house sit whatever its pet count. Boarding is not symmetric to that last part:
// boarding happens at her own home, so several boarders a night is ordinary and is governed by the
// pool cap alone. `kindsClash` is the whole of that asymmetry. Cross-kind, a shared night may be
// conceded as a HANDOVER within the tenant's allowance; SAME-KIND it may not, because a handover
// day is a night both stays occupy and two house sits sharing one is the double booking itself
// (`sameKindSpans`). Back-to-back stays share no night and are untouched by any of it. The
// allowance arrives on the request (`overlapAllowance`, from Tenants.HousesitBoardingOverlapDays),
// and a NULL switches the whole rule off, same-kind included; this module reads no config.
// There is NO bookend/boundary concession on the pool cap: occupancy is counted over `[start, end)`,
// so a day holds exactly the pets sleeping that night, and an over-full night is a double booking
// wherever it falls in a request. The back-to-back booking everyone reaches for that concession to
// explain needs none — a departing stay contributes nothing to its checkout day, so that day simply
// is not full. See `rangeConflictReason` for the two unsound concessions this replaced.

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
 * structural whereabouts overlap rule ONLY — per-service capacity is `byService`.
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
  /** ALL boarding-kind pets on this day — drives the structural whereabouts rule only. */
  boarding: KindOccupancy;
  /**
   * ALL housesit-kind pets on this day. Read by the whereabouts rule from BOTH sides: a boarding
   * request clashes with it, and so does another HOUSE SIT (see `kindsClash`).
   */
  housesit: KindOccupancy;
  blocked: number;
  /**
   * A non-blocked event starts or checks out on this day. INFORMATIONAL ONLY — no rule in this
   * module reads it, and none may: the flag is kind-agnostic, cannot say WHICH event set it, and
   * above all cannot distinguish a stay ARRIVING (all its pets in the pool that night) from one
   * CHECKING OUT (none of them). Two endpoint concessions were built on that conflation and both
   * accepted real double bookings — `rangeConflictReason` records what and why. Retained because
   * `DayCapacity` is exported engine API mirrored by out-of-tree consumers, not because anything
   * here needs it.
   */
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
   * `Tenants.HousesitBoardingOverlapDays` — how many days this request may overlap CROSS-KIND
   * occupancy (boarding against a house sit, in either direction), and only ever as a HANDOVER
   * (see `rangeConflictReason`). 0 = never; 1 = the product default. SAME-KIND occupancy (house
   * sit against house sit) is not governed by the number at all: no numbered value permits a
   * shared night (`sameKindSpans`). NULL = no limit, the rule stops running for both.
   * REQUIRED on purpose: a defaulted
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

/**
 * An event's exclusive end date, or its start when it has none (the single-day shape: it occupies
 * nothing). `??`, NOT `||`: an end date that is PRESENT but empty is a corrupt row, not a caller
 * saying "no end", and reading it as "no end" is how a range booking with a blanked-out EndDate came
 * to occupy nothing and leave its nights bookable. An absent end is a shape; an empty one is damage.
 */
const endOf = (event: CapacityEvent): string => event.end_date ?? event.start_date;

/**
 * Are this event's dates usable at all? Both must parse as `YYYY-MM-DD`, and the exclusive end may
 * not precede the start. An event with NO `end_date` (or one equal to its start) is well formed —
 * it simply occupies nothing (see `buildCapacity`), which is how single-day services stay invisible
 * to pool occupancy.
 *
 * Exported so a caller can TELL A HUMAN about a corrupt row rather than only failing safe on it:
 * `buildCapacity` treats what it cannot parse as occupied (below), which keeps the calendar sound
 * but silent, and a row that is quietly blocking a day forever is its own bug. The module stays
 * pure — it takes no logger and knows nothing about where the rows came from; naming the rows is
 * the caller's job (`server/lib/availability.ts` logs the booking ids).
 */
export function isWellFormedCapacityEvent(event: CapacityEvent): boolean {
  const start = event.start_date;
  const end = endOf(event);
  // String comparison is date comparison for zero-padded ISO dates, so no parsing is needed —
  // and none may be attempted before DATE_RE has passed.
  return DATE_RE.test(start) && DATE_RE.test(end) && end >= start;
}

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
    const end = endOf(event);

    // A CORRUPT ROW FAILS TOWARD OCCUPIED. This used to `continue` — skipping the event — which
    // made the one direction of error this engine must never take: a row that really does occupy
    // the pool contributed nothing, so its day read as bookable and the next request was seated on
    // top of it. Corrupt data is now a hard `blocked` day, the same direction `normalizeAllowance`
    // fails in (an unrecognised allowance reads as the stricter 0) and the same direction
    // calendar-sync already takes for a timed Google event (over-block, never under-block).
    //
    // `blocked`, not pool arithmetic, because NOTHING on a row whose dates are garbage is
    // trustworthy — least of all its `serviceType` and `petCount` — and because a hard stop is the
    // strictest reading available. No boundary and no span are recorded: a span needs a
    // `lastOccupied`, and the whole point is that this row's extent is unknown.
    //
    // The one day it CAN be pinned to is its start; the rest of its extent is unknowable, so this
    // is deliberately a floor rather than a guess. And when the START itself does not parse there
    // is no date to key at all — a date-indexed map cannot express it — so it is dropped here and
    // surfaced instead: `isWellFormedCapacityEvent` is what lets the caller log it (see
    // `server/lib/availability.ts`).
    if (!isWellFormedCapacityEvent(event)) {
      if (DATE_RE.test(start)) getOrCreate(start).blocked += 1;
      continue;
    }

    // Blocked events get no boundary. Informational either way (see `DayCapacity.isBoundary`) —
    // kept truthful rather than removed, since the field is exported engine API.
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
 * cap never blocks (auto pass-through). The WHEREABOUTS interaction (the handover rule) is
 * enforced at the range level, not here — it is a property of a range, not of a day.
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
 * - `cross_kind_overlap` — the whereabouts rule below, boarding against a house sit, refused
 *   because the shared days exceeded the allowance or were not a handover.
 * - `same_kind_overlap` — the same rule, house sit against another house sit, refused because they
 *   would share a night at all (there is no handover to concede against one's own kind).
 *
 * `same_kind_overlap` is an ADDITIVE member: an out-of-tree consumer switching exhaustively over
 * `RangeConflict` will not have a branch for it, so treat it the way the unmatched-default branch
 * treats `cross_kind_overlap` — both are the whereabouts rule, both answer the wire code
 * `overlap_not_allowed`, and the only remedy either offers is moving the dates.
 * - `blocked_or_full` — an admin block, or the service's own pool with no room.
 *
 * The two overlap reasons are ONE rule with one allowance knob, split only because the sentence a
 * caller prints differs: "your sitter has boarding on those dates" and "your sitter is already
 * house-sitting for someone else" are different facts, and telling a customer the first when the
 * second is true is a lie the code would be authoring. Reusing `cross_kind_overlap` for a
 * house-sit-on-house-sit clash would have made the name itself false.
 */
/** See the comment in `rangeConflictReason`: null passes through, a number passes through, and
 * anything else (only reachable from an untyped caller) reads as 0 — never as "no limit". */
function normalizeAllowance(value: number | null): number | null {
  if (value === null) return null;
  return Number.isFinite(value) ? value : 0;
}

export type RangeConflict =
  'over_cap' | 'cross_kind_overlap' | 'same_kind_overlap' | 'blocked_or_full';

/**
 * Do a stay of `kind` and a stay of `otherKind` claim the SAME PLACE on a night they share? This
 * one predicate is the whole of the whereabouts rule's asymmetry, and it is asymmetric because the
 * two kinds are:
 *
 *  - BOARDING happens at the sitter's OWN home. Two boardings on one night are not a clash at all —
 *    they are one house holding two dogs, which is a pool question and `MaxConcurrentPets` answers
 *    it. Nothing here may refuse them.
 *  - HOUSE SITTING happens at the CLIENT's home. She can sleep in exactly one of those a night,
 *    whether it holds one cat or four dogs, so a house sit clashes with boarding AND with every
 *    other house sit. Counting PETS is the wrong question for it: a pet cap can only express "one
 *    house sit a night" by also turning away anyone arriving with two dogs.
 *
 * So: a pair clashes as soon as EITHER side is a house sit.
 */
const kindsClash = (kind: PoolKind, otherKind: PoolKind): boolean =>
  kind === 'housesit' || otherKind === 'housesit';

/**
 * The spans occupying `day` that a stay of `kind` cannot share it with. For a boarding request
 * that is the day's house sits; for a house-sit request it is the day's house sits AND its
 * boardings. Order is stable (boarding first) but no rule depends on it.
 */
function clashingSpans(day: DayCapacity, kind: PoolKind): EventSpan[] {
  const spans: EventSpan[] = [];
  if (kindsClash(kind, 'boarding')) spans.push(...day.boarding.spans);
  if (kindsClash(kind, 'housesit')) spans.push(...day.housesit.spans);
  return spans;
}

/**
 * Of the spans occupying `day`, the ones a stay of `kind` clashes with AND can never HAND OVER to,
 * because the pair is SAME-KIND. Only ever a house sit under a house-sit request: two boardings do
 * not clash at all (`kindsClash`), so a boarding request always gets an empty list here and its
 * cross-kind handover is untouched.
 *
 * THE HANDOVER CONCESSION IS CROSS-KIND ONLY, and the reason is the occupancy model.
 * `EventSpan.lastOccupied` is `end_date - 1` — the last NIGHT slept, not the checkout morning — so
 * a "handover day" is a night BOTH stays occupy. Against a boarding that is a defensible
 * tolerance: the boarder is collected that evening and the sitter still sleeps in one place.
 * Against another house sit it IS the double booking, because she is booked to sleep in two homes
 * that night and one client's pets are alone. A Mon→Fri sit plus a Thu→Sun sit is the shape, and
 * no numbered allowance may buy that Thursday night.
 *
 * The allowance was never what made the ordinary working week legal. BACK-TO-BACK sits share no
 * occupied night at all (the first one's `lastOccupied` is the Thursday, the second one's `start`
 * is the Friday), so they never reach this rule and were legal at allowance 0 all along. The only
 * thing the allowance ever bought a same-kind pair was a shared night, and there is none to
 * concede. `null` still switches the whole rule off before any of this is asked, which is the
 * escape hatch for a sitter who would rather sort clashes out herself.
 */
function sameKindSpans(day: DayCapacity, kind: PoolKind): EventSpan[] {
  return kindsClash(kind, kind) ? day[kind].spans : [];
}

/** Every one of these bookings has `date` as its LAST occupied day — they are all leaving. */
const allDepartOn = (spans: EventSpan[], date: string): boolean =>
  spans.every((span) => span.lastOccupied === date);

/** Every one of these bookings has `date` as its FIRST occupied day — they are all arriving. */
const allArriveOn = (spans: EventSpan[], date: string): boolean =>
  spans.every((span) => span.start === date);

/**
 * The SOUNDLY PAINTABLE half of the whereabouts handover rule: is this day unusable by EVERY range
 * request of `kind`, whatever its dates?
 *
 * The rule itself is a property of a RANGE — really of a PAIR of ranges — so a per-day grid can
 * never paint it exactly, and `rangeConflictReason` stays the authority (CALENDAR_LOGIC.md §9). But
 * a caller that paints days (the month grid) must not claim a day is available when no request of
 * that kind could arrive on it, depart on it, or span it. That much IS a fact about the day alone,
 * and it lives here — beside the rule — rather than being re-derived by the caller.
 *
 * Four grounds, each one a rule the range walk would apply to any request touching this day:
 *
 *  1. A SAME-KIND span on the day (only ever a house sit, under a house-sit request). There is no
 *     handover to concede against one's own kind (`sameKindSpans`), so the day is unusable at every
 *     numbered allowance. This is the one ground on which the paint is EXACT rather than
 *     conservative: a night a house sit occupies is refused to every house-sit request, whatever
 *     its dates, so nothing is left for the range walk to decide.
 *  2. `allowance` 0 — a clashing stay may never share a day at all, so any clashing occupancy is
 *     final. (`null` switches the whole rule off; nothing is paintable.)
 *  3. The DIRECTIONAL half of rule 2. A request's only three options for a day are to arrive on it,
 *     depart on it, or span it, and spanning is never a handover — so if the day's clashing
 *     bookings are neither all departing nor all arriving, no request can use it.
 *  4. A ONE-NIGHT neighbour. Its single occupied day is both its arrival and its departure, so it
 *     passes the directional test from either side — but any handover doubles the only night it
 *     has, so `neighborsViolated` refuses every request that touches it (rule 3, seen from the
 *     other stay).
 *
 * A CHECKOUT day carries no occupancy at all, so it never reaches any of the four: back-to-back
 * stays of either kind stay paintable, which is what keeps ground 1 from striking out a sitter's
 * ordinary working week.
 *
 * Deliberately NOT decided here, because none of it is a property of one day: rule 3 for the
 * REQUEST (needs the request's length), the allowance BUDGET across a multi-day request, and a
 * multi-day neighbour's own budget/free-day count (which needs that neighbour's whole span in the
 * map, and a one-month read cannot promise it). Those stay with the range walk, which is why a span
 * of days this predicate leaves open can still be refused.
 */
export function whereaboutsDayBlocked(
  day: DayCapacity,
  date: string,
  kind: PoolKind,
  allowance: number | null,
): boolean {
  const normalized = normalizeAllowance(allowance);
  if (normalized === null) return false;
  const clashing = clashingSpans(day, kind);
  if (clashing.length === 0) return false;
  if (sameKindSpans(day, kind).length > 0) return true;
  if (normalized < 1) return true;
  if (clashing.some((span) => span.start === span.lastOccupied)) return true;
  return !(allDepartOn(clashing, date) || allArriveOn(clashing, date));
}

/**
 * DEPRECATED ALIAS of `whereaboutsDayBlocked`, retained for out-of-tree consumers only.
 *
 * The predicate was called `crossKindDayBlocked` while the whereabouts rule only ever judged a
 * boarding against a house sit; that name became false the moment it also judged a house sit
 * against another house sit. Renaming it in-tree is correct, but this module's exports are mirrored
 * by an out-of-tree booking MCP (see `findOpenings`, kept for exactly that reason), and a rename
 * with no alias is the breakage that policy exists to prevent. Same function, same arguments, same
 * verdict — prefer `whereaboutsDayBlocked` in new code.
 */
export const crossKindDayBlocked = whereaboutsDayBlocked;

/**
 * A booking the request's days touch, carrying the KIND it was found under. The kind is recovered
 * from which occupancy list held it rather than stored on the span, so the two can never drift; it
 * is needed because `neighborsViolated` must ask what clashes with the NEIGHBOUR, and a neighbour
 * house sit clashes with other house sits while a neighbour boarding does not clash with boardings.
 */
type TouchedSpan = { span: EventSpan; kind: PoolKind };

/** The clashing bookings the request's own days touch, de-duplicated by span identity (the same
 *  object sits on every day its event occupies, which is what makes identity meaningful). */
function touchedSpans(
  startDate: string,
  endDateExclusive: string,
  kind: PoolKind,
  capacityByDate: Map<string, DayCapacity>,
): TouchedSpan[] {
  const seen = new Map<EventSpan, PoolKind>();
  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    const day = capacityByDate.get(date);
    if (!day) continue;
    for (const other of ['boarding', 'housesit'] as const) {
      if (!kindsClash(kind, other)) continue;
      for (const span of day[other].spans) seen.set(span, other);
    }
  }
  return [...seen].map(([span, spanKind]) => ({ span, kind: spanKind }));
}

/**
 * The calendar window a correct verdict needs: the union of the request's own span with every
 * clashing booking it touches. Those neighbours routinely reach OUTSIDE the request's dates —
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
  const touched = touchedSpans(startDate, endDateExclusive, kind, capacityByDate);
  if (touched.length === 0) return null;
  let from = startDate;
  let last = addDays(endDateExclusive, -1);
  for (const { span } of touched) {
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
  for (const touched of touchedSpans(startDate, endDateExclusive, kind, capacityByDate)) {
    const { span } = touched;
    let shared = 0;
    let days = 0;
    for (let date = span.start; date <= span.lastOccupied; date = addDays(date, 1)) {
      days += 1;
      const inRequest = date >= startDate && date < endDateExclusive;
      const day = capacityByDate.get(date);
      // What clashes with the NEIGHBOUR, not with the request — the two differ now that a house
      // sit clashes with its own kind. `!== span` is what keeps a neighbour house sit from
      // counting ITSELF as occupancy on every one of its own days (which would make `shared`
      // trivially equal `days` and refuse everything).
      const mine = day !== undefined && clashingSpans(day, touched.kind).some((s) => s !== span);
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

    // Structural WHEREABOUTS rule (TENANT-WIDE, SYMMETRIC): two stays that claim different places
    // may share a day only as a HANDOVER, because the sitter cannot be in two places. This models
    // where she IS, not a pool, so it reads occupancy from ANY service of a clashing kind, and
    // governs a boarding laid over a house sit exactly as it governs the reverse — and, since a
    // house sit happens at the CLIENT's home, a house sit laid over ANOTHER house sit too
    // (`kindsClash`). A night therefore holds at most one house sit however few pets it has, which
    // is the question `MaxConcurrentPets` cannot ask: it counts pets, not houses.
    //
    // A shared day is legal only when ALL THREE hold, and each is checked for BOTH stays — the
    // incoming request here in the walk, the bookings it touches in `neighborsViolated` below:
    //   1. the count of shared days is within `overlapAllowance`;
    //   2. the day is a handover — either we ARRIVE on it and every clashing booking there
    //      DEPARTS on it, or we DEPART on it and every one of them ARRIVES on it;
    //   3. the stay is not shared END TO END — at least one of its own days is free of clashing
    //      occupancy.
    //
    // …and all three are CROSS-KIND ONLY. Against a stay of the request's own kind (only ever
    // house sit on house sit) a shared day is refused outright at every numbered allowance,
    // because the handover those conditions describe is itself a shared NIGHT — see
    // `sameKindSpans`. The ordinary back-to-back week is unaffected: it shares no night, so it
    // never reaches this branch at all.
    //
    // Rule 2 is directional on purpose. "At the tail ends" is not "at either end of the request":
    // both ends of a two-night request are its endpoints, so an endpoint-only test would let a
    // boarding sit exactly on top of a two-night house sit — a total double booking. Requiring one
    // stay to be leaving as the other arrives is what makes the concession a handover, and it is
    // also what refuses a one-night boarding dropped in the MIDDLE of a ten-day house sit (a
    // single-day stay is trivially "at its own endpoint", so nothing else would). `every one of
    // them`: if two bookings occupy the day and only one is leaving, the other is still there.
    if (overlapAllowance !== null) {
      const clashing = clashingSpans(day, request.kind);
      if (clashing.length > 0) {
        overlapDays += 1;
        // A span of the request's OWN kind — only ever house sit on house sit, since two boardings
        // do not clash at all. It gets NO handover concession (`sameKindSpans` carries the whole
        // argument): a handover day is a night both stays occupy, which is a tolerance against a
        // departing boarder and the double booking itself against another house sit.
        const sameKind = sameKindSpans(day, request.kind).length > 0;
        const weArrive = date === startDate && allDepartOn(clashing, date);
        const weDepart = date === requestEnd && allArriveOn(clashing, date);
        if (overlapDays > overlapAllowance || sameKind || !(weArrive || weDepart))
          // A day may carry both a boarding and another house sit; naming the same-kind one is the
          // more specific truth and the one a customer can act on ("your sitter is already sitting
          // at another home that night"), so it wins.
          return sameKind ? 'same_kind_overlap' : 'cross_kind_overlap';
      }
    }

    if (!dayBlocksRequest(day, request)) continue;

    // A FULL NIGHT IS A FULL NIGHT — there is NO endpoint concession here, and there must never be
    // one again. Two of them lived here and both were unsound for the same reason, so what follows
    // is the one rule that replaced them rather than a third patch:
    //
    //   Occupancy is measured over `[start, end)`, so a day carries exactly the pets SLEEPING that
    //   night. A night is atomic — nobody arrives "after" the pets already in the pool leave,
    //   because they do not leave until the morning. So an over-full night is a real double booking
    //   at ANY position in the request, including its two ends.
    //
    // 1. The "soft bookend" forgave an over-full non-blocked endpoint when the NEXT day had room,
    //    reading it as "the existing booking is ending here." A stay's CHECKOUT day and its LAST
    //    OCCUPIED NIGHT are different days and only the first frees the pool: with a cap of 2, one
    //    pet on Mar 1→5 and a 2-pet request for Mar 4→7 both quoted and posted, putting 3 pets in a
    //    2-pet pool on the night of Mar 4.
    // 2. The boundary (bookend) concession forgave an over-full endpoint that was also `isBoundary`.
    //    `isBoundary` is set on an existing stay's START day as well as its checkout day (see
    //    `buildCapacity`), so a day that is merely where another stay ARRIVES — every pet of it in
    //    the pool — was forgiven as though something were leaving: cap 2, an existing 2-pet boarding
    //    Sep 6→9 and a 2-pet request Sep 3→7 were both accepted, seating 4 pets on the night of the
    //    6th. It also read a boundary set by a THIRD, unrelated stay's checkout as licence to
    //    overfill a night, and — because `dayBlocksRequest` folds blocks and pool arithmetic into
    //    one answer — it waved through an admin-BLOCKED day whenever any booking happened to bookend
    //    it, which is a hard stop being bypassed.
    //
    // What made both look necessary is the legitimate handover, and it needs no concession at all:
    // on a stay's checkout day that stay contributes NOTHING to `byService`, so the day is simply
    // not full and the `continue` above has already taken it. A request may still start the day an
    // existing stay checks out, still end the day before another arrives, and a `1/2` night still
    // seats one more pet. What it may no longer do is share a night that is already full.
    //
    // Everything the concessions could have been reaching for is therefore either already legal by
    // plain arithmetic or a genuine refusal. Do not re-add an endpoint exception for a date the
    // month grid strikes out: the grid runs this same arithmetic, and agreeing with it is correct.
    return 'blocked_or_full';
  }

  // Rule 3 for the REQUEST, and the reason the count alone is not the guarantee. A doubled day is
  // tolerable as a TRANSITION into or out of a stay the sitter is actually there for; a stay with
  // no such day is not one she is there for at all — the dog is at her house every night she is
  // sleeping at a client's. Rule 2 cannot see this: a one-night stay is its own arrival AND
  // departure, so a chain of one-nighters (or a request exactly as long as the allowance)
  // satisfies the handover test on every single day and doubles the whole stay. This is also what
  // refuses a chain of one-night BOARDINGS laid end to end across a house sit.
  //
  // Both post-walk refusals below are necessarily CROSS-KIND. Any same-kind occupancy on a day of
  // the request already returned inside the walk (there is no handover to concede against one's
  // own kind), so if control reached here, no day the request covers carried a stay of its kind.
  if (overlapAllowance !== null && overlapDays > 0 && overlapDays >= requestDays) {
    return 'cross_kind_overlap';
  }

  // …and rules 1 and 3 again, from the OTHER stay's point of view. Without this the verdict
  // depends on the order the two bookings arrive in: a one-night boarding on Sep 4, then a house
  // sit Sep 1→5, is accepted (the sit has three free nights and one handover) even though booking
  // the same pair the other way round is refused — and the dog spends its only night alone while
  // the sitter sleeps at a client's. The physical claim is symmetric, so the test has to be.
  // (House sit against house sit needs none of this: it is symmetric already, because a shared
  // night is refused from whichever side asks and neither side has a concession to spend.)
  if (overlapAllowance !== null && overlapDays > 0) {
    // Cross-kind by construction, for the reason above: a neighbour of the request's own kind
    // would have had to occupy one of the request's own days to be touched at all, and that day
    // returned inside the walk.
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
