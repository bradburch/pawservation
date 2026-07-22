import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  createService,
  deleteService,
  insertBookingRequest,
  listServices,
  setServiceConfig,
} from '../db/repo';
import { adminToken, createTestEnv, TENANT_A, TENANT_B } from './helpers';

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

/** Sunny Paws (TENANT_A) is seeded with exactly 6 TenantServices rows — already at the 6-service
 * cap by design (see the "6-service cap" describe block below). Tests in this file that create an
 * ADDITIONAL custom service on Sunny Paws to exercise unrelated behavior must first free a slot;
 * deleting the seeded custom service (morning-walk, no bookings) does that without touching the
 * built-in rows other assertions here depend on. */
async function freeASlot(env: Env): Promise<void> {
  await deleteService(env.PAWBOOK_DB, TENANT_A, 'morning-walk');
}

describe('custom services — creation', () => {
  it('creates a disabled service from a template, slug derived from the label', async () => {
    const { env } = createTestEnv();
    await freeASlot(env);
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
    await freeASlot(env);
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

// Owner directive: at most 6 TenantServices rows (enabled or disabled) per tenant. Sunny Paws
// (TENANT_A) is seeded with exactly 6 rows (boarding, housesitting, daycare, walk, checkin,
// morning-walk) — already at the cap, which is deliberate seed behavior per the design note.
// Happy Tails (TENANT_B) is seeded with 5, one under the cap.
describe('custom services — 6-service cap', () => {
  it('refuses a 7th create once the tenant is at the cap, with a plain-language 400 and no row added', async () => {
    const { env } = createTestEnv();
    const before = await listServices(env.PAWBOOK_DB, TENANT_A);
    expect(before).toHaveLength(6);

    const { status, json } = await createSvc(env, { template: 'walk', label: 'Evening Stroll' });
    expect(status).toBe(400);
    expect(json.error).toBe(
      "You've reached the limit of 6 services. Delete one you no longer offer to add another.",
    );

    const after = await listServices(env.PAWBOOK_DB, TENANT_A);
    expect(after).toHaveLength(6);
  });

  it('allows the 6th create for a tenant one under the cap', async () => {
    const { env } = createTestEnv();
    const before = await listServices(env.PAWBOOK_DB, TENANT_B);
    expect(before).toHaveLength(5);

    const res = await app.request(
      '/api/happy-tails/admin/services',
      {
        method: 'POST',
        headers: await auth(TENANT_B, true),
        body: JSON.stringify({ template: 'boarding', label: 'Puppy Boarding' }),
      },
      env,
    );
    expect(res.status).toBe(201);

    const after = await listServices(env.PAWBOOK_DB, TENANT_B);
    expect(after).toHaveLength(6);
  });

  it('allows a create again after a delete brings an at-cap tenant back under it', async () => {
    const { env } = createTestEnv();
    const del = await app.request(
      '/api/sunny-paws/admin/services/morning-walk',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(del.status).toBe(204);
    expect(await listServices(env.PAWBOOK_DB, TENANT_A)).toHaveLength(5);

    const { status } = await createSvc(env, { template: 'walk', label: 'Evening Stroll' });
    expect(status).toBe(201);
    expect(await listServices(env.PAWBOOK_DB, TENANT_A)).toHaveLength(6);
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

  it('a custom boarding-pool service draws from an INDEPENDENT pet capacity from built-in boarding (0015)', async () => {
    const { env } = createTestEnv();
    await freeASlot(env);
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

    // Fill the CUSTOM service's occupancy with 2 pets — a different pool key than 'boarding'.
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
    // Built-in boarding (own seeded MaxConcurrentPets=2, zero existing bookings) is UNAFFECTED:
    // each service is its own pool since the 0015 per-service rework, so a 2-pet request still fits.
    const independent = (await (
      await app.request(
        '/api/sunny-paws/availability?type=boarding&start=2029-01-11&end=2029-01-13&pets=2',
        {},
        env,
      )
    ).json()) as { available: boolean };
    expect(independent.available).toBe(true);
  });
});

describe('custom services — deletion', () => {
  it('deletes an unused custom service; it disappears from settings', async () => {
    const { env } = createTestEnv();
    await freeASlot(env);
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
      acceptedPetTypes: null,
      maxConcurrentPets: null,
      cancellationTiers: null,
    });
    expect(updated).toBe(false);
  });
});
