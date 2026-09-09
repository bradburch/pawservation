import { describe, expect, it } from 'vitest';
import { getTenantBySlug, listServices, setServiceConfig, updateTenantSettings } from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';
import app from '../index';
import { PRICING } from '../lib/plan-pricing';

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

/**
 * `/config` IS PUBLIC and is fetched by every widget embedded on every sitter's own website. What
 * goes on it is therefore a publishing decision, not a convenience one — which is why the figures
 * go on and the plan STATE does not.
 */
describe('GET /:slug/config and the plan', () => {
  it('publishes the four figures from PRICING, the one place they live', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/sunny-paws/config', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pricing: Record<string, number> };
    // Read from the constant rather than restated, so a price change moves one file and this test
    // keeps agreeing with the landing page, llms.txt and the JSON-LD offers.
    expect(body.pricing).toEqual({
      soloMonthly: PRICING.soloMonthly,
      proMonthly: PRICING.proMonthly,
      proAnnual: PRICING.proAnnual,
      trialDays: PRICING.trialDays,
    });
  });

  it('publishes NO plan state — not the tier, not the renewal date, not the processor ids', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE Tenants
          SET Plan = 'pro', BilledUntil = '2099-01-01 00:00:00',
              StripeCustomerId = 'cus_leaked', StripeSubscriptionId = 'sub_leaked',
              LastBillingEventAt = '2026-09-08 00:00:00'
        WHERE Id = '${TENANT_A}'`,
    );
    const body = await (await app.request('/api/sunny-paws/config', {}, env)).text();
    for (const absent of [
      '"plan"',
      '"billedUntil"',
      '"stripeCustomerId"',
      '"stripeSubscriptionId"',
      '"lastBillingEventAt"',
      'cus_leaked',
      'sub_leaked',
      '2099-01-01',
    ]) {
      expect(body, absent).not.toContain(absent);
    }
    // The DERIVED flag is still published, because that is what a visitor's browser needs in order
    // to know whether a surface should mount. A tier and a renewal date have no such consumer on the
    // public wire, and the two processor ids are join keys to a name, a card and an email.
    expect((JSON.parse(body) as { premium: { assistant: boolean } }).premium.assistant).toBe(true);
  });
});
