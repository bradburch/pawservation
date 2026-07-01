import { useEffect, useState } from 'react';
import { api, type MonthDay } from '../shared-ui/api';

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

function daysInMonth(year: number, month1: number): number {
  return [
    31,
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month1 - 1];
}

/** Weekday index (0=Sun) for the 1st of the given month. Pure arithmetic, no Date.now(). */
function firstWeekday(year: number, month1: number): number {
  // days elapsed since 2000-01-01 (a Saturday, index 6)
  let days = 0;
  for (let y = 2000; y < year; y++)
    days += (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
  for (let m = 1; m < month1; m++) days += daysInMonth(year, m);
  return (6 + days) % 7;
}

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
  value: { start: string; end?: string };
  onChange: (v: { start: string; end?: string }) => void;
  reloadKey?: number;
}) {
  const [days, setDays] = useState<Map<string, MonthDay>>(new Map());
  const [today, setToday] = useState('');
  const parts = month.split('-');
  const year = Number(parts[0]);
  const mon = Number(parts[1]);

  useEffect(() => {
    let active = true;
    api
      .monthAvailability(slug, token, serviceType, month)
      .then((r) => {
        if (!active) return;
        setDays(new Map(r.days.map((d) => [d.date, d])));
        setToday(r.today);
      })
      .catch(() => {
        if (active) setDays(new Map());
      });
    return () => {
      active = false;
    };
  }, [slug, token, serviceType, month, reloadKey]);

  const shiftMonth = (delta: number) => {
    let y = year;
    let m = mon + delta;
    if (m < 1) {
      m = 12;
      y--;
    } else if (m > 12) {
      m = 1;
      y++;
    }
    onMonthChange(`${y}-${String(m).padStart(2, '0')}`);
  };

  const pick = (date: string, d: MonthDay | undefined) => {
    if (!d || d.status === 'unavailable' || (today && date < today)) return;
    if (shape === 'single') {
      onChange({ start: date });
      return;
    }
    // range: first tap = start; second tap = end (must be after start)
    if (!value.start || value.end || date < value.start) {
      onChange({ start: date });
    } else {
      onChange({ start: value.start, end: date });
    }
  };

  const cells: (string | null)[] = [];
  const lead = firstWeekday(year, mon);
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth(year, mon); day++) {
    cells.push(`${month}-${String(day).padStart(2, '0')}`);
  }

  const isSelected = (date: string): boolean => {
    if (shape === 'single') return value.start === date;
    return !!(
      value.start &&
      (date === value.start || (value.end !== undefined && date > value.start && date <= value.end))
    );
  };

  const hint =
    shape === 'range'
      ? value.start && !value.end
        ? 'Now tap end date.'
        : 'Tap start date.'
      : 'Tap any date to select.';

  return (
    <div className="bp-cal">
      <div className="bp-cal-nav">
        <button type="button" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
          ‹
        </button>
        <span className="bp-cal-title">
          {MONTHS[mon - 1]} {year}
        </span>
        <button type="button" aria-label="Next month" onClick={() => shiftMonth(1)}>
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
          if (isSelected(date)) cls.push('bp-sel');
          return (
            <button
              type="button"
              key={i}
              className={cls.join(' ')}
              disabled={past || d?.status === 'unavailable'}
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
      <p className="bp-cal-hint">{hint}</p>
    </div>
  );
}
