import { describe, expect, it } from 'vitest';
import { getTenantBySlug, updateTenantSettings } from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

describe('tenant config columns', () => {
  it('new demo tenant defaults all limits to null (unlimited)', async () => {
    const { env } = createTestEnv();
    const t = await getTenantBySlug(env.PAWBOOK_DB, 'paws-and-relax');
    expect(t).not.toBeNull();
    expect(t!.MaxBoardingPets).toBeNull();
    expect(t!.MaxHouseSitsPerDay).toBeNull();
    expect(t!.MaxStayNights).toBeNull();
    expect(t!.Timezone).toBeNull();
  });

  it('existing demo tenant keeps its configured boarding cap', async () => {
    const { env } = createTestEnv();
    const t = await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws');
    expect(t!.MaxBoardingPets).toBe(2);
  });

  it('round-trips all config fields including explicit nulls', async () => {
    const { env } = createTestEnv();
    await updateTenantSettings(env.PAWBOOK_DB, TENANT_A, {
      displayName: 'Sunny Paws',
      accentColor: '#2563eb',
      maxBoardingPets: null,
      maxHouseSitsPerDay: 1,
      maxStayNights: 30,
      timezone: 'Europe/London',
    });
    const t = await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws');
    expect(t!.MaxBoardingPets).toBeNull();
    expect(t!.MaxHouseSitsPerDay).toBe(1);
    expect(t!.MaxStayNights).toBe(30);
    expect(t!.Timezone).toBe('Europe/London');
  });
});
