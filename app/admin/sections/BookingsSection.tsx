import { useEffect, useRef, useState } from 'react';
import { adminApi, type AdminBooking } from '../../shared-ui/api.js';
import { IconClipboardCheck } from '../../shared-ui/icons';
import { PaymentsPanel } from '../PaymentsPanel';
import type { Session } from '../shared.js';
import { Hint } from '../Hint';

/** Renders the dates for one row: single date (+ time, for timed services) or a range. */
function formatWhen(b: AdminBooking): string {
  const range = b.endDate ? `${b.startDate} – ${b.endDate}` : b.startDate;
  return b.startTime ? `${range} at ${b.startTime}` : range;
}

const byStartDate = (a: AdminBooking, b: AdminBooking) => a.startDate.localeCompare(b.startDate);

/** True for bookings that aren't cancelled/declined — the payments ledger is fully editable for
 * these; cancelled/declined rows show a read-only ledger only when they have payments to show. */
const isActive = (b: AdminBooking) => b.status !== 'cancelled' && b.status !== 'declined';

function chipClass(status: string): string {
  if (status === 'confirmed') return ' pb-chip-ok';
  if (status === 'cancelled') return ' pb-chip-bad';
  if (status === 'declined') return ' pb-chip-warn';
  return '';
}

/** Payment state for a row; null for unpaid rows. 'paid in full' covers overpayment/tips
 * (paidTotal > estCost). Shown for cancelled/declined rows too, so a sitter reviewing a refund
 * case can still see the amount. */
function paidText(b: AdminBooking): string | null {
  if (b.paidTotal === 0) return null;
  if (b.estCost == null) return `paid $${b.paidTotal}`;
  return b.paidTotal >= b.estCost ? 'paid in full' : `paid $${b.paidTotal} of $${b.estCost}`;
}

type ListProps = {
  session: Session;
  /** Reloads the ONE shared bookings array held by Dashboard — a status change made through any
   * mounted list refreshes every consumer (Bookings and, from Task 3 on, Calendar). */
  reloadBookings: () => void;
  handleError: (e: unknown) => void;
  clearError: () => void;
};

/**
 * The stateful row machinery, one instance per rendered list: rows with status chips,
 * Confirm/Decline/Cancel actions, and the PaymentsPanel toggle. `busyId`/`openId`/`message`
 * are deliberately per-instance (spec: each mounted copy runs independently).
 */
function BookingList({
  items,
  session,
  reloadBookings,
  handleError,
  clearError,
}: ListProps & { items: AdminBooking[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const setStatus = async (b: AdminBooking, status: 'confirmed' | 'declined' | 'cancelled') => {
    if (busyId) return;
    if (
      status === 'cancelled' &&
      !window.confirm(
        `Cancel ${b.customerName || b.customerEmail || 'this client'}'s ${b.type} booking (${formatWhen(b)})? This can't be undone.`,
      )
    )
      return;
    clearError();
    setMessage('');
    setBusyId(b.id);
    try {
      const { notified } = await adminApi.bookings.setStatus(
        session.slug,
        session.token,
        b.id,
        status,
      );
      const who = b.customerName || b.customerEmail || 'the client';
      const verb =
        status === 'confirmed' ? 'Confirmed' : status === 'declined' ? 'Declined' : 'Cancelled';
      setMessage(
        `${verb} ${who}'s ${b.type} ${status === 'cancelled' ? 'booking' : 'request'}. ` +
          (notified
            ? `We emailed ${who} the update.`
            : `${who} couldn't be emailed automatically (email sending isn't set up), so let them know directly.`),
      );
      reloadBookings();
    } catch (e) {
      handleError(e);
    } finally {
      setBusyId(null);
    }
  };

  const actionsFor = (b: AdminBooking) => (
    <span>
      {b.status === 'pending' && (
        <>
          <button disabled={busyId === b.id} onClick={() => void setStatus(b, 'confirmed')}>
            Confirm
          </button>
          <button disabled={busyId === b.id} onClick={() => void setStatus(b, 'declined')}>
            Decline
          </button>
        </>
      )}
      {b.status === 'confirmed' && (
        <button disabled={busyId === b.id} onClick={() => void setStatus(b, 'cancelled')}>
          Cancel
        </button>
      )}
      {(isActive(b) || b.paidTotal > 0) && (
        <button onClick={() => setOpenId(openId === b.id ? null : b.id)}>
          {openId === b.id ? 'Close' : 'Payments'}
        </button>
      )}
    </span>
  );

  const row = (b: AdminBooking) => {
    const paid = paidText(b);
    return (
      <li key={b.id} data-booking-id={b.id}>
        <span>
          {b.customerName || b.customerEmail || 'Unknown customer'} — {b.type}
          <br />
          {formatWhen(b)} · {b.petCount} pet{b.petCount === 1 ? '' : 's'}
          {b.estCost != null ? ` · $${b.estCost}` : ''}{' '}
          {/* Capitalized to match the client-status chips ("Active"/"Pending") in Clients. */}
          <span className={`pb-chip${chipClass(b.status)}`}>
            {b.status.charAt(0).toUpperCase() + b.status.slice(1)}
          </span>
          {paid && <> · {paid}</>}
        </span>
        {actionsFor(b)}
        {(isActive(b) || b.paidTotal > 0) && openId === b.id && (
          <PaymentsPanel
            session={session}
            bookingId={b.id}
            onChanged={async () => reloadBookings()}
            handleError={handleError}
            allowRecord={isActive(b)}
          />
        )}
      </li>
    );
  };

  return (
    <>
      {/* Fixed to the viewport bottom (reusing the save bar's styling) so it can't scroll out
          of view or slide under the sticky header — it carries the "was the client told?" info. */}
      {message && (
        <div className="pb-savebar" role="status">
          <p className="pb-savebar-saved">{message}</p>
          <button onClick={() => setMessage('')}>OK</button>
        </div>
      )}
      <ul>{items.map(row)}</ul>
    </>
  );
}

/**
 * "Needs your reply" — the full pending-request rows (customer, dates, pet count, cost, status
 * chip, Confirm/Decline, PaymentsPanel), shared by BookingsSection and CalendarSection as the
 * same component rather than a re-derived summary. Filters and sorts to pending itself.
 */
export function PendingRequestsList({
  bookings,
  session,
  reloadBookings,
  handleError,
  clearError,
}: ListProps & { bookings: AdminBooking[] }) {
  const pending = bookings.filter((b) => b.status === 'pending').sort(byStartDate);
  return (
    <>
      <h3>
        {pending.length === 0
          ? 'No requests waiting for a reply'
          : `Needs your reply (${pending.length})`}
      </h3>
      {pending.length > 0 && (
        <BookingList
          items={pending}
          session={session}
          reloadBookings={reloadBookings}
          handleError={handleError}
          clearError={clearError}
        />
      )}
    </>
  );
}

export function BookingsSection({
  session,
  bookings,
  reloadBookings,
  handleError,
  clearError,
  focusId,
  onFocusConsumed,
}: ListProps & {
  bookings: AdminBooking[] | null;
  /** Chip deep-link from CalendarSection: scroll this booking's row into view and flash it. */
  focusId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const rest = (bookings ?? []).filter((b) => b.status !== 'pending').sort(byStartDate);

  // Scoped querySelector (not getElementById): CalendarSection's PendingRequestsList renders the
  // same rows with the same data-booking-id in its own (hidden) panel — a document-wide lookup
  // could match that hidden copy instead of this section's row.
  const listWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusId || bookings === null) return;
    const el = listWrapRef.current?.querySelector<HTMLElement>(
      `[data-booking-id="${CSS.escape(focusId)}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('pb-focus-flash');
      window.setTimeout(() => el.classList.remove('pb-focus-flash'), 2000);
    }
    onFocusConsumed?.();
  }, [focusId, bookings, onFocusConsumed]);

  return (
    <div ref={listWrapRef}>
      <h2>
        <IconClipboardCheck size={18} /> Bookings
        <Hint label="Bookings">
          Every request your clients send lands here — nothing is booked until you confirm it.
          Confirming or declining emails the client automatically.
        </Hint>
      </h2>
      {bookings === null ? (
        <p>Loading…</p>
      ) : bookings.length === 0 ? (
        <p className="pb-hint">No bookings yet.</p>
      ) : (
        <>
          <PendingRequestsList
            bookings={bookings}
            session={session}
            reloadBookings={reloadBookings}
            handleError={handleError}
            clearError={clearError}
          />
          {rest.length > 0 && (
            <>
              <h3>Everything else</h3>
              <BookingList
                items={rest}
                session={session}
                reloadBookings={reloadBookings}
                handleError={handleError}
                clearError={clearError}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
