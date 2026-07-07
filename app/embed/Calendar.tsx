import { useCallback, useEffect, useRef } from 'react';
import { api, isAuthExpired, type MonthDay } from '../shared-ui/api';
import {
  monthGrid,
  shiftMonth as shiftMonthFn,
  nextRangeSelection,
  rangePosition,
  type RangeValue,
} from '../../src/shared/index.js';
import { IconChevronLeft, IconChevronRight } from '../shared-ui/icons';
import { useAsync } from '../shared-ui/useAsync';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
      return { days: new Map(r.days.map((d) => [d.date, d])), today: r.today };
    } catch (e) {
      // An expired/invalid token must degrade to re-identify (see server/lib/token.ts) —
      // otherwise the calendar renders with no availability and silently ignores taps.
      if (isAuthExpired(e)) {
        onAuthExpiredRef.current?.();
        // Never resolve: the parent unmounts this component right after onAuthExpired()
        // flips auth state, so this just leaves `loading` true until then (matching the old
        // behavior of never updating fetch state once the token is known to be dead).
        return new Promise<{ days: Map<string, MonthDay>; today: string }>(() => {});
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

  const parts = month.split('-');
  const year = Number(parts[0]);
  const mon = Number(parts[1]);

  const pick = (date: string, d: MonthDay | undefined) => {
    if (!d || d.status === 'unavailable' || (today && date < today)) return;
    onChange(nextRangeSelection(value, date, shape));
  };

  const cells = monthGrid(month);

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
          aria-label="Previous month"
          onClick={() => onMonthChange(shiftMonthFn(month, -1))}
        >
          <IconChevronLeft />
        </button>
        <div className="bp-cal-heading">
          <span className="bp-cal-title">
            {MONTHS[mon - 1]} {year}
          </span>
          <span className="bp-cal-sub" aria-live="polite">
            {loading ? 'Loading availability…' : hint}
          </span>
        </div>
        <button
          type="button"
          aria-label="Next month"
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
      <div className="bp-cal-grid">
        {cells.map((date, i) => {
          if (!date) return <span key={i} className="bp-cal-empty" />;
          const d = days.get(date);
          const past = !!(today && date < today);
          const cls = ['bp-cal-day'];
          if (past) cls.push('bp-past');
          else if (d?.status === 'unavailable') cls.push('bp-unavail');
          else if (d?.status === 'partial') cls.push('bp-partial');
          if (d?.mine) cls.push('bp-mine');
          const pos = rangePosition(value, date, shape);
          if (pos !== 'none') cls.push('bp-sel', `bp-sel-${pos === 'middle' ? 'mid' : pos}`);
          return (
            <button
              type="button"
              key={i}
              className={cls.join(' ')}
              disabled={past || d?.status === 'unavailable'}
              aria-label={`${date}${past ? ', past' : d ? ', ' + d.status : ''}${d?.mine ? ', your booking' : ''}`}
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
          states.some((d) => d.status === 'unavailable') && (
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
