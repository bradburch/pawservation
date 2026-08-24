import {
  addDays,
  addMonths,
  billableUnits,
  buildCapacity,
  buildGroupKey,
  buildMixKey,
  DEFAULT_TIMEZONE,
  dedupePets,
  getPacificDateStr,
  isWellFormedCapacityEvent,
  mixFromPetTypes,
  nightsBetween,
  overlapReadWindow,
  rangeConflictReason,
  resolvePetSetRate,
  walkHasConflict,
  whereaboutsDayBlocked,
  type CapacityEvent,
  type CapacityRequest,
  type DayCapacity,
  type GroupRate,
  type MixRate,
  type PoolKind,
  type PricedPet,
  type RangeConflict,
} from '../../src/shared/index.js';
import {
  listCapacityRows,
  countSlotBookings,
  listPetGroupPricing,
  listServiceOptions,
  listServicePetRates,
  listServices,
  listSlotBookingCounts,
  listUserBookingDatesInRange,
  type CapacityRow,
  type OccupancyScope,
} from '../db/repo';
import type { BookingRow, Tenant, TenantService, TenantServiceOption } from '../types';
import { holidayAwareCost, splitUnits, type UnitSplit } from './holiday-cost';
import { DEFAULT_OVERLAP_DAYS } from './validation';

// Per-tenant availability built on the shared capacity engine. Each pool-drawing service carries
// its own nullable cap (MaxConcurrentPets; null = unlimited / auto pass-through).

// External rows are deliberately blocked-kind (an unconditional hard stop) — a Google event tells us
// the sitter is busy, not which pool is busy.
export function rowsToCapacityEvents(rows: CapacityRow[]): CapacityEvent[] {
  return rows.map((row) =>
    row.ServiceType === 'blocked' || row.ServiceType === 'external'
      ? { start_date: row.StartDate, end_date: row.EndDate ?? undefined, kind: 'blocked' as const }
      : {
          start_date: row.StartDate,
          end_date: row.EndDate ?? undefined,
          kind: row.CapacityKind === 'housesit' ? ('housesit' as const) : ('boarding' as const),
          serviceType: row.ServiceType,
          petCount: row.PetCount,
        },
  );
}

/**
 * The capacity map, plus the one thing the pure engine deliberately cannot do: TELL SOMEONE about a
 * row it could not read. `buildCapacity` treats an event whose dates don't parse as a blocked day
 * (fail toward occupied — see `isWellFormedCapacityEvent`), which keeps the calendar sound but
 * silent, and a corrupt row quietly blocking a date forever is its own bug. Every server-side
 * capacity read goes through here so the log happens once, at the boundary where the booking IDS
 * are still in hand (the engine only ever sees normalized events).
 *
 * Logged, never thrown: a single bad row must not 500 the whole availability read, and treating it
 * as occupied has already made the answer safe.
 */
function capacityFromRows(tenantId: string, rows: CapacityRow[]): Map<string, DayCapacity> {
  const events = rowsToCapacityEvents(rows);
  const corrupt = rows.filter((_, i) => !isWellFormedCapacityEvent(events[i]));
  if (corrupt.length > 0) {
    console.error(
      `capacity: tenant ${tenantId} has ${corrupt.length} booking row(s) with unusable dates — ` +
        `treated as BLOCKED days, fix or delete them: ` +
        corrupt.map((r) => `${r.Id} (${r.StartDate} → ${r.EndDate ?? 'null'})`).join(', '),
    );
  }
  return buildCapacity(events);
}

export type AvailabilityResult =
  | {
      available: true;
      /** Discriminant. `true` means the sitter has priced this exact pet set (or it is a single
       *  pet falling back to the option's own rate). See the `priced: false` arm. */
      priced: true;
      estCost: number;
      /**
       * The quantity `estCost` was actually billed for, in `unit`s — the number the widget shows
       * next to the price. Comes from the same `billableUnits` call `estimateCost` uses, so the
       * displayed quantity and the price can never disagree. Both are absent for single-day
       * services (daycare/walk/check-in): those are a flat per-booking charge with no quantity.
       */
      billedUnits?: number;
      unit?: 'night' | 'day';
      /**
       * RETAINED FOR WIRE COMPATIBILITY ONLY — prefer `billedUnits`/`unit`. Still literally the
       * night count (`nightsBetween`), which for a day-billed range service is one LESS than what
       * is charged. Kept (rather than renamed to `units`) because the exported engine API is
       * mirrored by the out-of-tree booking MCP deployment, whose readers CI here cannot inspect;
       * a rename would risk unprovable breakage for zero present-day gain, since every service
       * that exists today is night-billed. Droppable once the deployed MCP is confirmed not to
       * read it.
       */
      nights?: number;
      /**
       * How many of `billedUnits` fell on a listed US holiday and were charged at `holidayRate`
       * instead of the base rate, and what that rate was. BOTH are absent unless the service has a
       * `HolidayRate` AND at least one unit landed on one — so a quote with no holiday looks
       * exactly like it did before this feature. Display only: the widget renders them next to
       * `estCost`, which the server already computed. The client still computes no money.
       */
      holidayUnits?: number;
      holidayRate?: number;
      /**
       * The extra-time surcharge the owner's chosen times attract (0009), and its total — DISPLAY
       * ONLY, and deliberately NOT part of `estCost`. `estCost` is the price of the stay;
       * `extraTimeTotal` is what will be added to it as `BookingCharges` rows when the booking is
       * created, so `totalDue` stays `EstCost + chargesTotal` at every read site.
       *
       * Both fields are absent unless a fee actually applies, so a quote for a service with no
       * standard hours (every service until a sitter sets some) is byte-identical to what it was
       * before the feature. Written by `booking-ops`' `quoteBooking` from `extraTimeSurcharges` —
       * the SAME function that stamps the charges — so the previewed number and the stamped one
       * cannot drift, exactly as `feeToCancelToday` serves both the cancellation preview and its
       * stamp. Attached OUTSIDE `estimateCost`/`checkAvailability` on purpose: the price formula
       * never sees a time, and a surcharge never passes through it.
       */
      extraTimeFees?: { label: string; amount: number }[];
      extraTimeTotal?: number;
    }
  | {
      /**
       * The DATES are fine; the PRICE is not knowable. Two or more pets that the sitter has never
       * priced as a set — deliberately NOT folded into `available: false`, because the two answers
       * need different responses from the customer: "wait for a free date" versus "call the sitter
       * and ask for a rate". There is no cost field on this arm AT ALL, so no caller can coerce a
       * refusal into $0; `groupKey`/`mixKey` are the exact keys that found no match, so a sitter or
       * an agent can see which rate is missing.
       */
      available: true;
      priced: false;
      reason: 'unpriced-pet-set';
      groupKey: string;
      mixKey: string;
    }
  | {
      available: false;
      /** Customer-facing "why not", rendered verbatim by the widget (`BookTab`'s quoteRefusal). */
      reason: string;
      /**
       * A stable snake_case identifier for the refusal, present ONLY where the generic
       * "those dates just filled up" would misdescribe it — today just the house-sit/boarding
       * overlap rule, whose dates are NOT full. The booking POST forwards it (and this `reason`)
       * as its `{ error, code }`, so an agent gets the same distinction a person does.
       */
      code?: string;
    };

/**
 * The result of pricing a booking. `priced: false` carries NO cost — the failure cannot be
 * coerced to a number by any caller, because there is no number on it.
 *
 * `billedUnits`/`unit` are absent for single-day services (daycare/walk/check-in): a flat
 * per-booking charge has no quantity to label. This is the shape the wire has had since PR #65
 * and a deliberate, documented softening of design spec §4's literal type, which declared both
 * fields required before the single-day omission existed.
 *
 * `holidayUnits`/`holidayRate` are BOTH absent unless the service has a `HolidayRate` AND at
 * least one billed unit landed on a listed US holiday — see `holidayFields`. That keeps an
 * ordinary (no-holiday) quote's payload byte-identical to what it was before this feature.
 */
export type PriceResult =
  | {
      priced: true;
      cost: number;
      billedUnits?: number;
      unit?: 'night' | 'day';
      holidayUnits?: number;
      holidayRate?: number;
    }
  | { priced: false; reason: 'unpriced-pet-set'; groupKey: string; mixKey: string };

/**
 * The estimated cost of a booking — the ONE place the price formula lives, so the availability
 * quote and the stored booking cost can't diverge. Range services bill per unit of stay, taking
 * that unit from the service's own `RateUnit` (the same column the widget prints as "/night" or
 * "/day", so the price and its label can never disagree); single-day services (daycare/walk/
 * check-in) are a flat per-booking rate. Pure (no DB) — the candidate rate rows arrive as
 * arguments, fetched by `loadPetSetRates` — so callers that already know the dates can price a
 * booking without a capacity read.
 *
 * The optional `holidayUnits`/`holidayRate` on the `priced: true` result come from the SAME
 * `unitSplitFor` call the cost was computed from (see `holidayFields`), so the breakdown a caller
 * displays and the price it sits next to can never disagree.
 *
 * INVARIANT — no inferred pricing. A price must never come from an algorithm the sitter did not
 * configure. The rule is not "pet count may never be multiplied"; it is **"a rate the sitter did
 * not type is a price they did not agree to."** Concretely:
 *
 * - The only arithmetic permitted here is over **units of time** (nights, days, per-visit) times
 *   a stored `Rate`, and — only where the sitter stored `PetRateMode = 'linear'` — times the
 *   number of distinct pets. Nothing else may be multiplied, scaled, or surcharged.
 * - A per-combination rate is never GUESSED. `resolvePetSetRate` does exact matching and no
 *   arithmetic of any kind, and an explicitly stored pet-set rate always WINS over the multiplier:
 *   a sitter who typed a two-dog rate gets that rate, never 2× the one-dog rate.
 * - There is still no "×1.5 for the second dog", no percentage surcharge, no proration, and no
 *   nearest-match — the multiplier is exactly ×N or nothing.
 *
 * The structural guarantee, restated for `PetRateMode` (2026-07-28): the ONLY things `pets` can do
 * in this function are (a) select a stored rate by EXACT match, (b) for a single pet, fall through
 * to the option's own rate, and (c) multiply by its own DISTINCT COUNT — and (c) is reachable only
 * when the service row itself says `'linear'`, which is a value a sitter stored. `'exact'` is the
 * default for every row that has never been given one, and under `'exact'` a set of two or more
 * with no matching stored rate REFUSES exactly as it always has. Inventing a number from the
 * single-pet rate for a service that did NOT opt in is precisely the defect this comment prevents;
 * `server/__tests__/availability.test.ts`'s "a three-dog quote is refused, not tripled (mode
 * 'exact')" is its lock, and its `'linear'` sibling pins the opted-in multiplication next to it so
 * neither can be deleted as "the other one covers it".
 *
 * Holiday units (2026-07-27, WS-H) obey every rule above: a service's optional `HolidayRate` is an
 * explicit stored rate the sitter typed, charged per UNIT OF TIME that lands on a listed US
 * holiday, applied to whatever base rate `r` the pet-set resolution above produced — never a
 * multiplier, never derived. A NULL `HolidayRate` — every service until a sitter sets one — prices
 * identically to before the feature existed. Composing the two features is a single call to
 * `holidayAwareCost(r, service.HolidayRate, split)` below; `holiday-cost.ts` still never learns
 * that pets exist. Under `'linear'` the pet multiplier is applied to that composed total, so the
 * holiday leg scales too — see the `petMultiplier` comment at the call site for why.
 */
export function estimateCost(
  service: TenantService,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
  pets: PricedPet[],
  rates: { groupRates: GroupRate[]; mixRates: MixRate[] },
): PriceResult {
  const distinct = dedupePets(pets);
  const resolved = resolvePetSetRate({
    pets: distinct,
    serviceType: service.ServiceType,
    optionKey: option.OptionKey,
    groupRates: rates.groupRates,
    mixRates: rates.mixRates,
  });

  let rate: number;
  // 1 unless the sitter stored `PetRateMode = 'linear'` AND nothing exact matched. It is the only
  // pet-count operand in this function, and it can only ever be the DISTINCT pet count — never a
  // percentage, never a per-pet surcharge.
  let petMultiplier = 1;
  if (resolved) {
    // A stored pet-set rate ALWAYS wins, in both modes. The sitter typed a number for exactly
    // this set; multiplying it would price a set they already priced.
    rate = resolved.rate;
  } else if (distinct.length === 1) {
    // Spec §2 step 3: a single pet keeps the option's flat rate. This is explicit sitter config,
    // not inference, and scoping the refusal to 2+ pets is what stops this feature breaking every
    // booking on deploy (spec §2 "Why single-pet keeps the flat-rate fallback").
    rate = option.Rate;
  } else if (distinct.length >= 2 && service.PetRateMode === 'linear') {
    // The opted-in fallback (0005): N pets cost N times the one-pet rate. Two guards, both
    // load-bearing. `>= 2` keeps ZERO pets out: `petMultiplier = 0` would price an empty set at
    // $0 — a free booking is the same defect as an inferred one, and `priced: false` carrying no
    // cost at all is the shape that makes it unrepresentable. And the mode is compared against
    // 'linear' explicitly rather than "not 'exact'", so an unrecognised or legacy column value
    // reads as the REFUSING mode — the safe direction, since the unsafe one invents money.
    rate = option.Rate;
    petMultiplier = distinct.length;
  } else {
    // Spec §2 step 4, still the behaviour of every service that has not opted in. Zero pets lands
    // here in BOTH modes: an empty set has nothing to price, and the routes reject it earlier —
    // this is the structural backstop, not the user-facing check.
    return {
      priced: false,
      reason: 'unpriced-pet-set',
      groupKey: buildGroupKey(distinct.map((p) => p.id)),
      mixKey: buildMixKey(mixFromPetTypes(distinct.map((p) => p.petType))),
    };
  }

  // Holidays split the SAME units the base formula bills — they never change how many units
  // there are, only which stored rate each one is charged at. `rate` is the base rate `r`
  // resolved above (pet-set rate, or the option's flat rate for a single pet).
  //
  // The pet multiplier scales the COMPOSED total, not the base rate, so the holiday leg scales
  // with it: a sitter who opted into "N pets cost N times as much" would be astonished if the
  // third dog were free on Christmas, and pricing the holiday nights flat while the ordinary
  // nights scale is a discontinuity nobody typed either. `holidayAwareCost` therefore still never
  // sees a pet count — the composition here does.
  const split = unitSplitFor(service, startDate, endDateExclusive);
  const cost = holidayAwareCost(rate, service.HolidayRate, split) * petMultiplier;

  if (service.Shape !== 'range') return { priced: true, cost, ...holidayFields(service, split) };
  return {
    priced: true,
    cost,
    billedUnits: split.units,
    unit: billingUnit(service),
    ...holidayFields(service, split),
  };
}

/**
 * The billed units of a booking, partitioned into holiday and normal — the ONE computation of
 * "which units are holidays". `estimateCost` calls this once and prices AND reports the holiday
 * breakdown (via `holidayFields`) from that same result, so the breakdown a caller displays and
 * the price it sits next to can never disagree (the same reason `billedUnits` comes from the same
 * `billableUnits` call the price uses). Stays exported for the rare direct caller that needs the
 * split without a price (there is none in this file today).
 *
 * Range services split their `billableUnits` starting at check-in; single-day services are one
 * unit on the date itself. See `splitUnits` for the night-named-by-its-check-in-date convention.
 */
export function unitSplitFor(
  service: TenantService,
  startDate: string,
  endDateExclusive: string,
): UnitSplit {
  if (service.Shape !== 'range') return splitUnits(startDate, 1);
  const nights = nightsBetween(startDate, endDateExclusive);
  return splitUnits(startDate, billableUnits(nights, billingUnit(service)));
}

/**
 * The unit a range service bills in, from its own RateUnit (the column the UI prints). Anything
 * but 'day' bills nights — the pre-change behavior of every service, and the safe fallback for
 * bad data ('visit'/'walk' on a range service can only arrive that way). Shared by `estimateCost` and
 * the quote's `billedUnits` so the price and its stated quantity read the same column.
 */
function billingUnit(service: TenantService): 'night' | 'day' {
  return service.RateUnit === 'day' ? 'day' : 'night';
}

/**
 * The optional holiday fields on a quote — present only when a holiday rate actually applied.
 * Omitting them on an ordinary quote keeps the pre-feature payload byte-identical, which is what
 * lets the 1-vs-3-pets no-inference lock compare WHOLE payloads with `toEqual`.
 */
function holidayFields(
  service: TenantService,
  split: UnitSplit,
): { holidayUnits?: number; holidayRate?: number } {
  if (service.HolidayRate == null || split.holidayUnits === 0) return {};
  return { holidayUnits: split.holidayUnits, holidayRate: service.HolidayRate };
}

/**
 * The candidate rate rows for ONE (tenant, service), shaped for `estimateCost`. Async and
 * DB-touching, deliberately separate from the pure formula: the spec requires `estimateCost` to
 * take its rows as arguments. Both queries are tenant-scoped in the repo, which is what makes
 * "tenant A's rates never price tenant B's booking" structural rather than remembered.
 *
 * `listServicePetRates` is tenant-WIDE by design; the per-(service, option) filtering happens
 * inside `resolvePetSetRate`, which is scoped by `serviceType`/`optionKey` on every row.
 */
export async function loadPetSetRates(
  env: Env,
  tenantId: string,
  serviceType: string,
): Promise<{ groupRates: GroupRate[]; mixRates: MixRate[] }> {
  const [groups, mixes] = await Promise.all([
    listPetGroupPricing(env.PAWSERVATION_DB, tenantId, serviceType),
    listServicePetRates(env.PAWSERVATION_DB, tenantId),
  ]);
  return {
    groupRates: groups.map((r) => ({
      groupKey: r.GroupKey,
      rate: r.Rate,
      serviceType: r.ServiceType,
      optionKey: r.OptionKey,
    })),
    mixRates: mixes.map((r) => ({
      mixKey: r.MixKey,
      rate: r.Rate,
      serviceType: r.ServiceType,
      optionKey: r.OptionKey,
    })),
  };
}

/**
 * The tenant's overlap allowance, with a last-resort default for a row that somehow lacks the
 * column. The window that made this necessary is closed at the source — `tenantCacheKey` is
 * versioned (`…:config:v2`), so a row cached by a worker that predates migration 0006 is never
 * read back — and this stays as the backstop for any other path that hands us a partial row. It
 * falls back to the product default rather than `?? null`, because reading a missing value as
 * "no limit" switches the rule OFF for everybody, which is the one direction that cannot be
 * recovered from: an overbooking the sitter did not agree to, versus a refusal she can widen.
 */
function overlapAllowanceOf(tenant: Tenant): number | null {
  const stored: number | null | undefined = tenant.HousesitBoardingOverlapDays;
  return stored === undefined ? DEFAULT_OVERLAP_DAYS : stored;
}

/**
 * Why a single-day request cannot have a date. The engine's own `RangeConflict` covers ranges; a
 * single-day service is governed by blocked days and by its OPTION's per-session slot cap, which
 * lives outside the engine (CALENDAR_LOGIC.md §3 subtlety 1) and so needs its own vocabulary.
 */
type SingleConflict = 'blocked_day' | 'slot_full' | 'slot_no_room';

/**
 * Turn the engine's refusal into the customer's answer. The whereabouts overlap rule gets its own
 * sentences and its own `code` because "those dates are not available" is simply untrue of it — the
 * dates have room; the SITTER does not, and a customer told the truth can move by one day instead
 * of giving up. Every other refusal keeps the pre-existing generic wording verbatim.
 *
 * `same_kind_overlap` (a house sit against another house sit) shares the WIRE code
 * `overlap_not_allowed` with `cross_kind_overlap`, and only the sentence differs. The code names
 * the RULE, and there is one rule with one allowance knob behind both; splitting it would ask
 * every consumer to learn a distinction that changes nothing about what they can do next, which is
 * move the dates. The sentence is where the difference actually matters, because telling a
 * customer "your sitter has boarding on those dates" when she is in fact sitting another client's
 * home would be the code authoring a falsehood.
 */
function rangeRefusal(
  conflict: RangeConflict,
  kind: PoolKind,
): { available: false; reason: string; code?: string } {
  // The "more pets than the service could ever seat" answer, unchanged: it used to be produced by a
  // fast path inside checkRange, which now reports it as the engine's own `'over_cap'` instead (see
  // `rangeConflictFor`). Same string, same conditions, one fewer place that decides the wording.
  if (conflict === 'over_cap') {
    return {
      available: false,
      reason:
        kind === 'boarding'
          ? 'That exceeds our boarding capacity.'
          : 'That exceeds our house-sitting capacity.',
    };
  }
  if (conflict === 'same_kind_overlap') {
    return {
      available: false,
      reason:
        'Your sitter is already house-sitting for another client on those dates — she can only stay in one home a night, so a second house sit can meet it on the day one is ending as the other begins, never for the whole stay.',
      code: 'overlap_not_allowed',
    };
  }
  if (conflict !== 'cross_kind_overlap') {
    return { available: false, reason: 'Those dates are not available.' };
  }
  return {
    available: false,
    reason:
      kind === 'housesit'
        ? 'Your sitter has boarding on those dates — a house sit can only overlap it on the day one is ending as the other begins, never for the whole stay.'
        : 'Your sitter is house-sitting on those dates — a boarding can only overlap it on the day one is ending as the other begins, never for the whole stay.',
    code: 'overlap_not_allowed',
  };
}

/**
 * WOULD THIS RANGE FIT, and if not, which rule refused? The capacity/conflict half of `checkRange`,
 * on its own, because it has two audiences that must never drift apart: the customer quote (which
 * turns the answer into a customer-facing phrase via `rangeRefusal`) and the sitter's confirm
 * re-check (which turns the same answer into a warning she can override, via
 * `confirmOverbookWarning`). A second walk of the same rules is exactly how the two would come to
 * disagree, so there is only one.
 *
 * `scope` is the only thing the two callers ask differently — see `OccupancyScope`.
 */
async function rangeConflictFor(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  startDate: string,
  endDateExclusive: string,
  petCount: number,
  excludeBookingId?: string,
  scope: OccupancyScope = 'all-live',
): Promise<RangeConflict | null> {
  const request: CapacityRequest = {
    serviceType: service.ServiceType,
    kind: service.CapacityKind === 'housesit' ? 'housesit' : 'boarding',
    cap: service.MaxConcurrentPets,
    petCount,
    // The tenant's own handover allowance (0006). Read HERE, from the tenant row, because the
    // engine is pure and must never learn what a database is — and because this one call site is
    // reached by all three enforcement paths (the quote, the demo POST check, the real POST
    // check), which is what stops them disagreeing.
    overlapAllowance: overlapAllowanceOf(tenant),
  };
  // The engine (rangeConflictReason) already rejects an over-cap request on its own; this short-
  // circuit exists purely to skip the capacity DB read when the answer cannot depend on it.
  // Unlimited skips it.
  if (request.cap !== null && petCount > request.cap) return 'over_cap';
  // Fetch one day PAST checkout. This used to feed the engine's soft-bookend look-ahead, which is
  // gone (it forgave an over-full LAST OCCUPIED NIGHT as if it were a checkout day); the over-read
  // is kept because it still buys something and can never cost correctness. An opposite-kind
  // neighbour that departs on our own checkout day is a common shape, and with the extra day
  // already in the map `overlapReadWindow` below asks for no widening — one D1 query saved, and a
  // wider map can only ever make the verdict stricter, never wrong.
  const rows = await listCapacityRows(
    env.PAWSERVATION_DB,
    tenant.Id,
    startDate,
    addDays(endDateExclusive, 1),
    excludeBookingId,
    scope,
  );
  let capacity = capacityFromRows(tenant.Id, rows);

  // The overlap rule judges the bookings this request TOUCHES as well as the request itself (it is
  // symmetric, so the verdict cannot depend on which of two stays was booked first), and a touched
  // house sit or boarding routinely starts before this request or ends after it. When one does,
  // re-read the calendar over the union of their spans so those neighbours are whole; without it a
  // neighbour's own days would fall outside the map and read as free. Costs a second D1 read only
  // when an overlap actually exists — and never when the tenant has switched the rule off.
  const need =
    request.overlapAllowance === null
      ? null
      : overlapReadWindow(startDate, endDateExclusive, request.kind, capacity);
  const readEnd = addDays(endDateExclusive, 1);
  if (need !== null && (need.from < startDate || need.toExclusive > readEnd)) {
    const widened = await listCapacityRows(
      env.PAWSERVATION_DB,
      tenant.Id,
      need.from < startDate ? need.from : startDate,
      need.toExclusive > readEnd ? need.toExclusive : readEnd,
      excludeBookingId,
      scope,
    );
    capacity = capacityFromRows(tenant.Id, widened);
  }

  return rangeConflictReason(startDate, endDateExclusive, request, capacity);
}

async function checkRange(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
  pets: PricedPet[],
  rates: { groupRates: GroupRate[]; mixRates: MixRate[] },
  excludeBookingId?: string,
): Promise<AvailabilityResult> {
  // Math.max(…, 1) preserves today's behaviour for the (route-unreachable) empty set: capacity
  // has always been checked for at least one pet.
  const petCount = Math.max(dedupePets(pets).length, 1);
  const conflict = await rangeConflictFor(
    env,
    tenant,
    service,
    startDate,
    endDateExclusive,
    petCount,
    excludeBookingId,
  );
  if (conflict !== null)
    return rangeRefusal(conflict, service.CapacityKind === 'housesit' ? 'housesit' : 'boarding');
  // ONE call — estimateCost resolves the rate, prices, AND splits for holidays; the estCost and
  // the reported breakdown below come from this single result, so no site recomputes the formula.
  const price = estimateCost(service, option, startDate, endDateExclusive, pets, rates);
  if (!price.priced) return { available: true, ...price };
  return {
    available: true,
    priced: true,
    estCost: price.cost,
    // The quantity the price was computed from — same unit, same `billableUnits` call as
    // `estimateCost`, so the widget's "4 days" can never sit next to a 3-night price.
    billedUnits: price.billedUnits,
    unit: price.unit,
    nights: nightsBetween(startDate, endDateExclusive), // wire-compat only; see AvailabilityResult
    holidayUnits: price.holidayUnits,
    holidayRate: price.holidayRate,
  };
}

/**
 * Why a SINGLE-DAY request can't have this date — the mirror of `rangeConflictFor`, same two
 * audiences and the same reason for existing (one walk of the rules, two wordings). `'slot_full'`
 * and `'slot_no_room'` are kept apart because the customer needs to hear different things: the
 * session is gone, versus the session has room but not for THIS many pets.
 *
 * `option` is nullable only for the confirm re-check, which can meet a booking whose option the
 * sitter has since deleted: with no option there is no slot cap to test, and the blocked-day check
 * still stands.
 */
async function singleConflictFor(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  option: TenantServiceOption | null,
  date: string,
  petCount: number,
  excludeBookingId?: string,
  scope: OccupancyScope = 'all-live',
): Promise<SingleConflict | null> {
  const rows = await listCapacityRows(
    env.PAWSERVATION_DB,
    tenant.Id,
    date,
    addDays(date, 1),
    excludeBookingId,
    scope,
  );
  const capacity = capacityFromRows(tenant.Id, rows);
  if (walkHasConflict(date, capacity)) return 'blocked_day';
  if (option !== null && option.Capacity !== null) {
    const count = await countSlotBookings(
      env.PAWSERVATION_DB,
      tenant.Id,
      service.ServiceType,
      option.OptionKey,
      date,
      excludeBookingId,
      scope,
    );
    // The requested SET has to fit, not just one pet: `count + petCount > cap` is the same
    // arithmetic `dayBlocksRequest` applies to the boarding/house-sit pools. Asking only
    // `count >= cap` let a 3-pet request into a slot with one spot left — the exact class of
    // over-capacity accept the pool path removed, and a direct contradiction of the sitter-facing
    // promise that "a booking with three dogs uses three spots". Identical for a single pet
    // (`count + 1 > cap` ⇔ `count >= cap`), so nothing about one-pet behaviour moves.
    if (count + petCount > option.Capacity)
      return count >= option.Capacity ? 'slot_full' : 'slot_no_room';
  }
  return null;
}

async function checkSingle(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  option: TenantServiceOption,
  date: string,
  pets: PricedPet[],
  rates: { groupRates: GroupRate[]; mixRates: MixRate[] },
  excludeBookingId?: string,
): Promise<AvailabilityResult> {
  const petCount = Math.max(dedupePets(pets).length, 1);
  const conflict = await singleConflictFor(
    env,
    tenant,
    service,
    option,
    date,
    petCount,
    excludeBookingId,
  );
  if (conflict === 'blocked_day') return { available: false, reason: 'That day is blocked off.' };
  if (conflict !== null) {
    return {
      available: false,
      reason:
        conflict === 'slot_full'
          ? 'That session is full.'
          : `That session doesn't have room for ${petCount} pets.`,
    };
  }
  // ONE call — see checkRange's comment above for why this replaces a direct holidayAwareCost call.
  const price = estimateCost(service, option, date, date, pets, rates);
  if (!price.priced) return { available: true, ...price };
  return {
    available: true,
    priced: true,
    estCost: price.cost,
    holidayUnits: price.holidayUnits,
    holidayRate: price.holidayRate,
  };
}

export function checkAvailability(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
  pets: PricedPet[],
  rates: { groupRates: GroupRate[]; mixRates: MixRate[] },
  excludeBookingId?: string,
): Promise<AvailabilityResult> {
  return service.Shape === 'range'
    ? checkRange(
        env,
        tenant,
        service,
        option,
        startDate,
        endDateExclusive,
        pets,
        rates,
        excludeBookingId,
      )
    : checkSingle(env, tenant, service, option, startDate, pets, rates, excludeBookingId);
}

/** The stored fields the confirm re-check needs. `BookingRow` satisfies it. */
export type ConfirmableBooking = Pick<
  BookingRow,
  'Id' | 'ServiceType' | 'OptionKey' | 'StartDate' | 'EndDate' | 'PetCount'
>;

/**
 * WOULD CONFIRMING THIS STORED REQUEST OVERBOOK THE SITTER? Returns the sentence to show her, or
 * `null` when the dates are genuinely clear.
 *
 * A pending request holds capacity, but nothing re-validated when the sitter CONFIRMED it — so two
 * pending requests for one scarce day could both be confirmed, and a confirm could break a rule
 * that did not exist when the request was made: the 0006 handover rule, a day blocked off since, a
 * cap she has since lowered. This is that missing check, and it deliberately WARNS rather than
 * refuses: it is her calendar, and hard-refusing a double-booking she wants on purpose (the regular
 * client she will squeeze in) would be worse than the hole. What she must never be able to do is end
 * up over capacity without having been TOLD, which is what the caller's
 * acknowledgement-then-override flow provides.
 *
 * **Scope is `'committed-only'` on purpose.** Other PENDING requests are not commitments — they are
 * what she is adjudicating. Counting them would fire on the FIRST of two competing requests, where
 * confirming is exactly the right move, and a warning that cries wolf on the safe case is how the
 * dangerous case (the second confirm) gets clicked through. With commitments only, the first confirm
 * is silent and the second one warns.
 *
 * The booking's OWN row is excluded (`booking.Id`) — a pending request already occupies the pool, so
 * without that it would conflict with itself. Pet count comes from the stored `PetCount`, the same
 * number `rowsToCapacityEvents` gives every other row in the map.
 *
 * The booking WINDOW (0004) is deliberately not re-checked: minimum notice and the advance horizon
 * are the customer's constraints on asking, not the sitter's on accepting, and a request that has
 * simply grown old must not become unconfirmable.
 */
export async function confirmOverbookWarning(
  env: Env,
  tenant: Tenant,
  booking: ConfirmableBooking,
): Promise<string | null> {
  const service = (await listServices(env.PAWSERVATION_DB, tenant.Id)).find(
    (s) => s.ServiceType === booking.ServiceType,
  );
  // A service the sitter has since deleted has no cap, no pool and no rules left to break; the
  // stored row is all there is, and refusing to let her answer her client would help nobody.
  if (!service) return null;
  const petCount = Math.max(1, booking.PetCount);

  if (service.Shape === 'range') {
    const conflict = await rangeConflictFor(
      env,
      tenant,
      service,
      booking.StartDate,
      // A range row always stores an end date; `+1 day` is the same one-night fallback
      // `listUserBookingDatesInRange` uses, so a malformed row is checked rather than skipped.
      booking.EndDate ?? addDays(booking.StartDate, 1),
      petCount,
      booking.Id,
      'committed-only',
    );
    return conflict === null ? null : rangeWarning(conflict, service, petCount);
  }

  const option =
    (await listServiceOptions(env.PAWSERVATION_DB, tenant.Id)).find(
      (o) => o.ServiceType === booking.ServiceType && o.OptionKey === booking.OptionKey,
    ) ?? null;
  const conflict = await singleConflictFor(
    env,
    tenant,
    service,
    option,
    booking.StartDate,
    petCount,
    booking.Id,
    'committed-only',
  );
  return conflict === null ? null : singleWarning(conflict, service, option, petCount);
}

/** The sitter's wording for a range conflict — her calendar and her caps, not a customer's dates. */
function rangeWarning(conflict: RangeConflict, service: TenantService, petCount: number): string {
  const overbooks = 'Confirming anyway will double-book you.';
  if (conflict === 'same_kind_overlap') {
    return (
      'You are already house-sitting for another client over those nights, and you can only stay in one home a night. ' +
      `Two house sits can meet on a handover day, not across the whole stay. ${overbooks}`
    );
  }
  if (conflict === 'cross_kind_overlap') {
    return (
      (service.CapacityKind === 'housesit'
        ? 'You already have boarding confirmed over those nights — a house sit can only meet it on a handover day, not across the whole stay.'
        : 'You are already house-sitting over those nights — boarding can only meet it on a handover day, not across the whole stay.') +
      ` ${overbooks}`
    );
  }
  const pets = `${petCount} pet${petCount === 1 ? '' : 's'}`;
  const seats =
    service.MaxConcurrentPets === null
      ? ''
      : ` ${service.Label} seats ${service.MaxConcurrentPets} pet${service.MaxConcurrentPets === 1 ? '' : 's'} a day.`;
  if (conflict === 'over_cap')
    return `This request is for ${pets}, which is more than ${service.Label} can take at once.${seats} ${overbooks}`;
  return `Your calendar is already full or blocked off on those dates, and this request adds ${pets}.${seats} ${overbooks}`;
}

/** The same, for a single-day service's own day and per-session slot cap. */
function singleWarning(
  conflict: SingleConflict,
  service: TenantService,
  option: TenantServiceOption | null,
  petCount: number,
): string {
  const overbooks = 'Confirming anyway will double-book you.';
  if (conflict === 'blocked_day') return `That day is blocked off on your calendar. ${overbooks}`;
  const slot = option ? `${service.Label} — ${option.Label}` : service.Label;
  const holds =
    option?.Capacity != null
      ? ` That slot holds ${option.Capacity} pet${option.Capacity === 1 ? '' : 's'}.`
      : '';
  return `${slot} is already full on that date, and this request adds ${petCount} pet${petCount === 1 ? '' : 's'}.${holds} ${overbooks}`;
}

export type MonthDay = {
  date: string;
  status: 'available' | 'partial' | 'unavailable';
  used: number | null;
  max: number | null;
  mine: boolean;
  /**
   * Why this day can't be booked, in one short customer-facing phrase — `null` when it can.
   * Derived from the SAME branch that produced `status`, so the widget can explain a greyed-out
   * day (title/aria-label) without re-deriving any rule client-side.
   */
  reason: string | null;
};

/** The one place the customer-facing "why not" phrases live — see `MonthDay.reason`. */
const REASON = {
  blocked: 'Sitter unavailable',
  full: 'Fully booked',
  tooSoon: 'Too soon to book',
  tooFarAhead: 'Too far ahead to book',
  /**
   * The day has room, but not `petCount` pets' worth — the refusal `checkRange` would give and
   * the one a "1/2" cell used to hide. Always plural: a single pet that does not fit means the
   * pool is at its cap, which is `full`.
   */
  noRoom: (petCount: number) => `Not enough room for ${petCount} pets`,
  /**
   * The whereabouts handover rule (0006), named by where the SITTER is rather than by a full pool —
   * the dates have room, she does not. It names WHAT is on the day rather than what was asked for,
   * because a house-sit request can now be turned away by boarding OR by another house sit and the
   * two are different answers; `Sitter is house-sitting` covers the same-kind case exactly, so the
   * vocabulary gains no sixth string. Symmetric with `rangeRefusal`'s longer sentences.
   */
  whereabouts: (day: DayCapacity) =>
    day.housesit.spans.length > 0 ? 'Sitter is house-sitting' : 'Sitter has boarders',
} as const;

/** The month grid's response: the day states plus the booking window RESOLVED TO DATES. */
export type MonthAvailability = {
  today: string;
  /**
   * First and last date this service may be booked for, already resolved from the booking-window
   * knobs (`TenantServices.MinLeadDays` / `Tenants.MaxAdvanceMonths`) against the TENANT's
   * timezone. `latestBookable` is null when the business sets no horizon (= unlimited).
   * Published as dates, never as the knobs: the rule stays server-side (CLAUDE.md), and the
   * widget only compares strings to decide whether paging further is pointless.
   */
  earliestBookable: string;
  latestBookable: string | null;
  days: MonthDay[];
};

/**
 * Per-day availability for a calendar month, sourced from D1 — the same authoritative store
 * `checkAvailability` reads via `listCapacityRows`, so the month grid can never show a day as
 * open that the booking check would then reject (or vice versa). Google Calendar is never read
 * at request time. It IS read back — but only by the periodic reconcile (`calendar-sync.ts`),
 * which materializes foreign events into ServiceType='external' rows; by the time this function
 * runs, Google's busy days are already ordinary DB rows in `listCapacityRows`. The property that
 * matters survives: this function and `checkAvailability` read exactly one store, so the grid and
 * the booking check can never disagree.
 */
export async function monthAvailability(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  month: string, // YYYY-MM
  callerEndUserId: string,
  option: TenantServiceOption | null = null,
  /**
   * How many pets the grid is being painted FOR. The pool check below is the same
   * `dayBlocksRequest` arithmetic `checkRange` runs (`used + petCount > cap`), not "does at least
   * one pet fit" — otherwise a 1/2 day reads bookable to a two-dog household and the booking POST
   * then refuses it. Defaults to 1, which is exactly the pre-change behaviour.
   */
  petCount = 1,
  /**
   * A booking of the CALLER's own to leave out of the capacity map — set while they are editing
   * it. Without it the grid paints the days they already hold as occupied by someone, and a stay
   * being re-timed inside a tight pool reads as unavailable on its own dates. Ownership of this id
   * is verified by the caller (`booking-ops`' `monthGrid`) against customer-scoped SQL before it
   * ever reaches here.
   */
  excludeBookingId?: string,
): Promise<MonthAvailability> {
  const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
  const pets = Math.max(1, petCount);

  const monthStart = `${month}-01`;
  // new Date(year, month, 0) — month is 1-based here, day 0 = last day of prior month = last day of `month`
  const [yearStr, monStr] = month.split('-');
  const daysInMonth = new Date(Number(yearStr), Number(monStr), 0).getDate();
  const lastDay = addDays(monthStart, daysInMonth - 1);
  const monthEndExclusive = addDays(lastDay, 1);

  const poolKind: PoolKind | null = service.CapacityKind === 'none' ? null : service.CapacityKind;
  // The tenant's handover allowance, read here for the same reason `checkRange` reads it there: the
  // engine is pure and must never learn what a database is. Same function, same row, so the grid
  // and the quote can only ever disagree in the direction the grid is allowed to (see below).
  const overlapDays = overlapAllowanceOf(tenant);

  // Slot capacity is fetched ONCE for the whole grid (not per day), matching buildCapacity's
  // "build the map once" pattern, and run concurrently with the other D1 reads since none of
  // them depend on each other's result.
  const capacityLimit = poolKind === null ? (option?.Capacity ?? null) : null;
  const slotCountsPromise =
    capacityLimit !== null
      ? listSlotBookingCounts(
          env.PAWSERVATION_DB,
          tenant.Id,
          service.ServiceType,
          option!.OptionKey,
          monthStart,
          monthEndExclusive,
          excludeBookingId,
        )
      : Promise.resolve(null);

  const [capacityRows, slotCounts, mineRows] = await Promise.all([
    listCapacityRows(
      env.PAWSERVATION_DB,
      tenant.Id,
      monthStart,
      monthEndExclusive,
      excludeBookingId,
    ),
    slotCountsPromise,
    listUserBookingDatesInRange(
      env.PAWSERVATION_DB,
      tenant.Id,
      callerEndUserId,
      monthStart,
      monthEndExclusive,
    ),
  ]);

  const mineDays = new Set<string>();
  for (const row of mineRows) {
    // Single-day bookings (walk/daycare/check-in) store EndDate = null; treat as a one-day span.
    const end = row.EndDate ?? addDays(row.StartDate, 1);
    for (let d = row.StartDate; d < end; d = addDays(d, 1)) {
      mineDays.add(d);
    }
  }

  const cap = capacityFromRows(tenant.Id, capacityRows);

  // The booking window (0004): days the customer could never request — before the service's
  // minimum notice or past the business-wide horizon — paint as unavailable, so the grid, the
  // quote, and the booking POST (all three call validateBookingWindow's rule) can never disagree.
  const earliestBookable =
    service.MinLeadDays !== null && service.MinLeadDays > 0
      ? addDays(today, service.MinLeadDays)
      : today;
  const latestBookable =
    tenant.MaxAdvanceMonths !== null ? addMonths(today, tenant.MaxAdvanceMonths) : null;

  const days: MonthDay[] = [];
  for (let i = 0; i < daysInMonth; i++) {
    const date = addDays(monthStart, i);
    const day = cap.get(date);
    const outsideWindow =
      date < earliestBookable || (latestBookable !== null && date > latestBookable);

    let status: 'available' | 'partial' | 'unavailable';
    let used: number | null;
    let max: number | null;
    let reason: string | null = null;

    if (poolKind !== null) {
      // Range service (boarding / housesitting): capacity-aware against ITS OWN pool + cap.
      const rawUsed = day?.byService.get(service.ServiceType) ?? 0;
      max = service.MaxConcurrentPets;
      const blocked = (day?.blocked ?? 0) >= 1;
      // The requested SET has to fit, not just one pet — `used + pets > cap` is `dayBlocksRequest`
      // verbatim. `partial` still means "occupied but the set fits", so a cell showing 1/2 is now
      // true for the pets actually selected rather than for a hypothetical single pet.
      const noRoom = max != null && rawUsed + pets > max;
      // The whereabouts handover rule (0006), asked of THIS DAY only. The engine owns the question
      // (`whereaboutsDayBlocked`) and answers it conservatively: true only where NO request of this
      // kind could arrive, depart or span, whatever its dates. For a `housesit` request that now
      // includes a day already carrying another house sit, on exactly the same three grounds. The
      // rest of the rule is a property of a range and stays deliberately unpainted — see
      // CALENDAR_LOGIC.md §9 — so a day left open here can still be refused by the quote, but a day
      // the quote and the POST always refuse can no longer paint `available`.
      const whereabouts =
        day !== undefined && whereaboutsDayBlocked(day, date, poolKind, overlapDays);
      const unavailable = blocked || noRoom || whereabouts;
      status = unavailable ? 'unavailable' : max != null && rawUsed > 0 ? 'partial' : 'available';
      used = max != null ? rawUsed : null;
      if (blocked) reason = REASON.blocked;
      // A pool at its cap is "Fully booked" however many pets you asked for; a pool with room
      // that still can't seat this set gets the specific answer instead of a misleading one.
      else if (noRoom) reason = max != null && rawUsed >= max ? REASON.full : REASON.noRoom(pets);
      else if (whereabouts) reason = REASON.whereabouts(day!);
    } else {
      // Single-day unlimited service (walk / daycare / check-in): block-only, plus a per-slot
      // capacity check when the option has one. Customers never see raw counts — only status.
      const blocked = walkHasConflict(date, cap);
      // `slotUsed + pets > cap`, mirroring the pool branch above and `checkSingle`: a slot with one
      // spot left is not available to a two-pet request, and painting it `available` would put the
      // grid ahead of the quote in the one direction it may never lead.
      const slotUsed = capacityLimit !== null ? (slotCounts!.get(date) ?? 0) : 0;
      const noRoom = capacityLimit !== null && slotUsed + pets > capacityLimit;
      status = blocked || noRoom ? 'unavailable' : 'available';
      used = null;
      max = null;
      if (blocked) reason = REASON.blocked;
      // A slot at its cap is "Fully booked" whoever asks; one with room that still can't seat this
      // set gets the specific answer, same split as the pool branch.
      else if (noRoom)
        reason = slotUsed >= (capacityLimit ?? 0) ? REASON.full : REASON.noRoom(pets);
    }

    // The window overrides both the status and the reason: a day the customer could never request
    // is explained by the window, not by whatever capacity happens to sit on it.
    if (outsideWindow) {
      status = 'unavailable';
      reason = date < earliestBookable ? REASON.tooSoon : REASON.tooFarAhead;
    }
    days.push({ date, status, used, max, mine: mineDays.has(date), reason });
  }

  return { today, earliestBookable, latestBookable, days };
}
