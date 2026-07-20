import {
  addDays,
  billableUnits,
  buildCapacity,
  DEFAULT_TIMEZONE,
  getPacificDateStr,
  nightsBetween,
  rangeHasConflict,
  walkHasConflict,
  type CapacityEvent,
  type CapacityRequest,
  type PoolKind,
} from '../../src/shared/index.js';
import {
  listCapacityRows,
  countSlotBookings,
  listSlotBookingCounts,
  listUserBookingDatesInRange,
  type CapacityRow,
} from '../db/repo';
import type { Tenant, TenantService, TenantServiceOption } from '../types';

// Per-tenant availability built on the shared capacity engine. Each pool-drawing service carries
// its own nullable cap (MaxConcurrentPets / MaxPerDay; null = unlimited / auto pass-through).

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
  { available: true; estCost: number; nights?: number } | { available: false; reason: string };

/**
 * The estimated cost of a booking — the ONE place the price formula lives, so the availability
 * quote and the stored booking cost can't diverge. Range services bill per night; single-day
 * services (daycare/walk/check-in) are a flat per-booking rate. Pure (no DB), so callers that
 * already know the dates can price a booking without a capacity read.
 */
export function estimateCost(
  service: TenantService,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
): number {
  if (service.Shape !== 'range') return option.Rate;
  return option.Rate * billableUnits(nightsBetween(startDate, endDateExclusive), 'night');
}

async function checkRange(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
  petCount: number,
  excludeBookingId?: string,
): Promise<AvailabilityResult> {
  const request: CapacityRequest = {
    serviceType: service.ServiceType,
    kind: service.CapacityKind === 'housesit' ? 'housesit' : 'boarding',
    cap: service.CapacityKind === 'housesit' ? service.MaxPerDay : service.MaxConcurrentPets,
    petCount,
  };
  // The engine (rangeHasConflict) already rejects an over-cap boarding request on its own. This
  // fast path is kept purely for UX + cost: it returns a SPECIFIC "exceeds capacity" reason (vs the
  // generic "dates not available") and short-circuits before the capacity DB read. Unlimited skips it.
  if (request.kind === 'boarding' && request.cap !== null && petCount > request.cap) {
    return { available: false, reason: 'That exceeds our boarding capacity.' };
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
  return {
    available: true,
    estCost: estimateCost(service, option, startDate, endDateExclusive),
    nights: nightsBetween(startDate, endDateExclusive),
  };
}

async function checkSingle(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  option: TenantServiceOption,
  date: string,
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
  return { available: true, estCost: estimateCost(service, option, date, date) };
}

export function checkAvailability(
  env: Env,
  tenant: Tenant,
  service: TenantService,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
  petCount = 1,
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
        petCount,
        excludeBookingId,
      )
    : checkSingle(env, tenant, service, option, startDate, excludeBookingId);
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
      max = poolKind === 'boarding' ? service.MaxConcurrentPets : service.MaxPerDay;
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
