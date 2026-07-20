import { describe, expect, it } from 'vitest';
import { getTenantBySlug, listServices, setServiceConfig, updateTenantSettings } from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

describe('config columns — caps live on services, timezone on the tenant', () => {
  it('seed puts the boarding cap on the service row; housesit/none stay unlimited', async () => {
    const { env } = createTestEnv();
    const services = await listServices(env.PAWBOOK_DB, TENANT_A);
    expect(services.find((s) => s.ServiceType === 'boarding')?.MaxConcurrentPets).toBe(2);
    expect(services.find((s) => s.ServiceType === 'boarding')?.MaxPerDay).toBeNull();
    expect(services.find((s) => s.ServiceType === 'housesitting')?.MaxPerDay).toBeNull();
    expect(services.find((s) => s.ServiceType === 'walk')?.MaxConcurrentPets).toBeNull();
  });

  it('setServiceConfig round-trips per-service caps including explicit null', async () => {
    const { env } = createTestEnv();
    const before = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'boarding', {
      enabled: true,
      questions: before.Questions,
      minNights: before.MinNights,
      maxNights: before.MaxNights,
      minPetCount: before.MinPetCount,
      maxPetCount: before.MaxPetCount,
      acceptedPetTypes: before.AcceptedPetTypes,
      maxConcurrentPets: 7,
      maxPerDay: null,
    });
    let after = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.MaxConcurrentPets).toBe(7);
    await setServiceConfig(env.PAWBOOK_DB, TENANT_A, 'boarding', {
      enabled: true,
      questions: before.Questions,
      minNights: before.MinNights,
      maxNights: before.MaxNights,
      minPetCount: before.MinPetCount,
      maxPetCount: before.MaxPetCount,
      acceptedPetTypes: before.AcceptedPetTypes,
      maxConcurrentPets: null,
      maxPerDay: null,
    });
    after = (await listServices(env.PAWBOOK_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.MaxConcurrentPets).toBeNull();
  });

  it('tenant settings round-trip timezone/contact incl. explicit nulls (caps are gone)', async () => {
    const { env } = createTestEnv();
    await updateTenantSettings(env.PAWBOOK_DB, TENANT_A, {
      displayName: 'Sunny Paws',
      accentColor: '#2563eb',
      timezone: 'Europe/London',
    });
    const t = await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws');
    expect(t!.Timezone).toBe('Europe/London');
    await updateTenantSettings(env.PAWBOOK_DB, TENANT_A, {
      displayName: 'Sunny Paws',
      accentColor: '#2563eb',
      timezone: null,
    });
    expect((await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws'))!.Timezone).toBeNull();
  });
});
