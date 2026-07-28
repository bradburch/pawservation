import { useEffect, useRef, useState } from 'react';
import { adminApi, type AdminBooking } from '../../shared-ui/api.js';
import { IconClipboardCheck } from '../../shared-ui/icons';
import { ChargesPanel } from '../ChargesPanel';
import { PaymentsPanel } from '../PaymentsPanel';
import { totalDue, type ServiceForm, type Session } from '../shared.js';
import { formatFriendlyDate } from '../../../src/shared/index.js';
import { Hint } from '../Hint';

/** Renders the dates for one row: single date (+ time, for timed services), or a range with the
 * customer's optional arrival time. Humanized ("Jul 29 – 31" not "2026-07-29 – 2026-07-31") —
 * this is the sitter's densest view, and it was the last surface still speaking raw ISO. */
function formatWhen(b: AdminBooking): string {
  const range = b.endDate
    ? `${formatFriendlyDate(b.startDate)} – ${formatFriendlyDate(b.endDate)}`
    : formatFriendlyDate(b.startDate);
  if (!b.startTime) return range;
  return b.endDate ? `${range}, arriving ${b.startTime}` : `${range} at ${b.startTime}`;
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

/** Payment state for a row; null for unpaid rows with nothing owing. 'paid in full' covers
 * overpayment/tips. Measured against `totalDue` — the stay price PLUS any extra charges — so a
 * booking with a $45 vet visit on it does not read "paid in full" at the stay price. Shown for
 * cancelled/declined rows too, so a sitter reviewing a refund case can still see the amount. */
function paidText(b: AdminBooking): string | null {
  const due = totalDue(b);
  if (b.paidTotal === 0) return due != null && b.chargesTotal > 0 ? `owes $${due}` : null;
  if (due == null) return `paid $${b.paidTotal}`;
  return b.paidTotal >= due ? 'paid in full' : `paid $${b.paidTotal} of $${due}`;
}

/** Fee state for a cancelled row that had a cancellation fee assessed. Mirrors paidText's
 * "paid $X of $Y" shape, so a sitter reviewing the row sees the amount and how much of it has
 * been collected. Takes precedence over paidText on those rows. The fee itself and any extra
 * charges are stated separately (EarningsSection's honest phrasing) rather than pre-summed —
 * "fee $100 + $45 extras", never a single merged "$145" that reads as if it were the fee. */
function feeText(b: AdminBooking): string | null {
  if (b.status !== 'cancelled' || b.cancellationFee == null) return null;
  const extras = b.chargesTotal > 0 ? ` + $${b.chargesTotal} extras` : '';
  return b.paidTotal > 0
    ? `paid $${b.paidTotal} of fee $${b.cancellationFee}${extras}`
    : `fee $${b.cancellationFee}${extras}`;
}

type ListProps = {
  session: Session;
  /** Reloads the ONE shared bookings array held by Dashboard — a status change made through any
   * mounted list refreshes every consumer (Bookings and, from Task 3 on, Calendar). */
  reloadBookings: () => void;
  handleError: (e: unknown) => void;
  clearError: () => void;
  services: ServiceForm[];
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
  services,
}: ListProps & { items: AdminBooking[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const questionLabel = (type: string, qid: string): string => {
    const svc = services.find((s) => s.type === type);
    return svc?.questions.find((q) => q.id === qid)?.label ?? qid;
  };

  const setStatus = async (b: AdminBooking, status: 'confirmed' | 'declined' | 'cancelled') => {
    if (busyId) return;
    if (
      status === 'cancelled' &&
      !window.confirm(
        `Cancel ${b.customerName || b.customerEmail || 'this client'}'s ${b.type} booking (${formatWhen(b)})? This can't be undone.`,
      )
    )
      return;
    // Second prompt only when there's actually a fee to charge on this cancel; OK charges it,
    // Cancel waives it. Confirmed rows of a tiers service carry feeIfCancelledToday.
    let chargeFee = false;
    if (status === 'cancelled' && b.feeIfCancelledToday != null && b.feeIfCancelledToday > 0) {
      chargeFee = window.confirm(
        `Charge the $${b.feeIfCancelledToday} cancellation fee? OK charges it; Cancel waives it.`,
      );
    }
    clearError();
    setMessage('');
    setBusyId(b.id);
    try {
      const { notified, cancellationFee } = await adminApi.bookings.setStatus(
        session.slug,
        session.token,
        b.id,
        status,
        chargeFee,
      );
      const who = b.customerName || b.customerEmail || 'the client';
      const verb =
        status === 'confirmed' ? 'Confirmed' : status === 'declined' ? 'Declined' : 'Cancelled';
      setMessage(
        `${verb} ${who}'s ${b.type} ${status === 'cancelled' ? 'booking' : 'request'}. ` +
          (notified
            ? `We emailed ${who} the update.`
            : `${who} couldn't be emailed automatically (email sending isn't set up), so let them know directly.`) +
          // Server-computed (authoritative) amount, not the client-side feeIfCancelledToday preview.
          (chargeFee && cancellationFee != null
            ? ` Charged $${cancellationFee} cancellation fee.`
            : ''),
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
          <button
            className="pb-confirm"
            disabled={busyId === b.id}
            onClick={() => void setStatus(b, 'confirmed')}
            aria-label={`Confirm ${b.customerName ?? 'this booking'}, ${formatWhen(b)}`}
          >
            Confirm
          </button>
          <button
            disabled={busyId === b.id}
            onClick={() => void setStatus(b, 'declined')}
            aria-label={`Decline ${b.customerName ?? 'this booking'}, ${formatWhen(b)}`}
          >
            Decline
          </button>
        </>
      )}
      {b.status === 'confirmed' && (
        <button disabled={busyId === b.id} onClick={() => void setStatus(b, 'cancelled')}>
          Cancel
        </button>
      )}
      {(isActive(b) ||
        b.paidTotal > 0 ||
        b.chargesTotal > 0 ||
        Object.keys(b.answers).length > 0) && (
        <button onClick={() => setOpenId(openId === b.id ? null : b.id)}>
          {openId === b.id ? 'Close' : 'Details'}
        </button>
      )}
    </span>
  );

  const row = (b: AdminBooking) => {
    const paid = feeText(b) ?? paidText(b);
    return (
      <li key={b.id} data-booking-id={b.id}>
        <span>
          {b.customerName || b.customerEmail || 'Unknown customer'} — {b.type}
          <br />
          {formatWhen(b)} · {b.petCount} pet{b.petCount === 1 ? '' : 's'}
          {b.estCost != null ? ` · $${b.estCost}` : ''}
          {b.chargesTotal > 0 ? ` + $${b.chargesTotal} extras` : ''}{' '}
          {/* Capitalized to match the client-status chips ("Active"/"Pending") in Clients. */}
          <span className={`pb-chip${chipClass(b.status)}`}>
            {b.status.charAt(0).toUpperCase() + b.status.slice(1)}
          </span>
          {paid && <> · {paid}</>}
        </span>
        {actionsFor(b)}
        {(isActive(b) ||
          b.paidTotal > 0 ||
          b.chargesTotal > 0 ||
          Object.keys(b.answers).length > 0) &&
          openId === b.id && (
            <>
              {Object.keys(b.answers).length > 0 && (
                <dl className="pb-answers">
                  <div className="pb-answers-title">Their answers</div>
                  {Object.entries(b.answers).map(([qid, answer]) => (
                    <div key={qid}>
                      <dt>{questionLabel(b.type, qid)}</dt>
                      <dd>{answer}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <ChargesPanel
                session={session}
                bookingId={b.id}
                onChanged={async () => reloadBookings()}
                handleError={handleError}
                allowAdd={isActive(b)}
              />
              <PaymentsPanel
                session={session}
                bookingId={b.id}
                onChanged={async () => reloadBookings()}
                handleError={handleError}
                allowRecord={isActive(b)}
              />
            </>
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
  services,
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
          services={services}
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
  services,
}: ListProps & {
  bookings: AdminBooking[] | null;
  /** Chip deep-link from CalendarSection: scroll this booking's row into view and flash it. */
  focusId?: string | null;
  onFocusConsumed?: () => void;
}) {
  // External rows (materialized Google Calendar events) have no actions, no payments, no
  // customer — they belong on the calendar only, never in this list.
  const real = bookings === null ? null : bookings.filter((b) => !b.external);
  const rest = (real ?? []).filter((b) => b.status !== 'pending').sort(byStartDate);

  // Scoped querySelector (not getElementById): CalendarSection's PendingRequestsList renders the
  // same rows with the same data-booking-id in its own (hidden) panel — a document-wide lookup
  // could match that hidden copy instead of this section's row.
  const listWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusId || real === null) return;
    const el = listWrapRef.current?.querySelector<HTMLElement>(
      `[data-booking-id="${CSS.escape(focusId)}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('pb-focus-flash');
      window.setTimeout(() => el.classList.remove('pb-focus-flash'), 2000);
    }
    onFocusConsumed?.();
  }, [focusId, real, onFocusConsumed]);

  return (
    <div ref={listWrapRef}>
      <h2>
        <IconClipboardCheck size={18} /> Bookings
        <Hint label="Bookings">
          Every request your clients send lands here — nothing is booked until you confirm it.
          Confirming or declining emails the client automatically.
        </Hint>
      </h2>
      {real === null ? (
        <p>Loading…</p>
      ) : real.length === 0 ? (
        <p className="pb-hint">No bookings yet.</p>
      ) : (
        <>
          <PendingRequestsList
            bookings={real}
            session={session}
            reloadBookings={reloadBookings}
            handleError={handleError}
            clearError={clearError}
            services={services}
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
                services={services}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
