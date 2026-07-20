import { useState } from 'react';
import { adminApi } from '../../shared-ui/api.js';
import { IconPlug } from '../../shared-ui/icons';
import type { Settings } from '../shared.js';
import { Hint } from '../Hint';

/**
 * Small inline field for setting the pet-sitting calendar id on a connected Google Calendar.
 * Keyed on the capability so local state resets if the provider changes.
 */
function CalendarIdField({
  slug,
  token,
  initialValue,
  onSave,
  onError,
}: {
  slug: string;
  token: string;
  initialValue: string | null | undefined;
  onSave: () => void;
  onError: (e: unknown) => void;
}) {
  const [value, setValue] = useState(initialValue ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await adminApi.calendar.setCalendarId(slug, token, value);
      onSave();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pb-inline">
      <label>
        Pet-sitting calendar ID <span className="pb-hint">(blank = primary)</span>
        <input
          type="text"
          placeholder="primary"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <small className="pb-hint">
          Connect Google Calendar above, then paste the calendar you use for pet-sitting — bookings
          sync there and your busy days block automatically. Find the ID in Google Calendar →
          Settings → your calendar → &quot;Integrate calendar&quot; → Calendar ID (like{' '}
          <code>abc123@group.calendar.google.com</code>). Leave blank to use your main calendar.
        </small>
      </label>
      <button onClick={() => void save()} disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

export function AppsSection({
  calendar,
  slug,
  token,
  connectCalendar,
  disconnectCalendar,
  onCalendarSaved,
  handleError,
}: {
  calendar: Settings['calendar'];
  slug: string;
  token: string;
  connectCalendar: () => Promise<void>;
  disconnectCalendar: () => Promise<void>;
  onCalendarSaved: () => void;
  handleError: (e: unknown) => void;
}) {
  const connected = calendar.status === 'connected';
  return (
    <>
      <h2>
        <IconPlug size={18} /> Connected apps
        <Hint label="Connected apps">
          Link Pawbook to tools you already use. With Google Calendar connected, bookings appear on
          your own calendar automatically.
        </Hint>
      </h2>
      <ul>
        <li>
          Google Calendar{' '}
          <span className={`pb-chip${connected ? ' pb-chip-ok' : ''}`}>
            {connected ? 'Connected' : 'Not connected'}
          </span>{' '}
          {connected ? (
            <>
              <button onClick={() => void disconnectCalendar()}>Disconnect</button>
              <CalendarIdField
                slug={slug}
                token={token}
                initialValue={calendar.calendarId}
                onSave={onCalendarSaved}
                onError={handleError}
              />
            </>
          ) : (
            <button onClick={() => void connectCalendar()}>Connect Google Calendar</button>
          )}
        </li>
      </ul>
    </>
  );
}
