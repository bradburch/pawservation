export type BookingType = 'boarding' | 'house-sit' | 'walk' | 'check-in' | 'blocked';
export type RequestType = 'boarding' | 'house-sit' | 'walk' | 'check-in';

/**
 * Whether a request type is a timed visit (single-date, timed calendar event) rather than a
 * date-range sit. The single predicate for "this booking type is a walk/check-in", shared by
 * the web client calendar UX, the server tool-execution paths, and the booking service — so
 * the same classification rule never gets re-implemented inline. Distinct from
 * `isTimedVisit(type, hasStartDatetime)` in cancellation-policy, which is the 2-arg
 * fee-classification predicate (it also treats any start-time-bearing event as timed).
 */
export function isTimedVisitType(requestType: RequestType): requestType is 'walk' | 'check-in' {
  return requestType === 'walk' || requestType === 'check-in';
}

export interface OtherCharge {
  key: string;
  value: number;
}
