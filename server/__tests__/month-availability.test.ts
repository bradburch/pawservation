import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { createTestEnv, TEST_SECRET, endUserToken } from './helpers';
import { setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import type { MonthDay } from '../lib/availability';

const BOARDING_EVENT = {
  summary: 'Boarding: Bella',
  start: { date: '2026-10-20' },
  end: { date: '2026-10-21' },
  extendedProperties: {
    private: {
      pawbook: 'true',
      category: 'boarding',
      petCount: '1',
      customerEmail: 'jess@example.com',
    },
  },
};

const UNAVAILABLE_EVENT = {
  summary: 'Unavailable',
  start: { date: '2026-10-10' },
  end: { date: '2026-10-11' },
};

async function seedConnectedCalendar(env: Env) {
  await setProviderTokens(env.PAWBOOK_DB, 'tnt_sunnypaws', 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'fake-access'),
    refresh: await encryptToken(TEST_SECRET, 'fake-refresh'),
    expiresAt: '2099-01-01T00:00:00.000Z',
    calendarId: 'primary',
  });
}

function mockCalendarFetch(...items: object[]) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ items }), { status: 200 }),
  );
}

describe('GET /api/:slug/availability/month', () => {
  afterEach(() => vi.restoreAllMocks());

  it('connected calendar: boarding — blocks, partial, available, mine', async () => {
    const { env } = createTestEnv();
    await seedConnectedCalendar(env);
    mockCalendarFetch(BOARDING_EVENT, UNAVAILABLE_EVENT);

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=boarding&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: string; days: MonthDay[] };
    expect(body.days).toHaveLength(31);

    const d10 = body.days.find((d) => d.date === '2026-10-10')!;
    expect(d10.status).toBe('unavailable');

    const d20 = body.days.find((d) => d.date === '2026-10-20')!;
    expect(d20.status).toBe('partial');
    expect(d20.used).toBe(1);
    expect(d20.max).toBe(2);
    expect(d20.mine).toBe(true);

    const d15 = body.days.find((d) => d.date === '2026-10-15')!;
    expect(d15.status).toBe('available');
    expect(d15.mine).toBe(false);

    // today field must be a YYYY-MM-DD string
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('connected calendar: walk — blocks propagate, boarding capacity ignored, max=null', async () => {
    const { env } = createTestEnv();
    await seedConnectedCalendar(env);
    mockCalendarFetch(BOARDING_EVENT, UNAVAILABLE_EVENT);

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=walk&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: string; days: MonthDay[] };

    const d10 = body.days.find((d) => d.date === '2026-10-10')!;
    expect(d10.status).toBe('unavailable');

    const d20 = body.days.find((d) => d.date === '2026-10-20')!;
    expect(d20.status).toBe('available'); // boarding events ignored for walks
    expect(d20.max).toBeNull();
    expect(d20.used).toBeNull();
  });

  it('connected calendar: Google 500 → fail open, all available', async () => {
    const { env } = createTestEnv();
    await seedConnectedCalendar(env);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Server Error', { status: 500 }));

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=boarding&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: string; days: MonthDay[] };
    expect(body.days).toHaveLength(31);
    expect(body.days.every((d) => d.status === 'available')).toBe(true);
  });

  it('not connected: returns all available without calling fetch', async () => {
    const { env } = createTestEnv();
    // No calendar seeded — connection absent
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/availability/month?type=boarding&month=2026-10',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: string; days: MonthDay[] };
    expect(body.days).toHaveLength(31);
    expect(body.days.every((d) => d.status === 'available')).toBe(true);

    // fetch must NOT have been called for calendar events
    const calendarCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('googleapis.com/calendar'),
    );
    expect(calendarCalls).toHaveLength(0);
  });
});
