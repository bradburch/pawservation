import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, futureWeekday, TENANT_A } from './helpers';
/** A future Monday — the walk option under test is duration-priced, and the original fixture
 *  pinned a Monday, so that property is preserved rather than assumed irrelevant. */
const MONDAY = futureWeekday(1);

async function post(env: Env, body: Record<string, unknown>): Promise<Response> {
  const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
  return app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe('owner-set arrival time on range bookings', () => {
  it('stores a valid HH:MM and surfaces it on the admin list', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, {
      type: 'boarding',
      startDate: '2028-09-01',
      endDate: '2028-09-04',
      petIds: ['pet_sp_bella'],
      startTime: '14:30',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = raw.prepare('SELECT StartTime FROM BookingRequests WHERE Id = ?').get(id) as {
      StartTime: string | null;
    };
    expect(row.StartTime).toBe('14:30');

    const list = (await (
      await app.request(
        '/api/sunny-paws/admin/bookings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as { bookings: { id: string; startTime: string | null }[] };
    expect(list.bookings.find((b) => b.id === id)?.startTime).toBe('14:30');
  });

  it('leaves StartTime NULL when the widget sends none', async () => {
    const { env, raw } = createTestEnv();
    const res = await post(env, {
      type: 'boarding',
      startDate: '2028-09-10',
      endDate: '2028-09-12',
      petIds: ['pet_sp_bella'],
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = raw.prepare('SELECT StartTime FROM BookingRequests WHERE Id = ?').get(id) as {
      StartTime: string | null;
    };
    expect(row.StartTime).toBeNull();
  });

  it('rejects a malformed time with a stable code', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'boarding',
      startDate: '2028-09-15',
      endDate: '2028-09-17',
      petIds: ['pet_sp_bella'],
      startTime: '25:99',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_start_time');
  });

  it('rejects startTime on a single-day service (the option owns the clock there)', async () => {
    const { env } = createTestEnv();
    const res = await post(env, {
      type: 'walk',
      startDate: MONDAY,
      optionKey: 'd30',
      petIds: ['pet_sp_bella'],
      startTime: '09:00',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('invalid_start_time');
  });
});
