/**
 * Which Google calendar is booking sync pointed at — a personal one, or a dedicated one?
 *
 * Since PR #88 the connected calendar is READ, not just written: every event on it without a
 * Pawservation booking id blocks booking requests for those dates. So a sitter pointed at her
 * PRIMARY calendar has her dentist appointments deleting her own availability. This predicate is
 * what lets the server and the dashboard agree on when to say so.
 *
 * Classified by Google's own id shape, with no network call and no stored identity: the OAuth grant
 * we hold (`calendar.events` + `calendar.app.created`) carries no `openid`/`userinfo.email` scope,
 * so the sitter's account address is simply not available to compare against — and asking for it
 * would force every already-connected tenant to reconnect.
 *
 * The shapes:
 * - A SECONDARY calendar — both the kind `calendars.insert` creates and the kind a sitter makes by
 *   hand in Google Calendar — always has an id ending `@group.calendar.google.com`.
 * - A PRIMARY calendar is addressed by the literal alias `'primary'` OR by the account's own email
 *   address, and we store NULL to mean "primary" as well (see `conn.CalendarId ?? 'primary'` in
 *   server/lib/calendar-sync.ts).
 *
 * Deliberately conservative: anything not provably secondary counts as personal, so an unrecognised
 * id draws the warning rather than silently skipping it. A false positive costs one extra sentence
 * of advice; a false negative costs a sitter her availability without telling her. (Known miss: a
 * subscribed holiday feed, `…@group.v.calendar.google.com`, reads as personal. Nobody points booking
 * sync at a read-only feed, and the consequence is a warning, not a block.)
 *
 * Lives in src/shared so the create-calendar guard in server/routes/admin.ts and the standing
 * warning in app/admin/sections/AppsSection.tsx ask the same question of the same string — the same
 * reason SERVICE_TEMPLATES and isValidRate live here. Pure strings: no Google call, no D1, no money.
 */

/** Suffix every Google *secondary* calendar id ends with. */
export const SECONDARY_CALENDAR_SUFFIX = '@group.calendar.google.com';

/** True when `calendarId` provably names a calendar separate from the account's primary one. */
export function isDedicatedCalendarId(calendarId: string | null | undefined): boolean {
  return (
    typeof calendarId === 'string' &&
    calendarId.trim().toLowerCase().endsWith(SECONDARY_CALENDAR_SUFFIX)
  );
}

/**
 * True when booking sync is (or would be) pointed at the sitter's own personal calendar — so
 * everything already on it blocks booking requests. The exact complement of the above, named
 * positively because that is how every call site reads it.
 */
export function isPersonalCalendarTarget(calendarId: string | null | undefined): boolean {
  return !isDedicatedCalendarId(calendarId);
}
