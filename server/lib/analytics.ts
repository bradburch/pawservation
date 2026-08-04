import type { AnalyticsData } from '../types';

/**
 * Shapes a raw `getAnalytics` result into the JSON payload the admin analytics dashboard (and
 * the owner sitter-detail view) render. Pure — no I/O. Extracted from the inline mapping that
 * used to live in the `/:slug/admin/analytics` route handler so both routes stay in lockstep.
 */
export function serializeAnalytics(data: AnalyticsData) {
  const outstanding = data.outstanding.map((o) => ({
    bookingId: o.BookingId,
    name: o.Name,
    email: o.Email,
    serviceType: o.ServiceType,
    startDate: o.StartDate,
    estCost: o.EstCost,
    chargesTotal: o.ChargesTotal,
    paidTotal: o.PaidTotal,
    // Total due is the stay price (or fee) PLUS extra charges; EstCost stays the quoted price.
    balance: o.EstCost + o.ChargesTotal - o.PaidTotal,
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
   * can leave a client in credit becomes visible: `credit` is `paidTotal - keepable`, the same
   * one-rule arithmetic the outstanding row's `balance` uses, read in the other direction. There is
   * deliberately no *Record payment* affordance on these rows (see `CREDIT_WHERE_SQL`): a credit is
   * a negative balance, not a payable one — the *resolution* affordances are `credit/keep` (the client
   * agreed she keeps it) and correcting the payment ledger (the money went back). See
   * `keepBookingCredit`.
   */
  const credits = data.credits.map((c) => ({
    bookingId: c.BookingId,
    name: c.Name,
    email: c.Email,
    serviceType: c.ServiceType,
    startDate: c.StartDate,
    status: c.Status,
    keepable: c.Keepable,
    paidTotal: c.PaidTotal,
    credit: c.PaidTotal - c.Keepable,
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
      thisMonth: data.monthly.at(-1)?.Total ?? 0,
      lastMonth: data.monthly.at(-2)?.Total ?? 0,
      outstandingTotal: outstanding.reduce((sum, o) => sum + o.balance, 0),
      outstandingCount: outstanding.length,
      // Never netted against `outstandingTotal`: one client owing $100 and another being owed $100
      // is not a settled book, and showing $0 would say it was.
      creditTotal: credits.reduce((sum, c) => sum + c.credit, 0),
    },
    monthly: data.monthly.map((m) => ({ month: m.Month, total: m.Total })),
    ytd: data.ytd,
    quarterly: data.quarterly,
    byService: data.byService.map((s) => ({
      serviceType: s.ServiceType,
      label: s.Label,
      total: s.Total,
    })),
    topClients: data.topClients.map((t) => ({
      endUserId: t.EndUserId,
      name: t.Name,
      email: t.Email,
      total: t.Total,
      bookings: t.Bookings,
    })),
    outstanding,
    credits,
    /**
     * HOUSEHOLD BALANCES, passed through verbatim. Every figure is already computed — by
     * `getHouseholdBalances`, over the same `CREDITABLE_AMOUNT_SQL` the two lists above are built
     * from — so there is deliberately nothing to map here: a balance is money, money is server-side,
     * and a client that re-added the numbers could disagree with the page it is printed on.
     *
     * The tiles above are NOT rebuilt from these rows. `outstandingTotal` and `creditTotal` stay
     * per-booking and stay un-netted: netting a debt against a credit is right WITHIN one household
     * (that is what a statement is) and wrong across two, and the tiles speak for the whole book.
     */
    households: data.households,
  };
}
