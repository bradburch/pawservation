import { useState } from 'react';
import { isPersonalCalendarTarget } from '../../../src/shared/index.js';
import { adminApi } from '../../shared-ui/api.js';
import { IconPlug } from '../../shared-ui/icons';
import type { Settings } from '../shared.js';
import { Hint } from '../Hint';

/** Must match PET_CALENDAR_SUMMARY in server/lib/google-calendar.ts (copy only — the server names
 *  the calendar it creates; this is just what we promise before the round-trip). */
const PET_CALENDAR_NAME = 'Pawservation — Pet bookings';

/**
 * The dedicated-calendar control — and, while sync still points at a personal calendar, the
 * standing warning that explains why it matters.
 *
 * Since PR #88 the connected calendar is READ: every event on it that Pawservation didn't create
 * blocks booking requests for those dates. A sitter left on the default target ('primary', written
 * by the OAuth callback) therefore has her dentist appointments deleting her own availability. That
 * is not a one-shot toast — it stays true until she moves the target — so it renders as a
 * persistent block directly above the one-click remedy.
 *
 * "Personal" is `isPersonalCalendarTarget` from src/shared: NULL, 'primary', and the account's own
 * email address all name the primary calendar. The server's create-calendar guard asks the same
 * function the same question, so the button shown here is exactly the button the server will honour.
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

  // Already on a separate calendar: nothing to warn about and nothing to create (the server 409s to
  // avoid making a second one), so render the current target instead of a button it would reject.
  if (!isPersonalCalendarTarget(calendarId)) {
    return (
      <p className="pb-hint">
        {created ? `Created "${created}". ` : ''}Bookings sync to a separate calendar:{' '}
        <code className="pb-truncate">{calendarId}</code>. Only events on that calendar affect your
        availability — the rest of your Google account is never read. Clear the calendar ID below to
        go back to your main calendar.
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
    <>
      <p className="pb-warn-note">
        <strong>Bookings are syncing to your main Google Calendar.</strong>
        Everything already on it — appointments, reminders, personal events — blocks new booking
        requests for those dates.
      </p>
      <div>
        <button onClick={() => void create()} disabled={busy}>
          {busy ? 'Creating…' : 'Create a pet calendar'}
        </button>
        <small className="pb-hint">
          Pawservation makes a separate "{PET_CALENDAR_NAME}" calendar in your Google account and
          syncs bookings there instead, so only pet work affects your availability. Your upcoming
          bookings move across automatically, and your personal calendar stops being read.
        </small>
      </div>
    </>
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
        Or use a calendar you already made{' '}
        <span className="pb-hint">(blank = your main calendar)</span>
        <input
          type="text"
          placeholder="primary"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <small className="pb-hint">
          Paste the calendar you keep pet-sitting on and bookings are written there instead. Find
          the ID in Google Calendar → Settings → your calendar → &quot;Integrate calendar&quot; →
          Calendar ID (like <code>abc123@group.calendar.google.com</code>). Make sure it&rsquo;s a
          calendar you made for pet-sitting, not your main one — sync is two-way with whichever
          calendar you name here, so everything on it blocks booking requests. Deleting a synced
          booking&apos;s event there cancels that booking and the client is notified. Calendars
          other than the connected one are never read.
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
          appear on your calendar automatically — and busy events on that calendar block new booking
          requests here.
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
            <>
              <p className="pb-hint">
                Bookings will appear on your Google Calendar automatically. One thing to know before
                you connect: the calendar you connect is also read, so anything already on it — a
                dentist appointment, a school pickup — blocks booking requests for those dates. Once
                you&rsquo;re connected, let Pawservation make you a separate pet calendar and only
                pet work will affect your availability.
              </p>
              <button onClick={() => void connectCalendar()}>Connect Google Calendar</button>
            </>
          )}
        </li>
      </ul>
      <p className="pb-hint">
        <strong>How your calendar affects bookings.</strong> Busy events on the connected calendar,
        and days you mark under <a href="#timeoff">Time off</a>, stop <em>new</em> requests for
        those dates — they never change a booking you&rsquo;ve already confirmed. And nothing books
        itself: every request waits under <a href="#bookings">Bookings</a> until you confirm or
        decline it.
      </p>
    </>
  );
}
