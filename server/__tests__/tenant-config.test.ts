import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTenantBySlug, listServices, setServiceConfig, updateTenantSettings } from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';
import { liveSource } from './helpers/live-source';
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
      subscribe: false,
    });
  });

  it('reads each figure from PRICING at the call site, not as a typed number', () => {
    // Comparing the RESPONSE to `PRICING` stays green when the route types `29` beside the import:
    // the response and the constant would both say 29 and the "one place they live" claim in the
    // title above would be untested. So the source is pinned too, over executable text only.
    const SOURCE = liveSource(
      readFileSync(join(import.meta.dirname, '..', 'routes', 'public.ts'), 'utf8'),
    );
    for (const field of ['soloMonthly', 'proMonthly', 'proAnnual', 'trialDays']) {
      expect(SOURCE, field).toContain(`PRICING.${field}`);
    }
  });

  it('publishes subscribe=false when PLAN_SUBSCRIBE is unset, which is every fork', async () => {
    // Unset is OFF, and it is off for a reason: `PREMIUM_ORIGIN` is already set in production, so
    // the panel gating on the origin alone would ship a live Subscribe button against a checkout
    // route that does not exist yet.
    const { env } = createTestEnv();
    expect('PLAN_SUBSCRIBE' in env).toBe(false);
    const body = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      pricing: { subscribe: boolean };
    };
    expect(body.pricing.subscribe).toBe(false);
  });

  it('publishes subscribe=true only for the exact opt-in value', async () => {
    const { env } = createTestEnv();
    const ask = async (over: Partial<Env>) =>
      (
        (await (
          await app.request('/api/sunny-paws/config', {}, { ...env, ...over } as Env)
        ).json()) as { pricing: { subscribe: boolean } }
      ).pricing.subscribe;
    expect(await ask({ PLAN_SUBSCRIBE: 'true' })).toBe(true);
    expect(await ask({ PLAN_SUBSCRIBE: ' TRUE ' })).toBe(true);
    // Everything else is off, fail-closed: a var set to the empty string, to `false`, or to
    // somebody's idea of truthy sells nothing.
    for (const value of ['', 'false', '1', 'yes', 'off']) {
      expect(await ask({ PLAN_SUBSCRIBE: value }), value).toBe(false);
    }
  });

  it('publishes the flag as a property of the DEPLOYMENT, for every tenant alike', async () => {
    // Not derived from the tenant at all: a sitter who is disabled, comped or already paying gets
    // the same answer, because the question is "does this deployment sell plans".
    const { env, raw } = createTestEnv();
    raw.exec(`UPDATE Tenants SET DisabledAt = '2026-07-23 00:00:00' WHERE Id = '${TENANT_A}'`);
    const body = (await (
      await app.request('/api/sunny-paws/config', {}, { ...env, PLAN_SUBSCRIBE: 'true' } as Env)
    ).json()) as { disabled: boolean; pricing: { subscribe: boolean } };
    expect(body.disabled).toBe(true);
    expect(body.pricing.subscribe).toBe(true);
  });

  it('answers a reserved word as an unknown tenant rather than 500ing', async () => {
    // `tenantMiddleware` calls `next()` for a reserved slug WITHOUT setting a tenant, so this
    // handler's very first line dereferences `undefined` — a 500, which tells a prober the word is
    // special. `adminAuth` and `routes/billing.ts` both already guard for exactly this.
    const { env } = createTestEnv();
    for (const slug of ['billing', 'owner', 'signup', 'admin', 'password-reset']) {
      const res = await app.request(`/api/${slug}/config`, {}, env);
      expect(res.status, slug).toBe(404);
      expect(await res.text(), slug).toBe('{"error":"Unknown tenant"}');
    }
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
