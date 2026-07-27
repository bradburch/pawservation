import { useState } from 'react';
import { adminApi } from '../../shared-ui/api.js';
import { IconPlug } from '../../shared-ui/icons';
import type { Settings } from '../shared.js';
import { Hint } from '../Hint';

/** Must match PET_CALENDAR_SUMMARY in server/lib/google-calendar.ts (copy only — the server names
 *  the calendar it creates; this is just what we promise before the round-trip). */
const PET_CALENDAR_NAME = 'Pawservation — Pet bookings';

/**
 * The default way to get a pet-only calendar: Pawservation creates a secondary calendar inside the
 * sitter's own Google account and points booking sync at it. Once a non-primary calendar is the
 * target there is nothing to create, so this renders the current target instead of a button that
 * the server would only reject (it 409s to avoid making a second calendar).
 */
function PetCalendarAction({
  slug,
  token,
  calendarId,
  onCreated,
  onError,
}: {
  slug: string;
  token: string;
  calendarId: string | null | undefined;
  onCreated: () => void;
  onError: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  if (calendarId && calendarId !== 'primary') {
    return (
      <p className="pb-hint">
        {created ? `Created “${created}”. ` : ''}Bookings sync to a separate calendar:{' '}
        <code className="pb-truncate">{calendarId}</code>. Clear the calendar ID below to go back to
        your main calendar.
      </p>
    );
  }

  const create = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { summary } = await adminApi.calendar.createPetCalendar(slug, token);
      setCreated(summary);
      onCreated();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button onClick={() => void create()} disabled={busy}>
        {busy ? 'Creating…' : 'Create a pet calendar'}
      </button>
      <small className="pb-hint">
        Pawservation makes a separate “{PET_CALENDAR_NAME}” calendar in your Google account, so pet
        work stays out of your personal calendar.
      </small>
    </div>
  );
}

/**
 * Escape hatch for a sitter who already made her own pet-sitting calendar: paste its id instead of
 * letting Pawservation create one. Keyed on the capability so local state resets if the provider
 * changes.
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
        Or use a calendar you already made <span className="pb-hint">(blank = primary)</span>
        <input
          type="text"
          placeholder="primary"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <small className="pb-hint">
          Paste the calendar you use for pet-sitting and bookings are written there instead. Find
          the ID in Google Calendar → Settings → your calendar → &quot;Integrate calendar&quot; →
          Calendar ID (like <code>abc123@group.calendar.google.com</code>). Leave blank to use your
          main calendar. Bookings flow out to Google, not in: an event you add in Google does
          <em>not</em> block your Pawservation availability — use Blocked dates for that. (Deleting
          a synced booking&apos;s event in Google does cancel that booking.)
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
          Link Pawservation to tools you already use. With Google Calendar connected, bookings
          appear on your own calendar automatically.
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
              <PetCalendarAction
                slug={slug}
                token={token}
                calendarId={calendar.calendarId}
                onCreated={onCalendarSaved}
                onError={handleError}
              />
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
