import { useCallback, useState } from 'react';
import { formatFriendlyDate } from '../../src/shared/index.js';
import {
  api,
  getToken,
  isAuthExpired,
  setToken,
  type Booking,
  type TenantConfig,
} from '../shared-ui/api';
import { useAsync } from '../shared-ui/useAsync';
import { Identify } from './Identify';
import { errorMsg, slug } from './shared';

type MineOutcome =
  { kind: 'ok'; bookings: Booking[] } | { kind: 'reauth' } | { kind: 'error'; message: string };

/** Words, never colour alone — the status of a booking has to survive a greyscale screen. */
const STATUS_TEXT: Record<string, string> = {
  pending: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  declined: 'Declined',
};

function whenText(b: Booking): string {
  return b.endDate
    ? `${formatFriendlyDate(b.startDate)} – ${formatFriendlyDate(b.endDate)}`
    : formatFriendlyDate(b.startDate);
}

export function MineTab({ config }: { config: TenantConfig }) {
  // Resolves to a settled outcome rather than throwing — an expired/invalid token degrades to
  // re-identify (see server/lib/token.ts) instead of surfacing as a generic error.
  const load = useCallback(async (): Promise<MineOutcome> => {
    const token = getToken(slug);
    if (!token) return { kind: 'reauth' };
    try {
      const res = await api.myBookings(slug, token);
      return { kind: 'ok', bookings: res.bookings };
    } catch (e) {
      if (isAuthExpired(e)) {
        setToken(slug, null);
        return { kind: 'reauth' };
      }
      return { kind: 'error', message: errorMsg(e) };
    }
  }, []);

  const { data: outcome, reload } = useAsync(load);

  /** Which card is showing its confirm overlay; only ever one at a time. */
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState('');

  const labelFor = (type: string) => config.services.find((s) => s.type === type)?.label ?? type;

  async function cancel(b: Booking) {
    const token = getToken(slug);
    if (!token) return;
    setBusyId(b.id);
    setCancelError('');
    try {
      await api.cancelBooking(slug, token, b.id);
      setConfirmId(null);
      reload();
    } catch (e) {
      if (isAuthExpired(e)) {
        setToken(slug, null);
        reload();
        return;
      }
      setCancelError(errorMsg(e));
    } finally {
      setBusyId(null);
    }
  }

  // Seeded from token presence until the first load settles, so there's no flash of the wrong
  // view while `outcome` is still null.
  const needIdentify = outcome ? outcome.kind === 'reauth' : !getToken(slug);
  const error = outcome?.kind === 'error' ? outcome.message : '';
  const bookings = outcome?.kind === 'ok' ? outcome.bookings : null;

  if (needIdentify) return <Identify onDone={reload} />;
  if (error) return <p className="bp-error">{error}</p>;
  if (!bookings) return <p>Loading…</p>;
  if (bookings.length === 0)
    return <p>No bookings yet — switch to Book to request your first one.</p>;

  return (
    <ul className="bp-mine">
      {bookings.map((b) => {
        const confirming = confirmId === b.id;
        const fee = b.feeIfCancelledToday ?? 0;
        return (
          <li key={b.id} className="bp-mine-item">
            <div className="bp-mine-head">
              <strong className="bp-mine-title">{labelFor(b.type)}</strong>
              <span className="bp-mine-status">{STATUS_TEXT[b.status] ?? b.status}</span>
            </div>
            <div className="bp-mine-when">{whenText(b)}</div>
            <div className="bp-mine-meta">
              {b.pets.length > 0
                ? b.pets.join(', ')
                : `${b.petCount} pet${b.petCount === 1 ? '' : 's'}`}
              {b.estCost != null ? ` · est. $${b.estCost}` : ''}
              {b.chargesTotal > 0
                ? ` · plus $${b.chargesTotal} (${b.charges.map((ch) => ch.label).join(', ')})`
                : ''}
              {b.status === 'cancelled' && b.cancellationFee != null && b.cancellationFee > 0
                ? ` · cancellation fee $${b.cancellationFee}`
                : ''}
            </div>
            {/* The action slot is ALWAYS rendered, empty or not: the widget lives in an
                auto-resizing iframe, and a row that grows a button on some loads and not others
                changes scrollHeight and bounces the host page. */}
            <div className="bp-mine-actions">
              {b.cancellable ? (
                <button
                  type="button"
                  className="bp-mine-cancel"
                  onClick={() => {
                    setCancelError('');
                    setConfirmId(b.id);
                  }}
                >
                  Cancel booking
                </button>
              ) : null}
            </div>

            {/* Confirm step as an in-card overlay (absolute inset-0), NOT an expanding panel: it
                covers the card instead of adding to it, so document height is identical whether
                it's open or closed and the embedding page never jumps. */}
            {confirming ? (
              <div className="bp-mine-confirm" role="group" aria-label="Confirm cancellation">
                {/* Only the COPY scrolls; the action row below is pinned. A long contact line or a
                    wrapped service label must never push the buttons out of reach, and the fix
                    can't be "let the card grow" — that would move the host page. */}
                <div className="bp-mine-confirm-body">
                  <p className="bp-mine-confirm-q">Cancel this booking?</p>
                  <p className="bp-mine-confirm-fee">
                    {fee > 0
                      ? `A $${fee} cancellation fee applies.`
                      : 'No cancellation fee applies.'}
                  </p>
                  <p className="bp-mine-confirm-alt">
                    Need different dates instead?{' '}
                    {config.contactPhone ? (
                      <>
                        Call <a href={`tel:${config.contactPhone}`}>{config.contactPhone}</a>
                      </>
                    ) : null}
                    {config.contactPhone && config.contactEmail ? ' or ' : null}
                    {config.contactEmail ? (
                      <>
                        email <a href={`mailto:${config.contactEmail}`}>{config.contactEmail}</a>
                      </>
                    ) : null}
                    {!config.contactPhone && !config.contactEmail
                      ? `get in touch with ${config.displayName}`
                      : null}{' '}
                    to move it rather than cancel.
                  </p>
                  {/* Reserved slot: the message appears in space the overlay already occupies. */}
                  <p className="bp-mine-confirm-err">{cancelError}</p>
                </div>
                <div className="bp-mine-confirm-row">
                  <button
                    type="button"
                    className="bp-mine-keep"
                    onClick={() => {
                      setCancelError('');
                      setConfirmId(null);
                    }}
                  >
                    Keep booking
                  </button>
                  <button
                    type="button"
                    className="bp-mine-confirm-go"
                    disabled={busyId === b.id}
                    onClick={() => void cancel(b)}
                  >
                    {busyId === b.id ? 'Cancelling…' : 'Yes, cancel'}
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
