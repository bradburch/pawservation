import type { ProviderConnection } from '../types';

/**
 * Google Calendar is the only real integration — it connects via the OAuth routes in
 * server/routes/admin.ts (start/disconnect/calendar-id), not a generic registry.
 */

export type CalendarView = {
  status: 'disconnected' | 'connected-stub' | 'connected';
  connectedAt: string | null;
  calendarId: string | null;
};

/** Project a tenant's persisted connection rows down to the calendar connection's view. */
export function calendarView(connections: ProviderConnection[]): CalendarView {
  const row = connections.find((c) => c.Capability === 'calendar');
  return {
    status: row?.Status ?? 'disconnected',
    connectedAt: row?.ConnectedAt ?? null,
    calendarId: row?.CalendarId ?? null,
  };
}
