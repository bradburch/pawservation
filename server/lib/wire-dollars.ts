/**
 * THE WIRE IS STILL WHOLE DOLLARS. Storage moved to integer cents in migration 0015; the JSON,
 * CSV, email and calendar text every client already reads did not. These helpers are the seam
 * between the two, and they exist as one module rather than as a divide scattered through every
 * route so that the follow-up commit which makes the wire cents has exactly one place to delete.
 *
 * `centsToWholeDollars` THROWS on a figure that is not a whole number of dollars. That is
 * deliberate: in this commit every stored value is a multiple of 100 (the migration multiplied,
 * and every input is still a whole-dollar number), so a throw here is the loud failure of a
 * conversion missed somewhere upstream — never a number to round away.
 *
 * Only shapes serialized by MORE THAN ONE caller belong here. A one-off divide stays inline at
 * its own emit site, where the reader can see it.
 */
import { centsToWholeDollars } from '../../src/shared/index.js';
import type { HouseholdDetailRow } from '../types';

/**
 * One household's statement, cents → whole dollars, for the SITTER's drill-down
 * (`GET /:slug/admin/accounts/:accountId`) — now its only caller. The customer's own
 * "what do I owe?" (`GET /:slug/account`) used to share it; that surface's wire is cents and
 * says so, so `getMyAccount` renames the same row itself rather than dividing. When the sitter's
 * wire follows, this whole module goes with it.
 *
 * `accountId` stays widened to `string | null` — the generic parameter is what let the two
 * callers share one helper, and narrowing it now would be churn on a module about to be deleted.
 */
export function householdDetailToDollars<T extends { accountId: string | null }>(
  detail: T & Omit<HouseholdDetailRow, 'accountId'>,
): T & Omit<HouseholdDetailRow, 'accountId'> {
  return {
    ...detail,
    bookings: detail.bookings.map((b) => ({
      ...b,
      cost: centsToWholeDollars(b.cost),
      charges: b.charges.map((c) => ({ ...c, amount: centsToWholeDollars(c.amount) })),
      chargesTotal: centsToWholeDollars(b.chargesTotal),
      paidTotal: centsToWholeDollars(b.paidTotal),
      expected: centsToWholeDollars(b.expected),
    })),
    householdPayments: detail.householdPayments.map((p) => ({
      ...p,
      amount: centsToWholeDollars(p.amount),
    })),
    expectedTotal: centsToWholeDollars(detail.expectedTotal),
    paidTotal: centsToWholeDollars(detail.paidTotal),
    balance: centsToWholeDollars(detail.balance),
  };
}
