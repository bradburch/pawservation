/** IANA zone list for timezone dropdowns: the runtime's full list when available, else a small
 * fallback (Intl.supportedValuesOf is baseline in every modern browser). Shared by the Business
 * section and the setup wizard's profile step so the two pickers can never drift. */
export const TIMEZONES: string[] =
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : [
        'America/Los_Angeles',
        'America/Denver',
        'America/Chicago',
        'America/New_York',
        'America/Anchorage',
        'Pacific/Honolulu',
        'Europe/London',
        'Europe/Paris',
        'Australia/Sydney',
      ];

/** The browser's own zone when the picker lists it, else '' (= the instance default). A new
 * business's timezone defaults to where the sitter is sitting rather than to a coast she may not
 * be on; the setup wizard shows it in the dropdown before anything is saved. */
export function pickTimezone(
  zone: string | undefined,
  list: readonly string[] = TIMEZONES,
): string {
  return zone && list.includes(zone) ? zone : '';
}

/** `pickTimezone` over what this browser reports; '' if Intl cannot say. */
export function browserTimezone(): string {
  try {
    return pickTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return '';
  }
}
