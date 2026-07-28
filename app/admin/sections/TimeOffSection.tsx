import { useState } from 'react';
import { addDays, formatBlockRange } from '../../../src/shared/index.js';
import { IconCalendar } from '../../shared-ui/icons';
import type { Settings } from '../shared.js';
import { adminFetch } from '../shared.js';
import { Hint } from '../Hint';

export function TimeOffSection({
  blocked,
  slug,
  token,
  onChanged,
  handleError,
  clearError,
}: {
  blocked: Settings['blocked'];
  slug: string;
  token: string;
  onChanged: () => Promise<void>;
  handleError: (e: unknown) => void;
  clearError: () => void;
}) {
  const [blockStart, setBlockStart] = useState('');
  const [blockEnd, setBlockEnd] = useState('');
  const [busy, setBusy] = useState(false);

  // The sitter types the FIRST and LAST day off (inclusive — how humans say "Aug 10–17");
  // the API/DB convention is an exclusive end, so convert at this boundary.
  const rangeValid = blockStart !== '' && blockEnd !== '' && blockEnd >= blockStart;

  const addBlock = async () => {
    if (busy || !rangeValid) return;
    clearError();
    setBusy(true);
    try {
      await adminFetch(token, `/api/${slug}/admin/blocked`, {
        method: 'POST',
        body: JSON.stringify({ startDate: blockStart, endDate: addDays(blockEnd, 1) }),
      });
      setBlockStart('');
      setBlockEnd('');
      await onChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const removeBlock = async (id: string) => {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      await adminFetch(token, `/api/${slug}/admin/blocked/${id}`, { method: 'DELETE' });
      await onChanged();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>
        <IconCalendar size={18} /> Time off
        <Hint label="Time off">
          Days you don&rsquo;t want bookings. Blocked days disappear from clients&rsquo; calendars
          immediately — no save needed — and they only stop <em>new</em> requests. A booking
          you&rsquo;ve already confirmed is never cancelled by blocking a day.
        </Hint>
      </h2>
      <p className="pb-applies">Changes here apply immediately.</p>
      <ul>
        {blocked.map((b) => (
          <li key={b.id}>
            {formatBlockRange(b.startDate, b.endDate)}
            <button
              onClick={() => void removeBlock(b.id)}
              aria-label={`Remove time off ${formatBlockRange(b.startDate, b.endDate)}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="pb-inline">
        <label className="pb-inline">
          First day off
          <input type="date" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
        </label>
        <label className="pb-inline">
          Last day off
          <input type="date" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
        </label>
        <button onClick={() => void addBlock()} disabled={busy || !rangeValid}>
          {busy ? 'Saving…' : 'Block these days'}
        </button>
      </div>
      <p className="pb-hint">
        Both days are included — for one day off, pick the same day twice.
        {blockStart && blockEnd && blockEnd < blockStart
          ? ' The last day must be on or after the first day.'
          : ''}
      </p>
      <p className="pb-hint">
        <strong>How unavailable days work.</strong> Blocking days stops <em>new</em> requests for
        those dates — clients simply can&rsquo;t pick them. It never changes a booking you&rsquo;ve
        already confirmed, and it never cancels anything. Events on a connected Google Calendar work
        the same way (see <a href="#apps">Connected apps</a>). And nothing is ever booked without
        you: every request waits under <a href="#bookings">Bookings</a> until you confirm or decline
        it.
      </p>
    </>
  );
}
