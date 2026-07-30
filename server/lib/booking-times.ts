/**
 * A booking's TIMES: who is allowed to set them, and (as of 0009) what one outside the sitter's
 * standard hours costs. Server-only — the resolution reads a `TenantService` row, and the surcharge
 * is MONEY, which the client never computes.
 *
 * ── Who owns the clock ─────────────────────────────────────────────────────────────────────────
 *
 * `TenantServices.HasDuration` is the discriminator, not `Shape`:
 *
 * - **`HasDuration = 1`** (walks, check-ins): the OPTION owns the clock. Its `StartTime` /
 *   `DurationMinutes` *are* the appointment, so a client-supplied arrival or departure there is a
 *   bug rather than a preference, and both are refused. That is the pre-existing rule, unchanged —
 *   `arrival-time.test.ts` pins it.
 * - **`HasDuration = 0`** (boarding, house sitting, DAYCARE): nobody else owns the clock, so the
 *   owner may set an arrival and/or a departure. Daycare joining that list is the behaviour change
 *   in 0008: it is a whole day with no fixed appointment, so "the option owns the clock" was never
 *   true of it — it simply had no time at all.
 *
 * Times are owner-set FREELY, not bounded by a sitter-configured window, and that is deliberate. A
 * hard window would be a new reason to REFUSE a request, and every hard availability rule in this
 * codebase has to be enforced in three agreeing places (the quote, the month grid, the booking
 * POST). A month grid has no time axis, so a window could only ever be enforced in two of them —
 * the grid would paint a day open that the POST then refused. The extra-time surcharge (0009) is
 * the soft answer to the same need: it never refuses, it discloses a price. The one ordering rule
 * that IS a refusal is a self-consistency check between two fields of one form (a departure must
 * be after its own arrival); it can never make an otherwise-bookable day unbookable, because the
 * customer fixes it by changing their own input.
 *
 * ── Ordering ──────────────────────────────────────────────────────────────────────────────────
 *
 * On a RANGE stay the departure is on the END date. `departureTime <= startTime` is therefore
 * legal and common, and comparing them would refuse "drop off Friday 17:00, collect Monday 08:00".
 * On a SINGLE-DAY booking both times sit on `StartDate`, so the departure must be strictly later.
 * That asymmetry is the single easiest thing in this feature to get wrong; it lives here, once.
 */
import { isValidTimeString } from './validation';
import type { ExtraTimeOrigin, TenantService, TenantServiceOption } from '../types';

/**
 * A whole-dollar surcharge a booking's times attract, carrying the `BookingCharges.Origin`
 * provenance tag that lets an EDIT re-derive exactly these rows and leave a charge the sitter typed
 * herself alone. The origin domain lives in `server/types.ts` beside the column it is stored in.
 */
export type ExtraTimeCharge = { label: string; amount: number; origin: ExtraTimeOrigin };

export type ResolvedTimes = { startTime: string | null; departureTime: string | null };
export type TimesError = { error: string; code: string; status: 400 };

/**
 * The times to STAMP on a booking, or the refusal. One function for the create path, the edit path
 * and the quote, so a rule cannot be enforced by two of them and forgotten by the third.
 *
 * `rawStartTime`/`rawDepartureTime` are the untrusted wire values (`null` = not supplied). The
 * returned `startTime` falls back to the option's own clock for a duration-priced service, exactly
 * as it always has, which is what keeps the stamped value and the calendar push reading one source.
 */
export function resolveBookingTimes(
  service: TenantService,
  option: TenantServiceOption,
  rawStartTime: string | null,
  rawDepartureTime: string | null,
): ResolvedTimes | TimesError {
  // The option is the appointment: its slot time is not the customer's to move, and there is no
  // second edge of it for them to name either.
  const ownerMaySetTimes = service.HasDuration === 0;

  if (rawStartTime !== null) {
    if (!ownerMaySetTimes)
      return {
        error: 'An arrival time is set by the option you picked, not by you.',
        code: 'invalid_start_time',
        status: 400,
      };
    if (!isValidTimeString(rawStartTime))
      return {
        error: 'Arrival time must look like 14:30 (24-hour HH:MM).',
        code: 'invalid_start_time',
        status: 400,
      };
  }
  if (rawDepartureTime !== null) {
    if (!ownerMaySetTimes)
      return {
        error: 'A departure time is set by the option you picked, not by you.',
        code: 'invalid_departure_time',
        status: 400,
      };
    if (!isValidTimeString(rawDepartureTime))
      return {
        error: 'Departure time must look like 08:30 (24-hour HH:MM).',
        code: 'invalid_departure_time',
        status: 400,
      };
  }

  const startTime = ownerMaySetTimes ? rawStartTime : option.StartTime;
  const departureTime = ownerMaySetTimes ? rawDepartureTime : null;

  // ORDERING — single-day only. See the module docblock: on a range stay the departure is on the
  // END date and may be earlier in the day than the arrival.
  if (
    service.Shape !== 'range' &&
    startTime !== null &&
    departureTime !== null &&
    departureTime <= startTime
  ) {
    return {
      error: 'Pick-up has to be later in the day than drop-off.',
      code: 'invalid_departure_time',
      status: 400,
    };
  }

  return { startTime, departureTime };
}

/** Narrow `resolveBookingTimes`' union. */
export function isTimesError(value: ResolvedTimes | TimesError): value is TimesError {
  return 'error' in value;
}

/**
 * WHAT THE BOOKING'S TIMES COST — the ONE computation of the extra-time surcharge, called by the
 * quote (which previews it) and by the create/edit paths (which stamp it as `BookingCharges` rows).
 * Modelled on `feeToCancelToday`: the number a customer is shown and the number the server writes
 * come from the same function, so they cannot drift.
 *
 * ── Why this is a CHARGE and not part of `estimateCost` ────────────────────────────────────────
 *
 * `estimateCost`'s docblock says the only arithmetic permitted there is units of time × a stored
 * rate (× the distinct pet count under `PetRateMode = 'linear'`), and that nothing may be
 * "multiplied, scaled, or **surcharged**". This is a surcharge, so it stays out — and not merely
 * out of deference: inside `estimateCost` the `'linear'` pet multiplier is applied to the composed
 * total, so a $20 early arrival would silently become $60 for three dogs. A per-pet fee nobody
 * typed is precisely the no-inferred-pricing defect that invariant exists to prevent, and the only
 * way to place this inside `estimateCost` would be to carve an exception out of the one clean
 * multiplication. As a `BookingCharges` row it costs nothing instead: `EstCost` keeps meaning "the
 * price of the stay", and `totalDue = EstCost + chargesTotal` picks the fee up at every read site
 * already derived that way.
 *
 * ── FLAT, and PER STAY ────────────────────────────────────────────────────────────────────────
 *
 * Two stored whole-dollar amounts the sitter typed, each charged at most once. NOT per hour: an
 * hourly fee needs a duration and a rounding rule, and a rounding rule is a price the sitter did
 * not type. NOT per day either: a stay has exactly ONE arrival and ONE departure, so billing a
 * multi-day stay per day for a single early drop-off invents an event that never happened. The
 * result is that the whole feature performs no multiplication at all — it sums stored amounts.
 *
 * NULL anywhere switches it off, the `HolidayRate` convention: the fee applies only when the sitter
 * stored BOTH a standard time and its fee, AND the owner actually named a time outside it. Times
 * are 'HH:MM' zero-padded, so a string compare IS a clock compare.
 */
export function extraTimeSurcharges(
  service: TenantService,
  times: ResolvedTimes,
): ExtraTimeCharge[] {
  const charges: ExtraTimeCharge[] = [];
  const { StandardArrivalTime, StandardDepartureTime, EarlyArrivalFee, LateDepartureFee } = service;
  if (
    StandardArrivalTime !== null &&
    EarlyArrivalFee !== null &&
    times.startTime !== null &&
    times.startTime < StandardArrivalTime
  ) {
    charges.push({
      label: `Early arrival (${times.startTime})`,
      amount: EarlyArrivalFee,
      origin: 'extra_time_early',
    });
  }
  if (
    StandardDepartureTime !== null &&
    LateDepartureFee !== null &&
    times.departureTime !== null &&
    times.departureTime > StandardDepartureTime
  ) {
    charges.push({
      label: `Late departure (${times.departureTime})`,
      amount: LateDepartureFee,
      origin: 'extra_time_late',
    });
  }
  return charges;
}
