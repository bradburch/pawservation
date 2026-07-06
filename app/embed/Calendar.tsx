import { useEffect, useState } from 'react';
import { api, isAuthExpired, type MonthDay } from '../shared-ui/api';
import {
  monthGrid,
  shiftMonth as shiftMonthFn,
  nextRangeSelection,
  rangePosition,
  type RangeValue,
} from '../../src/shared/index.js';
import { IconChevronLeft, IconChevronRight } from '../shared-ui/icons';

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
  // Combine fetch result into one object keyed by deps so loading/error can be derived without
  // calling setState synchronously inside the effect body (react-hooks/set-state-in-effect rule).
  const depsKey = `${slug}|${token}|${serviceType}|${optionKey ?? ''}|${month}|${reloadKey ?? ''}`;
  const [fetchState, setFetchState] = useState<{
    fetchedKey: string;
    days: Map<string, MonthDay>;
    today: string;
    error: boolean;
  }>({ fetchedKey: '', days: new Map(), today: '', error: false });

  // Derive display state from whether the current deps match the last completed fetch.
  const loading = fetchState.fetchedKey !== depsKey;
  const loadError = !loading && fetchState.error;
  const days = loading ? new Map<string, MonthDay>() : fetchState.days;
  const today = loading ? '' : fetchState.today;

  const parts = month.split('-');
  const year = Number(parts[0]);
  const mon = Number(parts[1]);

  useEffect(() => {
    let active = true;
    api
      .monthAvailability(slug, token, serviceType, month, optionKey)
      .then((r) => {
        if (!active) return;
        setFetchState({
          fetchedKey: depsKey,
          days: new Map(r.days.map((d) => [d.date, d])),
          today: r.today,
          error: false,
        });
      })
      .catch((e: unknown) => {
        if (!active) return;
        // An expired/invalid token must degrade to re-identify (see server/lib/token.ts) —
        // otherwise the calendar renders with no availability and silently ignores taps.
        if (isAuthExpired(e)) {
          onAuthExpired?.();
          return;
        }
        setFetchState({ fetchedKey: depsKey, days: new Map(), today: '', error: true });
      });
    return () => {
      active = false;
    };
    // onAuthExpired is deliberately not a dep: parents pass a fresh closure each render,
    // and re-running this fetch when it changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, slug, token, serviceType, optionKey, month]);

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
