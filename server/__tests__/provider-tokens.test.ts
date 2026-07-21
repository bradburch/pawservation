import { describe, expect, it } from 'vitest';
import {
  clearProviderConnection,
  getProviderConnection,
  setBookingGCalEventId,
  setProviderTokens,
} from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

describe('provider token repo', () => {
  it('upserts tokens with connected status, then clears them', async () => {
    const { env } = createTestEnv();
    await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
      access: 'enc-a',
      refresh: 'enc-r',
      expiresAt: '2030-01-01T00:00:00Z',
      calendarId: 'primary',
    });
    let conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(conn?.Status).toBe('connected');
    expect(conn?.AccessToken).toBe('enc-a');
    expect(conn?.CalendarId).toBe('primary');

    await clearProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(conn?.Status).toBe('disconnected');
    expect(conn?.AccessToken).toBeNull();
  });

  it('setBookingGCalEventId writes the event id onto a booking', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, PetCount, Status)
              VALUES ('b1', '${TENANT_A}', 'daycare', '2030-02-01', 1, 'pending')`);
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, 'b1', 'evt_xyz', null);
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='b1'`).get() as {
      GCalEventId: string;
    };
    expect(row.GCalEventId).toBe('evt_xyz');
  });
});
