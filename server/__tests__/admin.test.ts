import { describe, expect, it } from 'vitest';
import app from '../index';
import { providerViews, type CapabilityDescriptor } from '../lib/providers';
import { mintToken } from '../lib/token';
import {
  adminHeaders,
  adminToken,
  createTestEnv,
  TENANT_A,
  TENANT_B,
  TEST_SECRET,
} from './helpers';

/** Admin Bearer headers for a tenant, optionally with a JSON content type. */
async function auth(tenantId: string, json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { Authorization: `Bearer ${await adminToken(tenantId)}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
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
          maxBoardingPets: 3,
          petTypes: ['dog', 'cat'],
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
      maxBoardingPets: number;
      services: { type: string; options: { rate: number }[] }[];
    };
    expect(config.displayName).toBe('Sunny Paws Deluxe');
    expect(config.accentColor).toBe('#10b981');
    expect(config.maxBoardingPets).toBe(3);
    expect(config.services.find((s) => s.type === 'boarding')?.options[0].rate).toBe(75);

    // …and the OTHER tenant is untouched.
    const other = (await (await app.request('/api/happy-tails/config', {}, env)).json()) as {
      displayName: string;
    };
    expect(other.displayName).toBe('Happy Tails');
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

  it('capacity edits change availability outcomes (per-tenant max)', async () => {
    const { env } = createTestEnv();
    // Seed: Jun 21-24 at Sunny Paws has 1 pet, max 2 -> a 2-pet request conflicts.
    const before = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2028-06-21&end=2028-06-24&pets=2',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(before.available).toBe(false);

    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ maxBoardingPets: 5 }),
      },
      env,
    );

    const after = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2028-06-21&end=2028-06-24&pets=2',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(after.available).toBe(true);

    // The OTHER tenant's capacity is untouched by Sunny Paws' change.
    const otherConfig = (await (await app.request('/api/happy-tails/config', {}, env)).json()) as {
      maxBoardingPets: number;
    };
    expect(otherConfig.maxBoardingPets).toBe(4);
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
    const avail = await app.request(
      '/api/sunny-paws/availability?type=walk&start=2028-08-01',
      {},
      env,
    );
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
      await app.request('/api/sunny-paws/availability?type=walk&start=2028-09-01', {}, env)
    ).json()) as { available: boolean };
    const boarding = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2028-08-30&end=2028-09-05&pets=1',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(walk.available).toBe(false);
    expect(boarding.available).toBe(false);

    await app.request(
      `/api/sunny-paws/admin/blocked/${created.id}`,
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    const walkAfter = (await (
      await app.request('/api/sunny-paws/availability?type=walk&start=2028-09-01', {}, env)
    ).json()) as { available: boolean };
    expect(walkAfter.available).toBe(true);
  });

  it('connecting a provider flips status to connected-stub, per tenant', async () => {
    const { env } = createTestEnv();
    await app.request(
      '/api/sunny-paws/admin/providers/calendar/connect',
      { method: 'POST', headers: await auth(TENANT_A) },
      env,
    );
    const a = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as { providers: { capability: string; status: string }[] };
    const b = (await (
      await app.request('/api/happy-tails/admin/settings', { headers: await auth(TENANT_B) }, env)
    ).json()) as { providers: { capability: string; status: string }[] };
    expect(a.providers.find((p) => p.capability === 'calendar')?.status).toBe('connected-stub');
    expect(b.providers.find((p) => p.capability === 'calendar')?.status).toBe('disconnected');

    const unknown = await app.request(
      '/api/sunny-paws/admin/providers/teleportation/connect',
      { method: 'POST', headers: await auth(TENANT_A) },
      env,
    );
    expect(unknown.status).toBe(404);
  });

  it('adding a capability is a registry entry, not a schema change (FR18)', () => {
    const extended: CapabilityDescriptor[] = [
      { capability: 'payments', provider: 'stripe', label: 'Stripe' },
    ];
    const views = providerViews([], extended);
    expect(views).toEqual([
      {
        capability: 'payments',
        provider: 'stripe',
        label: 'Stripe',
        status: 'disconnected',
        connectedAt: null,
      },
    ]);
  });

  it('saves pet types and free-typed service options, reflected in config', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          petTypes: ['cat'],
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
      petTypes: string[];
      services: { type: string; options: { durationMinutes: number | null; rate: number }[] }[];
    };
    expect(cfg.petTypes).toEqual(['cat']);
    const walk = cfg.services.find((s) => s.type === 'walk')!;
    expect(walk.options).toHaveLength(2);
    expect(walk.options.find((o) => o.durationMinutes === 40)?.rate).toBe(19);
  });

  it('rejects an unknown pet type without persisting', async () => {
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
    expect(res.status).toBe(400);
  });

  it('rejects duplicate durations within one service', async () => {
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
                { label: 'also 30', durationMinutes: 30, rate: 25 },
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
});

describe('configurable limits via admin settings', () => {
  it('persists null (unlimited) and new limit fields, surfaced in config', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'content-type': 'application/json' },
        body: JSON.stringify({
          maxBoardingPets: null,
          maxHouseSitsPerDay: 1,
          maxStayNights: 14,
          timezone: 'America/New_York',
        }),
      },
      env,
    );
    expect(put.status).toBe(204);
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      maxBoardingPets: number | null;
      maxHouseSitsPerDay: number | null;
      maxStayNights: number | null;
      timezone: string | null;
    };
    expect(cfg.maxBoardingPets).toBeNull();
    expect(cfg.maxHouseSitsPerDay).toBe(1);
    expect(cfg.maxStayNights).toBe(14);
    expect(cfg.timezone).toBe('America/New_York');
  });

  it('rejects an invalid timezone', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'content-type': 'application/json' },
        body: JSON.stringify({ timezone: 'Mars/Phobos' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('accepts a boarding cap above the old ceiling of 50', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'content-type': 'application/json' },
        body: JSON.stringify({ maxBoardingPets: 80 }),
      },
      env,
    );
    expect(res.status).toBe(204);
  });
});
