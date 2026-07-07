import { useEffect, useState } from 'react';
import { adminApi, type AdminBooking } from '../../shared-ui/api.js';
import { IconClipboardCheck } from '../../shared-ui/icons';
import type { Session } from '../shared.js';

/** Renders the dates for one row: single date (+ time, for timed services) or a range. */
function formatWhen(b: AdminBooking): string {
  const range = b.endDate ? `${b.startDate} – ${b.endDate}` : b.startDate;
  return b.startTime ? `${range} at ${b.startTime}` : range;
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

  const setStatus = async (id: string, status: 'confirmed' | 'cancelled') => {
    if (busyId) return;
    clearError();
    setBusyId(id);
    try {
      await adminApi.bookings.setStatus(session.slug, session.token, id, status);
      setBookings(await load());
    } catch (e) {
      handleError(e);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <h2>
        <IconClipboardCheck size={18} /> Bookings
      </h2>
      <p className="pb-applies">Confirm or decline requests as they come in.</p>
      {bookings === null ? (
        <p>Loading…</p>
      ) : bookings.length === 0 ? (
        <p className="pb-hint">No bookings yet.</p>
      ) : (
        <ul>
          {bookings.map((b) => (
            <li key={b.id}>
              <span>
                {b.customerName || b.customerEmail || 'Unknown customer'} — {b.type}
                <br />
                {formatWhen(b)} · {b.petCount} pet{b.petCount === 1 ? '' : 's'}
                {b.estCost != null ? ` · $${b.estCost}` : ''}{' '}
                <span
                  className={`pb-chip${
                    b.status === 'confirmed'
                      ? ' pb-chip-ok'
                      : b.status === 'cancelled'
                        ? ' pb-chip-warn'
                        : ''
                  }`}
                >
                  {b.status}
                </span>
              </span>
              <span>
                {b.status === 'pending' && (
                  <>
                    <button
                      disabled={busyId === b.id}
                      onClick={() => void setStatus(b.id, 'confirmed')}
                    >
                      Confirm
                    </button>
                    <button
                      disabled={busyId === b.id}
                      onClick={() => void setStatus(b.id, 'cancelled')}
                    >
                      Decline
                    </button>
                  </>
                )}
                {b.status === 'confirmed' && (
                  <button
                    disabled={busyId === b.id}
                    onClick={() => void setStatus(b.id, 'cancelled')}
                  >
                    Cancel
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
