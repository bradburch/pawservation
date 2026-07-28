import {
  addDays,
  billableUnits,
  buildCapacity,
  buildGroupKey,
  buildMixKey,
  DEFAULT_TIMEZONE,
  dedupePets,
  getPacificDateStr,
  mixFromPetTypes,
  nightsBetween,
  rangeHasConflict,
  resolvePetSetRate,
  walkHasConflict,
  type CapacityEvent,
  type CapacityRequest,
  type GroupRate,
  type MixRate,
  type PoolKind,
  type PricedPet,
} from '../../src/shared/index.js';
import {
  listCapacityRows,
  countSlotBookings,
  listPetGroupPricing,
  listServicePetRates,
  listSlotBookingCounts,
  listUserBookingDatesInRange,
  type CapacityRow,
} from '../db/repo';
import type { Tenant, TenantService, TenantServiceOption } from '../types';

// Per-tenant availability built on the shared capacity engine. Each pool-drawing service carries
// its own nullable cap (MaxConcurrentPets; null = unlimited / auto pass-through).

export function rowsToCapacityEvents(rows: CapacityRow[]): CapacityEvent[] {
  return rows.map((row) =>
    row.ServiceType === 'blocked'
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
  | { available: false; reason: string };

/**
 * The result of pricing a booking. `priced: false` carries NO cost — the failure cannot be
 * coerced to a number by any caller, because there is no number on it.
 *
 * `billedUnits`/`unit` are absent for single-day services (daycare/walk/check-in): a flat
 * per-booking charge has no quantity to label. This is the shape the wire has had since PR #65
 * and a deliberate, documented softening of design spec §4's literal type, which declared both
 * fields required before the single-day omission existed.
 */
export type PriceResult =
  | { priced: true; cost: number; billedUnits?: number; unit?: 'night' | 'day' }
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
 * INVARIANT — no inferred pricing. A price must never come from an algorithm the sitter did not
 * configure:
 *
 * - **Pet count never affects price.** Two dogs for three nights cost the same as one dog for
 *   three nights UNLESS the sitter stored a rate for that exact set — and then the price is that
 *   stored number, not a function of the count.
 * - The only arithmetic permitted here is over **units of time** (nights, days, per-visit) times
 *   a stored `Rate`. Nothing else may be multiplied, scaled, or surcharged.
 * - A per-pet or per-combination rate requires an explicit stored rate entry the sitter chose. It
 *   must never be inferred (no "×1.5 for the second dog", no per-pet multiplier).
 *
 * The structural guarantee: the ONLY thing `pets` can do in this function is select a stored rate
 * by EXACT match (`resolvePetSetRate`, which does no arithmetic of any kind), or, for a single
 * pet, fall through to the option's own rate. There is no expression anywhere below in which a
 * pet count is an operand. When no rate matches a set of two or more, the function REFUSES —
 * inventing a number from the single-pet rate is precisely the defect this comment prevents, and
 * `server/__tests__/availability.test.ts`'s "a three-dog quote is refused, not tripled" is its
 * lock.
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
  if (resolved) {
    rate = resolved.rate;
  } else if (distinct.length === 1) {
    // Spec §2 step 3: a single pet keeps the option's flat rate. This is explicit sitter config,
    // not inference, and scoping the refusal to 2+ pets is what stops this feature breaking every
    // booking on deploy (spec §2 "Why single-pet keeps the flat-rate fallback").
    rate = option.Rate;
  } else {
    // Spec §2 step 4. Zero pets lands here too: an empty set has nothing to price, and the routes
    // reject it earlier — this is the structural backstop, not the user-facing check.
    return {
      priced: false,
      reason: 'unpriced-pet-set',
      groupKey: buildGroupKey(distinct.map((p) => p.id)),
      mixKey: buildMixKey(mixFromPetTypes(distinct.map((p) => p.petType))),
    };
  }

  if (service.Shape !== 'range') return { priced: true, cost: rate };
  const nights = nightsBetween(startDate, endDateExclusive);
  const unit = billingUnit(service);
  const units = billableUnits(nights, unit);
  return { priced: true, cost: rate * units, billedUnits: units, unit };
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
    listPetGroupPricing(env.PAWBOOK_DB, tenantId, serviceType),
    listServicePetRates(env.PAWBOOK_DB, tenantId),
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
  const request: CapacityRequest = {
    serviceType: service.ServiceType,
    kind: service.CapacityKind === 'housesit' ? 'housesit' : 'boarding',
    cap: service.MaxConcurrentPets,
    petCount,
  };
  // The engine (rangeHasConflict) already rejects an over-cap request on its own. This fast path
  // is kept purely for UX + cost: it returns a SPECIFIC "exceeds capacity" reason (vs the generic
  // "dates not available") and short-circuits before the capacity DB read. Unlimited skips it.
  if (request.cap !== null && petCount > request.cap) {
    return {
      available: false,
      reason:
        request.kind === 'boarding'
          ? 'That exceeds our boarding capacity.'
          : 'That exceeds our house-sitting capacity.',
    };
  }
  // Fetch one day PAST checkout so the soft-bookend look-ahead sees a booking starting on the
  // checkout day (without +1, listCapacityRows clips that row and a final night can double-book).
  const rows = await listCapacityRows(
    env.PAWBOOK_DB,
    tenant.Id,
    startDate,
    addDays(endDateExclusive, 1),
    excludeBookingId,
  );
  const capacity = buildCapacity(rowsToCapacityEvents(rows));
  if (rangeHasConflict(startDate, endDateExclusive, request, capacity)) {
    return { available: false, reason: 'Those dates are not available.' };
  }
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
  };
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
  const rows = await listCapacityRows(
    env.PAWBOOK_DB,
    tenant.Id,
    date,
    addDays(date, 1),
    excludeBookingId,
  );
  const capacity = buildCapacity(rowsToCapacityEvents(rows));
  if (walkHasConflict(date, capacity)) {
    return { available: false, reason: 'That day is blocked off.' };
  }
  if (option.Capacity !== null) {
    const count = await countSlotBookings(
      env.PAWBOOK_DB,
      tenant.Id,
      service.ServiceType,
      option.OptionKey,
      date,
      excludeBookingId,
    );
    if (count >= option.Capacity) {
      return { available: false, reason: 'That session is full.' };
    }
  }
  const price = estimateCost(service, option, date, date, pets, rates);
  if (!price.priced) return { available: true, ...price };
  return { available: true, priced: true, estCost: price.cost };
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

export type MonthDay = {
  date: string;
  status: 'available' | 'partial' | 'unavailable';
  used: number | null;
  max: number | null;
  mine: boolean;
};

/**
 * Per-day availability for a calendar month, sourced from D1 — the same authoritative store
 * `checkAvailability` reads via `listCapacityRows`, so the month grid can never show a day as
 * open that the booking check would then reject (or vice versa). Google Calendar is a one-way
 * sync TARGET only (`calendar-sync.ts`); it is never read back here.
 */
export async function monthAvailability(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  month: string, // YYYY-MM
  callerEndUserId: string,
  option: TenantServiceOption | null = null,
): Promise<{ today: string; days: MonthDay[] }> {
  const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);

  const monthStart = `${month}-01`;
  // new Date(year, month, 0) — month is 1-based here, day 0 = last day of prior month = last day of `month`
  const [yearStr, monStr] = month.split('-');
  const daysInMonth = new Date(Number(yearStr), Number(monStr), 0).getDate();
  const lastDay = addDays(monthStart, daysInMonth - 1);
  const monthEndExclusive = addDays(lastDay, 1);

  const poolKind: PoolKind | null = service.CapacityKind === 'none' ? null : service.CapacityKind;

  // Slot capacity is fetched ONCE for the whole grid (not per day), matching buildCapacity's
  // "build the map once" pattern, and run concurrently with the other D1 reads since none of
  // them depend on each other's result.
  const capacityLimit = poolKind === null ? (option?.Capacity ?? null) : null;
  const slotCountsPromise =
    capacityLimit !== null
      ? listSlotBookingCounts(
          env.PAWBOOK_DB,
          tenant.Id,
          service.ServiceType,
          option!.OptionKey,
          monthStart,
          monthEndExclusive,
        )
      : Promise.resolve(null);

  const [capacityRows, slotCounts, mineRows] = await Promise.all([
    listCapacityRows(env.PAWBOOK_DB, tenant.Id, monthStart, monthEndExclusive),
    slotCountsPromise,
    listUserBookingDatesInRange(
      env.PAWBOOK_DB,
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

  const cap = buildCapacity(rowsToCapacityEvents(capacityRows));

  const days: MonthDay[] = [];
  for (let i = 0; i < daysInMonth; i++) {
    const date = addDays(monthStart, i);
    const day = cap.get(date);

    let status: 'available' | 'partial' | 'unavailable';
    let used: number | null;
    let max: number | null;

    if (poolKind !== null) {
      // Range service (boarding / housesitting): capacity-aware against ITS OWN pool + cap.
      const rawUsed = day?.byService.get(service.ServiceType) ?? 0;
      max = service.MaxConcurrentPets;
      const blocked = (day?.blocked ?? 0) >= 1;
      const unavailable = blocked || (max != null && rawUsed >= max);
      status = unavailable ? 'unavailable' : max != null && rawUsed > 0 ? 'partial' : 'available';
      used = max != null ? rawUsed : null;
    } else {
      // Single-day unlimited service (walk / daycare / check-in): block-only, plus a per-slot
      // capacity check when the option has one. Customers never see raw counts — only status.
      const blocked = walkHasConflict(date, cap);
      const full = capacityLimit !== null && (slotCounts!.get(date) ?? 0) >= capacityLimit;
      status = blocked || full ? 'unavailable' : 'available';
      used = null;
      max = null;
    }

    days.push({ date, status, used, max, mine: mineDays.has(date) });
  }

  return { today, days };
}
