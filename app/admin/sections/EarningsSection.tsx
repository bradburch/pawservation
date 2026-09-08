import { useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, type AnalyticsPayload, type HouseholdDetail } from '../../shared-ui/api.js';
import { IconChartBar } from '../../shared-ui/icons';
import { AttributionPanel } from '../AttributionPanel';
import { CalendarBackfillPanel } from '../CalendarBackfillPanel';
import { CsvImportPanel } from '../CsvImportPanel';
import { PaymentsPanel } from '../PaymentsPanel';
import { VenmoImportPanel } from '../VenmoImportPanel';
import type { Session } from '../shared.js';
import { formatCents, formatCentsForKey, formatFriendlyDate } from '../../../src/shared/index.js';
import { Hint } from '../Hint';

const NO_PAYMENTS = 'No payments recorded yet.';

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * The ", incl. …" tail on an outstanding balance. Each component is named with its OWN amount, so
 * a cancelled booking that owes only its extras never reads as a cancellation fee the sitter
 * waived: `isCancellationFee` means "the base amount on this row is a fee" (server-side it also
 * requires that fee to be non-zero), and the extras are always a separate figure.
 */
function breakdown(o: AnalyticsPayload['outstanding'][number]): string {
  const parts = [
    ...(o.isCancellationFee ? [`${formatCents(o.estCostCents)} cancellation fee`] : []),
    ...(o.chargesTotalCents > 0 ? [`${formatCents(o.chargesTotalCents)} extras`] : []),
  ];
  return parts.length ? `, incl. ${parts.join(' + ')}` : '';
}

/**
 * Who a household IS, in the sitter's words: the people in it, joined. A household can hold two
 * customers (they share a pet), so a single name would be a lie on exactly the rows this feature
 * exists for. Falls back to the email, then to the same "Unknown client" every other list uses.
 */
function householdName(h: AnalyticsPayload['households'][number]): string {
  const names = h.owners.map((o) => o.name || o.email).filter((n): n is string => !!n);
  return names.length ? names.join(' & ') : 'Unknown client';
}

/**
 * One `openId` drives every expandable row on this page, and an account id is a PET id while the
 * other rows key off booking ids — so households are namespaced to keep a pet id that happens to
 * equal a booking id from opening two panels at once (`groupIntoAccounts` prefixes its keys for the
 * same reason).
 */
const householdKey = (h: AnalyticsPayload['households'][number]): string =>
  `account:${h.accountId}`;

/** '2026-07' → 'Jul 26'. */
function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y.slice(2)}`;
}

/**
 * THE DRILL-DOWN BEHIND ONE HOUSEHOLD BALANCE (Story 2.4, FR-7c). Every booking's cost and extra
 * charges stay attributed to that booking — a cancellation fee never reads as part of some other
 * stay — and a household-level payment is listed on its own, never pinned to whichever booking
 * happened to be open. Fetches independently of the summary row above it: the server's own
 * `expectedTotalCents`/`paidTotalCents`/`balanceCents` are printed here too — and each booking's
 * own `outstandingCents` — so there is nothing for a reader to add up, or subtract, that the
 * server hasn't already computed identically.
 */
function HouseholdDetailPanel({ session, accountId }: { session: Session; accountId: string }) {
  const [detail, setDetail] = useState<HouseholdDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    adminApi.households
      .detail(session.slug, session.token, accountId)
      .then((d) => active && setDetail(d))
      .catch(() => active && setError('Could not load this household’s detail.'));
    return () => {
      active = false;
    };
  }, [session, accountId]);

  if (error) return <p className="pb-hint">{error}</p>;
  if (!detail) return <p className="pb-hint">Loading…</p>;

  return (
    <div className="pb-household-detail">
      {detail.bookings.length === 0 && detail.householdPayments.length === 0 && (
        <p className="pb-hint">Nothing recorded against this household yet.</p>
      )}
      {detail.bookings.length > 0 && (
        <ul>
          {detail.bookings.map((b) => (
            <li key={b.bookingId}>
              {b.serviceType} ({formatFriendlyDate(b.startDate)}) — {b.status}
              <br />
              {b.status === 'cancelled' && b.costCents > 0
                ? `${formatCents(b.costCents)} cancellation fee`
                : formatCents(b.costCents)}
              {b.chargesTotalCents > 0 &&
                ` + ${formatCents(b.chargesTotalCents)} extras (${b.charges
                  .map((c) => `${c.label} ${formatCents(c.amountCents)}`)
                  .join(', ')})`}
              {` — paid ${formatCents(b.paidTotalCents)}`}
              {/* WHAT THIS STAY STILL OWES, printed as the server computed it (`outstandingCents`)
                  rather than subtracted here: the sitter reading a disputed line sees the same
                  figure the attribution guard enforces, because it IS that figure. */}
              {b.outstandingCents > 0 && `, ${formatCents(b.outstandingCents)} still owing`}
              {b.paidTotalCents === 0 && b.expectedCents > 0 && (
                <span className="pb-hint"> — nothing recorded against this booking</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {detail.householdPayments.length > 0 && (
        <>
          <h4>Payments recorded against this household</h4>
          <ul>
            {detail.householdPayments.map((p) => (
              <li key={p.id}>
                {formatCents(p.amountCents)} via {p.method} on {formatFriendlyDate(p.paidDate)}
                {p.note ? ` — ${p.note}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The bar caption, or `null` when it would not fit the 30-unit bar pitch at fontSize 7. Six
 *  characters is the measured limit ("$4250" fits, "$4250.50" does not); the `<title>` on every
 *  bar carries the exact figure regardless, so omitting the caption hides nothing. */
function barLabel(totalCents: number): string | null {
  const text = `$${formatCentsForKey(totalCents)}`;
  return text.length <= 6 ? text : null;
}

/** Hand-rolled 12-bar SVG chart — no chart library (see the design's non-goals). */
function MonthlyChart({ monthly }: { monthly: AnalyticsPayload['monthly'] }) {
  const max = Math.max(1, ...monthly.map((m) => m.totalCents));
  const barW = 22;
  const gap = 8;
  const chartH = 110;
  const width = monthly.length * (barW + gap) - gap;
  return (
    <svg
      className="pb-earnings-chart"
      viewBox={`0 0 ${width} ${chartH + 16}`}
      role="img"
      aria-label="Recorded revenue by month over the last 12 months"
    >
      {monthly.map((m, i) => {
        // Bar geometry is a RATIO, so it is unit-agnostic and unchanged by the move to cents.
        const h =
          m.totalCents === 0 ? 0 : Math.max(2, Math.round((m.totalCents / max) * (chartH - 16)));
        const x = i * (barW + gap);
        return (
          <g key={m.month}>
            {/* The label only fits above a short bar. The threshold is the SAME $10,000 it always
                was, restated in the payload's unit. This is the ONE render that does not use
                `formatCents`: a full "$4,250.00" is nine glyphs at fontSize 7 and overflows the
                30-unit bar pitch, clipping at the chart's edges, so the bar caption drops the
                grouping comma and the trailing ".00" via `formatCentsForKey` ("$4250",
                "$4250.50"). Tiles, lists and every other figure on this page stay on
                `formatCents`.

                Dropping ".00" is not enough on its own once cents exist: "$4250.50" is eight
                glyphs and overflows the pitch exactly as "$4,250.00" did, so the caption is
                rendered ONLY when it actually fits — six characters or fewer, which is every
                whole-dollar figure under the threshold and every cent-bearing one up to $999.99.
                A month that has cents AND four figures simply goes uncaptioned rather than
                spilling across its neighbours; the bar keeps its `<title>`, so the exact total is
                still one hover away and nothing is lost but the printed duplicate. */}
            {m.totalCents > 0 && m.totalCents < 1_000_000 && barLabel(m.totalCents) !== null && (
              <text x={x + barW / 2} y={chartH - h - 3} textAnchor="middle" fontSize="7">
                {barLabel(m.totalCents)}
              </text>
            )}
            <rect x={x} y={chartH - h} width={barW} height={h} rx="2">
              {/* The full figure, always — the caption above is the one that may be dropped. */}
              <title>{`${monthLabel(m.month)}: ${formatCents(m.totalCents)}`}</title>
            </rect>
            <text x={x + barW / 2} y={chartH + 11} textAnchor="middle" fontSize="7">
              {monthLabel(m.month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Presentational render body for the earnings payload — tiles, monthly/quarterly charts,
 * by-service, top-clients, outstanding balances. No data fetching, no session requirement.
 *
 * When `session` + `onChanged` (and `handleError`, needed by `PaymentsPanel`) are all supplied,
 * the outstanding row gets a "Record payment" button that opens `PaymentsPanel`. Omit them (the
 * owner drill-down case, which has no session/mutation path for a sitter's own bookings) and
 * outstanding rows render read-only — same numbers, no button.
 */
export function EarningsView({
  data,
  session,
  onChanged,
  handleError,
  clearError,
}: {
  data: AnalyticsPayload;
  session?: Session;
  onChanged?: () => void;
  handleError?: (e: unknown) => void;
  clearError?: () => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Separate from `openId` (which drives the payment panels): a sitter can have the "Record
  // payment" form and the booking/charge/payment breakdown open on the same household at once.
  const [detailId, setDetailId] = useState<string | null>(null);

  /**
   * "The client said keep it." No amount is sent — the server computes it from the same expressions
   * this row's `credit` came from, so what gets logged is exactly what she just read. Confirmed
   * first, like every other money action in the dashboard.
   */
  const keepIt = async (c: AnalyticsPayload['credits'][number]) => {
    if (!session || !onChanged || !handleError || busyId) return;
    const who = c.name || c.email || 'your client';
    if (
      !window.confirm(
        `Log the ${formatCents(c.creditCents)} overpayment as kept on this booking? Use this when ${who} agreed you keep it — your Earnings total doesn't change, the booking is just owed ${formatCents(c.creditCents)} more.`,
      )
    )
      return;
    setBusyId(c.bookingId);
    try {
      await adminApi.payments.keepCredit(session.slug, session.token, c.bookingId);
      await onChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusyId(null);
    }
  };

  // accountId -> display label, built once from the same household rows the balances list below
  // already has — AttributionPanel never re-fetches or re-derives who a household is, it only
  // asks this for a name to print next to a credit.
  const householdLabels = useMemo(
    () => new Map(data.households.map((h) => [h.accountId, householdName(h)])),
    [data.households],
  );

  const hasPayments = data.byService.length > 0;
  // Both are bar-scaling denominators only — a ratio, so the unit never reaches the geometry.
  const maxService = Math.max(1, ...data.byService.map((s) => s.totalCents));
  const maxQuarter = Math.max(1, ...data.quarterly.map((q) => q.totalCents));

  return (
    <>
      <h2>
        <IconChartBar size={18} /> Earnings
        <Hint label="Earnings">
          Built entirely from the payments you record on bookings. Record every payment and this
          page keeps itself accurate.
        </Hint>
      </h2>

      <div className="pb-tiles">
        <div className="pb-tile">
          <strong>{formatCents(data.tiles.thisMonthCents)}</strong>
          <span>This month</span>
        </div>
        <div className="pb-tile">
          <strong>{formatCents(data.tiles.lastMonthCents)}</strong>
          <span>Last month</span>
        </div>
        <div className="pb-tile">
          <strong>{formatCents(data.ytdCents)}</strong>
          <span>Year to date</span>
        </div>
        <div className="pb-tile">
          <strong>{formatCents(data.tiles.outstandingTotalCents)}</strong>
          <span>Outstanding</span>
        </div>
        <div className="pb-tile">
          <strong>{data.tiles.outstandingCount}</strong>
          <span>{data.tiles.outstandingCount === 1 ? 'Unpaid booking' : 'Unpaid bookings'}</span>
        </div>
        {/* Only when there IS one: a permanent "$0 in credit" tile would be noise on a healthy
            book, and this figure is never netted into Outstanding (see the server comment). */}
        {data.tiles.creditTotalCents > 0 && (
          <div className="pb-tile">
            <strong>{formatCents(data.tiles.creditTotalCents)}</strong>
            <span>Owed back</span>
          </div>
        )}
      </div>

      <h3>Revenue over time</h3>
      {hasPayments ? (
        <MonthlyChart monthly={data.monthly} />
      ) : (
        <p className="pb-hint">{NO_PAYMENTS}</p>
      )}

      <h3>By quarter (this year)</h3>
      <ul className="pb-hbars">
        {data.quarterly.map((qt) => (
          <li key={qt.q}>
            <span>Q{qt.q}</span>
            <div className="pb-hbar">
              <div
                className="pb-hbar-fill"
                style={{ width: `${(qt.totalCents / maxQuarter) * 100}%` }}
              />
            </div>
            <span>{formatCents(qt.totalCents)}</span>
          </li>
        ))}
      </ul>

      <h3>By service (all-time)</h3>
      {data.byService.length === 0 ? (
        <p className="pb-hint">{NO_PAYMENTS}</p>
      ) : (
        <ul className="pb-hbars">
          {data.byService.map((s) => (
            <li key={s.serviceType}>
              <span>{s.label}</span>
              <div className="pb-hbar">
                <div
                  className="pb-hbar-fill"
                  style={{ width: `${(s.totalCents / maxService) * 100}%` }}
                />
              </div>
              <span>{formatCents(s.totalCents)}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Top clients (all-time)</h3>
      {data.topClients.length === 0 ? (
        <p className="pb-hint">{NO_PAYMENTS}</p>
      ) : (
        <ul>
          {data.topClients.map((t) => (
            <li key={t.endUserId}>
              <span className="pb-truncate" title={t.name || t.email || 'Unknown client'}>
                {t.name || t.email || 'Unknown client'}
              </span>
              <span>
                {formatCents(t.totalCents)} · {t.bookings} booking{t.bookings === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {session && onChanged && handleError && clearError && (
        <VenmoImportPanel
          session={session}
          onImported={onChanged}
          handleError={handleError}
          clearError={clearError}
        />
      )}

      {/* The generic mapped-CSV importer, for a sitter whose bank or payment app doesn't export
          Venmo's fixed shape — same "bring outside records into Earnings" job, one extra mapping
          step up front. */}
      {session && onChanged && handleError && clearError && (
        <CsvImportPanel
          session={session}
          onImported={onChanged}
          handleError={handleError}
          clearError={clearError}
        />
      )}

      {/* Adopting a sitter's calendar history is the same "bring outside records into Earnings"
          job the Venmo importer does for payments — same preview/tick/import shape, same reason
          to live here rather than under Calendar (which shows the LIVE calendar, not history). */}
      {session && onChanged && handleError && clearError && (
        <CalendarBackfillPanel
          session={session}
          onImported={onChanged}
          handleError={handleError}
          clearError={clearError}
        />
      )}

      {/* Credits an import left unattached to any one booking (Task 5 of payment attribution) —
          same "bring outside records into a clean state" job as the three importers above, one
          step later in the pipeline: this is for money already recorded, just not yet tied to a
          stay. */}
      {session && onChanged && handleError && clearError && (
        <AttributionPanel
          session={session}
          households={householdLabels}
          onApplied={onChanged}
          handleError={handleError}
          clearError={clearError}
        />
      )}

      {/* HOUSEHOLD BALANCES, above the per-booking lists because it is the question the sitter
          actually asks — "does Jennifer owe me anything?" — and the per-booking rows below are the
          working. Two customers who share a pet appear ONCE here, with one balance, exactly as they
          share one invoice number. Every number is the server's; nothing on this page adds up a
          household. Balances of different households are never combined into a total: one client
          owing $100 while another is owed $100 is not a settled book, which is also why the tiles
          above keep Outstanding and Owed back apart. */}
      <h3>Balances by household</h3>
      {data.households.length === 0 ? (
        <p className="pb-hint">No household balances yet.</p>
      ) : (
        <ul>
          {data.households.map((h) => (
            <li key={h.accountId}>
              <span className="pb-truncate-block" title={householdName(h)}>
                <span className="pb-truncate">{householdName(h)}</span>
                <br />
                {h.balanceCents > 0
                  ? `owes ${formatCents(h.balanceCents)}`
                  : h.balanceCents < 0
                    ? `in credit ${formatCents(-h.balanceCents)}`
                    : 'settled up'}{' '}
                (paid {formatCents(h.paidTotalCents)} of {formatCents(h.expectedTotalCents)} across{' '}
                {h.bookingIds.length} booking
                {h.bookingIds.length === 1 ? '' : 's'})
              </span>
              {/* RECORD ONE PAYMENT FOR THE WHOLE HOUSEHOLD (0011). This is the affordance the
                  feature exists for: a client who pays monthly hands over one amount covering
                  several stays, and the sitter records that — one row, no split invented, nothing
                  to allocate. The same panel the booking rows open, pointed at the household. */}
              {session && onChanged && handleError && (
                <>
                  <button
                    onClick={() => setOpenId(openId === householdKey(h) ? null : householdKey(h))}
                  >
                    {openId === householdKey(h) ? 'Close' : 'Record payment'}
                  </button>
                  {openId === householdKey(h) && (
                    <PaymentsPanel
                      session={session}
                      target={{ accountId: h.accountId }}
                      onChanged={onChanged}
                      handleError={handleError}
                    />
                  )}
                  {/* THE DRILL-DOWN (Story 2.4, FR-7c): every booking, its cost, its extra charges,
                      and every payment — including household-level ones — behind THIS balance. */}
                  <button
                    onClick={() => setDetailId(detailId === h.accountId ? null : h.accountId)}
                  >
                    {detailId === h.accountId ? 'Hide detail' : 'Show detail'}
                  </button>
                  {detailId === h.accountId && (
                    <HouseholdDetailPanel session={session} accountId={h.accountId} />
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* PAYMENTS THAT BELONG TO NO HOUSEHOLD. A household payment is filed under a PET id, and a
          deleted customer takes her pets — and their ownership edges — with her, leaving the
          payment pointing at nothing. That money is still counted in the tiles above, so the one
          thing this page must not do is drop it quietly: shown here, the sitter can re-record it
          against the right household and delete the stray. The server never guesses a household
          for it, and neither does this list. Nothing renders when there are none. */}
      {data.orphanedPayments.length > 0 && (
        <>
          <h3>Payments with no household</h3>
          <p className="pb-hint">
            Recorded against a client or pet that has since been deleted, so they belong to no
            balance below. They are still counted in the totals above. Re-record each one against
            the right household, then delete the original.
          </p>
          <ul>
            {data.orphanedPayments.map((o) => (
              <li key={o.accountId}>
                {formatCents(o.totalCents)} filed under a deleted pet ({o.accountId})
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Outstanding balances</h3>
      {data.outstanding.length === 0 ? (
        <p className="pb-hint">No outstanding balances.</p>
      ) : (
        <ul>
          {data.outstanding.map((o) => (
            <li key={o.bookingId}>
              <span className="pb-truncate-block" title={o.name || o.email || 'Unknown client'}>
                <span className="pb-truncate">{o.name || o.email || 'Unknown client'}</span> —{' '}
                {o.serviceType} ({formatFriendlyDate(o.startDate)})
                <br />
                {/* `estCostCents + chargesTotalCents` is the documented total-due rule (design
                    spec §4), and both terms are now the SAME unit — the one sum this page is
                    allowed to do. `balanceCents` itself is the server's, never re-derived here. */}
                owes {formatCents(o.balanceCents)} (paid {formatCents(o.paidTotalCents)} of{' '}
                {formatCents(o.estCostCents + o.chargesTotalCents)}
                {breakdown(o)})
              </span>
              {session && onChanged && handleError && (
                <>
                  <button onClick={() => setOpenId(openId === o.bookingId ? null : o.bookingId)}>
                    {openId === o.bookingId ? 'Close' : 'Record payment'}
                  </button>
                  {openId === o.bookingId && (
                    <PaymentsPanel
                      session={session}
                      target={{ bookingId: o.bookingId }}
                      onChanged={onChanged}
                      handleError={handleError}
                    />
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Overpayments. Rendered only when there are any — a sitter with a clean book should not have
          to read a "nothing here" line — and with NO *Record payment* button: this is money going the
          other way. The commonest source is an edit: a stay paid in full and then shortened
          re-stamps a lower EstCost.
          
          Two ways to CLOSE one, because they mean opposite things about her revenue: the money went
          back (correct the ledger — delete the payment, then re-record what was actually kept, which
          is what makes Earnings fall), or the client agreed she keeps it (logged as a charge on the
          booking, so revenue stays put and the booking is simply owed more). "Keep it" is hidden when
          the server says it cannot close this row — a declined request may keep nothing — so no
          button here is one that does nothing. */}
      {data.credits.length > 0 && (
        <>
          <h3>Owed back to clients</h3>
          <ul>
            {data.credits.map((c) => (
              <li key={c.bookingId}>
                <span className="pb-truncate-block" title={c.name || c.email || 'Unknown client'}>
                  <span className="pb-truncate">{c.name || c.email || 'Unknown client'}</span> —{' '}
                  {c.serviceType} ({formatFriendlyDate(c.startDate)})
                  <br />
                  overpaid {formatCents(c.creditCents)} (paid {formatCents(c.paidTotalCents)}
                  {c.keepableCents > 0
                    ? ` of ${formatCents(c.keepableCents)}`
                    : ', now owes nothing'}
                  )
                </span>
                {session && onChanged && handleError && (
                  <span>
                    {c.canKeep && (
                      <button disabled={busyId === c.bookingId} onClick={() => void keepIt(c)}>
                        Keep it
                      </button>
                    )}
                    <button
                      onClick={() => setOpenId(openId === c.bookingId ? null : c.bookingId)}
                      aria-label={`Correct the payments on ${c.name ?? 'this booking'}`}
                    >
                      {openId === c.bookingId ? 'Close' : 'Refund…'}
                    </button>
                  </span>
                )}
                {session && onChanged && handleError && openId === c.bookingId && (
                  <>
                    <p className="pb-hint">
                      Send the {formatCents(c.creditCents)} back however you paid it, then correct
                      the record here: delete the payment and re-record what you actually kept.
                    </p>
                    {/* allowRecord=false on purpose: on a credit row the ledger is delete-only. Once
                        the overpayment is gone the booking is either settled or shows up under
                        Outstanding, where *Record payment* is proven to work. */}
                    <PaymentsPanel
                      session={session}
                      target={{ bookingId: c.bookingId }}
                      onChanged={onChanged}
                      handleError={handleError}
                      allowRecord={false}
                    />
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function EarningsSection({
  session,
  handleError,
  clearError,
}: {
  session: Session;
  handleError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const alive = useRef(true);

  const load = () => adminApi.analytics.get(session.slug, session.token);

  useEffect(() => {
    let active = true;
    load()
      .then((d) => active && setData(d))
      .catch((e) => active && handleError(e));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = async () => {
    clearError();
    try {
      const result = await load();
      if (alive.current) {
        setData(result);
      }
    } catch (e) {
      if (alive.current) {
        handleError(e);
      }
    }
  };

  if (data === null)
    return (
      <>
        <h2>
          <IconChartBar size={18} /> Earnings
        </h2>
        <p>Loading…</p>
      </>
    );

  return (
    <EarningsView
      data={data}
      session={session}
      onChanged={reload}
      handleError={handleError}
      clearError={clearError}
    />
  );
}
