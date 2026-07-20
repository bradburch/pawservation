import { useMemo, useState } from 'react';
import {
  addDays,
  DEFAULT_TIMEZONE,
  getPacificDateStr,
  isWeekend,
  monthGrid,
  shiftMonth,
} from '../../../src/shared/index.js';
import type { AdminBooking } from '../../shared-ui/api.js';
import { IconCalendar, IconChevronLeft, IconChevronRight } from '../../shared-ui/icons';
import type { Session, Settings } from '../shared.js';
import { Hint } from '../Hint';
import { PendingRequestsList } from './BookingsSection';

/**
 * The sitter's month at a glance: time off as red-tinted bands, confirmed bookings as solid chips,
 * pending as hollow/dashed chips, with the shared "Needs your reply" list underneath. A viewport
 * onto existing data — clicking a chip deep-links to the booking's full row in Bookings rather
 * than re-implementing the row here (see the spec's deep-link rationale).
 */

type DayEntry = { kind: 'timeoff' } | { kind: 'booking'; booking: AdminBooking; label: string };

/** Customer first name → email → 'Guest'. */
function whoLabel(b: AdminBooking): string {
  const first = b.customerName?.trim().split(/\s+/)[0];
  return first || b.customerEmail || 'Guest';
}

function addEntry(map: Map<string, DayEntry[]>, date: string, entry: DayEntry): void {
  const list = map.get(date);
  if (list) list.push(entry);
  else map.set(date, [entry]);
}

/**
 * Paint `[start, endExclusive)` into the map, clipped to the viewed `month` ('YYYY-MM').
 * endExclusive follows the DB and Google all-day convention — the checkout/return day is NOT
 * painted, so the grid shows exactly the days Google shows. `endExclusive: null` paints
 * `start` alone. Spans that begin before the viewed month are clamped to its first day.
 */
function paintDays(
  map: Map<string, DayEntry[]>,
  start: string,
  endExclusive: string | null,
  month: string,
  entry: DayEntry,
): void {
  const stop = endExclusive ?? addDays(start, 1);
  const monthFirst = `${month}-01`;
  for (let d = start < monthFirst ? monthFirst : start; d < stop; d = addDays(d, 1)) {
    if (!d.startsWith(`${month}-`)) break; // ran past the viewed month
    addEntry(map, d, entry);
  }
}

/**
 * Reshape the shared bookings array + blocked ranges into per-day entries for one month.
 * Admin-app only (the server never needs this). Per-day order: time off first (rendered as the
 * band at the top of the cell), then bookings untimed-first, then by startTime.
 */
export function buildMonthEntries(
  bookings: AdminBooking[],
  blocked: Settings['blocked'],
  services: Settings['services'],
  month: string,
): Map<string, DayEntry[]> {
  const map = new Map<string, DayEntry[]>();
  for (const b of blocked) {
    paintDays(map, b.startDate, b.endDate, month, { kind: 'timeoff' });
  }
  const labelFor = (type: string) => services.find((s) => s.type === type)?.label ?? type;
  const active = bookings
    .filter((b) => b.status !== 'cancelled' && b.status !== 'declined')
    .sort((a, b) => (a.startTime ?? '').localeCompare(b.startTime ?? ''));
  for (const b of active) {
    paintDays(map, b.startDate, b.endDate, month, {
      kind: 'booking',
      booking: b,
      label: `${whoLabel(b)} · ${labelFor(b.type)}`,
    });
  }
  return map;
}

function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MAX_PER_CELL = 3;

function DayCell({
  date,
  entries,
  isToday,
  onOpenBooking,
}: {
  date: string;
  entries: DayEntry[];
  isToday: boolean;
  onOpenBooking: (id: string) => void;
}) {
  // Day-state tint, one per cell by priority: time off (not available, red family)
  // over confirmed (green family) over pending (lighter hollow). Chips/bands inside
  // the cell keep their own shape cues (solid vs dashed vs band) for colorblind users.
  const hasTimeoff = entries.some((e) => e.kind === 'timeoff');
  const hasConfirmed = entries.some(
    (e) => e.kind === 'booking' && e.booking.status === 'confirmed',
  );
  const hasPending = entries.some((e) => e.kind === 'booking' && e.booking.status === 'pending');
  const state = hasTimeoff
    ? ' pb-cal-off'
    : hasConfirmed
      ? ' pb-cal-booked'
      : hasPending
        ? ' pb-cal-pend'
        : '';
  const cellClass =
    'pb-cal-cell' +
    (isWeekend(date) ? ' pb-cal-weekend' : '') +
    state +
    (isToday ? ' pb-cal-today' : '');
  return (
    <div className={cellClass}>
      <span className="pb-cal-daynum">{Number(date.slice(8))}</span>
      {entries.slice(0, MAX_PER_CELL).map((entry, j) =>
        entry.kind === 'timeoff' ? (
          <span key={`t-${j}`} className="pb-cal-timeoff">
            Time off
          </span>
        ) : (
          <button
            key={entry.booking.id}
            type="button"
            className={`pb-cal-chip${entry.booking.status === 'pending' ? ' pb-cal-chip-pending' : ''}`}
            title={`${entry.label} — open in Bookings`}
            onClick={() => onOpenBooking(entry.booking.id)}
          >
            {entry.label}
          </button>
        ),
      )}
      {entries.length > MAX_PER_CELL && (
        <button
          type="button"
          className="pb-cal-more"
          onClick={() => {
            window.location.hash = 'bookings';
          }}
        >
          +{entries.length - MAX_PER_CELL} more
        </button>
      )}
    </div>
  );
}

export function CalendarSection({
  session,
  settings,
  bookings,
  reloadBookings,
  onOpenBooking,
  handleError,
  clearError,
}: {
  session: Session;
  settings: Settings;
  bookings: AdminBooking[] | null;
  reloadBookings: () => void;
  /** Chip click-through: Dashboard sets focusBookingId and navigates to #bookings. */
  onOpenBooking: (id: string) => void;
  handleError: (e: unknown) => void;
  clearError: () => void;
}) {
  // Tenant-zone "today" — matches the sitter's business day, not the browser's zone.
  const today = getPacificDateStr(new Date(), settings.timezone ?? DEFAULT_TIMEZONE);
  const [month, setMonth] = useState(() => today.slice(0, 7));

  const entriesByDay = useMemo(
    () => buildMonthEntries(bookings ?? [], settings.blocked, settings.services, month),
    [bookings, settings.blocked, settings.services, month],
  );

  const cells = monthGrid(month);

  return (
    <>
      <h2>
        <IconCalendar size={18} /> Calendar
        <Hint label="Calendar">
          Your month at a glance — confirmed bookings, requests waiting on you, and your time off.
          Tap any booking to open its full details under Bookings.
        </Hint>
      </h2>
      {bookings === null ? (
        <p>Loading…</p>
      ) : (
        <>
          <div className="pb-cal-head">
            <h3>{monthTitle(month)}</h3>
            <div className="pb-cal-nav">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setMonth((m) => shiftMonth(m, -1))}
              >
                <IconChevronLeft size={16} />
              </button>
              <button type="button" onClick={() => setMonth(today.slice(0, 7))}>
                Today
              </button>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setMonth((m) => shiftMonth(m, 1))}
              >
                <IconChevronRight size={16} />
              </button>
            </div>
          </div>

          <div className="pb-cal-grid">
            {DOW.map((d) => (
              <div key={d} className="pb-cal-dow" aria-hidden="true">
                {d}
              </div>
            ))}
            {cells.map((date, i) =>
              date === null ? (
                <div key={`lead-${i}`} className="pb-cal-cell pb-cal-blank" />
              ) : (
                <DayCell
                  key={date}
                  date={date}
                  entries={entriesByDay.get(date) ?? []}
                  isToday={date === today}
                  onOpenBooking={onOpenBooking}
                />
              ),
            )}
          </div>

          {entriesByDay.size === 0 && <p className="pb-hint">Nothing booked this month yet.</p>}

          {/* Plain-words legend for the three visual styles above. */}
          <div className="pb-cal-legend">
            <span>
              <span className="pb-cal-key pb-cal-key-confirmed" /> Confirmed
            </span>
            <span>
              <span className="pb-cal-key pb-cal-key-pending" /> Waiting for your reply
            </span>
            <span>
              <span className="pb-cal-key pb-cal-key-timeoff" /> Time off
            </span>
          </div>

          <p className="pb-hint pb-cal-sync">
            {settings.calendar.status === 'connected' ? (
              'Synced with your Google Calendar.'
            ) : (
              <>
                Connect Google Calendar in <a href="#apps">Connected apps</a> to see these on your
                phone&rsquo;s calendar.
              </>
            )}
          </p>

          <PendingRequestsList
            bookings={bookings}
            session={session}
            reloadBookings={reloadBookings}
            handleError={handleError}
            clearError={clearError}
          />
        </>
      )}
    </>
  );
}
