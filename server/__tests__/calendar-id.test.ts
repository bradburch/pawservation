import { describe, expect, it } from 'vitest';
import app from '../index';
import { listProviderConnections, setProviderCalendarId, setProviderTokens } from '../db/repo';
import { adminToken, createTestEnv, TENANT_A } from './helpers';

const CAL_ID = 'sitting@group.calendar.google.com';

async function seedCalendar(env: Env) {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: 'enc-a',
    refresh: 'enc-r',
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

describe('setProviderCalendarId (repo)', () => {
  it('sets and clears CalendarId on the connected row', async () => {
    const { env } = createTestEnv();
    await seedCalendar(env);

    // Set a custom calendar id
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', CAL_ID);
    const connections = await listProviderConnections(env.PAWBOOK_DB, TENANT_A);
    const row = connections.find((c) => c.Capability === 'calendar');
    expect(row?.CalendarId).toBe(CAL_ID);

    // Set to null clears it
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', null);
    const connections2 = await listProviderConnections(env.PAWBOOK_DB, TENANT_A);
    const row2 = connections2.find((c) => c.Capability === 'calendar');
    expect(row2?.CalendarId).toBeNull();
  });
});

describe('POST /:slug/admin/providers/calendar/calendar-id (route)', () => {
  it('sets the calendar id and persists it (204)', async () => {
    const { env } = createTestEnv();
    await seedCalendar(env);
    const token = await adminToken(TENANT_A);

    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/calendar-id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ calendarId: 'x@group.calendar.google.com' }),
      },
      env,
    );
    expect(res.status).toBe(204);

    const connections = await listProviderConnections(env.PAWBOOK_DB, TENANT_A);
    const row = connections.find((c) => c.Capability === 'calendar');
    expect(row?.CalendarId).toBe('x@group.calendar.google.com');
  });

  it('blank calendarId clears to null', async () => {
    const { env } = createTestEnv();
    await seedCalendar(env);
    const token = await adminToken(TENANT_A);

    // First set a non-primary id
    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', CAL_ID);

    // Now clear with empty string
    const res = await app.request(
      '/api/sunny-paws/admin/providers/calendar/calendar-id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ calendarId: '' }),
      },
      env,
    );
    expect(res.status).toBe(204);

    const connections = await listProviderConnections(env.PAWBOOK_DB, TENANT_A);
    const row = connections.find((c) => c.Capability === 'calendar');
    expect(row?.CalendarId).toBeNull();
  });

  it('calendarId appears in the settings GET response', async () => {
    const { env } = createTestEnv();
    await seedCalendar(env);
    const token = await adminToken(TENANT_A);

    await setProviderCalendarId(env.PAWBOOK_DB, TENANT_A, 'calendar', CAL_ID);

    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { calendar: { calendarId: string | null } };
    expect(body.calendar.calendarId).toBe(CAL_ID);
  });
});
