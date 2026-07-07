import { useCallback } from 'react';
import { formatShortDate } from '../../src/shared/index.js';
import { api, getToken, isAuthExpired, setToken, type Booking } from '../shared-ui/api';
import { useAsync } from '../shared-ui/useAsync';
import { Identify } from './Identify';
import { errorMsg, slug } from './shared';

type MineOutcome =
  { kind: 'ok'; bookings: Booking[] } | { kind: 'reauth' } | { kind: 'error'; message: string };

export function MineTab() {
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

  // Seeded from token presence until the first load settles, so there's no flash of the wrong
  // view while `outcome` is still null.
  const needIdentify = outcome ? outcome.kind === 'reauth' : !getToken(slug);
  const error = outcome?.kind === 'error' ? outcome.message : '';
  const bookings = outcome?.kind === 'ok' ? outcome.bookings : null;

  if (needIdentify) return <Identify onDone={reload} />;
  if (error) return <p className="bp-error">{error}</p>;
  if (!bookings) return <p>Loading…</p>;
  if (bookings.length === 0) return <p>No bookings yet — book one above!</p>;

  return (
    <ul className="bp-mine">
      {bookings.map((b) => (
        <li key={b.id}>
          <span className="bp-mine-main">
            <strong>{b.type}</strong> {formatShortDate(b.startDate)}
            {b.endDate ? ` – ${formatShortDate(b.endDate)}` : ''} ·{' '}
            {b.pets.length > 0
              ? b.pets.join(', ')
              : `${b.petCount} pet${b.petCount === 1 ? '' : 's'}`}
            {b.estCost != null ? ` · est. $${b.estCost}` : ''}
          </span>
          <em>{b.status}</em>
        </li>
      ))}
    </ul>
  );
}
