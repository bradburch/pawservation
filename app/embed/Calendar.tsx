import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { api, isAuthExpired, type MonthAvailability, type MonthDay } from '../shared-ui/api';
import {
  addDays,
  formatShortDate,
  holidaysInMonth,
  isWeekend,
  monthGrid,
  shiftMonth as shiftMonthFn,
  nextRangeSelection,
  rangePosition,
  type RangePosition,
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
const GRID_COLUMNS = 7;

/** The month response, indexed for O(1) cell lookup and stamped with what it describes. */
type MonthState = Omit<MonthAvailability, 'days'> & {
  days: Map<string, MonthDay>;
  forService: string;
  forOption: string;
};
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

/**
 * The client's read on a candidate stay, from the day statuses ALREADY in hand — no endpoint, no
 * money, no capacity rules re-derived. Three outcomes, and the third is the one that matters:
 *
 * - `clear` — every day the stay occupies is paintable and painted bookable.
 * - `conflict` — one is not, named with the server's own `reason` for it.
 * - `null` — **no verdict**, because at least one occupied day is not in the loaded month. The
 *   day map holds ONE month; a range spanning out of it must degrade to silence rather than
 *   guess, since a confidently wrong "looks open" is worse than saying nothing.
 *
 * It is an OPTIMISTIC HINT, never a guarantee, and is worded that way. Per-day status is
 * necessary but not sufficient for a range service: `rangeHasConflict` has bookend / soft-bookend
 * sharing and the house-sit-over-boarding one-day rule (CALENDAR_LOGIC.md §3), none of which any
 * per-day paint can express — so a span of green days can still be refused, and an endpoint on a
 * full day is *more* permissive than the paint suggests. The server remains the authority.
 */
type RangeVerdict = { ok: true } | { ok: false; date: string; reason: string | null } | null;

/** String compares, not date math: 'YYYY-MM-DD' sorts lexicographically. */
const maxDate = (a: string, b: string) => (a > b ? a : b);
const minDate = (a: string, b: string) => (a < b ? a : b);

/** Spoken name for a cell's place in the COMMITTED selection; pairs with `aria-selected`. */
const SELECTION_NOTE: Record<RangePosition, string | null> = {
  none: null,
  only: 'selected',
  start: 'first day',
  middle: 'in your dates',
  end: 'last day',
};

function rangeVerdict(
  start: string,
  endExclusive: string,
  days: Map<string, MonthDay>,
  weekdaysOnly: boolean,
  today: string,
): RangeVerdict {
  if (!start || !endExclusive || endExclusive <= start) return null;
  // Bounded by the day map: the first date it doesn't hold ends the walk with no verdict, and it
  // holds at most one month, so this can never run away.
  for (let date = start; date < endExclusive; date = addDays(date, 1)) {
    const day = days.get(date);
    if (!day) return null;
    if (today && date < today) return { ok: false, date, reason: 'Already past' };
    if (weekdaysOnly && isWeekend(date)) return { ok: false, date, reason: 'Weekdays only' };
    if (day.status === 'unavailable') return { ok: false, date, reason: day.reason };
  }
  return { ok: true };
}

export function Calendar({
  slug,
  token,
  serviceType,
  optionKey,
  petIds,
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
  /**
   * Comma-joined ids of the pets the customer has selected. The grid is painted FOR this set —
   * a day with one of two slots free is bookable for one pet and not for two — so a change here
   * refetches the month. The arithmetic is entirely the server's; this is a cache key.
   */
  petIds?: string;
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
      const r = await api.monthAvailability(slug, token, serviceType, month, optionKey, petIds);
      // Stamp which service/option this answer describes: useAsync retains the last success
      // across a DEPENDENCY change too, not just across an error, so without the stamp the
      // previous service's window bounds would drive the nav buttons until the new month lands
      // (minimum notice is per service). See `boundsFresh` below.
      return {
        ...r,
        days: new Map(r.days.map((d) => [d.date, d])),
        forService: serviceType,
        forOption: optionKey ?? '',
      };
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
  }, [slug, token, serviceType, month, optionKey, petIds, reloadKey]);

  const { data, error, loading } = useAsync(fetchMonth);
  const loadError = !loading && !!error;
  // Gate on loadError as well as loading: useAsync retains the last successful data on a
  // failed fetch, but this grid should render blank + the error message (the pre-hook
  // behavior), not a stale month's availability.
  const showData = !loading && !loadError;
  const days = useMemo(
    () => (showData ? (data?.days ?? new Map<string, MonthDay>()) : new Map<string, MonthDay>()),
    [showData, data],
  );
  const today = showData ? (data?.today ?? '') : '';
  // While the month data is in flight the grid knows nothing: `days` is empty and `today` is ''.
  // Without this gate every cell would render enabled, undimmed and implicitly AVAILABLE, and
  // taps on it would silently do nothing. Disable the whole grid until the answer arrives.
  const gridBusy = loading || loadError;

  // Month-nav bounds. Both are DATES the server already resolved from the booking window (per-
  // service minimum notice + the business-wide horizon) in the TENANT's timezone — the client
  // does no date arithmetic, it only slices a date to its 'YYYY-MM' and compares strings.
  // Read from `data` rather than the gated values above so paging stays enabled while the next
  // MONTH loads (useAsync keeps the last successful result) — the bounds describe the service,
  // not the month on screen. But only while the retained answer still describes THIS service and
  // option; otherwise treat the bounds as unknown, which leaves both buttons enabled (permissive
  // — the server still refuses an out-of-window request, and the grid still paints it out).
  const boundsFresh =
    !!data && data.forService === serviceType && data.forOption === (optionKey ?? '');
  const earliestMonth = boundsFresh ? data.earliestBookable.slice(0, 7) : null;
  // null latestBookable = no horizon: page forward forever, exactly like the server allows.
  const latestMonth = boundsFresh ? (data.latestBookable?.slice(0, 7) ?? null) : null;
  // A misconfigured business (minimum notice past its own horizon) has NO bookable month at all.
  // Disabling both buttons there would trap the customer between two contradictory labels, so
  // leave paging alone and let the all-unavailable grid tell the story.
  const windowUnbookable =
    earliestMonth !== null && latestMonth !== null && earliestMonth > latestMonth;
  const atEarliest = !windowUnbookable && earliestMonth !== null && month <= earliestMonth;
  const atLatest = !windowUnbookable && latestMonth !== null && month >= latestMonth;

  const parts = month.split('-');
  const year = Number(parts[0]);
  const mon = Number(parts[1]);

  const grid = useMemo(() => monthGrid(month), [month]);
  // Pad, never truncate: monthGrid never exceeds 6 rows (max lead 6 + 31 days = 37 cells).
  const cells: (string | null)[] = useMemo(
    () => [...grid, ...Array.from({ length: Math.max(0, GRID_CELLS - grid.length) }, () => null)],
    [grid],
  );
  const rows: (string | null)[][] = useMemo(
    () =>
      Array.from({ length: GRID_CELLS / GRID_COLUMNS }, (_, r) =>
        cells.slice(r * GRID_COLUMNS, r * GRID_COLUMNS + GRID_COLUMNS),
      ),
    [cells],
  );
  const holidays = useMemo(
    () => new Map(holidaysInMonth(month).map((h) => [h.date, h.name])),
    [month],
  );

  const selectable = useCallback(
    (date: string): boolean => {
      if (gridBusy) return false;
      const d = days.get(date);
      if (!d || d.status === 'unavailable') return false;
      if (today && date < today) return false;
      if (weekdaysOnly && isWeekend(date)) return false;
      return true;
    },
    [gridBusy, days, today, weekdaysOnly],
  );

  const pick = (date: string) => {
    if (!selectable(date)) return;
    onChange(nextRangeSelection(value, date, shape));
  };

  // ── Roving tabindex + keyboard grid ────────────────────────────────────────
  // `.bp-cal-grid` used to be a flat list of buttons: tabbing past a month cost 30+ stops. It is
  // now a role="grid" of rows where exactly ONE cell is tabbable (the anchor) and the arrows move
  // between them. Unavailable days carry aria-disabled rather than `disabled` — a disabled button
  // is not focusable, and a grid whose blocked days can't be reached is a grid you can't read.
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusDate, setFocusDate] = useState<string | null>(null);
  // Set by the key handlers only: focus is moved imperatively in response to a keypress, never
  // stolen on mount or on a background refetch.
  const wantFocus = useRef(false);

  const inMonth = (date: string | null | undefined): date is string =>
    !!date && date.slice(0, 7) === month;
  const firstOfMonth = `${month}-01`;
  const anchor =
    (inMonth(focusDate) && focusDate) ||
    (inMonth(value.start) && value.start) ||
    (inMonth(today) && today) ||
    firstOfMonth;

  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${anchor}"]`)?.focus();
  });

  /** Move the anchor, paging the month when the move crosses out of it (bounds permitting). */
  const moveTo = (date: string) => {
    const target = date.slice(0, 7);
    if (target !== month) {
      if (target < month && atEarliest) return;
      if (target > month && atLatest) return;
      onMonthChange(target);
    }
    setFocusDate(date);
    wantFocus.current = true;
  };

  const onGridKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = cells.indexOf(anchor);
    const column = index < 0 ? 0 : index % GRID_COLUMNS;
    const monthDays = grid.filter((c): c is string => !!c);
    // Same day-of-month in the neighbouring month, clamped to its length (Mar 31 → Feb 28).
    const pageBy = (delta: number) => {
      const target = shiftMonthFn(month, delta);
      const targetDays = monthGrid(target).filter((c): c is string => !!c);
      const same = `${target}-${anchor.slice(-2)}`;
      return targetDays.includes(same) ? same : targetDays[targetDays.length - 1];
    };
    const handlers: Record<string, () => void> = {
      ArrowLeft: () => moveTo(addDays(anchor, -1)),
      ArrowRight: () => moveTo(addDays(anchor, 1)),
      ArrowUp: () => moveTo(addDays(anchor, -GRID_COLUMNS)),
      ArrowDown: () => moveTo(addDays(anchor, GRID_COLUMNS)),
      // Week edges, derived from the anchor's COLUMN in the grid — no weekday arithmetic — then
      // clamped into the month so Home on the 1st row doesn't land on a padding cell.
      Home: () => moveTo(maxDate(addDays(anchor, -column), monthDays[0])),
      End: () =>
        moveTo(
          minDate(addDays(anchor, GRID_COLUMNS - 1 - column), monthDays[monthDays.length - 1]),
        ),
      PageUp: () => moveTo(pageBy(-1)),
      PageDown: () => moveTo(pageBy(1)),
      Escape: () => onChange({}),
    };
    const handler = handlers[e.key];
    if (!handler) return;
    e.preventDefault();
    handler();
  };

  // ── Provisional range + verdict ────────────────────────────────────────────
  // Two-tap selection stays (drag-select inside an iframe needs a global mouseup listener plus
  // elementFromPoint plus preventDefault on touchstart — hostile). Hover/keyboard focus only
  // PREVIEWS the second tap; nothing is committed until it happens.
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const awaitingEnd = shape === 'range' && !!value.start && !value.end;
  const candidateEnd = !awaitingEnd
    ? null
    : hoverDate && hoverDate > value.start!
      ? hoverDate
      : inMonth(focusDate) && focusDate > value.start!
        ? focusDate
        : null;
  // What the band + verdict describe: the committed range, or the one the customer is hovering.
  const bandValue: RangeValue = candidateEnd ? { start: value.start, end: candidateEnd } : value;
  const verdict =
    shape === 'range' && bandValue.start && bandValue.end
      ? rangeVerdict(bandValue.start, bandValue.end, days, !!weekdaysOnly, today)
      : null;

  // The cheap win the grid already knows the answer to: the first day in THIS month a customer
  // could actually pick. Silent when that is simply the first day on offer (nothing to point at).
  const nextOpening = useMemo(() => {
    const monthDays = grid.filter((c): c is string => !!c);
    const eligible = monthDays.filter((d) => !today || d >= today);
    const open = eligible.find(selectable) ?? null;
    return { open, isFirst: !!open && open === eligible[0], none: eligible.length > 0 && !open };
  }, [grid, today, selectable]);

  const note = verdict
    ? verdict.ok
      ? 'These dates look open — your sitter confirms.'
      : `${formatShortDate(verdict.date)} is unavailable${
          verdict.reason ? ` — ${verdict.reason.toLowerCase()}` : ''
        }.`
    : // Silent while the day map is unknown, and while a first day is already committed: the
      // month's next opening has nothing to add to "now tap your last day", and pointing at a
      // date BEHIND the one already chosen would read as a correction.
      gridBusy || awaitingEnd
      ? ''
      : nextOpening.none
        ? `No openings in ${MONTHS[mon - 1]}.`
        : nextOpening.open && !nextOpening.isFirst
          ? `Next opening: ${formatShortDate(nextOpening.open)}`
          : '';

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
      <div className="bp-cal-grid bp-cal-head" aria-hidden="true">
        {WEEKDAYS.map((w) => (
          <span key={w} className="bp-cal-weekday">
            {w}
          </span>
        ))}
      </div>
      <div
        className={`bp-cal-grid${gridBusy ? ' bp-cal-busy' : ''}`}
        role="grid"
        aria-label={`${MONTHS[mon - 1]} ${year} availability`}
        aria-busy={loading || undefined}
        ref={gridRef}
        onKeyDown={onGridKeyDown}
        onMouseLeave={() => setHoverDate(null)}
      >
        {rows.map((row, r) => (
          // display:contents — the row exists for the accessibility tree; the 7-column grid
          // layout is unchanged, and with it the reserved six-row height.
          <div className="bp-cal-row" role="row" key={r}>
            {row.map((date, i) => {
              if (!date) return <span key={i} className="bp-cal-empty" role="gridcell" />;
              const d = days.get(date);
              const past = !!(today && date < today);
              const weekend = !!weekdaysOnly && isWeekend(date);
              const isToday = !!today && date === today;
              const holiday = holidays.get(date) ?? null;
              const blocked = past || weekend || d?.status === 'unavailable';
              // Why this day can't be picked, in the customer's words. The server owns every
              // reason it knows (capacity, blocked, outside the booking window); the two the
              // client alone can see — a past day and a weekday-only weekend — are named here.
              const reason = past
                ? 'Already past'
                : weekend
                  ? 'Weekdays only'
                  : (d?.reason ?? null);
              const cls = ['bp-cal-day'];
              if (past) cls.push('bp-past');
              else if (weekend || d?.status === 'unavailable') cls.push('bp-unavail');
              else if (d?.status === 'partial') cls.push('bp-partial');
              if (d?.mine) cls.push('bp-mine');
              if (isToday) cls.push('bp-today');
              if (holiday) cls.push('bp-cal-holiday');
              const pos = rangePosition(bandValue, date, shape);
              if (pos !== 'none') {
                cls.push('bp-sel', `bp-sel-${pos === 'middle' ? 'mid' : pos}`);
                // Everything past the committed start is a PREVIEW while a second tap is
                // pending — tinted, not solid, so "chosen" and "considering" never look alike.
                if (candidateEnd && date > value.start!) cls.push('bp-prov');
              }
              // Selection is announced from the COMMITTED value, never the provisional band: a
              // preview that follows the cursor (or, for a keyboard user, the focus) is not a
              // choice, and calling it "selected" would tell a screen-reader user they had picked
              // dates they have not picked. aria-selected is the idiomatic carrier in a
              // role="grid", and is set only where true — false on all 31 cells would have every
              // arrow keypress announce "not selected".
              const chosen = rangePosition(value, date, shape);
              const notes = [
                isToday ? 'today' : null,
                past ? 'past' : weekend ? 'weekdays only' : (d?.status ?? null),
                // Only the server's reason is additive; the client's two already read as above.
                past || weekend ? null : (d?.reason ?? null),
                // Which END of the stay this is — aria-selected alone says "in the range", not
                // "this is your check-in day".
                SELECTION_NOTE[chosen],
                d?.mine ? 'your booking' : null,
                holiday,
              ].filter(Boolean);
              return (
                <button
                  type="button"
                  key={i}
                  role="gridcell"
                  data-date={date}
                  className={cls.join(' ')}
                  // aria-disabled, not disabled: a `disabled` button drops out of the focus
                  // order, and the whole point of the roving grid is that a customer can arrow
                  // ONTO a struck-out day and hear why it's struck out. `pick` no-ops anyway.
                  aria-disabled={gridBusy || blocked || undefined}
                  aria-selected={chosen !== 'none' || undefined}
                  tabIndex={date === anchor ? 0 : -1}
                  title={[holiday, reason].filter(Boolean).join(' — ') || undefined}
                  aria-label={[date, ...notes].join(', ')}
                  onClick={() => pick(date)}
                  onFocus={() => setFocusDate(date)}
                  // Only while a second tap is pending — otherwise every mouse move across the
                  // grid would be a state update with nothing to show for it.
                  onMouseEnter={() => {
                    if (awaitingEnd) setHoverDate(date);
                  }}
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
        ))}
      </div>
      {/* Always rendered with a reserved height (see widget.css) — a line that appears and
          disappears as the customer hovers days would bounce the host page's iframe on every
          mouse move. Whatever it says, it occupies the same space. */}
      <p
        className={`bp-cal-note${verdict && !verdict.ok ? ' bp-cal-note-bad' : ''}`}
        role="status"
        aria-live="polite"
      >
        {note}
      </p>
      {(() => {
        // Built from the RETAINED response, not the loading-gated `days`: gating it here emptied
        // the legend mid-fetch, unmounting the whole <ul> and then remounting it — a shrink-then-
        // grow the auto-resizing iframe faithfully forwards to the host page on every month
        // change. The <ul> is also always rendered (see .bp-cal-legend's min-height) so a month
        // that happens to need no entries doesn't collapse it either.
        const states = [...(data?.days.values() ?? [])];
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
        return <ul className="bp-cal-legend">{legend}</ul>;
      })()}
      {loadError && <p className="bp-error">Couldn&apos;t load availability — please reload.</p>}
    </div>
  );
}
