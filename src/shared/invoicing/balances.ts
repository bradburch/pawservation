/**
 * HOUSEHOLD BALANCES: what a household owes, rather than what each booking owes.
 *
 * `buildAccounts` already answers "who bills together" — the connected component of the
 * owner<->pet graph, which is why two customers who share a single pet get one statement and one
 * invoice number. This module answers the money question over exactly those components:
 *
 *     balance = Σ(booking costs + charges) − Σ(payments), across every booking of the household
 *
 * The per-booking form of that sum needed **no schema change at all**: payments were per-booking
 * rows, a household is a set of bookings, so the rollup was a sum over data that already existed.
 * `Payments.AccountId` (0011) then added the second term — one payment recorded against the
 * HOUSEHOLD, covering however many bookings, because that is how clients actually pay — and it is
 * exactly that: a term added to a sum, not a reinterpretation of one.
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
import { buildAccounts, type Account, type OwnerPetLink } from './accounts.js';

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

/**
 * One payment recorded against a HOUSEHOLD rather than a booking (`Payments.AccountId`, 0011).
 *
 * `accountId` is an account id, which is a PET id — and it is matched by MEMBERSHIP ("the household
 * whose pets contain this id"), never by equality against the household's own id. The account id is
 * the lexicographically-first pet of its component, so adding a pet that sorts earlier RENAMES the
 * household; resolving by membership means a payment recorded before that rename still lands on the
 * same household afterwards.
 */
export type HouseholdPayment = { accountId: string; amount: number };

/**
 * PAYMENT ANCHORS — which household a payment filed under a pet that is no longer in the account
 * graph belongs to. The only pets that reach here are DECEASED ones: the caller drops them from
 * `links` because a dead pet cannot be booked or quoted, which is a statement about BOOKINGS and
 * was never a statement about money. A payment does not stop having been received when one of the
 * household's pets dies.
 *
 * Resolution runs through the pet's OWNERS, over these very components: a deceased pet keeps its
 * owner edges, those owners are still customers, and their household is still `buildAccounts`'s
 * own answer. That is a READ of the existing graph, not an inference about where money should go —
 * which is exactly why it resolves NOTHING in the two cases where it would become one:
 *
 *  - the anchor's owners hold no live pet between them, so there is no household to resolve to;
 *  - the anchor's owners now sit in two different households (the edge that joined them was the
 *    dead pet itself), so "which one" has no answer the data can give.
 *
 * Both leave the payment unresolved, and `buildHouseholdBalances` then reports it in
 * `unattachedPaymentAccountIds`: visible, and attached to nobody.
 */
export function buildPaymentAnchors(
  accounts: Account[],
  anchorLinks: OwnerPetLink[],
): Map<string, string> {
  const accountByOwner = new Map<string, string>();
  const componentPets = new Set<string>();
  for (const account of accounts) {
    for (const ownerId of account.ownerIds) accountByOwner.set(ownerId, account.id);
    for (const petId of account.petIds) componentPets.add(petId);
  }

  // petId -> the distinct households its owners belong to. Exactly one of them ⇒ resolved.
  const candidates = new Map<string, Set<string>>();
  for (const link of anchorLinks) {
    if (componentPets.has(link.petId)) continue; // already a member; it needs no anchor
    const accountId = accountByOwner.get(link.ownerId);
    const found = candidates.get(link.petId) ?? new Set<string>();
    if (accountId !== undefined) found.add(accountId);
    candidates.set(link.petId, found);
  }

  const anchors = new Map<string, string>();
  for (const [petId, accountIds] of candidates) {
    if (accountIds.size === 1) anchors.set(petId, [...accountIds][0]!);
  }
  return anchors;
}

/** One household's statement. `balance` negative means the household is IN CREDIT. */
export type HouseholdBalance = {
  /** The account id `buildAccounts` produced: the lexicographically-first pet in the component. */
  accountId: string;
  ownerIds: string[];
  petIds: string[];
  /**
   * Pets that are NOT in the component (they have died) but under whose ids a payment still
   * resolves here, by `buildPaymentAnchors`. Deliberately separate from `petIds`: these pets are
   * not part of the account, they are only ids a payment may legitimately have been filed under.
   * A reader resolving a payment — or an account id from before the death — must consider both
   * lists; a reader asking "which pets does this household have?" wants `petIds` alone.
   */
  anchorPetIds: string[];
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
  /**
   * Account ids on household payments that resolve to no household AT ALL — not by membership, and
   * not through `anchorLinks` either, which means the pet the payment was filed under has been
   * REMOVED (a `deleteCustomer` cascade takes its owner edges with it) or its owners have since
   * scattered across households. A pet that merely died is NOT here: it still anchors its payment.
   *
   * Reported for the same reason as `unattachedBookingIds`, and more urgently: the money was
   * received, it still counts as revenue, and the caller must show it somewhere. Attaching it to a
   * household that might not be its own is the one outcome worse than saying so out loud.
   */
  unattachedPaymentAccountIds: string[];
};

export function buildHouseholdBalances(input: {
  links: OwnerPetLink[];
  /**
   * Owner<->pet edges for pets that are NOT in `links` because they have died. Used only to
   * resolve payments filed under them (`buildPaymentAnchors`) — never to form an account, never to
   * name one, and never to add a pet to a household. Omitted ⇒ a payment whose anchor pet has died
   * resolves to nothing and is reported unattached, which is what this module did before anchors
   * existed.
   */
  anchorLinks?: OwnerPetLink[];
  bookings: HouseholdBooking[];
  payments?: HouseholdPayment[];
}): HouseholdBalances {
  const accounts = buildAccounts(input.links);
  const anchors = buildPaymentAnchors(accounts, input.anchorLinks ?? []);

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

  /**
   * Household payments: ONE row, however many bookings it covers, added to the household's paid
   * total once. Nothing about it touches any booking — which is the point. The sitter records what
   * her client actually did (paid $400 in July) rather than a split across eight stays that she
   * invented, that nobody agreed to, and that an edit to any one of those stays would falsify.
   */
  const unattachedPaymentAccountIds: string[] = [];
  for (const payment of input.payments ?? []) {
    // Membership first — the ordinary case. Then the anchor index, which covers the pet that has
    // DIED since the payment was filed under it: same household, read through the owners the dead
    // pet still holds edges to. Only when neither answers is the payment genuinely homeless.
    const accountId = accountByPet.get(payment.accountId) ?? anchors.get(payment.accountId);
    if (accountId === undefined) {
      unattachedPaymentAccountIds.push(payment.accountId);
      continue;
    }
    const total = totals.get(accountId) ?? { bookingIds: [], expected: 0, paid: 0 };
    total.paid += payment.amount;
    totals.set(accountId, total);
  }

  // Ordered by account id (which `buildAccounts` already sorted) so identical inputs always produce
  // byte-identical output, however the rows arrived. A household with no activity at all is dropped
  // — a statement for a client who has never booked and never paid is noise on the page — but one
  // that has only PREPAID is kept, in credit: paying before the booking exists is a thing clients
  // do, and the timing of a payment carries no meaning in this arithmetic.
  const households = accounts
    .filter((account) => totals.has(account.id))
    .map((account) => {
      const total = totals.get(account.id)!;
      return {
        accountId: account.id,
        ownerIds: account.ownerIds,
        petIds: account.petIds,
        anchorPetIds: [...anchors.entries()]
          .filter(([, id]) => id === account.id)
          .map(([petId]) => petId)
          .sort(),
        bookingIds: total.bookingIds,
        expectedTotal: total.expected,
        paidTotal: total.paid,
        balance: total.expected - total.paid,
      };
    });

  return { households, unattachedBookingIds, unattachedPaymentAccountIds };
}
