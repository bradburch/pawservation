import { describe, expect, it } from 'vitest';
import { getTenantBySlug, listServices, setServiceConfig, updateTenantSettings } from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

describe('config columns — caps live on services, timezone on the tenant', () => {
  it('seed puts the boarding cap on the service row; housesit/none stay unlimited', async () => {
    const { env } = createTestEnv();
    const services = await listServices(env.PAWSERVATION_DB, TENANT_A);
    expect(services.find((s) => s.ServiceType === 'boarding')?.MaxConcurrentPets).toBe(2);
    expect(services.find((s) => s.ServiceType === 'housesitting')?.MaxConcurrentPets).toBeNull();
    expect(services.find((s) => s.ServiceType === 'walk')?.MaxConcurrentPets).toBeNull();
  });

  it('setServiceConfig round-trips per-service caps including explicit null', async () => {
    const { env } = createTestEnv();
    const before = (await listServices(env.PAWSERVATION_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    await setServiceConfig(env.PAWSERVATION_DB, TENANT_A, 'boarding', {
      enabled: true,
      description: before.Description,
      questions: before.Questions,
      maxNights: before.MaxNights,
      maxPetCount: before.MaxPetCount,
      minLeadDays: null,
      acceptedPetTypes: before.AcceptedPetTypes,
      maxConcurrentPets: 7,
      cancellationTiers: before.CancellationTiers,
      holidayRate: before.HolidayRate,
      petRateMode: before.PetRateMode,
      standardArrivalTime: null,
      standardDepartureTime: null,
      earlyArrivalFee: null,
      lateDepartureFee: null,
    });
    let after = (await listServices(env.PAWSERVATION_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.MaxConcurrentPets).toBe(7);
    await setServiceConfig(env.PAWSERVATION_DB, TENANT_A, 'boarding', {
      enabled: true,
      description: before.Description,
      questions: before.Questions,
      maxNights: before.MaxNights,
      maxPetCount: before.MaxPetCount,
      minLeadDays: null,
      acceptedPetTypes: before.AcceptedPetTypes,
      maxConcurrentPets: null,
      cancellationTiers: before.CancellationTiers,
      holidayRate: before.HolidayRate,
      petRateMode: before.PetRateMode,
      standardArrivalTime: null,
      standardDepartureTime: null,
      earlyArrivalFee: null,
      lateDepartureFee: null,
    });
    after = (await listServices(env.PAWSERVATION_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.MaxConcurrentPets).toBeNull();
  });

  it('carries a nullable HolidayRate on every service, defaulting to NULL', async () => {
    const { env } = createTestEnv();
    const services = await listServices(env.PAWSERVATION_DB, TENANT_A);
    expect(services.length).toBeGreaterThan(0);
    // NULL = no holiday pricing = today's behavior, for every seeded service.
    for (const svc of services) expect(svc.HolidayRate).toBeNull();
  });

  it('round-trips a HolidayRate through setServiceConfig', async () => {
    const { env } = createTestEnv();
    const before = (await listServices(env.PAWSERVATION_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    await setServiceConfig(env.PAWSERVATION_DB, TENANT_A, 'boarding', {
      enabled: Boolean(before.Enabled),
      description: before.Description,
      questions: before.Questions,
      maxNights: before.MaxNights,
      maxPetCount: before.MaxPetCount,
      minLeadDays: null,
      acceptedPetTypes: before.AcceptedPetTypes,
      maxConcurrentPets: before.MaxConcurrentPets,
      cancellationTiers: before.CancellationTiers,
      holidayRate: 75,
      petRateMode: before.PetRateMode,
      standardArrivalTime: null,
      standardDepartureTime: null,
      earlyArrivalFee: null,
      lateDepartureFee: null,
    });
    const after = (await listServices(env.PAWSERVATION_DB, TENANT_A)).find(
      (s) => s.ServiceType === 'boarding',
    )!;
    expect(after.HolidayRate).toBe(75);
  });

  it('tenant settings round-trip timezone/contact incl. explicit nulls (caps are gone)', async () => {
    const { env } = createTestEnv();
    await updateTenantSettings(env.PAWSERVATION_DB, TENANT_A, {
      displayName: 'Sunny Paws',
      accentColor: '#2563eb',
      timezone: 'Europe/London',
      housesitBoardingOverlapDays: 1,
      calendarCostBasis: 'total',
      attributionSpillDays: 14,
    });
    const t = await getTenantBySlug(env.PAWSERVATION_DB, 'sunny-paws');
    expect(t!.Timezone).toBe('Europe/London');
    await updateTenantSettings(env.PAWSERVATION_DB, TENANT_A, {
      displayName: 'Sunny Paws',
      accentColor: '#2563eb',
      timezone: null,
      housesitBoardingOverlapDays: 1,
      calendarCostBasis: 'total',
      attributionSpillDays: 14,
    });
    expect((await getTenantBySlug(env.PAWSERVATION_DB, 'sunny-paws'))!.Timezone).toBeNull();
  });
});
