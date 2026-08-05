import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { listServices, setProviderTokens } from '../db/repo';
import { mintAdminToken, mintToken } from '../lib/token';
import { encryptToken } from '../lib/token-crypto';
import {
  adminHeaders,
  adminToken,
  createTestEnv,
  endUserToken,
  TENANT_A,
  TENANT_B,
  TEST_SECRET,
} from './helpers';

/** Connected Google Calendar with a far-future token expiry — no refresh round-trip needed. */
async function connectCalendar(env: Env, tenantId: string): Promise<void> {
  await setProviderTokens(env.PAWSERVATION_DB, tenantId, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z',
    calendarId: 'primary',
  });
}

/** Admin Bearer headers for a tenant, optionally with a JSON content type. */
async function auth(tenantId: string, json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { Authorization: `Bearer ${await adminToken(tenantId)}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** Authenticated availability quote. Every caller supplies REAL pet ids: there is no pet-count
 *  param any more, by design (design spec §5). */
async function quote(
  env: Env,
  slug: string,
  query: string,
  petIds: string[],
  email = 'jess@example.com',
): Promise<Response> {
  const token = await endUserToken(env, slug, email);
  return app.request(
    `/api/${slug}/availability?${query}&petIds=${petIds.join(',')}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
}

describe('tenant admin', () => {
  it('rejects missing, malformed, end-user, and wrong-tenant tokens', async () => {
    const { env } = createTestEnv();

    const missing = await app.request('/api/sunny-paws/admin/settings', {}, env);
    expect(missing.status).toBe(401);

    const malformed = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: 'Bearer not-a-token' } },
      env,
    );
    expect(malformed.status).toBe(401);

    // A widget (end-user) token has no admin role → must not authenticate admin routes.
    const endUserToken = await mintToken('eu-1', TENANT_A, TEST_SECRET);
    const wrongRole = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${endUserToken}` } },
      env,
    );
    expect(wrongRole.status).toBe(401);

    // A valid admin token for the OTHER tenant → 403.
    const crossTenant = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await auth(TENANT_B) },
      env,
    );
    expect(crossTenant.status).toBe(403);
  });

  it('settings edits are tenant-scoped and reflected live in the widget config (FR19)', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          displayName: 'Sunny Paws Deluxe',
          accentColor: '#10b981',
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 75 }],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    // Widget config (KV cache invalidated) shows the new values…
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      displayName: string;
      accentColor: string;
      services: { type: string; options: { rate: number }[] }[];
    };
    expect(config.displayName).toBe('Sunny Paws Deluxe');
    expect(config.accentColor).toBe('#10b981');
    expect(config.services.find((s) => s.type === 'boarding')?.options[0].rate).toBe(75);

    // …and the OTHER tenant is untouched.
    const other = (await (await app.request('/api/happy-tails/config', {}, env)).json()) as {
      displayName: string;
    };
    expect(other.displayName).toBe('Happy Tails');
  });

  it('writes multiple services in ONE settings PUT (the wizard batch-apply contract)', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 61 }],
            },
            {
              type: 'daycare',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 32 }],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; options: { rate: number }[] }[];
    };
    expect(cfg.services.find((s) => s.type === 'boarding')?.options[0].rate).toBe(61);
    expect(cfg.services.find((s) => s.type === 'daycare')?.options[0].rate).toBe(32);
  });

  it('rejects a settings PUT with a bad service rate WITHOUT committing the rest (atomic validation)', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          displayName: 'Should Not Persist',
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 99 }],
            },
            {
              type: 'walk',
              enabled: true,
              options: [{ label: 'x', durationMinutes: 30, rate: 0 }], // invalid — rejects the whole request
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    // Neither the rename nor the first (valid) service may have been written.
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      displayName: string;
      services: { type: string; options: { rate: number }[] }[];
    };
    expect(config.displayName).toBe('Sunny Paws');
    expect(config.services.find((s) => s.type === 'boarding')?.options[0].rate).toBe(50);
  });

  it('rejects an UNPRICED option ("") and names the service and the option', async () => {
    const { env } = createTestEnv();
    // A new service/option now starts with an empty price input (no default price), so '' on the
    // wire is the common failure — the message has to answer "which price is missing?".
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          displayName: 'Should Not Persist',
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [{ label: 'Puppy Check-in', durationMinutes: 30, rate: '' }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain('Walk'); // the service (singular since the rename)…
    expect(error).toContain('Puppy Check-in'); // …and the specific option
    // Same atomicity as the rate: 0 case above — nothing in the request persists.
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      displayName: string;
    };
    expect(config.displayName).toBe('Sunny Paws');
  });

  it('rejects a retired minPetCount instead of silently ignoring it', async () => {
    const { env } = createTestEnv();
    // Same contract as the retired maxPerDay: a client that still sends a minimum must be told it
    // no longer applies, never left believing a minimum it submitted is in force.
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              minPetCount: 3,
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('minimum pet count') as unknown as string,
    });
  });

  it('rejects a settings PUT that still sends minNights (no silent drop)', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              minNights: 2,
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('minimum');
  });

  it('capacity edits change availability outcomes (per-service cap)', async () => {
    const { env } = createTestEnv();
    // Seed: Jun 21-24 at Sunny Paws has 1 pet, max 2 -> a 2-pet request conflicts.
    const before = (await (
      await quote(env, 'sunny-paws', 'type=boarding&start=2028-06-21&end=2028-06-24', [
        'pet_sp_bella',
        'pet_sp_mochi',
      ])
    ).json()) as { available: boolean };
    expect(before.available).toBe(false);

    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              maxConcurrentPets: 5,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
            },
          ],
        }),
      },
      env,
    );

    const after = (await (
      await quote(env, 'sunny-paws', 'type=boarding&start=2028-06-21&end=2028-06-24', [
        'pet_sp_bella',
        'pet_sp_mochi',
      ])
    ).json()) as { available: boolean };
    expect(after.available).toBe(true);

    // The OTHER tenant's service cap is untouched by Sunny Paws' change.
    const otherSettings = (await (
      await app.request('/api/happy-tails/admin/settings', { headers: await auth(TENANT_B) }, env)
    ).json()) as { services: { type: string; maxConcurrentPets: number | null }[] };
    expect(otherSettings.services.find((s) => s.type === 'boarding')?.maxConcurrentPets).toBe(4);
  });

  it('disabling a service hides it from config and rejects bookings for it', async () => {
    const { env } = createTestEnv();
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ services: [{ type: 'walk', enabled: false, options: [] }] }),
      },
      env,
    );
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string }[];
    };
    expect(config.services.map((s) => s.type)).not.toContain('walk');
    const avail = await quote(env, 'sunny-paws', 'type=walk&start=2028-08-01', ['pet_sp_bella']);
    expect(avail.status).toBe(400);
  });

  it('blocked ranges block boarding and walks, and removal restores availability', async () => {
    const { env } = createTestEnv();
    const created = (await (
      await app.request(
        '/api/sunny-paws/admin/blocked',
        {
          method: 'POST',
          headers: await auth(TENANT_A, true),
          body: JSON.stringify({ startDate: '2028-09-01', endDate: '2028-09-03' }),
        },
        env,
      )
    ).json()) as { id: string };

    const walk = (await (
      await quote(env, 'sunny-paws', 'type=walk&start=2028-09-01', ['pet_sp_bella'])
    ).json()) as { available: boolean };
    const boarding = (await (
      await quote(env, 'sunny-paws', 'type=boarding&start=2028-08-30&end=2028-09-05', [
        'pet_sp_bella',
      ])
    ).json()) as { available: boolean };
    expect(walk.available).toBe(false);
    expect(boarding.available).toBe(false);

    await app.request(
      `/api/sunny-paws/admin/blocked/${created.id}`,
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    const walkAfter = (await (
      await quote(env, 'sunny-paws', 'type=walk&start=2028-09-01', ['pet_sp_bella'])
    ).json()) as { available: boolean };
    expect(walkAfter.available).toBe(true);
  });

  describe('POST/DELETE /admin/blocked — Google Calendar hooks', () => {
    afterEach(() => vi.restoreAllMocks());

    it('creates the blocked row SyncPending and pushes an all-day UNAVAILABLE event to Google', async () => {
      const { env, raw } = createTestEnv();
      await connectCalendar(env, TENANT_A);
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_blocked_1' }), { status: 200 }));

      const created = (await (
        await app.request(
          '/api/sunny-paws/admin/blocked',
          {
            method: 'POST',
            headers: await auth(TENANT_A, true),
            body: JSON.stringify({ startDate: '2028-10-01', endDate: '2028-10-03' }),
          },
          env,
        )
      ).json()) as { id: string };

      // insertBookingRequest always stamps SyncPending = 1 regardless of connection state; because
      // the route awaits its calendar push under Vitest (no ExecutionContext), by the time the
      // response lands a successful push has already cleared it via the same CAS that stamped
      // GCalEventId — so a SyncPending of 0 here IS the proof the push round-tripped successfully.
      const row = raw
        .prepare('SELECT SyncPending, GCalEventId, Status FROM BookingRequests WHERE Id = ?')
        .get(created.id) as { SyncPending: number; GCalEventId: string | null; Status: string };
      expect(row.SyncPending).toBe(0);
      expect(row.Status).toBe('confirmed');
      expect(row.GCalEventId).toBe('evt_blocked_1');

      expect(spy).toHaveBeenCalledOnce();
      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(init.body as string) as {
        summary: string;
        start: { date: string };
        end: { date: string };
      };
      expect(sentBody.summary).toMatch(/unavailable/i);
      expect(sentBody.start.date).toBe('2028-10-01');
      expect(sentBody.end.date).toBe('2028-10-03');
    });

    it('DELETE removes the mirrored Google event, frees the day, then 404s on a repeat call', async () => {
      const { env, raw } = createTestEnv();
      await connectCalendar(env, TENANT_A);
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_blocked_2' }), { status: 200 }));

      const created = (await (
        await app.request(
          '/api/sunny-paws/admin/blocked',
          {
            method: 'POST',
            headers: await auth(TENANT_A, true),
            body: JSON.stringify({ startDate: '2028-11-01', endDate: '2028-11-03' }),
          },
          env,
        )
      ).json()) as { id: string };

      const blockedBoarding = (await (
        await quote(env, 'sunny-paws', 'type=boarding&start=2028-11-01&end=2028-11-02', [
          'pet_sp_bella',
        ])
      ).json()) as { available: boolean };
      expect(blockedBoarding.available).toBe(false);

      // Same spy instance as the create step (vi.spyOn on an already-spied fetch returns the
      // existing mock) — clear its call history so the assertions below are scoped to the DELETE.
      spy.mockClear();
      spy.mockResolvedValue(new Response(null, { status: 204 }));
      const first = await app.request(
        `/api/sunny-paws/admin/blocked/${created.id}`,
        { method: 'DELETE', headers: await auth(TENANT_A) },
        env,
      );
      expect(first.status).toBe(204);
      expect(spy).toHaveBeenCalledOnce();
      const [deleteUrl, deleteInit] = spy.mock.calls[0] as [string, RequestInit];
      expect(deleteUrl).toContain('evt_blocked_2');
      expect(deleteInit.method).toBe('DELETE');

      const row = raw
        .prepare('SELECT Status FROM BookingRequests WHERE Id = ?')
        .get(created.id) as { Status: string };
      expect(row.Status).toBe('cancelled');

      const freed = (await (
        await quote(env, 'sunny-paws', 'type=boarding&start=2028-11-01&end=2028-11-02', [
          'pet_sp_bella',
        ])
      ).json()) as { available: boolean };
      expect(freed.available).toBe(true);

      const second = await app.request(
        `/api/sunny-paws/admin/blocked/${created.id}`,
        { method: 'DELETE', headers: await auth(TENANT_A) },
        env,
      );
      expect(second.status).toBe(404);
    });

    it('DELETE on a never-synced blocked row (no calendar connected) 204s without a Google call', async () => {
      const { env } = createTestEnv(); // no connectCalendar call
      const spy = vi.spyOn(globalThis, 'fetch');

      const created = (await (
        await app.request(
          '/api/sunny-paws/admin/blocked',
          {
            method: 'POST',
            headers: await auth(TENANT_A, true),
            body: JSON.stringify({ startDate: '2028-12-01', endDate: '2028-12-03' }),
          },
          env,
        )
      ).json()) as { id: string };
      expect(spy).not.toHaveBeenCalled(); // no connection: create-side push no-ops

      const del = await app.request(
        `/api/sunny-paws/admin/blocked/${created.id}`,
        { method: 'DELETE', headers: await auth(TENANT_A) },
        env,
      );
      expect(del.status).toBe(204);
      expect(spy).not.toHaveBeenCalled(); // GCalEventId was null — nothing to delete in Google
    });
  });

  it('GET /admin/settings reports the calendar connection as disconnected by default', async () => {
    const { env } = createTestEnv();
    const res = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      calendar: { status: string; connectedAt: string | null; calendarId: string | null };
    };
    expect(res.calendar).toEqual({ status: 'disconnected', connectedAt: null, calendarId: null });
  });

  it('saves free-typed service options, reflected in config (top-level petTypes is ignored)', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          petTypes: ['cat'], // stale client payload — the registry no longer takes this field
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                { label: '20 min', durationMinutes: 20, rate: 22 },
                { label: '40 min', durationMinutes: 40, rate: 19 },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      petTypes: { slug: string; label: string }[];
      services: { type: string; options: { durationMinutes: number | null; rate: number }[] }[];
    };
    // The registry is untouched by the stale petTypes field — full seeded registry stays.
    expect(cfg.petTypes).toEqual([
      { slug: 'cat', label: 'Cat' },
      { slug: 'dog', label: 'Dog' },
      { slug: 'rabbit', label: 'Rabbit' },
    ]);
    const walk = cfg.services.find((s) => s.type === 'walk')!;
    expect(walk.options).toHaveLength(2);
    expect(walk.options.find((o) => o.durationMinutes === 40)?.rate).toBe(19);
  });

  it('an unknown top-level pet type is silently ignored, not rejected', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ petTypes: ['dragon'] }),
      },
      env,
    );
    expect(res.status).toBe(204);
  });

  it('accepts two options sharing a duration but not a name, with distinct keys', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'checkin',
              enabled: true,
              options: [
                { label: '30 minutes', durationMinutes: 30, rate: 18 },
                { label: 'Puppy Check-in', durationMinutes: 30, rate: 22 },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(204);
    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as { services: { type: string; options: { optionKey: string; label: string }[] }[] };
    const checkin = settings.services.find((s) => s.type === 'checkin')!;
    expect(checkin.options.map((o) => o.label).sort()).toEqual(['30 minutes', 'Puppy Check-in']);
    expect(new Set(checkin.options.map((o) => o.optionKey)).size).toBe(2);
  });

  it('rejects two options with the same name within one service', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                { label: '30 min', durationMinutes: 30, rate: 20 },
                { label: '30 min', durationMinutes: 30, rate: 25 },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects multiple options for a non-duration service (would collide on optionKey)', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [
                { label: 'Standard', durationMinutes: null, rate: 50 },
                { label: 'Premium', durationMinutes: null, rate: 80 },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    // Nothing persisted: the seeded single boarding option is intact.
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; options: { rate: number }[] }[];
    };
    const boarding = cfg.services.find((s) => s.type === 'boarding')!;
    expect(boarding.options).toHaveLength(1);
    expect(boarding.options[0].rate).toBe(50);
  });

  it('saves a windowed option, deriving duration from the window and ignoring a bogus client duration', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Morning Walk',
                  durationMinutes: 999, // bogus — server must override from the window
                  rate: 25,
                  startTime: '11:00',
                  endTime: '14:00',
                  capacity: 4,
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const adminSettings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      services: {
        type: string;
        options: {
          optionKey: string;
          durationMinutes: number | null;
          startTime: string | null;
          endTime: string | null;
          capacity: number | null;
        }[];
      }[];
    };
    const adminWalk = adminSettings.services.find((s) => s.type === 'walk')!;
    expect(adminWalk.options).toHaveLength(1);
    expect(adminWalk.options[0]).toMatchObject({
      optionKey: 'morning-walk',
      durationMinutes: 180, // 11:00–14:00, not the bogus 999
      startTime: '11:00',
      endTime: '14:00',
      capacity: 4,
    });

    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: {
        type: string;
        options: {
          optionKey: string;
          startTime: string | null;
          endTime: string | null;
          capacity: number | null;
        }[];
      }[];
    };
    const cfgWalk = cfg.services.find((s) => s.type === 'walk')!;
    expect(cfgWalk.options[0]).toMatchObject({
      optionKey: 'morning-walk',
      startTime: '11:00',
      endTime: '14:00',
      capacity: 4,
    });
  });

  it('rejects a one-sided time window', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                { label: 'Morning Walk', durationMinutes: 60, rate: 25, startTime: '11:00' },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a window whose end is not after its start', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Morning Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '14:00',
                  endTime: '11:00',
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-positive capacity', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Morning Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '11:00',
                  endTime: '14:00',
                  capacity: 0,
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects two windowed options with the same label (OptionKey collision)', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Group Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '11:00',
                  endTime: '12:00',
                },
                {
                  label: 'Group Walk',
                  durationMinutes: 60,
                  rate: 30,
                  startTime: '15:00',
                  endTime: '16:00',
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a blank option label', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [{ label: '  ', durationMinutes: 30, rate: 20 }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('persists per-service questions and constraints, round-tripping through GET and the public config', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [
                { label: 'Is your dog crate-trained?', type: 'yesno', required: true },
                {
                  label: 'Feeding schedule',
                  type: 'select',
                  required: false,
                  options: ['am', 'pm'],
                },
              ],
              maxNights: 14,
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      services: {
        type: string;
        shape: string;
        questions: { id: string; label: string; type: string }[];
        maxNights: number | null;
      }[];
    };
    const boarding = settings.services.find((s) => s.type === 'boarding')!;
    expect(boarding.shape).toBe('range');
    expect(boarding.questions).toHaveLength(2);
    expect(boarding.questions[0].label).toBe('Is your dog crate-trained?');
    expect(boarding.questions[0].id).toBeTruthy(); // server-assigned stable id
    expect(boarding.maxNights).toBe(14);

    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; questions: { label: string }[]; maxNights: number | null }[];
    };
    const publicBoarding = config.services.find((s) => s.type === 'boarding')!;
    expect(publicBoarding.questions).toHaveLength(2);
    expect(publicBoarding.maxNights).toBe(14);
    expect('minNights' in publicBoarding).toBe(false);
  });

  it('rejects malformed question definitions without persisting anything', async () => {
    const { env } = createTestEnv();

    const badType = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'Bad', type: 'essay', required: false }],
            },
          ],
        }),
      },
      env,
    );
    expect(badType.status).toBe(400);

    const badSelect = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'No options', type: 'select', required: false, options: [] }],
            },
          ],
        }),
      },
      env,
    );
    expect(badSelect.status).toBe(400);

    // minNights is rejected outright now — this doubles as the nothing-persisted proof below.
    const sendsMinNights = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              minNights: 10,
              maxNights: 2,
            },
          ],
        }),
      },
      env,
    );
    expect(sendsMinNights.status).toBe(400);

    const nonNumericMinMax = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [
                { label: 'Bad bound', type: 'number', required: false, min: 'not-a-number' },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(nonNumericMinMax.status).toBe(400);

    // Nothing above should have persisted — boarding rate is still the seeded 50.
    const config = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; options: { rate: number }[] }[];
    };
    expect(config.services.find((s) => s.type === 'boarding')?.options[0].rate).toBe(50);
  });

  it('drops a retired question `pattern` instead of rejecting or storing it', async () => {
    const { env } = createTestEnv();
    // The regex pattern feature is gone. An older client (or stale draft) that still sends one is
    // NOT rejected — the key is simply not carried through, so text questions have no format rule.
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              // '(' is not even a valid regex — proof nothing tries to compile it.
              questions: [{ label: 'Stale pattern', type: 'text', required: false, pattern: '(' }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(204);

    const body = (await (
      await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await auth(TENANT_A, true) },
        env,
      )
    ).json()) as { services: { type: string; questions: Record<string, unknown>[] }[] };
    const stored = body.services.find((s) => s.type === 'boarding')!.questions[0];
    expect(stored.label).toBe('Stale pattern');
    expect(stored).not.toHaveProperty('pattern');
  });

  it('preserves existing questions and constraints when a PUT omits them for a service (patch semantics)', async () => {
    const { env } = createTestEnv();
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              questions: [{ label: 'Is your dog crate-trained?', type: 'yesno', required: true }],
              maxNights: 14,
            },
          ],
        }),
      },
      env,
    );

    // A caller PUTs the same service with ONLY `type`/`enabled` — questions/constraints omitted.
    const partial = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 55 }],
            },
          ],
        }),
      },
      env,
    );
    expect(partial.status).toBe(204);

    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      services: {
        type: string;
        questions: { label: string }[];
        maxNights: number | null;
        options: { rate: number }[];
      }[];
    };
    const boarding = settings.services.find((s) => s.type === 'boarding')!;
    // The rate change from the partial PUT took effect...
    expect(boarding.options[0].rate).toBe(55);
    // ...but questions/constraints, which the partial PUT never mentioned, survived untouched.
    expect(boarding.questions).toHaveLength(1);
    expect(boarding.questions[0].label).toBe('Is your dog crate-trained?');
    expect(boarding.maxNights).toBe(14);
  });

  it('rejects a time window on a non-per-visit (range-shaped) service', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', rate: 50, startTime: '11:00', endTime: '14:00' }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it("preserves a windowed option's OptionKey across a label rename, so existing bookings stay capacity-tracked", async () => {
    const { env } = createTestEnv();
    const create = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  label: 'Morning Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '11:00',
                  endTime: '14:00',
                  capacity: 2,
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(create.status).toBe(204);

    const book = async () => {
      const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
      return app.request(
        '/api/sunny-paws/bookings',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            type: 'walk',
            optionKey: 'morning-walk',
            startDate: '2028-11-01',
            petIds: ['pet_sp_bella'],
          }),
        },
        env,
      );
    };
    expect((await book()).status).toBe(201);
    expect((await book()).status).toBe(201);

    // Rename the option, sending back the optionKey the GET response gave us for it.
    const rename = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: [
                {
                  optionKey: 'morning-walk',
                  label: 'AM Walk',
                  durationMinutes: 60,
                  rate: 25,
                  startTime: '11:00',
                  endTime: '14:00',
                  capacity: 2,
                },
              ],
            },
          ],
        }),
      },
      env,
    );
    expect(rename.status).toBe(204);

    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; options: { optionKey: string; label: string }[] }[];
    };
    const walk = cfg.services.find((s) => s.type === 'walk')!;
    expect(walk.options[0]).toMatchObject({ optionKey: 'morning-walk', label: 'AM Walk' });

    // Capacity 2, already booked twice under 'morning-walk' — a third booking against that
    // same (preserved) key must still be rejected, proving the rename didn't orphan the count.
    const third = await book();
    expect(third.status).toBe(409);
  });
});

describe('configurable limits via admin settings (service-level, 0015)', () => {
  const boardingOpts = [{ label: 'Standard', durationMinutes: null, rate: 50 }];
  const houseOpts = [{ label: 'Standard', durationMinutes: null, rate: 70 }];
  const putSettings = async (env: Env, body: unknown) =>
    app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    );
  type SettingsCaps = {
    services: {
      type: string;
      capacityKind: 'boarding' | 'housesit' | 'none';
      maxConcurrentPets: number | null;
      maxNights: number | null;
    }[];
  };
  const getSettings = async (env: Env) =>
    (await (
      await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await adminHeaders(TENANT_A) },
        env,
      )
    ).json()) as SettingsCaps & Record<string, unknown>;

  it('PUT service caps round-trip through GET, which also exposes capacityKind (F5)', async () => {
    const { env } = createTestEnv();
    const res = await putSettings(env, {
      services: [
        { type: 'boarding', enabled: true, maxConcurrentPets: 5, options: boardingOpts },
        { type: 'housesitting', enabled: true, maxConcurrentPets: 2, options: houseOpts },
      ],
    });
    expect(res.status).toBe(204);
    const settings = await getSettings(env);
    const boarding = settings.services.find((s) => s.type === 'boarding')!;
    expect(boarding).toMatchObject({
      capacityKind: 'boarding',
      maxConcurrentPets: 5,
    });
    expect(settings.services.find((s) => s.type === 'housesitting')).toMatchObject({
      capacityKind: 'housesit',
      maxConcurrentPets: 2,
    });
    expect(settings.services.find((s) => s.type === 'walk')).toMatchObject({
      capacityKind: 'none',
      maxConcurrentPets: null,
    });
  });

  it('a cap on the wrong service kind is rejected, not silently ignored', async () => {
    const { env } = createTestEnv();
    const wrongPerDay = await putSettings(env, {
      services: [{ type: 'boarding', enabled: true, maxPerDay: 3, options: boardingOpts }],
    });
    expect(wrongPerDay.status).toBe(400);
    expect(((await wrongPerDay.json()) as { error: string }).error).toBe(
      "Boarding: that capacity doesn't apply to this service.",
    );
    const wrongConcurrent = await putSettings(env, {
      services: [
        {
          type: 'walk',
          enabled: true,
          maxConcurrentPets: 3,
          options: [{ label: '30 min', durationMinutes: 30, rate: 20 }],
        },
      ],
    });
    expect(wrongConcurrent.status).toBe(400);
  });

  it('PATCH semantics: an absent cap field keeps the current value; explicit null clears', async () => {
    const { env } = createTestEnv();
    await putSettings(env, {
      services: [{ type: 'boarding', enabled: true, maxConcurrentPets: 5, options: boardingOpts }],
    });
    // Absent -> keep 5.
    await putSettings(env, {
      services: [{ type: 'boarding', enabled: true, options: boardingOpts }],
    });
    let settings = await getSettings(env);
    expect(settings.services.find((s) => s.type === 'boarding')?.maxConcurrentPets).toBe(5);
    // Explicit null -> unlimited.
    await putSettings(env, {
      services: [
        { type: 'boarding', enabled: true, maxConcurrentPets: null, options: boardingOpts },
      ],
    });
    settings = await getSettings(env);
    expect(settings.services.find((s) => s.type === 'boarding')?.maxConcurrentPets).toBeNull();
  });

  it('accepts a boarding cap above the old ceiling of 50; rejects one over the 1000 rail', async () => {
    const { env } = createTestEnv();
    expect(
      (
        await putSettings(env, {
          services: [
            { type: 'boarding', enabled: true, maxConcurrentPets: 80, options: boardingOpts },
          ],
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await putSettings(env, {
          services: [
            { type: 'boarding', enabled: true, maxConcurrentPets: 2000, options: boardingOpts },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it('the removed tenant fields no longer round-trip: absent from GET, ignored on PUT', async () => {
    const { env } = createTestEnv();
    const settings = await getSettings(env);
    expect('maxBoardingPets' in settings).toBe(false);
    expect('maxHouseSitsPerDay' in settings).toBe(false);
    expect('maxStayNights' in settings).toBe(false);
    // Old clients may still send them — harmlessly ignored, never written.
    expect((await putSettings(env, { maxBoardingPets: 1 })).status).toBe(204);
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as Record<
      string,
      unknown
    >;
    expect('maxBoardingPets' in cfg).toBe(false);
    expect('maxStayNights' in cfg).toBe(false);
  });

  it('rejects an invalid timezone', async () => {
    const { env } = createTestEnv();
    const res = await putSettings(env, { timezone: 'Mars/Phobos' });
    expect(res.status).toBe(400);
  });
});

describe('settings — capacity in pets (MaxPerDay retired)', () => {
  it('PATCH maxConcurrentPets on a house-sit service persists and GET reflects it', async () => {
    const { env } = createTestEnv();
    const headers = {
      ...(await adminHeaders(TENANT_A)),
      'Content-Type': 'application/json',
    };
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          services: [
            {
              type: 'housesitting',
              enabled: true,
              maxConcurrentPets: 3,
              options: [{ label: 'Standard', rate: 70 }],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const get = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const body = (await get.json()) as {
      services: { type: string; maxConcurrentPets: number | null }[];
    };
    const house = body.services.find((s) => s.type === 'housesitting')!;
    expect(house.maxConcurrentPets).toBe(3);
    // maxPerDay is gone from the API surface.
    expect('maxPerDay' in house).toBe(false);
  });

  it('PATCH rejects a maxPerDay value on any service', async () => {
    const { env } = createTestEnv();
    const headers = {
      ...(await adminHeaders(TENANT_A)),
      'Content-Type': 'application/json',
    };
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          services: [
            {
              type: 'housesitting',
              enabled: true,
              maxPerDay: 2,
              options: [{ label: 'Standard', rate: 70 }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "House sitting: that capacity doesn't apply to this service.",
    );
  });
});

describe('GET /admin/settings exposes the signed-in sitter’s own login email', () => {
  // The setup wizard prefills a NULL contactEmail with it — tenants provisioned before signup
  // started stamping Tenants.ContactEmail have no contact address at all, and asking the sitter
  // to retype the address they just signed up with is the bug this closes.
  it('returns adminEmail for the authenticated TenantUsers row', async () => {
    const { env } = createTestEnv();
    const token = await mintAdminToken('tu_sunny', TENANT_A, TEST_SECRET);
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { adminEmail: string | null }).adminEmail).toBe(
      'admin@sunnypaws.example',
    );
  });

  it('is null — never another tenant’s sitter — when the user id is not this tenant’s', async () => {
    const { env } = createTestEnv();
    // 'tu_dana' belongs to TENANT_B; the read is scoped by TenantId, so it must not resolve here.
    const token = await mintAdminToken('tu_dana', TENANT_A, TEST_SECRET);
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { adminEmail: string | null }).adminEmail).toBeNull();
  });
});

describe('settings — service short description (0025)', () => {
  /** PUT one service body; every case here only ever varies the description. */
  const putHousesitting = async (env: Env, description: unknown) =>
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'housesitting',
              enabled: true,
              description,
              options: [{ label: 'Standard', rate: 70 }],
            },
          ],
        }),
      },
      env,
    );

  const getHousesitting = async (env: Env) => {
    const get = await app.request(
      '/api/sunny-paws/admin/settings',
      { headers: await auth(TENANT_A) },
      env,
    );
    const body = (await get.json()) as { services: { type: string; description: unknown }[] };
    return body.services.find((s) => s.type === 'housesitting')!;
  };

  it('saves a description and round-trips it through GET /admin/settings', async () => {
    const { env } = createTestEnv();
    expect((await putHousesitting(env, '  Overnights at your place.  ')).status).toBe(204);
    // Stored trimmed, not as typed.
    expect((await getHousesitting(env)).description).toBe('Overnights at your place.');
  });

  it('treats an empty or whitespace-only description as cleared (NULL, never "")', async () => {
    const { env } = createTestEnv();
    await putHousesitting(env, 'Something to clear later.');
    expect((await putHousesitting(env, '')).status).toBe(204);
    expect((await getHousesitting(env)).description).toBeNull();

    await putHousesitting(env, 'Set again.');
    expect((await putHousesitting(env, '   \n  ')).status).toBe(204);
    expect((await getHousesitting(env)).description).toBeNull();
  });

  it('keeps the current description when the field is absent from the service body (PATCH semantics)', async () => {
    const { env } = createTestEnv();
    await putHousesitting(env, 'Kept across an unrelated save.');
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'housesitting',
              enabled: true,
              options: [{ label: 'Standard', rate: 75 }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(204);
    expect((await getHousesitting(env)).description).toBe('Kept across an unrelated save.');
  });

  it('rejects a description over 200 characters with a clear message, persisting nothing', async () => {
    const { env } = createTestEnv();
    await putHousesitting(env, 'The short one that must survive.');
    const res = await putHousesitting(env, 'x'.repeat(201));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'House sitting: description must be 200 characters or fewer.',
    );
    expect((await getHousesitting(env)).description).toBe('The short one that must survive.');
    // Exactly at the cap is fine — the boundary is inclusive.
    expect((await putHousesitting(env, 'y'.repeat(200))).status).toBe(204);
  });

  it('rejects a non-string, non-null description instead of silently clearing the stored one', async () => {
    const { env } = createTestEnv();
    await putHousesitting(env, 'Must survive a bogus follow-up save.');
    const res = await putHousesitting(env, 42);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'House sitting: description must be text.',
    );
    // The whole PUT is rejected — coercing 42 to null would have wiped a blurb the request never
    // meant to touch.
    expect((await getHousesitting(env)).description).toBe('Must survive a bogus follow-up save.');
    // An explicit null is still the documented way to clear it.
    expect((await putHousesitting(env, null)).status).toBe(204);
    expect((await getHousesitting(env)).description).toBeNull();
  });

  it('ISOLATION: a description is neither readable nor writable across tenants', async () => {
    const { env } = createTestEnv();
    const readBoarding = async (slug: string, tenantId: string) => {
      const get = await app.request(
        `/api/${slug}/admin/settings`,
        { headers: await auth(tenantId) },
        env,
      );
      const body = (await get.json()) as { services: { type: string; description: unknown }[] };
      return body.services.find((s) => s.type === 'boarding')!.description;
    };
    const putBoarding = async (slug: string, tenantId: string, description: string) =>
      await app.request(
        `/api/${slug}/admin/settings`,
        {
          method: 'PUT',
          headers: await auth(tenantId, true),
          body: JSON.stringify({
            services: [
              {
                type: 'boarding',
                enabled: true,
                description,
                options: [{ label: 'Standard', rate: 50 }],
              },
            ],
          }),
        },
        env,
      );

    expect((await putBoarding('sunny-paws', TENANT_A, "Tenant A's private blurb.")).status).toBe(
      204,
    );

    // READ: B's own admin view and public config show B's seeded blurb, never A's.
    expect(await readBoarding('happy-tails', TENANT_B)).toBe(
      'Small-group boarding for dogs only, four dogs max per day.',
    );
    const cfgB = (await (await app.request('/api/happy-tails/config', {}, env)).json()) as {
      services: { type: string; description: string | null }[];
    };
    expect(cfgB.services.find((s) => s.type === 'boarding')!.description).not.toContain('Tenant A');

    // WRITE: A's admin token cannot reach B's settings at all — a real token for the wrong tenant
    // is authenticated but not authorized, hence 403 rather than 401.
    const crossWrite = await putBoarding('happy-tails', TENANT_A, 'Overwritten by tenant A.');
    expect(crossWrite.status).toBe(403);
    expect(await readBoarding('happy-tails', TENANT_B)).toBe(
      'Small-group boarding for dogs only, four dogs max per day.',
    );

    // And B writing its own blurb leaves A's untouched.
    expect((await putBoarding('happy-tails', TENANT_B, "Tenant B's own blurb.")).status).toBe(204);
    expect(await readBoarding('sunny-paws', TENANT_A)).toBe("Tenant A's private blurb.");
  });

  it('surfaces the SEEDED demo descriptions, so a bad seed.sql merge fails CI instead of passing', async () => {
    const { env } = createTestEnv();
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; description: string | null }[];
    };
    // Nothing else asserts a seeded description; without this, resolving a seed.sql conflict by
    // dropping the Description column from the INSERT would keep the suite green.
    expect(cfg.services.find((s) => s.type === 'boarding')!.description).toBe(
      'Your pet stays at our home with a fenced yard and two walks a day.',
    );
    expect(cfg.services.find((s) => s.type === 'daycare')!.description).toBe(
      'Drop off in the morning, pick up by 6pm.',
    );
  });

  it('exposes the description on the public widget config', async () => {
    const { env } = createTestEnv();
    await putHousesitting(env, 'We stay over so your pet keeps its routine.');
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; description: string | null }[];
    };
    expect(cfg.services.find((s) => s.type === 'housesitting')!.description).toBe(
      'We stay over so your pet keeps its routine.',
    );
    // A service with no blurb reports null rather than omitting the key.
    expect(cfg.services.find((s) => s.type === 'walk')!.description).toBeNull();
  });
});

describe('settings PUT caps', () => {
  const q = (label: string) => ({ label, type: 'yesno', required: false });

  it('rejects a 6th question, accepts 5', async () => {
    const { env } = createTestEnv();
    const mk = (n: number) => ({
      services: [
        {
          type: 'walk',
          enabled: true,
          options: [{ label: '30 minutes', durationMinutes: 30, rate: 20 }],
          questions: Array.from({ length: n }, (_, i) => q(`Q${i + 1}`)),
        },
      ],
    });
    const six = await app.request(
      '/api/sunny-paws/admin/settings',
      { method: 'PUT', headers: await auth(TENANT_A, true), body: JSON.stringify(mk(6)) },
      env,
    );
    expect(six.status).toBe(400);
    expect(((await six.json()) as { error: string }).error).toContain('5 questions');
    const five = await app.request(
      '/api/sunny-paws/admin/settings',
      { method: 'PUT', headers: await auth(TENANT_A, true), body: JSON.stringify(mk(5)) },
      env,
    );
    expect(five.status).toBe(204);
  });

  it('rejects maxPetCount 16, accepts 15', async () => {
    const { env } = createTestEnv();
    const mk = (maxPetCount: number) => ({
      services: [
        {
          type: 'boarding',
          enabled: true,
          options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
          maxPetCount,
          // Seeded boarding pool is 2; raise it so the pool-vs-max check can't mask this test.
          maxConcurrentPets: 20,
        },
      ],
    });
    const sixteen = await app.request(
      '/api/sunny-paws/admin/settings',
      { method: 'PUT', headers: await auth(TENANT_A, true), body: JSON.stringify(mk(16)) },
      env,
    );
    expect(sixteen.status).toBe(400);
    expect(((await sixteen.json()) as { error: string }).error).toContain('15');
    const fifteen = await app.request(
      '/api/sunny-paws/admin/settings',
      { method: 'PUT', headers: await auth(TENANT_A, true), body: JSON.stringify(mk(15)) },
      env,
    );
    expect(fifteen.status).toBe(204);
  });

  it("rejects a daily pool smaller than one booking's max pets — including via PATCH semantics", async () => {
    const { env } = createTestEnv();
    const boarding = (extra: Record<string, unknown>) => ({
      services: [
        {
          type: 'boarding',
          enabled: true,
          options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
          ...extra,
        },
      ],
    });
    // Both in one body: pool 2 < maxPetCount 3.
    const direct = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify(boarding({ maxPetCount: 3, maxConcurrentPets: 2 })),
      },
      env,
    );
    expect(direct.status).toBe(400);
    // Equal is fine.
    const equal = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify(boarding({ maxPetCount: 3, maxConcurrentPets: 3 })),
      },
      env,
    );
    expect(equal.status).toBe(204);
    // PATCH case: stored maxPetCount is now 3; lowering only the pool below it must also reject.
    const patched = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify(boarding({ maxConcurrentPets: 2 })),
      },
      env,
    );
    expect(patched.status).toBe(400);
    expect(((await patched.json()) as { error: string }).error).toContain('per day');
  });

  it('accepts, echoes, and clears a holidayRate', async () => {
    const { env } = createTestEnv();
    const put = async (holidayRate: number | null) =>
      app.request(
        '/api/sunny-paws/admin/settings',
        {
          method: 'PUT',
          headers: await auth(TENANT_A, true),
          body: JSON.stringify({
            services: [
              {
                type: 'boarding',
                enabled: true,
                options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
                holidayRate,
              },
            ],
          }),
        },
        env,
      );
    const read = async () => {
      const res = await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await auth(TENANT_A, true) },
        env,
      );
      const body = (await res.json()) as {
        services: { type: string; holidayRate: number | null }[];
      };
      return body.services.find((s) => s.type === 'boarding')!.holidayRate;
    };

    expect((await put(75)).status).toBe(204);
    expect(await read()).toBe(75);
    expect((await put(null)).status).toBe(204);
    expect(await read()).toBeNull(); // explicit null clears it back to "no holiday pricing"
  });

  it('keeps the current holidayRate when the field is absent (PATCH semantics)', async () => {
    const { env } = createTestEnv();
    const body = (services: unknown) => JSON.stringify({ services });
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: body([
          {
            type: 'boarding',
            enabled: true,
            options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
            holidayRate: 75,
          },
        ]),
      },
      env,
    );
    // Second PUT omits holidayRate entirely — it must NOT be wiped.
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: body([
          {
            type: 'boarding',
            enabled: true,
            options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
          },
        ]),
      },
      env,
    );
    const svc = (await listServices(env.PAWSERVATION_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(svc.HolidayRate).toBe(75);
  });

  it('rejects a holidayRate that is not whole dollars >= 1', async () => {
    const { env } = createTestEnv();
    for (const bad of [0, -5, 12.5]) {
      const res = await app.request(
        '/api/sunny-paws/admin/settings',
        {
          method: 'PUT',
          headers: await auth(TENANT_A, true),
          body: JSON.stringify({
            services: [
              {
                type: 'boarding',
                enabled: true,
                options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
                holidayRate: bad,
              },
            ],
          }),
        },
        env,
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('Holiday rate');
    }
  });

  it('publishes holidayRate on the public config so the widget can label holidays', async () => {
    const { env } = createTestEnv();
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              holidayRate: 75,
            },
          ],
        }),
      },
      env,
    );
    const res = await app.request('/api/sunny-paws/config', {}, env);
    const cfg = (await res.json()) as { services: { type: string; holidayRate: number | null }[] };
    expect(cfg.services.find((s) => s.type === 'boarding')!.holidayRate).toBe(75);
  });
});

describe('settings — PetRateMode, the sitter-opted-in per-pet multiplier (0005)', () => {
  const putMode = async (env: Env, petRateMode: unknown) =>
    app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
              petRateMode,
            },
          ],
        }),
      },
      env,
    );

  it("every seeded service starts 'exact' — the multiplier is never the ambient default", async () => {
    const { env } = createTestEnv();
    const services = await listServices(env.PAWSERVATION_DB, TENANT_A);
    expect(services.length).toBeGreaterThan(0);
    for (const svc of services) expect(svc.PetRateMode).toBe('exact');
  });

  it('round-trips the mode through the settings PUT and back out of the GET', async () => {
    const { env } = createTestEnv();
    expect((await putMode(env, 'linear')).status).toBe(204);
    const read = async () => {
      const res = await app.request(
        '/api/sunny-paws/admin/settings',
        { headers: await auth(TENANT_A) },
        env,
      );
      const body = (await res.json()) as { services: { type: string; petRateMode: string }[] };
      return body.services.find((s) => s.type === 'boarding')!.petRateMode;
    };
    expect(await read()).toBe('linear');
    expect(
      (await listServices(env.PAWSERVATION_DB, TENANT_A)).find((s) => s.ServiceType === 'boarding')!
        .PetRateMode,
    ).toBe('linear');
    expect((await putMode(env, 'exact')).status).toBe(204);
    expect(await read()).toBe('exact');
  });

  it('keeps the stored mode when the field is absent (PATCH semantics — no silent re-moding)', async () => {
    const { env } = createTestEnv();
    expect((await putMode(env, 'linear')).status).toBe(204);
    // A later save that says nothing about pricing mode must not quietly reset the opt-in.
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
            },
          ],
        }),
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(
      (await listServices(env.PAWSERVATION_DB, TENANT_A)).find((s) => s.ServiceType === 'boarding')!
        .PetRateMode,
    ).toBe('linear');
  });

  it('rejects an unknown mode rather than coercing it in either direction', async () => {
    const { env } = createTestEnv();
    for (const bad of ['sliding', '', 1, true, null]) {
      const res = await putMode(env, bad);
      expect(res.status).toBe(400);
    }
    // Nothing was written by any of those attempts.
    expect(
      (await listServices(env.PAWSERVATION_DB, TENANT_A)).find((s) => s.ServiceType === 'boarding')!
        .PetRateMode,
    ).toBe('exact');
  });

  it('the mode is per SERVICE and per TENANT — one opt-in moves exactly one row', async () => {
    const { env } = createTestEnv();
    expect((await putMode(env, 'linear')).status).toBe(204);
    const sunny = await listServices(env.PAWSERVATION_DB, TENANT_A);
    expect(sunny.find((s) => s.ServiceType === 'boarding')!.PetRateMode).toBe('linear');
    for (const svc of sunny.filter((s) => s.ServiceType !== 'boarding'))
      expect(svc.PetRateMode).toBe('exact');
    for (const svc of await listServices(env.PAWSERVATION_DB, TENANT_B))
      expect(svc.PetRateMode).toBe('exact');
  });
});

describe('settings PUT — the per-service option cap', () => {
  const optionRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      label: `Pack ${i + 1}`,
      durationMinutes: 60,
      rate: 25,
    }));
  const putOptions = async (env: Env, n: number) =>
    app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [{ type: 'walk', enabled: true, options: optionRows(n) }],
        }),
      },
      env,
    );

  it('accepts a service at exactly the cap', async () => {
    const { env } = createTestEnv();
    expect((await putOptions(env, 8)).status).toBe(204);
  });

  /**
   * The cap blocks GROWTH, not existence. "Add an option" was unbounded before the cap landed, so
   * a live sitter can already hold more rows than the limit — and a flat `> MAX` check would lock
   * her out of saving ANYTHING in Settings until she deleted options she still uses. A rule
   * introduced today must not retroactively invalidate a configuration that was legal when made.
   */
  it('an ALREADY over-cap service stays saveable — the cap is not retroactive', async () => {
    const { env, raw } = createTestEnv();
    // 11 stored walk options, the way a pre-cap sitter's row looks. Written directly, since the
    // PUT is exactly the thing being proven not to lock her out.
    raw
      .prepare(`DELETE FROM TenantServiceOptions WHERE TenantId=? AND ServiceType='walk'`)
      .run(TENANT_A);
    for (let i = 1; i <= 11; i++)
      raw
        .prepare(
          `INSERT INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate)
           VALUES (?, ?, 'walk', ?, ?, ?, 25)`,
        )
        .run(`opt_over_${i}`, TENANT_A, `d${i * 10}`, `${i * 10} min`, i * 10);

    // Re-saving all 11 unchanged — plus an unrelated edit — must succeed.
    const resave = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              description: 'Neighbourhood walks',
              options: Array.from({ length: 11 }, (_, i) => ({
                optionKey: `d${(i + 1) * 10}`,
                label: `${(i + 1) * 10} min`,
                durationMinutes: (i + 1) * 10,
                rate: 25,
              })),
            },
          ],
        }),
      },
      env,
    );
    expect(resave.status).toBe(204);

    // But she still cannot GROW it — and the message says why, naming both numbers.
    const grow = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              options: Array.from({ length: 12 }, (_, i) => ({
                label: `${(i + 1) * 10} min`,
                durationMinutes: (i + 1) * 10,
                rate: 25,
              })),
            },
          ],
        }),
      },
      env,
    );
    expect(grow.status).toBe(400);
    const msg = ((await grow.json()) as { error: string }).error;
    expect(msg).toContain('already has 11 options');
    expect(msg).toContain('limit of 8');
  });

  it('refuses one option past the cap, in plain language, and writes nothing', async () => {
    const { env } = createTestEnv();
    expect((await putOptions(env, 8)).status).toBe(204);
    const res = await putOptions(env, 9);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('at most 8 options');
    // The rejected payload left the 8 saved rows alone rather than half-applying.
    const rows = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as { services: { type: string; options: unknown[] }[] };
    expect(rows.services.find((s) => s.type === 'walk')!.options).toHaveLength(8);
  });
});
