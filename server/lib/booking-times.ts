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
import type { TenantService, TenantServiceOption } from '../types';

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
