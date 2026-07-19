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
