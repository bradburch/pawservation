import type { RequestType } from '../types/booking.js';
import type { EffectivePrice, PetGroupPricingRow } from './types.js';

/**
 * The timed services priced by DURATION. A walk or check-in of a given length is
 * its OWN rate — a 2-hour walk does not extend or prorate to a 1-hour walk. Sits
 * (boarding/house-sit) are not duration-keyed (they price per night/day), so their
 * composite key carries no duration component.
 */
const TIMED_SERVICES = new Set<RequestType>(['walk', 'check-in']);

/** The default visit length (minutes) for a timed service when none is otherwise known. */
export const DEFAULT_VISIT_DURATION_MINUTES = 60;

/** True for services whose rate is keyed by (pets, type, TIME) rather than per night/day. */
export function isTimedService(bookingType: string): boolean {
  return TIMED_SERVICES.has(bookingType as RequestType);
}

/**
 * Build the canonical group key for a set of pets: de-duplicate, sort, and
 * comma-join the member PetIds. A single pet is a one-element key; the key is
 * order-independent so any permutation of the same pet set maps to the same
 * entry. Empty set → empty string.
 *
 * This is the order-INSENSITIVE base of the composite pricing key: the pet set
 * "Pedro and Remy" and "Remy and Pedro" (same PetIds, any order) collapse to one
 * key. Name casing never reaches here — callers resolve names to canonical PetIds
 * first — so "coco and Gigi" and "Gigi and coco" map to the same key as long as
 * they resolve to the same IDs. See {@link pricingCompositeKey} for the full
 * (pets, type, time) key used by the DB rows.
 */
export function petGroupKey(petIds: string[]): string {
  return [...new Set(petIds)].sort().join(',');
}

/**
 * Build the SINGLE composite pricing key for a (pet COMBINATION, booking type,
 * duration) entry — the one source of truth shared by the write path (sync +
 * backfill), the read path, and the booking cost stamp, used identically by walks
 * and check-ins.
 *
 * The pet-set portion is always {@link petGroupKey} (order-insensitive, de-duped).
 * For a TIMED service (walk/check-in) the requested visit duration is appended so a
 * 2-hour walk and a 1-hour walk are DISTINCT entries — never scaled or reused. For a
 * sit (boarding/house-sit) the duration is ignored and the key is just the pet-set
 * key, so the existing `(GroupKey, BookingType)` rows are unchanged (additive).
 */
export function pricingCompositeKey(
  petIds: string[],
  bookingType: string,
  durationMinutes: number | null | undefined,
): string {
  const base = petGroupKey(petIds);
  if (isTimedService(bookingType) && durationMinutes != null) {
    return `${base}|${durationMinutes}`;
  }
  return base;
}

/**
 * Resolve the per-unit price for an exact pet COMBINATION, booking type, and (for
 * timed services) requested duration.
 *
 * Computes the composite key for the requested pet set + duration and looks up the
 * SINGLE matching {@link PetGroupPricingRow}. If found, returns its `{ cost, costUnit }`;
 * otherwise falls back to the provided default — there is NO summation, proration, or
 * nearest-duration math. A 2-hour walk only matches a stored 2-hour walk entry.
 */
export function getCombinedSetPrice(
  rows: PetGroupPricingRow[],
  bookingType: string,
  petIds: string[],
  defaultCost: number,
  defaultCostUnit: string,
  durationMinutes?: number | null,
): EffectivePrice {
  const match = findCombinedSetRow(rows, bookingType, petIds, durationMinutes);
  if (!match) {
    return { cost: defaultCost, costUnit: defaultCostUnit };
  }
  return { cost: match.cost, costUnit: match.costUnit ?? defaultCostUnit };
}

/**
 * The SINGLE {@link PetGroupPricingRow} for an exact pet combination, booking type, and (for
 * timed services) duration — or `undefined` when the owner has no saved entry for that set.
 * Single source of the match rule shared by {@link getCombinedSetPrice} and the quote layer
 * (so the quote can tell a real combined-set price apart from a default-rate fallback).
 */
export function findCombinedSetRow(
  rows: PetGroupPricingRow[],
  bookingType: string,
  petIds: string[],
  durationMinutes?: number | null,
): PetGroupPricingRow | undefined {
  const key = pricingCompositeKey(petIds, bookingType, durationMinutes);
  return rows.find((r) => r.bookingType === bookingType && r.groupKey === key);
}
