/**
 * HOUSEHOLD BALANCES: what a household owes, rather than what each booking owes.
 *
 * `buildAccounts` already answers "who bills together" — the connected component of the
 * owner<->pet graph, which is why two customers who share a single pet get one statement and one
 * invoice number. This module answers the money question over exactly those components:
 *
 *     balance = Σ(booking costs + charges) − Σ(payments), across every booking of the household
 *
 * and it needs **no schema change at all**. Payments are per-booking today; a household is a set of
 * bookings; so the rollup is a sum the database can already answer. (Recording ONE payment against
 * a household rather than against a booking is a separate, later change — this module is what makes
 * that change a matter of adding a term to a sum rather than reinterpreting one.)
 *
 * Pure and dependency-free (src/shared/ rules), and — like `buildAccounts` — deliberately ignorant
 * of three things its callers own:
 *
 *  - **What a booking is WORTH.** `expected` arrives already computed by the one server-side rule
 *    that owns it (`CREDITABLE_AMOUNT_SQL` in `server/db/repo.ts`: the quote or the assessed
 *    cancellation fee, plus extra charges, and zero for a request that was declined). Restating that
 *    arithmetic here would be a second money rule, which is the drift this codebase exists to avoid.
 *  - **Deceased pets.** The caller filters them out of `links`, exactly as `buildAccounts` requires.
 *  - **Names.** Ids in, ids out; the display layer joins them to people.
 *
 * NETTING, and the one place it is legitimate. Within a household, a credit on one booking cancels a
 * debt on another — that IS the household statement, the thing the sitter is asking for when she
 * asks "does Jennifer owe me anything?". ACROSS households nothing is ever netted: one client owing
 * $100 while another is owed $100 is not a settled book, so the two appear as two rows here and the
 * earnings tiles keep reporting `outstandingTotal` and `creditTotal` separately (see
 * `serializeAnalytics`). This module returns per-household figures only and computes no grand total,
 * so there is nothing here for a caller to net by accident.
 */
import { buildAccounts, type OwnerPetLink } from './accounts.js';

/**
 * One booking's money, already reduced to two numbers by the caller. `ownerId` is the customer the
 * booking was made by (NULL on older widget bookings that never carried one); `petIds` are the pets
 * on it. Both are attachment evidence — see `buildHouseholdBalances` for which wins.
 */
export type HouseholdBooking = {
  bookingId: string;
  ownerId: string | null;
  petIds: string[];
  /** What this booking totals to owing: quote-or-fee plus extra charges. Never negative. */
  expected: number;
  /** What has been received against it. */
  paid: number;
};

/** One household's statement. `balance` negative means the household is IN CREDIT. */
export type HouseholdBalance = {
  /** The account id `buildAccounts` produced: the lexicographically-first pet in the component. */
  accountId: string;
  ownerIds: string[];
  petIds: string[];
  /** Every booking rolled into this balance, in the order the caller supplied them. */
  bookingIds: string[];
  expectedTotal: number;
  paidTotal: number;
  balance: number;
};

export type HouseholdBalances = {
  households: HouseholdBalance[];
  /**
   * Bookings that matched NO household — a customer whose every pet has died (they hold no edge at
   * all, so `buildAccounts` never places them) or a booking carrying neither a customer nor a pet.
   * Reported rather than swallowed: their money is real, it is still visible booking-by-booking on
   * the Earnings page, and a silent drop here would make the household rollup quietly disagree with
   * that page for reasons nobody could see.
   */
  unattachedBookingIds: string[];
};

export function buildHouseholdBalances(input: {
  links: OwnerPetLink[];
  bookings: HouseholdBooking[];
}): HouseholdBalances {
  const accounts = buildAccounts(input.links);

  // Both indexes point at an account id, so attaching a booking is two map lookups rather than a
  // scan per booking. `buildAccounts` returns components, so neither key can appear twice.
  const accountByOwner = new Map<string, string>();
  const accountByPet = new Map<string, string>();
  for (const account of accounts) {
    for (const ownerId of account.ownerIds) accountByOwner.set(ownerId, account.id);
    for (const petId of account.petIds) accountByPet.set(petId, account.id);
  }

  const totals = new Map<string, { bookingIds: string[]; expected: number; paid: number }>();
  const unattachedBookingIds: string[] = [];

  for (const booking of input.bookings) {
    /**
     * EXACTLY ONE household per booking, or a sum double-counts it. The customer who made the
     * booking wins, because that is whose name is on it; pets are the fallback for a booking that
     * never carried a customer. A booking whose pets span two households (possible only through a
     * pet the households do not share) resolves to the lexicographically-first of them — an
     * arbitrary rule chosen only so it is a STABLE one: the alternative, adding the booking to
     * both, bills its cost twice.
     */
    const petAccounts = booking.petIds
      .map((petId) => accountByPet.get(petId))
      .filter((id): id is string => id !== undefined)
      .sort();
    const accountId =
      (booking.ownerId === null ? undefined : accountByOwner.get(booking.ownerId)) ??
      petAccounts[0];
    if (accountId === undefined) {
      unattachedBookingIds.push(booking.bookingId);
      continue;
    }
    const total = totals.get(accountId) ?? { bookingIds: [], expected: 0, paid: 0 };
    total.bookingIds.push(booking.bookingId);
    total.expected += booking.expected;
    total.paid += booking.paid;
    totals.set(accountId, total);
  }

  // Ordered by account id (which `buildAccounts` already sorted) so identical inputs always produce
  // byte-identical output, however the rows arrived. Households with no bookings are dropped: they
  // carry no money, and a statement for a client who has never booked is noise on the page.
  const households = accounts
    .filter((account) => totals.has(account.id))
    .map((account) => {
      const total = totals.get(account.id)!;
      return {
        accountId: account.id,
        ownerIds: account.ownerIds,
        petIds: account.petIds,
        bookingIds: total.bookingIds,
        expectedTotal: total.expected,
        paidTotal: total.paid,
        balance: total.expected - total.paid,
      };
    });

  return { households, unattachedBookingIds };
}
