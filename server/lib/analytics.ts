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
    paidTotal: o.PaidTotal,
    balance: o.EstCost - o.PaidTotal,
    // The subquery's EstCost is aliased from CancellationFee on a cancelled row, so the UI
    // needs this flag to label the amount as a fee rather than a live booking balance.
    isCancellationFee: o.Status === 'cancelled',
  }));
  return {
    tiles: {
      thisMonth: data.monthly.at(-1)?.Total ?? 0,
      lastMonth: data.monthly.at(-2)?.Total ?? 0,
      outstandingTotal: outstanding.reduce((sum, o) => sum + o.balance, 0),
      outstandingCount: outstanding.length,
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
  };
}
