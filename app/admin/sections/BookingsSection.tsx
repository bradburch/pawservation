import { useEffect, useState } from 'react';
import { adminApi, type AdminBooking } from '../../shared-ui/api.js';
import { IconClipboardCheck } from '../../shared-ui/icons';
import { PaymentsPanel } from '../PaymentsPanel';
import type { Session } from '../shared.js';

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

export function BookingsSection({
  session,
  handleError,
  clearError,
}: {
  session: Session;
  handleError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [bookings, setBookings] = useState<AdminBooking[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const load = () =>
    adminApi.bookings.list(session.slug, session.token).then(({ bookings: list }) => list);

  useEffect(() => {
    let active = true;
    load()
      .then((list) => active && setBookings(list))
      .catch((e) => active && handleError(e));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

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
      setBookings(await load());
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
      <li key={b.id}>
        <span>
          {b.customerName || b.customerEmail || 'Unknown customer'} — {b.type}
          <br />
          {formatWhen(b)} · {b.petCount} pet{b.petCount === 1 ? '' : 's'}
          {b.estCost != null ? ` · $${b.estCost}` : ''}{' '}
          <span className={`pb-chip${chipClass(b.status)}`}>{b.status}</span>
          {paid && <> · {paid}</>}
        </span>
        {actionsFor(b)}
        {(isActive(b) || b.paidTotal > 0) && openId === b.id && (
          <PaymentsPanel
            session={session}
            bookingId={b.id}
            onChanged={async () => setBookings(await load())}
            handleError={handleError}
            allowRecord={isActive(b)}
          />
        )}
      </li>
    );
  };

  const pending = (bookings ?? []).filter((b) => b.status === 'pending').sort(byStartDate);
  const rest = (bookings ?? []).filter((b) => b.status !== 'pending').sort(byStartDate);

  return (
    <>
      <h2>
        <IconClipboardCheck size={18} /> Bookings
      </h2>
      {/* Fixed to the viewport bottom (reusing the save bar's styling) so it can't scroll out
          of view or slide under the sticky header — it carries the "was the client told?" info. */}
      {message && (
        <div className="pb-savebar" role="status">
          <p className="pb-savebar-saved">{message}</p>
          <button onClick={() => setMessage('')}>OK</button>
        </div>
      )}
      {bookings === null ? (
        <p>Loading…</p>
      ) : bookings.length === 0 ? (
        <p className="pb-hint">No bookings yet.</p>
      ) : (
        <>
          <h3>
            {pending.length === 0
              ? 'No requests waiting for a reply'
              : `Needs your reply (${pending.length})`}
          </h3>
          {pending.length > 0 && <ul>{pending.map(row)}</ul>}
          {rest.length > 0 && (
            <>
              <h3>Everything else</h3>
              <ul>{rest.map(row)}</ul>
            </>
          )}
        </>
      )}
    </>
  );
}
