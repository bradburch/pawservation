import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../index';
import { insertBookingRequest, setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { createTestEnv, TENANT_A, TENANT_B, TEST_SECRET } from './helpers';

const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

/** Run the real scheduled() handler the way the runtime does, awaiting its waitUntil work. */
async function runScheduled(env: Env) {
  const tail: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tail.push(p),
    passThroughOnException: () => {},
  };
  await worker.scheduled(
    { scheduledTime: Date.now(), cron: '*/15 * * * *', noRetry: () => {} } as ScheduledController,
    env,
    ctx as never,
  );
  await Promise.all(tail);
}

describe('scheduled() — the 15-minute calendar sweep', () => {
  afterEach(() => vi.restoreAllMocks());

  it('re-drives the outbox and reconciles for connected tenants only', async () => {
    const { env } = createTestEnv();
    // Tenant A connected; tenant B not — B must produce zero Google traffic.
    await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
      access: await encryptToken(TEST_SECRET, 'access-1'),
      refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
      expiresAt: '2030-01-01T00:00:00Z',
      calendarId: 'primary',
    });
    const pendingA = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: addDays(TODAY, 10),
      endDate: addDays(TODAY, 12),
      optionKey: 'standard',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    const pendingB = await insertBookingRequest(env.PAWBOOK_DB, TENANT_B, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: addDays(TODAY, 10),
      endDate: addDays(TODAY, 12),
      optionKey: 'standard',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/events?'))
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ id: 'evt_cron' }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    await runScheduled(env);
    const state = async (id: string) =>
      (await env.PAWBOOK_DB.prepare(
        'SELECT SyncPending, GCalEventId FROM BookingRequests WHERE Id = ?',
      )
        .bind(id)
        .first<{ SyncPending: number; GCalEventId: string | null }>())!;
    expect(await state(pendingA)).toMatchObject({ SyncPending: 0, GCalEventId: 'evt_cron' });
    expect(await state(pendingB)).toMatchObject({ SyncPending: 1, GCalEventId: null }); // untouched
  });

  it('one tenant blowing up does not stop the sweep, and no connections means no Google traffic', async () => {
    const { env } = createTestEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    await runScheduled(env); // no connected tenants seeded
    expect(spy).not.toHaveBeenCalled();
  });
});
