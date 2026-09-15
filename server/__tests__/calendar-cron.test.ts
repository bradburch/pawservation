import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCalendarSweep } from '../lib/calendar-cron';
import { insertBookingRequest, listConnectedCalendarTenants, setProviderTokens } from '../db/repo';
import { premiumNow } from '../lib/premium';
import { encryptToken } from '../lib/token-crypto';
import { addDays, getPacificDateStr, DEFAULT_TIMEZONE } from '../../src/shared/index.js';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';

const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);

async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

/** A generic mock covering every Google call one sweep can make: GET (list events, for
 * reconcile) answers with no events; POST to .../events (create, for backfill/outbox) answers
 * with a fresh event id per call. */
function mockGoogle() {
  let n = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (method === 'GET') return new Response(JSON.stringify({ items: [] }), { status: 200 });
    return new Response(JSON.stringify({ id: `evt_sweep_${++n}` }), { status: 200 });
  });
}

describe('runCalendarSweep — backfill for pre-existing rows', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pushes a pre-existing blocked (time-off) row that predates the sync feature — SyncPending=0, GCalEventId=NULL, on an already-connected tenant', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);

    // The old code path: a blocked row inserted before time-off started pushing to Google was
    // born SyncPending=0 and never got a GCalEventId. Neither the outbox (SyncPending=1
    // required) nor reconcile's re-assertion pass (GCalEventId IS NOT NULL required) can ever
    // reach it — only backfill's GCalEventId IS NULL predicate does, and until this fix backfill
    // never ran on a cron sweep for an already-connected tenant.
    const blockedId = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: addDays(TODAY, 5),
      endDate: addDays(TODAY, 7),
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    raw.exec(
      `UPDATE BookingRequests SET SyncPending = 0, GCalEventId = NULL WHERE Id = '${blockedId}'`,
    );

    const before = raw
      .prepare(`SELECT SyncPending, GCalEventId FROM BookingRequests WHERE Id = '${blockedId}'`)
      .get() as { SyncPending: number; GCalEventId: string | null };
    expect(before).toMatchObject({ SyncPending: 0, GCalEventId: null });

    mockGoogle();
    await runCalendarSweep(env);

    const after = raw
      .prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id = '${blockedId}'`)
      .get() as { GCalEventId: string | null };
    expect(after.GCalEventId).toMatch(/^evt_sweep_/);
  });
});

/**
 * THE SWEEP SKIPS A LAPSED BUSINESS, under enforcement only. The cron is the one writer of her
 * calendar that needs no request from her at all, so a lapse that made her dashboard read-only and
 * left the sweep pushing events to Google every fifteen minutes would be a lapse in name only.
 * Through `repo.ts`, with the predicate applied IN CODE over the rows the SQL returns: the query
 * itself compares no date, because `isPlanCurrent` is the one expression allowed to (AD-13).
 */
describe('runCalendarSweep — a lapsed business is not swept while the deployment enforces', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists a connected tenant while not enforcing, and drops her once enforcing finds no grant', async () => {
    const { env, raw } = createTestEnv(); // TENANT_A holds no grant of any kind
    await connectCalendar(env);
    expect(
      (await listConnectedCalendarTenants(env.PAWSERVATION_DB, false)).map((t) => t.Id),
    ).toEqual([TENANT_A]);
    expect(await listConnectedCalendarTenants(env.PAWSERVATION_DB, true)).toEqual([]);
    // …and back in the list the moment she holds a comp, so the exclusion is the predicate and
    // not the flag.
    raw
      .prepare('UPDATE Tenants SET CompedUntil = ? WHERE Id = ?')
      .run(premiumNow(new Date(Date.now() + 3_600_000)), TENANT_A);
    expect(
      (await listConnectedCalendarTenants(env.PAWSERVATION_DB, true)).map((t) => t.Id),
    ).toEqual([TENANT_A]);
  });

  it('makes no Google call for her under enforcement, and the same rows are swept when not', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env);
    const blockedId = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: addDays(TODAY, 5),
      endDate: addDays(TODAY, 7),
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    raw.exec(
      `UPDATE BookingRequests SET SyncPending = 0, GCalEventId = NULL WHERE Id = '${blockedId}'`,
    );
    const google = mockGoogle();
    await runCalendarSweep({ ...env, PLAN_ENFORCE: 'true' } as Env);
    expect(google).not.toHaveBeenCalled();
    const untouched = raw
      .prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id = '${blockedId}'`)
      .get() as { GCalEventId: string | null };
    expect(untouched.GCalEventId).toBeNull();

    // The control: the shipped default sweeps her exactly as before.
    await runCalendarSweep(env);
    expect(google).toHaveBeenCalled();
    const swept = raw
      .prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id = '${blockedId}'`)
      .get() as { GCalEventId: string | null };
    expect(swept.GCalEventId).toMatch(/^evt_sweep_/);
  });
});
