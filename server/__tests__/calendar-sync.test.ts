import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncBookingToCalendar } from '../lib/calendar-sync';
import { setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

const tenant = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant;

async function connectCalendar(env: Env, expiresAt: string) {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt,
    calendarId: 'primary',
  });
}
function seedBooking(raw: { exec: (s: string) => void }, id: string) {
  raw.exec(`INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, EstCost, Status)
            VALUES ('${id}', '${TENANT_A}', 'boarding', '2030-03-01', '2030-03-04', 1, 150, 'pending')`);
}

describe('syncBookingToCalendar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an event and persists the event id when connected', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z'); // not expired
    seedBooking(raw, 'b1');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_b1' }), { status: 200 }));
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b1',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      estCost: 150,
    });
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='b1'`).get() as {
      GCalEventId: string;
    };
    expect(row.GCalEventId).toBe('evt_b1');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('no-ops when the calendar is not connected', async () => {
    const { env, raw } = createTestEnv();
    seedBooking(raw, 'b2');
    const spy = vi.spyOn(globalThis, 'fetch');
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b2',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      estCost: 150,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token before creating the event', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2000-01-01T00:00:00Z'); // expired
    seedBooking(raw, 'b3');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'evt_b3' }), { status: 200 }));
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b3',
      endUserId: null,
      serviceType: 'boarding',
      serviceLabel: 'Boarding',
      startDate: '2030-03-01',
      endDate: '2030-03-04',
      startTime: null,
      durationMinutes: null,
      petCount: 1,
      estCost: 150,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    const eventCall = spy.mock.calls[1];
    expect((eventCall[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer access-2',
    });
  });
});
