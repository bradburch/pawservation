import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, TENANT_A } from './helpers';
import { listServices, setServiceConfig } from '../db/repo';

/** Admin Bearer headers plus JSON content type, for PUT bodies. */
async function auth(tenantId: string): Promise<Record<string, string>> {
  return { ...(await adminHeaders(tenantId)), 'Content-Type': 'application/json' };
}

const BOARDING_BODY_BASE = {
  type: 'boarding',
  enabled: true,
  options: [{ label: 'Standard', durationMinutes: null, rate: 50 }],
};

describe('cancellation tiers config round-trip', () => {
  it('setServiceConfig persists tiers and listServices parses them', async () => {
    const { env } = createTestEnv();
    const before = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(before.CancellationTiers).toBeNull();

    const tiers = [
      { withinDays: 2, percent: 100 },
      { withinDays: 7, percent: 50 },
    ];
    const ok = await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'boarding', {
      enabled: true,
      questions: before.Questions,
      minNights: before.MinNights,
      maxNights: before.MaxNights,
      minPetCount: before.MinPetCount,
      maxPetCount: before.MaxPetCount,
      acceptedPetTypes: before.AcceptedPetTypes,
      maxConcurrentPets: before.MaxConcurrentPets,
      maxPerDay: before.MaxPerDay,
      cancellationTiers: tiers,
    });
    expect(ok).toBe(true);

    const after = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.CancellationTiers).toEqual(tiers);
  });

  it('null clears tiers', async () => {
    const { env } = createTestEnv();
    const before = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;

    const tiers = [{ withinDays: 3, percent: 25 }];
    const setOk = await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'boarding', {
      enabled: true,
      questions: before.Questions,
      minNights: before.MinNights,
      maxNights: before.MaxNights,
      minPetCount: before.MinPetCount,
      maxPetCount: before.MaxPetCount,
      acceptedPetTypes: before.AcceptedPetTypes,
      maxConcurrentPets: before.MaxConcurrentPets,
      maxPerDay: before.MaxPerDay,
      cancellationTiers: tiers,
    });
    expect(setOk).toBe(true);

    const withTiers = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(withTiers.CancellationTiers).toEqual(tiers);

    const clearOk = await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'boarding', {
      enabled: true,
      questions: before.Questions,
      minNights: before.MinNights,
      maxNights: before.MaxNights,
      minPetCount: before.MinPetCount,
      maxPetCount: before.MaxPetCount,
      acceptedPetTypes: before.AcceptedPetTypes,
      maxConcurrentPets: before.MaxConcurrentPets,
      maxPerDay: before.MaxPerDay,
      cancellationTiers: null,
    });
    expect(clearOk).toBe(true);

    const cleared = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(cleared.CancellationTiers).toBeNull();
  });
});

describe('admin settings PUT — cancellation tiers', () => {
  it('accepts valid tiers on a service and persists them', async () => {
    const { env } = createTestEnv();
    const tiers = [
      { withinDays: 2, percent: 100 },
      { withinDays: 7, percent: 50 },
    ];
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A),
        body: JSON.stringify({ services: [{ ...BOARDING_BODY_BASE, cancellationTiers: tiers }] }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const after = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.CancellationTiers).toEqual(tiers);
  });

  it('rejects an empty tiers array (use null to mean "no policy")', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A),
        body: JSON.stringify({ services: [{ ...BOARDING_BODY_BASE, cancellationTiers: [] }] }),
      },
      env,
    );
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain('Boarding');
  });

  it('rejects unsorted tiers with an error naming the service', async () => {
    const { env } = createTestEnv();
    const unsorted = [
      { withinDays: 7, percent: 50 },
      { withinDays: 2, percent: 100 },
    ];
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A),
        body: JSON.stringify({
          services: [{ ...BOARDING_BODY_BASE, cancellationTiers: unsorted }],
        }),
      },
      env,
    );
    expect(put.status).toBe(400);
    const body = (await put.json()) as { error: string };
    expect(body.error).toContain('Boarding');
  });

  it('leaves existing tiers unchanged when the field is omitted (PATCH idiom)', async () => {
    const { env } = createTestEnv();
    const tiers = [{ withinDays: 3, percent: 25 }];
    const set = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A),
        body: JSON.stringify({ services: [{ ...BOARDING_BODY_BASE, cancellationTiers: tiers }] }),
      },
      env,
    );
    expect(set.status).toBe(204);

    // Second PUT omits cancellationTiers entirely — must not wipe what was just set.
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A),
        body: JSON.stringify({ services: [{ ...BOARDING_BODY_BASE }] }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const after = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.CancellationTiers).toEqual(tiers);
  });

  it('clears tiers when the field is explicitly null', async () => {
    const { env } = createTestEnv();
    const tiers = [{ withinDays: 3, percent: 25 }];
    const set = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A),
        body: JSON.stringify({ services: [{ ...BOARDING_BODY_BASE, cancellationTiers: tiers }] }),
      },
      env,
    );
    expect(set.status).toBe(204);

    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A),
        body: JSON.stringify({
          services: [{ ...BOARDING_BODY_BASE, cancellationTiers: null }],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const after = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.CancellationTiers).toBeNull();
  });
});
