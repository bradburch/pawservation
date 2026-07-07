import { useState } from 'react';
import { formatBlockRange } from '../../../src/shared/index.js';
import { IconCalendar } from '../../shared-ui/icons';
import type { Settings } from '../shared.js';
import { adminFetch } from '../shared.js';

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

  const addBlock = async () => {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      await adminFetch(token, `/api/${slug}/admin/blocked`, {
        method: 'POST',
        body: JSON.stringify({ startDate: blockStart, endDate: blockEnd }),
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
      </h2>
      <p className="pb-applies">Changes here apply immediately.</p>
      <ul>
        {blocked.map((b) => (
          <li key={b.id}>
            {formatBlockRange(b.startDate, b.endDate)}
            <button onClick={() => void removeBlock(b.id)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="pb-inline">
        <input type="date" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} />
        <input type="date" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} />
        <button onClick={() => void addBlock()} disabled={busy}>
          {busy ? 'Saving…' : 'Block range'}
        </button>
      </div>
    </>
  );
}
