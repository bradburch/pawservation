import { describe, expect, it } from 'vitest';
import app from '../index';
import { createService, insertBookingRequest, setServiceConfig } from '../db/repo';
import { adminToken, createTestEnv, TENANT_A } from './helpers';

/** Admin Bearer headers for a tenant, optionally with a JSON content type. */
async function auth(tenantId: string, json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { Authorization: `Bearer ${await adminToken(tenantId)}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function createSvc(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ status: number; json: { type?: string; error?: string } }> {
  const res = await app.request(
    '/api/sunny-paws/admin/services',
    { method: 'POST', headers: await auth(TENANT_A, true), body: JSON.stringify(body) },
    env,
  );
  return { status: res.status, json: (await res.json()) as { type?: string; error?: string } };
}

describe('custom services — creation', () => {
  it('creates a disabled service from a template, slug derived from the label', async () => {
    const { env } = createTestEnv();
    const { status, json } = await createSvc(env, { template: 'walk', label: 'Afternoon Walk!' });
    expect(status).toBe(201);
    expect(json.type).toBe('afternoon-walk');

    // Visible in admin settings (disabled, template behavior, custom) but NOT in the public
    // config until priced + enabled.
    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as {
      services: { type: string; label: string; custom: boolean; enabled: boolean; shape: string }[];
      templates: { id: string }[];
    };
    const created = settings.services.find((s) => s.type === 'afternoon-walk')!;
    expect(created).toMatchObject({
      label: 'Afternoon Walk!',
      custom: true,
      enabled: false,
      shape: 'single',
    });
    expect(settings.templates.map((t) => t.id)).toContain('walk');

    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string }[];
    };
    expect(cfg.services.some((s) => s.type === 'afternoon-walk')).toBe(false);
  });

  it('rejects unknown templates, empty/punctuation labels, reserved and duplicate slugs', async () => {
    const { env } = createTestEnv();
    expect((await createSvc(env, { template: 'spa', label: 'Spa day' })).status).toBe(400);
    expect((await createSvc(env, { template: 'walk', label: '   ' })).status).toBe(400);
    expect((await createSvc(env, { template: 'walk', label: '---' })).status).toBe(400);
    expect((await createSvc(env, { template: 'walk', label: 'Blocked' })).status).toBe(400);
    // 'morning-walk' is seeded for Sunny Paws; 'walk' collides with the built-in row.
    expect((await createSvc(env, { template: 'walk', label: 'Morning Walk' })).status).toBe(400);
    expect((await createSvc(env, { template: 'walk', label: 'Walk' })).status).toBe(400);
  });

  it('rejects a template id that only matches via the JS `in` operator prototype chain', async () => {
    const { env } = createTestEnv();
    expect((await createSvc(env, { template: 'constructor', label: 'x' })).status).toBe(400);
  });

  it('a custom service whose slug collides with an Object.prototype key is still custom and deletable', async () => {
    const { env } = createTestEnv();
    const { status, json } = await createSvc(env, { template: 'walk', label: 'Constructor' });
    expect(status).toBe(201);
    expect(json.type).toBe('constructor');

    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as { services: { type: string; custom: boolean }[] };
    expect(settings.services.find((s) => s.type === 'constructor')).toMatchObject({ custom: true });

    const del = await app.request(
      '/api/sunny-paws/admin/services/constructor',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(del.status).toBe(204);
  });

  it('createService rejects a duplicate (TenantId, ServiceType) at the DB level', async () => {
    const { env } = createTestEnv();
    const svc = {
      serviceType: 'race-walk',
      label: 'Race Walk',
      icon: 'paw',
      shape: 'single' as const,
      rateUnit: 'visit' as const,
      hasDuration: true,
      capacityKind: 'none' as const,
      sortOrder: 99,
    };
    await createService(env.PAWBOOK_DB, TENANT_A, svc);
    await expect(createService(env.PAWBOOK_DB, TENANT_A, svc)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
  });
});

describe('custom services — booking', () => {
  it('a seeded custom service (morning-walk) is bookable through the public availability path', async () => {
    const { env } = createTestEnv();
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      services: { type: string; label: string; icon: string; hasDuration: boolean }[];
    };
    const mw = cfg.services.find((s) => s.type === 'morning-walk')!;
    expect(mw).toMatchObject({ label: 'Morning walk', icon: 'paw', hasDuration: true });

    const avail = (await (
      await app.request('/api/sunny-paws/availability?type=morning-walk&start=2028-08-01', {}, env)
    ).json()) as { available: boolean; estCost: number };
    expect(avail).toMatchObject({ available: true, estCost: 18 });
  });

  it('a custom boarding-pool service draws from the SAME pet capacity as built-in boarding', async () => {
    const { env } = createTestEnv();
    await createSvc(env, { template: 'boarding', label: 'Luxury Boarding' });
    // Price + enable it via the normal settings PUT.
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            { type: 'luxury-boarding', enabled: true, options: [{ label: 'Suite', rate: 90 }] },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    // Fill Sunny Paws' 2-pet boarding pool via the CUSTOM service...
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'luxury-boarding',
      startDate: '2029-01-10',
      endDate: '2029-01-15',
      optionKey: 'standard',
      petType: null,
      petCount: 2,
      estCost: null,
      status: 'confirmed',
    });
    // ...and BUILT-IN boarding must see the pool as full on those dates.
    const shared = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2029-01-11&end=2029-01-13&pets=1',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(shared.available).toBe(false);
  });
});

describe('custom services — deletion', () => {
  it('deletes an unused custom service; it disappears from settings', async () => {
    const { env } = createTestEnv();
    await createSvc(env, { template: 'checkin', label: 'Evening Visit' });
    const del = await app.request(
      '/api/sunny-paws/admin/services/evening-visit',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(del.status).toBe(204);
    const settings = (await (
      await app.request('/api/sunny-paws/admin/settings', { headers: await auth(TENANT_A) }, env)
    ).json()) as { services: { type: string }[] };
    expect(settings.services.some((s) => s.type === 'evening-visit')).toBe(false);
  });

  it('refuses to delete built-ins, unknown slugs, and services with booking history', async () => {
    const { env } = createTestEnv();
    const builtin = await app.request(
      '/api/sunny-paws/admin/services/boarding',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(builtin.status).toBe(400);

    const unknown = await app.request(
      '/api/sunny-paws/admin/services/teleport',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(unknown.status).toBe(404);

    // morning-walk gets a booking → 409, and it must still exist afterwards.
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'morning-walk',
      startDate: '2029-02-01',
      endDate: null,
      optionKey: 'd30',
      petType: null,
      petCount: 1,
      estCost: 18,
      status: 'confirmed',
    });
    const withBookings = await app.request(
      '/api/sunny-paws/admin/services/morning-walk',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(withBookings.status).toBe(409);
  });

  it('setServiceConfig reports no-op instead of silently succeeding when the row is gone', async () => {
    const { env } = createTestEnv();
    const updated = await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'no-such-service', {
      enabled: true,
      questions: [],
      minNights: null,
      maxNights: null,
      minPetCount: null,
      maxPetCount: null,
    });
    expect(updated).toBe(false);
  });
});
