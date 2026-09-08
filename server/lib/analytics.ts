import type { AnalyticsData } from '../types';

/**
 * Shapes a raw `getAnalytics` result into the JSON payload the admin analytics dashboard (and
 * the owner sitter-detail view) render. Pure — no I/O. Extracted from the inline mapping that
 * used to live in the `/:slug/admin/analytics` route handler so both routes stay in lockstep.
 *
 * NO FIGURE ON THIS PAYLOAD CHANGES UNIT ANY MORE. `AnalyticsData` is cents throughout (0015) and
 * so is everything below, named `*Cents` on the wire (design spec §2) — the tiles, the monthly and
 * quarterly series, by-service and top-clients, the outstanding and credit lists, the household
 * rows and the orphaned-payment totals. The dollar-named fields are REMOVED rather than kept
 * beside their cents twins, so a reader that still means dollars is a type error rather than a
 * 100x-wrong number on a page.
 *
 * Every arithmetic expression here — `EstCost + ChargesTotal - PaidTotal`, the credit, both tile
 * sums — is therefore single-unit integer arithmetic in cents, and there is no division left to
 * lose a half-dollar to. That is the point: a client who pays $45.50 reaches this page intact.
 */
export function serializeAnalytics(data: AnalyticsData) {
  const outstanding = data.outstanding.map((o) => ({
    bookingId: o.BookingId,
    name: o.Name,
    email: o.Email,
    serviceType: o.ServiceType,
    startDate: o.StartDate,
    estCostCents: o.EstCost,
    chargesTotalCents: o.ChargesTotal,
    paidTotalCents: o.PaidTotal,
    // Total due is the stay price (or fee) PLUS extra charges; EstCost stays the quoted price.
    balanceCents: o.EstCost + o.ChargesTotal - o.PaidTotal,
    // The subquery's EstCost is aliased from CancellationFee on a cancelled row, so the UI
    // needs this flag to label the amount as a fee rather than a live booking balance. Status
    // alone is NOT enough: a fee-FREE cancellation can still be outstanding purely for its extra
    // charges (EstCost resolves to the stored 0), and labelling those $45 of extras a
    // "cancellation fee" tells the sitter she assessed a fee she waived. The flag means "the base
    // amount on this row IS a fee", so it needs the fee to actually be there.
    isCancellationFee: o.Status === 'cancelled' && o.EstCost > 0,
  }));
  /**
   * OVER-payments — money the customer no longer owes. The one place an edit's re-stamped `EstCost`
   * can leave a client in credit becomes visible: `creditCents` is `paidTotalCents - keepableCents`,
   * the same one-rule arithmetic the outstanding row's `balanceCents` uses, read in the other
   * direction. There is deliberately no *Record payment* affordance on these rows (see
   * `CREDIT_WHERE_SQL`): a credit is a negative balance, not a payable one — the *resolution*
   * affordances are `credit/keep` (the client agreed she keeps it) and correcting the payment
   * ledger (the money went back). See `keepBookingCredit`.
   */
  const credits = data.credits.map((c) => ({
    bookingId: c.BookingId,
    name: c.Name,
    email: c.Email,
    serviceType: c.ServiceType,
    startDate: c.StartDate,
    status: c.Status,
    keepableCents: c.Keepable,
    paidTotalCents: c.PaidTotal,
    creditCents: c.PaidTotal - c.Keepable,
    /**
     * Can this credit be closed by KEEPING it (`POST /credit/keep` logs it as a charge), or only by
     * refunding it? A `'declined'` request may keep nothing at all — `CREDITABLE_AMOUNT_SQL` is 0
     * for it by rule, so a charge cannot close its credit — and offering a button that does not work
     * is the mirror of the "balance whose *Record payment* 404s" defect the outstanding pairing
     * exists to prevent. Derived here from the SAME status rule the SQL applies, so the client never
     * restates it.
     */
    canKeep: c.Status !== 'declined',
  }));
  return {
    tiles: {
      thisMonthCents: data.monthly.at(-1)?.Total ?? 0,
      lastMonthCents: data.monthly.at(-2)?.Total ?? 0,
      // SUMMED FROM THE ROWS ABOVE, not re-derived from the raw columns. `balanceCents` and
      // `creditCents` are each stated once, in the mapping, and the tile is their total — so a
      // change to what a balance MEANS (an extra term, a clamp) cannot land on the list and miss
      // the figure printed above it. The two used to be independent copies of the same
      // expression, which is a disagreement waiting to be shipped.
      outstandingTotalCents: outstanding.reduce((sum, o) => sum + o.balanceCents, 0),
      outstandingCount: outstanding.length,
      // Never netted against `outstandingTotalCents`: one client owing $100 and another being owed
      // $100 is not a settled book, and showing $0 would say it was.
      creditTotalCents: credits.reduce((sum, c) => sum + c.creditCents, 0),
    },
    monthly: data.monthly.map((m) => ({ month: m.Month, totalCents: m.Total })),
    ytdCents: data.ytd,
    quarterly: data.quarterly.map((q) => ({ q: q.q, totalCents: q.total })),
    byService: data.byService.map((s) => ({
      serviceType: s.ServiceType,
      label: s.Label,
      totalCents: s.Total,
    })),
    topClients: data.topClients.map((t) => ({
      endUserId: t.EndUserId,
      name: t.Name,
      email: t.Email,
      totalCents: t.Total,
      bookings: t.Bookings,
    })),
    outstanding,
    credits,
    /**
     * HOUSEHOLD BALANCES, PASSED THROUGH WHOLE — the row `getHouseholdBalances` computed, over the
     * same `CREDITABLE_AMOUNT_SQL` the two lists above are built from, published unchanged. There
     * is deliberately nothing to map: a balance is money, money is server-side, and a client that
     * re-added the numbers could disagree with the page it is printed on.
     *
     * The tiles above are NOT rebuilt from these rows. `outstandingTotalCents` and
     * `creditTotalCents` stay per-booking and stay un-netted: netting a debt against a credit is
     * right WITHIN one household (that is what a statement is) and wrong across two, and the tiles
     * speak for the whole book.
     */
    households: data.households,
    /**
     * MONEY THAT BELONGS TO NO HOUSEHOLD — a household payment whose account-id pet was deleted
     * along with its owner edges (`deleteCustomer`), leaving nothing in the database able to say
     * which household it settled. Passed through beside the balances rather than folded into one
     * of them or quietly dropped: the revenue figures above already count this money, so
     * `Σ households.paidTotalCents + Σ orphanedPayments.totalCents` must equal it for the page to
     * be telling the truth — one unit on both sides, so the sum needs no conversion to be checked.
     * Naming an orphan out loud is the only honest option; guessing it a household is the one
     * thing worse than losing it.
     */
    orphanedPayments: data.orphanedPayments,
  };
}
