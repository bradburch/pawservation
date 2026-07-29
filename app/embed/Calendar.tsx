import { useCallback, useEffect, useRef } from 'react';
import { api, isAuthExpired, type MonthAvailability, type MonthDay } from '../shared-ui/api';
import {
  holidaysInMonth,
  isWeekend,
  monthGrid,
  shiftMonth as shiftMonthFn,
  nextRangeSelection,
  rangePosition,
  type RangeValue,
} from '../../src/shared/index.js';
import { IconChevronLeft, IconChevronRight } from '../shared-ui/icons';
import { useAsync } from '../shared-ui/useAsync';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/**
 * Always render six weeks (6 × 7). A month grid is 4–6 rows tall depending on its length and
 * lead offset; letting that vary — or letting it collapse to nothing while a month loads —
 * changes the widget's height, and the embed lives in an auto-resizing iframe (App.tsx posts
 * scrollHeight on every ResizeObserver tick), so the host page would visibly bounce.
 */
const GRID_CELLS = 42;

/** The month response, with its day list indexed for O(1) cell lookup. */
type MonthState = Omit<MonthAvailability, 'days'> & { days: Map<string, MonthDay> };
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function Calendar({
  slug,
  token,
  serviceType,
  optionKey,
  weekdaysOnly,
  shape,
  month,
  onMonthChange,
  value,
  onChange,
  reloadKey,
  onAuthExpired,
}: {
  slug: string;
  token: string;
  serviceType: string;
  optionKey?: string;
  /** Selected option is weekday-only: marks unavailable + disable Sat/Sun (server enforces the same). */
  weekdaysOnly?: boolean;
  shape: 'range' | 'single';
  month: string;
  onMonthChange: (m: string) => void;
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  reloadKey?: number;
  /** Called when the month fetch is rejected as unauthenticated (expired token). */
  onAuthExpired?: () => void;
}) {
  // Held in a ref (not a fetchMonth dep) so a parent that passes a fresh closure every render
  // doesn't give fetchMonth a new identity each time — that would make useAsync refetch, which
  // triggers a render, which makes a new closure, looping forever. Assigned in an effect (not
  // during render — React forbids mutating a ref's `current` synchronously in the render body)
  // so the ref is current before any later event/effect reads it.
  const onAuthExpiredRef = useRef(onAuthExpired);
  useEffect(() => {
    onAuthExpiredRef.current = onAuthExpired;
  });

  const fetchMonth = useCallback(async () => {
    // reloadKey doesn't change what's fetched — referencing it is what forces a fresh
    // fetchMonth identity (and therefore a refetch) after a booking submission bumps it.
    void reloadKey;
    try {
      const r = await api.monthAvailability(slug, token, serviceType, month, optionKey);
      return { ...r, days: new Map(r.days.map((d) => [d.date, d])) };
    } catch (e) {
      // An expired/invalid token must degrade to re-identify (see server/lib/token.ts) —
      // otherwise the calendar renders with no availability and silently ignores taps.
      if (isAuthExpired(e)) {
        onAuthExpiredRef.current?.();
        // Never resolve: the parent unmounts this component right after onAuthExpired()
        // flips auth state, so this just leaves `loading` true until then (matching the old
        // behavior of never updating fetch state once the token is known to be dead).
        return new Promise<MonthState>(() => {});
      }
      throw e;
    }
  }, [slug, token, serviceType, month, optionKey, reloadKey]);

  const { data, error, loading } = useAsync(fetchMonth);
  const loadError = !loading && !!error;
  // Gate on loadError as well as loading: useAsync retains the last successful data on a
  // failed fetch, but this grid should render blank + the error message (the pre-hook
  // behavior), not a stale month's availability.
  const showData = !loading && !loadError;
  const days = showData ? (data?.days ?? new Map<string, MonthDay>()) : new Map<string, MonthDay>();
  const today = showData ? (data?.today ?? '') : '';
  // While the month data is in flight the grid knows nothing: `days` is empty and `today` is ''.
  // Without this gate every cell would render enabled, undimmed and implicitly AVAILABLE, and
  // taps on it would silently do nothing. Disable the whole grid until the answer arrives.
  const gridBusy = loading || loadError;

  // Month-nav bounds. Both are DATES the server already resolved from the booking window (per-
  // service minimum notice + the business-wide horizon) in the TENANT's timezone — the client
  // does no date arithmetic, it only slices a date to its 'YYYY-MM' and compares strings.
  // Read from `data` rather than the gated values above so paging stays enabled while the next
  // month loads (useAsync keeps the last successful result), and because the bounds describe the
  // service, not the month on screen.
  const earliestMonth = data ? data.earliestBookable.slice(0, 7) : null;
  // null latestBookable = no horizon: page forward forever, exactly like the server allows.
  const latestMonth = data?.latestBookable?.slice(0, 7) ?? null;
  const atEarliest = earliestMonth !== null && month <= earliestMonth;
  const atLatest = latestMonth !== null && month >= latestMonth;

  const parts = month.split('-');
  const year = Number(parts[0]);
  const mon = Number(parts[1]);

  const pick = (date: string, d: MonthDay | undefined) => {
    if (!d || d.status === 'unavailable' || (today && date < today)) return;
    if (weekdaysOnly && isWeekend(date)) return;
    onChange(nextRangeSelection(value, date, shape));
  };

  const grid = monthGrid(month);
  // Pad, never truncate: monthGrid never exceeds 6 rows (max lead 6 + 31 days = 37 cells).
  const cells: (string | null)[] = [
    ...grid,
    ...Array.from({ length: Math.max(0, GRID_CELLS - grid.length) }, () => null),
  ];
  const holidays = new Map(holidaysInMonth(month).map((h) => [h.date, h.name]));

  const hint =
    shape === 'range'
      ? value.start && value.end
        ? 'Tap a day to start over'
        : value.start
          ? 'Now tap your last day'
          : 'Tap your first day'
      : 'Tap a date to select it';

  return (
    <div className="bp-cal">
      <div className="bp-cal-nav">
        <button
          type="button"
          // Genuinely disabled rather than a silent no-op: paging into months the booking window
          // already rules out only ever shows a full grid of struck-through days.
          disabled={atEarliest}
          aria-label={
            atEarliest
              ? `No earlier months — the earliest date you can book is ${data?.earliestBookable}`
              : 'Previous month'
          }
          title={atEarliest ? 'No earlier months you can book' : undefined}
          onClick={() => onMonthChange(shiftMonthFn(month, -1))}
        >
          <IconChevronLeft />
        </button>
        <div className="bp-cal-heading">
          <span className="bp-cal-title">
            {MONTHS[mon - 1]} {year}
          </span>
          <span className="bp-cal-sub" aria-live="polite">
            {loading
              ? 'Loading availability…'
              : atLatest
                ? `${hint} · last month you can book`
                : hint}
          </span>
        </div>
        <button
          type="button"
          disabled={atLatest}
          aria-label={
            atLatest
              ? `No later months — this business books no further ahead than ${data?.latestBookable}`
              : 'Next month'
          }
          title={atLatest ? 'No later months you can book' : undefined}
          onClick={() => onMonthChange(shiftMonthFn(month, 1))}
        >
          <IconChevronRight />
        </button>
      </div>
      <div className="bp-cal-grid bp-cal-head">
        {WEEKDAYS.map((w) => (
          <span key={w} className="bp-cal-weekday">
            {w}
          </span>
        ))}
      </div>
      <div
        className={`bp-cal-grid${gridBusy ? ' bp-cal-busy' : ''}`}
        aria-busy={loading || undefined}
      >
        {cells.map((date, i) => {
          if (!date) return <span key={i} className="bp-cal-empty" />;
          const d = days.get(date);
          const past = !!(today && date < today);
          const weekend = !!weekdaysOnly && isWeekend(date);
          const isToday = !!today && date === today;
          const holiday = holidays.get(date) ?? null;
          // Why this day can't be picked, in the customer's words. The server owns every reason
          // it knows (capacity, blocked, outside the booking window); the two the client alone
          // can see — a past day and a weekday-only weekend — are named here.
          const reason = past ? 'Already past' : weekend ? 'Weekdays only' : (d?.reason ?? null);
          const cls = ['bp-cal-day'];
          if (past) cls.push('bp-past');
          else if (weekend || d?.status === 'unavailable') cls.push('bp-unavail');
          else if (d?.status === 'partial') cls.push('bp-partial');
          if (d?.mine) cls.push('bp-mine');
          if (isToday) cls.push('bp-today');
          if (holiday) cls.push('bp-cal-holiday');
          const pos = rangePosition(value, date, shape);
          if (pos !== 'none') cls.push('bp-sel', `bp-sel-${pos === 'middle' ? 'mid' : pos}`);
          const notes = [
            isToday ? 'today' : null,
            past ? 'past' : weekend ? 'weekdays only' : (d?.status ?? null),
            // Only the server's reason is additive; the client's two already read as the note above.
            past || weekend ? null : (d?.reason ?? null),
            d?.mine ? 'your booking' : null,
            holiday,
          ].filter(Boolean);
          return (
            <button
              type="button"
              key={i}
              className={cls.join(' ')}
              disabled={gridBusy || past || weekend || d?.status === 'unavailable'}
              title={[holiday, reason].filter(Boolean).join(' — ') || undefined}
              aria-label={[date, ...notes].join(', ')}
              onClick={() => pick(date, d)}
            >
              {Number(date.slice(-2))}
              {d?.status === 'partial' && d.max != null ? (
                <small>
                  {d.used}/{d.max}
                </small>
              ) : null}
            </button>
          );
        })}
      </div>
      {(() => {
        const states = [...days.values()];
        const legend = [
          states.some((d) => d.status === 'partial') && (
            <li key="partial" className="bp-lg-partial">
              Almost full
            </li>
          ),
          states.some((d) => d.mine) && (
            <li key="mine" className="bp-lg-mine">
              Your bookings
            </li>
          ),
          // Weekday-only options mark Sat/Sun unavailable with the same treatment, so the
          // legend must explain it even when no server-reported day is unavailable.
          (!!weekdaysOnly || states.some((d) => d.status === 'unavailable')) && (
            <li key="unavail" className="bp-lg-unavail">
              Unavailable
            </li>
          ),
        ].filter(Boolean);
        return legend.length > 0 ? <ul className="bp-cal-legend">{legend}</ul> : null;
      })()}
      {loadError && <p className="bp-error">Couldn&apos;t load availability — please reload.</p>}
    </div>
  );
}
