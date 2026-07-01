import { useEffect, useState } from 'react';
import { api, type MonthDay } from '../shared-ui/api';
import {
  monthGrid,
  shiftMonth as shiftMonthFn,
  nextRangeSelection,
  isDateSelected,
  type RangeValue,
} from '../../src/shared/index.js';

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
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
  shape,
  month,
  onMonthChange,
  value,
  onChange,
  reloadKey,
}: {
  slug: string;
  token: string;
  serviceType: string;
  shape: 'range' | 'single';
  month: string;
  onMonthChange: (m: string) => void;
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  reloadKey?: number;
}) {
  // Combine fetch result into one object keyed by deps so loading/error can be derived without
  // calling setState synchronously inside the effect body (react-hooks/set-state-in-effect rule).
  const depsKey = `${slug}|${token}|${serviceType}|${month}|${reloadKey ?? ''}`;
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
      .monthAvailability(slug, token, serviceType, month)
      .then((r) => {
        if (!active) return;
        setFetchState({
          fetchedKey: depsKey,
          days: new Map(r.days.map((d) => [d.date, d])),
          today: r.today,
          error: false,
        });
      })
      .catch(() => {
        if (!active) return;
        setFetchState({ fetchedKey: depsKey, days: new Map(), today: '', error: true });
      });
    return () => {
      active = false;
    };
  }, [depsKey, slug, token, serviceType, month]);

  const pick = (date: string, d: MonthDay | undefined) => {
    if (!d || d.status === 'unavailable' || (today && date < today)) return;
    onChange(nextRangeSelection(value, date, shape));
  };

  const cells = monthGrid(month);

  const hint =
    shape === 'range'
      ? value.start && !value.end
        ? 'Now tap end date.'
        : 'Tap start date.'
      : 'Tap any date to select.';

  return (
    <div className="bp-cal">
      <div className="bp-cal-nav">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onMonthChange(shiftMonthFn(month, -1))}
        >
          ‹
        </button>
        <span className="bp-cal-title">
          {MONTHS[mon - 1]} {year}
        </span>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => onMonthChange(shiftMonthFn(month, 1))}
        >
          ›
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
          if (isDateSelected(value, date, shape)) cls.push('bp-sel');
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
      <ul className="bp-cal-legend">
        <li className="bp-lg-available">Available</li>
        <li className="bp-lg-partial">Partial</li>
        <li className="bp-lg-mine">My sits</li>
        <li className="bp-lg-unavail">Unavailable</li>
        <li className="bp-lg-sel">Selected</li>
      </ul>
      {loading ? (
        <p className="bp-cal-hint">Loading availability…</p>
      ) : loadError ? (
        <p className="bp-error">Couldn&apos;t load availability — please reload.</p>
      ) : (
        <p className="bp-cal-hint">{hint}</p>
      )}
    </div>
  );
}
