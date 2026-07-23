import { useEffect, useRef, useState } from 'react';
import { adminApi, type AnalyticsPayload } from '../../shared-ui/api.js';
import { IconChartBar } from '../../shared-ui/icons';
import { PaymentsPanel } from '../PaymentsPanel';
import type { Session } from '../shared.js';
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

/** '2026-07' → 'Jul 26'. */
function monthLabel(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y.slice(2)}`;
}

/** Hand-rolled 12-bar SVG chart — no chart library (see the design's non-goals). */
function MonthlyChart({ monthly }: { monthly: AnalyticsPayload['monthly'] }) {
  const max = Math.max(1, ...monthly.map((m) => m.total));
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
        const h = m.total === 0 ? 0 : Math.max(2, Math.round((m.total / max) * (chartH - 16)));
        const x = i * (barW + gap);
        return (
          <g key={m.month}>
            {m.total > 0 && m.total < 10000 && (
              <text x={x + barW / 2} y={chartH - h - 3} textAnchor="middle" fontSize="7">
                ${m.total}
              </text>
            )}
            <rect x={x} y={chartH - h} width={barW} height={h} rx="2" />
            <text x={x + barW / 2} y={chartH + 11} textAnchor="middle" fontSize="7">
              {monthLabel(m.month)}
            </text>
          </g>
        );
      })}
    </svg>
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
  const [openId, setOpenId] = useState<string | null>(null);
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

  const hasPayments = data.byService.length > 0;
  const maxService = Math.max(1, ...data.byService.map((s) => s.total));
  const maxQuarter = Math.max(1, ...data.quarterly.map((q) => q.total));

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
          <strong>${data.tiles.thisMonth}</strong>
          <span>This month</span>
        </div>
        <div className="pb-tile">
          <strong>${data.tiles.lastMonth}</strong>
          <span>Last month</span>
        </div>
        <div className="pb-tile">
          <strong>${data.ytd}</strong>
          <span>Year to date</span>
        </div>
        <div className="pb-tile">
          <strong>${data.tiles.outstandingTotal}</strong>
          <span>Outstanding</span>
        </div>
        <div className="pb-tile">
          <strong>{data.tiles.outstandingCount}</strong>
          <span>Unpaid bookings</span>
        </div>
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
                style={{ width: `${(qt.total / maxQuarter) * 100}%` }}
              />
            </div>
            <span>${qt.total}</span>
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
                  style={{ width: `${(s.total / maxService) * 100}%` }}
                />
              </div>
              <span>${s.total}</span>
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
                ${t.total} · {t.bookings} booking{t.bookings === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
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
                {o.serviceType} ({o.startDate})
                <br />
                owes ${o.balance} (paid ${o.paidTotal} of ${o.estCost}
                {o.isCancellationFee ? ' cancellation fee' : ''})
              </span>
              <button onClick={() => setOpenId(openId === o.bookingId ? null : o.bookingId)}>
                {openId === o.bookingId ? 'Close' : 'Record payment'}
              </button>
              {openId === o.bookingId && (
                <PaymentsPanel
                  session={session}
                  bookingId={o.bookingId}
                  onChanged={reload}
                  handleError={handleError}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
