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
  type CapacityLimits,
} from '../../src/shared/index.js';
import { getProviderConnection, listCapacityRows } from '../db/repo';
import { getCalendarAccessToken } from './calendar-sync';
import { categorizeCalendarEvent, listCalendarEvents } from './google-calendar';
import { SERVICE_CATALOG, type ServiceType } from '../lib/services';
import type { BookingRow, Tenant, TenantServiceOption } from '../types';

/**
 * Per-tenant availability built on the shared capacity engine. The tenant's nullable config
 * columns map straight onto CapacityLimits (null = unlimited / auto pass-through).
 */
function tenantLimits(tenant: Tenant): CapacityLimits {
  return {
    maxBoardingPets: tenant.MaxBoardingPets,
    maxHouseSitsPerDay: tenant.MaxHouseSitsPerDay,
  };
}

export function rowsToCapacityEvents(rows: BookingRow[]): CapacityEvent[] {
  return rows.map((row) => ({
    start_date: row.StartDate,
    end_date: row.EndDate ?? undefined,
    type:
      row.ServiceType === 'blocked'
        ? 'blocked'
        : row.ServiceType === 'housesitting'
          ? 'house-sit'
          : 'boarding',
    petCount: row.PetCount,
  }));
}

export type AvailabilityResult =
  | { available: true; estCost: number; nights?: number }
  | { available: false; reason: string };

/**
 * The estimated cost of a booking — the ONE place the price formula lives, so the availability
 * quote and the stored booking cost can't diverge. Range services bill per night; single-day
 * services (daycare/walk/check-in) are a flat per-booking rate. Pure (no DB), so callers that
 * already know the dates can price a booking without a capacity read.
 */
export function estimateCost(
  serviceType: ServiceType,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
): number {
  if (SERVICE_CATALOG[serviceType].shape !== 'range') return option.Rate;
  return option.Rate * billableUnits(nightsBetween(startDate, endDateExclusive), 'night');
}

function serviceTypeToCapacityType(t: string): 'boarding' | 'house-sit' {
  return t === 'housesitting' ? 'house-sit' : 'boarding';
}

async function checkRange(
  env: Env,
  tenant: Tenant,
  serviceType: ServiceType,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
  petCount: number,
  excludeBookingId?: string,
): Promise<AvailabilityResult> {
  const requestType = serviceTypeToCapacityType(serviceType);
  const limits = tenantLimits(tenant);
  // The engine (rangeHasConflict) already rejects an over-cap boarding request on its own. This
  // fast path is kept purely for UX + cost: it returns a SPECIFIC "exceeds capacity" reason (vs the
  // generic "dates not available") and short-circuits before the capacity DB read. Unlimited skips it.
  if (
    requestType === 'boarding' &&
    tenant.MaxBoardingPets !== null &&
    petCount > tenant.MaxBoardingPets
  ) {
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
  if (rangeHasConflict(startDate, endDateExclusive, requestType, capacity, limits, petCount)) {
    return { available: false, reason: 'Those dates are not available.' };
  }
  return {
    available: true,
    estCost: estimateCost(serviceType, option, startDate, endDateExclusive),
    nights: nightsBetween(startDate, endDateExclusive),
  };
}

async function checkSingle(
  env: Env,
  tenant: Tenant,
  serviceType: ServiceType,
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
  return { available: true, estCost: estimateCost(serviceType, option, date, date) };
}

export function checkAvailability(
  env: Env,
  tenant: Tenant,
  serviceType: ServiceType,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
  petCount = 1,
  excludeBookingId?: string,
): Promise<AvailabilityResult> {
  return SERVICE_CATALOG[serviceType].shape === 'range'
    ? checkRange(
        env,
        tenant,
        serviceType,
        option,
        startDate,
        endDateExclusive,
        petCount,
        excludeBookingId,
      )
    : checkSingle(env, tenant, serviceType, option, startDate, excludeBookingId);
}

export type MonthDay = {
  date: string;
  status: 'available' | 'partial' | 'unavailable';
  used: number | null;
  max: number | null;
  mine: boolean;
};

/**
 * Per-day availability for a calendar month, sourced exclusively from the tenant's Google Calendar.
 * Boarding/Unavailable events are categorized via extendedProperties metadata and summary parsing,
 * then fed through the shared capacity engine to produce each day's status.
 */
export async function monthAvailability(
  env: Env,
  tenant: Tenant,
  serviceType: ServiceType,
  month: string, // YYYY-MM
  callerEmail: string,
): Promise<{ today: string; days: MonthDay[] }> {
  const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);

  const monthStart = `${month}-01`;
  // new Date(year, month, 0) — month is 1-based here, day 0 = last day of prior month = last day of `month`
  const [yearStr, monStr] = month.split('-');
  const daysInMonth = new Date(Number(yearStr), Number(monStr), 0).getDate();
  const lastDay = addDays(monthStart, daysInMonth - 1);
  const monthEndExclusive = addDays(lastDay, 1);
  const timeMin = `${addDays(monthStart, -1)}T00:00:00Z`;
  const timeMax = `${addDays(monthEndExclusive, 1)}T00:00:00Z`;

  const conn = await getProviderConnection(env.PAWBOOK_DB, tenant.Id, 'calendar');

  const capacityEvents: CapacityEvent[] = [];
  const mineDays = new Set<string>();

  try {
    if (conn && conn.Status === 'connected' && conn.AccessToken && conn.RefreshToken) {
      const accessToken = await getCalendarAccessToken(env, tenant, conn);
      const events = await listCalendarEvents(
        accessToken,
        conn.CalendarId ?? 'primary',
        timeMin,
        timeMax,
      );

      for (const ev of events) {
        const result = categorizeCalendarEvent(ev);
        if (result.kind === 'booking') {
          const { category, petCount, email } = result;
          if (category === 'boarding') {
            capacityEvents.push({
              start_date: ev.start,
              end_date: ev.end,
              type: 'boarding',
              petCount,
            });
          } else if (category === 'housesitting') {
            capacityEvents.push({ start_date: ev.start, end_date: ev.end, type: 'house-sit' });
          }
          // walk/daycare/checkin: no capacity event
          if (email === callerEmail) {
            for (let d = ev.start; d < ev.end; d = addDays(d, 1)) {
              mineDays.add(d);
            }
          }
        } else if (result.kind === 'block') {
          capacityEvents.push({ start_date: ev.start, end_date: ev.end, type: 'blocked' });
        }
        // kind === 'ignore': skip
      }
    }
  } catch {
    // Calendar read failed (e.g. Google 5xx, token refresh error). Fail open: treat as if
    // no calendar is connected so the widget stays usable. All days will appear available.
  }

  const cap = buildCapacity(capacityEvents);
  const requestType: 'boarding' | 'house-sit' | null =
    serviceType === 'housesitting' || serviceType === 'boarding'
      ? serviceTypeToCapacityType(serviceType)
      : null;

  const days: MonthDay[] = [];
  for (let i = 0; i < daysInMonth; i++) {
    const date = addDays(monthStart, i);
    const day = cap.get(date);

    let status: 'available' | 'partial' | 'unavailable';
    let used: number | null;
    let max: number | null;

    if (requestType !== null) {
      // Range service (boarding / housesitting): capacity-aware
      const rawUsed = requestType === 'boarding' ? (day?.boarding ?? 0) : (day?.houseSits ?? 0);
      max = requestType === 'boarding' ? tenant.MaxBoardingPets : tenant.MaxHouseSitsPerDay;
      const blocked = (day?.blocked ?? 0) >= 1;
      const unavailable = blocked || (max != null && rawUsed >= max);
      status = unavailable ? 'unavailable' : max != null && rawUsed > 0 ? 'partial' : 'available';
      used = max != null ? rawUsed : null;
    } else {
      // Single-day unlimited service (walk / daycare / check-in): block-only
      status = walkHasConflict(date, cap) ? 'unavailable' : 'available';
      used = null;
      max = null;
    }

    days.push({ date, status, used, max, mine: mineDays.has(date) });
  }

  return { today, days };
}
