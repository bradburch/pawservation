import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import {
  getCalendarAccessToken,
  reconcileBookingsWithCalendar,
  syncBookingToCalendar,
} from '../lib/calendar-sync';
import {
  getProviderConnection,
  insertBookingRequest,
  setBookingGCalEventId,
  setProviderTokens,
} from '../db/repo';
import { decryptToken, encryptToken } from '../lib/token-crypto';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import { adminToken, createTestEnv, TENANT_A, TENANT_B, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

/**
 * ADVERSARIAL MULTI-TENANCY AUDIT — two sitters (Sunny Paws / Happy Tails) BOTH with Google
 * Calendar connected, sharing one customer (jess@example.com, seeded as eu_sp_jess + eu_ht_jess).
 * Proves the booking→calendar pipeline never leaks a bearer token, calendar id, event write,
 * refreshed token, or delete across the tenant boundary.
 */

const tenantA = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant; // Sunny Paws
const tenantB = { Id: TENANT_B, Slug: 'happy-tails', Timezone: null } as Tenant; // Happy Tails

// Distinct per-tenant secrets — the whole point of the audit is that these never cross over.
const A_ACCESS = 'sunny-access-token';
const A_REFRESH = 'sunny-refresh-token';
const A_CAL = 'sunny-paws@group.calendar.google.com';
const B_ACCESS = 'happy-access-token';
const B_REFRESH = 'happy-refresh-token';
const B_CAL = 'happy-tails@group.calendar.google.com';

const FAR_FUTURE = '2035-01-01T00:00:00Z';
const LONG_EXPIRED = '2000-01-01T00:00:00Z';

// Seeded shared customer (same email in both tenants, different row per tenant).
const EU_A = 'eu_sp_jess';
const EU_B = 'eu_ht_jess';

async function connect(
  env: Env,
  tenantId: string,
  opts: { access: string; refresh: string; calendarId: string; expiresAt: string },
) {
  await setProviderTokens(env.PAWBOOK_DB, tenantId, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, opts.access),
    refresh: await encryptToken(TEST_SECRET, opts.refresh),
    expiresAt: opts.expiresAt,
    calendarId: opts.calendarId,
  });
}

/** Find the fetch call whose URL targets a given calendar id (encoded as Google's REST client does). */
function callForCalendar(spy: ReturnType<typeof vi.spyOn>, calendarId: string) {
  const needle = encodeURIComponent(calendarId);
  return spy.mock.calls.find((call: unknown[]) => String(call[0]).includes(needle));
}

function authHeaderOf(call: unknown[] | undefined): string | undefined {
  const init = call?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

// ── reconcile window fixtures, relative to the real clock (mirrors calendar-reconcile.test.ts) ──
const TODAY = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
const IN_WINDOW_START = addDays(TODAY, 10);
const IN_WINDOW_END = addDays(TODAY, 13);

function emptyCalendarResponse() {
  return new Response(JSON.stringify({ items: [] }), { status: 200 });
}

const syncInput = (bookingId: string, endUserId: string) => ({
  bookingId,
  endUserId,
  serviceType: 'boarding' as const,
  serviceLabel: 'Boarding',
  startDate: IN_WINDOW_START,
  endDate: IN_WINDOW_END,
  startTime: null,
  durationMinutes: null,
  petCount: 1,
  petNames: [],
  estCost: 150,
  status: 'pending' as const,
});

async function seedSynced(env: Env, tenantId: string, endUserId: string, eventId: string) {
  const id = await insertBookingRequest(env.PAWBOOK_DB, tenantId, {
    endUserId,
    serviceType: 'boarding',
    startDate: IN_WINDOW_START,
    endDate: IN_WINDOW_END,
    optionKey: 'standard',
    petType: 'dog',
    petCount: 1,
    estCost: 150,
    status: 'confirmed',
  });
  await setBookingGCalEventId(env.PAWBOOK_DB, tenantId, id, eventId, null);
  return id;
}

async function statusOf(env: Env, id: string): Promise<string> {
  const row = await env.PAWBOOK_DB.prepare('SELECT Status FROM BookingRequests WHERE Id = ?')
    .bind(id)
    .first<{ Status: string }>();
  return row!.Status;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — right token, right calendar on the create path.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 1: event creation uses each tenant’s own bearer token + calendar id', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes each booking’s event to that tenant’s calendar/token and lands the id on the right row', async () => {
    const { env, raw } = createTestEnv();
    await connect(env, TENANT_A, {
      access: A_ACCESS,
      refresh: A_REFRESH,
      calendarId: A_CAL,
      expiresAt: FAR_FUTURE,
    });
    await connect(env, TENANT_B, {
      access: B_ACCESS,
      refresh: B_REFRESH,
      calendarId: B_CAL,
      expiresAt: FAR_FUTURE,
    });

    // Bookings for the SAME shared customer email, one per tenant.
    const bookingA = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: EU_A,
      serviceType: 'boarding',
      startDate: IN_WINDOW_START,
      endDate: IN_WINDOW_END,
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 150,
      status: 'pending',
    });
    const bookingB = await insertBookingRequest(env.PAWBOOK_DB, TENANT_B, {
      endUserId: EU_B,
      serviceType: 'boarding',
      startDate: IN_WINDOW_START,
      endDate: IN_WINDOW_END,
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 150,
      status: 'pending',
    });

    // The mock returns an event id derived from WHICH calendar was targeted, so a mis-routed
    // write would visibly persist the wrong id.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      const id = u.includes(encodeURIComponent(A_CAL)) ? 'evt_sunny' : 'evt_happy';
      return new Response(JSON.stringify({ id }), { status: 200 });
    });

    await syncBookingToCalendar(env, tenantA, syncInput(bookingA, EU_A));
    await syncBookingToCalendar(env, tenantB, syncInput(bookingB, EU_B));

    const callA = callForCalendar(spy, A_CAL);
    const callB = callForCalendar(spy, B_CAL);

    // Each tenant's create call carried its OWN calendar id + bearer token.
    expect(callA, 'Sunny Paws calendar was targeted').toBeDefined();
    expect(callB, 'Happy Tails calendar was targeted').toBeDefined();
    expect(authHeaderOf(callA)).toBe(`Bearer ${A_ACCESS}`);
    expect(authHeaderOf(callB)).toBe(`Bearer ${B_ACCESS}`);

    // The cross pairing NEVER happened: no call to A's calendar with B's token, or vice versa.
    expect(authHeaderOf(callA)).not.toBe(`Bearer ${B_ACCESS}`);
    expect(authHeaderOf(callB)).not.toBe(`Bearer ${A_ACCESS}`);

    // Persisted event ids landed on the correct tenant's booking row.
    const rowA = raw
      .prepare('SELECT GCalEventId FROM BookingRequests WHERE Id = ?')
      .get(bookingA) as { GCalEventId: string };
    const rowB = raw
      .prepare('SELECT GCalEventId FROM BookingRequests WHERE Id = ?')
      .get(bookingB) as { GCalEventId: string };
    expect(rowA.GCalEventId).toBe('evt_sunny');
    expect(rowB.GCalEventId).toBe('evt_happy');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — reconcile is tenant-scoped: A's empty calendar can't cancel B's work.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 2: reconcile for one tenant never touches the other’s bookings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('cancels tenant A’s synced booking while tenant B’s identical booking stays confirmed', async () => {
    const { env } = createTestEnv();
    await connect(env, TENANT_A, {
      access: A_ACCESS,
      refresh: A_REFRESH,
      calendarId: A_CAL,
      expiresAt: FAR_FUTURE,
    });
    await connect(env, TENANT_B, {
      access: B_ACCESS,
      refresh: B_REFRESH,
      calendarId: B_CAL,
      expiresAt: FAR_FUTURE,
    });

    const idA = await seedSynced(env, TENANT_A, EU_A, 'evt_sunny_1');
    const idB = await seedSynced(env, TENANT_B, EU_B, 'evt_happy_1');

    // Google reports NO events for whichever calendar is queried.
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(emptyCalendarResponse());

    // Reconcile ONLY tenant A.
    await reconcileBookingsWithCalendar(env, tenantA);

    // A's booking was cancelled (its event is gone); B's was never inspected or altered.
    expect(await statusOf(env, idA)).toBe('cancelled');
    expect(await statusOf(env, idB)).toBe('confirmed');

    // Proof the reconcile only ever spoke to A's calendar — B's calendar was never queried.
    expect(callForCalendar(spy, A_CAL), 'A calendar queried').toBeDefined();
    expect(callForCalendar(spy, B_CAL), 'B calendar NOT queried').toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — token refresh writes only to the refreshing tenant's row.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 3: an expired-token refresh persists to the right tenant only', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rewrites tenant A’s access token and leaves tenant B’s connection byte-identical', async () => {
    const { env, raw } = createTestEnv();
    await connect(env, TENANT_A, {
      access: A_ACCESS,
      refresh: A_REFRESH,
      calendarId: A_CAL,
      expiresAt: LONG_EXPIRED, // forces a refresh
    });
    await connect(env, TENANT_B, {
      access: B_ACCESS,
      refresh: B_REFRESH,
      calendarId: B_CAL,
      expiresAt: FAR_FUTURE,
    });

    const bRowBefore = raw
      .prepare('SELECT * FROM ProviderConnections WHERE TenantId = ?')
      .get(TENANT_B);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'sunny-access-REFRESHED', expires_in: 3600 }), {
        status: 200,
      }),
    );

    const connA = (await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar'))!;
    const token = await getCalendarAccessToken(env, tenantA, connA);
    expect(token).toBe('sunny-access-REFRESHED');

    // Tenant A's stored (encrypted) access token now decrypts to the refreshed value.
    const aRowAfter = raw
      .prepare('SELECT AccessToken, TokenExpiresAt FROM ProviderConnections WHERE TenantId = ?')
      .get(TENANT_A) as { AccessToken: string; TokenExpiresAt: string };
    expect(await decryptToken(TEST_SECRET, aRowAfter.AccessToken)).toBe('sunny-access-REFRESHED');
    expect(aRowAfter.TokenExpiresAt).not.toBe(LONG_EXPIRED);

    // Tenant B's ENTIRE row is unchanged — no field was touched by A's refresh.
    const bRowAfter = raw
      .prepare('SELECT * FROM ProviderConnections WHERE TenantId = ?')
      .get(TENANT_B);
    expect(bRowAfter).toEqual(bRowBefore);
    // And B's token still decrypts to B's original secret.
    const bConn = (await getProviderConnection(env.PAWBOOK_DB, TENANT_B, 'calendar'))!;
    expect(await decryptToken(TEST_SECRET, bConn.AccessToken!)).toBe(B_ACCESS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — decline deletes from the right calendar; cross-tenant decline is scoped out.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 4: admin decline hits only its own calendar and can’t reach across tenants', () => {
  afterEach(() => vi.restoreAllMocks());

  async function seedPendingSynced(env: Env, tenantId: string, endUserId: string, eventId: string) {
    const id = await insertBookingRequest(env.PAWBOOK_DB, tenantId, {
      endUserId,
      serviceType: 'boarding',
      startDate: IN_WINDOW_START,
      endDate: IN_WINDOW_END,
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 150,
      status: 'pending',
    });
    await setBookingGCalEventId(env.PAWBOOK_DB, tenantId, id, eventId, null);
    return id;
  }

  it('deletes tenant B’s event with B’s token/calendar and never touches A’s event', async () => {
    const { env } = createTestEnv();
    await connect(env, TENANT_A, {
      access: A_ACCESS,
      refresh: A_REFRESH,
      calendarId: A_CAL,
      expiresAt: FAR_FUTURE,
    });
    await connect(env, TENANT_B, {
      access: B_ACCESS,
      refresh: B_REFRESH,
      calendarId: B_CAL,
      expiresAt: FAR_FUTURE,
    });

    const idA = await seedPendingSynced(env, TENANT_A, EU_A, 'evt_sunny_del');
    const idB = await seedPendingSynced(env, TENANT_B, EU_B, 'evt_happy_del');

    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    // Authenticate as Happy Tails' admin and decline Happy Tails' OWN booking.
    const res = await app.request(
      `/api/happy-tails/admin/bookings/${idB}/status`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await adminToken(TENANT_B)}`,
        },
        body: JSON.stringify({ status: 'declined' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await statusOf(env, idB)).toBe('cancelled'); // declined == cancelled + Declined flag

    // Exactly the DELETE to B's calendar with B's token fired.
    const deleteCalls = spy.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(1);
    const del = deleteCalls[0];
    const delUrl = String(del[0]);
    expect(delUrl).toContain(encodeURIComponent(B_CAL));
    expect(delUrl).toContain(encodeURIComponent('evt_happy_del'));
    expect(authHeaderOf(del)).toBe(`Bearer ${B_ACCESS}`);

    // Tenant A's calendar / event / token were never referenced by any fetch.
    for (const [url, init] of spy.mock.calls) {
      const u = String(url);
      expect(u).not.toContain(encodeURIComponent(A_CAL));
      expect(u).not.toContain(encodeURIComponent('evt_sunny_del'));
      expect((init as RequestInit | undefined) && authHeaderOf([url, init])).not.toBe(
        `Bearer ${A_ACCESS}`,
      );
    }
    expect(await statusOf(env, idA)).toBe('pending'); // A's booking untouched
  });

  it('404s when tenant B’s admin tries to decline tenant A’s booking, and A’s event is never deleted', async () => {
    const { env } = createTestEnv();
    await connect(env, TENANT_A, {
      access: A_ACCESS,
      refresh: A_REFRESH,
      calendarId: A_CAL,
      expiresAt: FAR_FUTURE,
    });
    await connect(env, TENANT_B, {
      access: B_ACCESS,
      refresh: B_REFRESH,
      calendarId: B_CAL,
      expiresAt: FAR_FUTURE,
    });

    const idA = await seedPendingSynced(env, TENANT_A, EU_A, 'evt_sunny_del');

    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));

    // Happy Tails' admin, authenticated for happy-tails, targets a Sunny Paws booking id.
    const res = await app.request(
      `/api/happy-tails/admin/bookings/${idA}/status`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await adminToken(TENANT_B)}`,
        },
        body: JSON.stringify({ status: 'declined' }),
      },
      env,
    );

    // The tenant-scoped UPDATE (WHERE TenantId = B AND Id = A_id) matches nothing → 404.
    expect(res.status).toBe(404);
    // A's booking is still pending and no calendar delete ever fired.
    expect(await statusOf(env, idA)).toBe('pending');
    const deleteCalls = spy.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(0);
  });
});
