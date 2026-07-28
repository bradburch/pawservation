import { describe, expect, it } from 'vitest';
import {
  deletePetTypeAndScrub,
  deleteService,
  listAllPetGroupPricing,
  listPetGroupPricing,
  listServicePetRates,
  replaceServiceOptions,
  replaceServicePetRates,
  upsertPetGroupRate,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

/** A minimal valid replaceServiceOptions row for a timed service. */
const opt = (optionKey: string, rate: number) => ({
  optionKey,
  label: optionKey,
  durationMinutes: 30,
  rate,
  startTime: null,
  endTime: null,
  capacity: null,
  weekdaysOnly: false,
});

const seedRates = async (env: Env, tenantId: string) => {
  await replaceServicePetRates(env.PAWBOOK_DB, tenantId, 'walk', 'd30', [
    { mixKey: 'dog:2', rate: 35 },
  ]);
  await replaceServicePetRates(env.PAWBOOK_DB, tenantId, 'walk', 'd60', [
    { mixKey: 'dog:2', rate: 55 },
    { mixKey: 'cat:1|dog:1', rate: 50 },
  ]);
  await upsertPetGroupRate(env.PAWBOOK_DB, tenantId, {
    serviceType: 'walk',
    optionKey: 'd30',
    groupKey: 'p_a,p_b',
    rate: 44,
  });
  await upsertPetGroupRate(env.PAWBOOK_DB, tenantId, {
    serviceType: 'walk',
    optionKey: 'd60',
    groupKey: 'p_a,p_b',
    rate: 64,
  });
};

describe('deleteService scrubs BOTH rate tables for that service', () => {
  it('removes the service’s rate rows, leaves a sibling service’s', async () => {
    const { env } = createTestEnv();
    await seedRates(env, TENANT_A);
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'checkin', 'd15', [
      { mixKey: 'dog:2', rate: 20 },
    ]);
    await deleteService(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk')).toHaveLength(0);
    const mixes = await listServicePetRates(env.PAWBOOK_DB, TENANT_A);
    expect(mixes).toHaveLength(1);
    expect(mixes[0].ServiceType).toBe('checkin');
  });

  it('is tenant-scoped', async () => {
    const { env } = createTestEnv();
    await seedRates(env, TENANT_A);
    await seedRates(env, TENANT_B);
    await deleteService(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_B)).toHaveLength(3);
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_B, 'walk')).toHaveLength(2);
  });
});

describe('replaceServiceOptions scrubs rates for DROPPED option keys only', () => {
  it('a dropped option loses its rates in both tables; a kept option keeps them', async () => {
    const { env } = createTestEnv();
    await seedRates(env, TENANT_A);
    // New option set keeps d30, drops d60:
    await replaceServiceOptions(env.PAWBOOK_DB, TENANT_A, 'walk', [opt('d30', 20)]);
    const mixes = await listServicePetRates(env.PAWBOOK_DB, TENANT_A);
    expect(mixes.map((m) => m.OptionKey)).toEqual(['d30']);
    const groups = await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(groups.map((g) => g.OptionKey)).toEqual(['d30']);
  });

  it('an EMPTY option set clears every rate for the service', async () => {
    const { env } = createTestEnv();
    await seedRates(env, TENANT_A);
    await replaceServiceOptions(env.PAWBOOK_DB, TENANT_A, 'walk', []);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk')).toHaveLength(0);
  });

  it('REGRESSION LOCK: a deleted option re-added under the same derived key does NOT resurrect its old rate', async () => {
    const { env } = createTestEnv();
    await seedRates(env, TENANT_A);
    await replaceServiceOptions(env.PAWBOOK_DB, TENANT_A, 'walk', [opt('d30', 20)]); // d60 deleted
    await replaceServiceOptions(env.PAWBOOK_DB, TENANT_A, 'walk', [
      opt('d30', 20),
      opt('d60', 35), // re-added: same derived key, price the sitter never re-set
    ]);
    const mixes = await listServicePetRates(env.PAWBOOK_DB, TENANT_A);
    expect(mixes.filter((m) => m.OptionKey === 'd60')).toHaveLength(0);
    const groups = await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(groups.filter((g) => g.OptionKey === 'd60')).toHaveLength(0);
  });

  it('is tenant-scoped — the scrub never crosses tenants', async () => {
    const { env } = createTestEnv();
    await seedRates(env, TENANT_A);
    await seedRates(env, TENANT_B);
    await replaceServiceOptions(env.PAWBOOK_DB, TENANT_A, 'walk', [opt('d30', 20)]);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_B)).toHaveLength(3);
  });
});

describe('deletePetTypeAndScrub scrubs mix rates naming the dead species', () => {
  it('removes exactly the mixes containing the species, across options; group rows untouched', async () => {
    const { env } = createTestEnv();
    await seedRates(env, TENANT_A);
    // 'rabbit' is in Sunny Paws' registry with zero pets/bookings — deletable.
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'checkin', 'd15', [
      { mixKey: 'dog:1|rabbit:1', rate: 25 },
      { mixKey: 'rabbit:2', rate: 22 },
      { mixKey: 'dog:2', rate: 20 },
    ]);
    await deletePetTypeAndScrub(env.PAWBOOK_DB, TENANT_A, 'rabbit');
    const mixes = await listServicePetRates(env.PAWBOOK_DB, TENANT_A);
    expect(mixes.some((m) => m.MixKey.includes('rabbit'))).toBe(false);
    // The walk mixes (dog/cat) and the dog:2 checkin mix survive:
    expect(mixes).toHaveLength(4);
    // Pet-id rows key on UUIDs, not species — untouched by design:
    expect(await listAllPetGroupPricing(env.PAWBOOK_DB, TENANT_A)).toHaveLength(2);
  });

  it('a similarly-named species is NOT scrubbed (cat vs bobcat — no substring matching)', async () => {
    const { env } = createTestEnv();
    // Register 'bobcat' so both slugs are live, then rate both:
    const { createPetType } = await import('../db/repo');
    await createPetType(env.PAWBOOK_DB, TENANT_A, 'bobcat', 'Bobcat');
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'd30', [
      { mixKey: 'bobcat:1', rate: 30 },
      { mixKey: 'cat:1', rate: 18 },
    ]);
    await deletePetTypeAndScrub(env.PAWBOOK_DB, TENANT_A, 'bobcat');
    const mixes = await listServicePetRates(env.PAWBOOK_DB, TENANT_A);
    expect(mixes.map((m) => m.MixKey)).toEqual(['cat:1']);
  });

  it('is tenant-scoped', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'd30', [
      { mixKey: 'rabbit:1', rate: 30 },
    ]);
    // Tenant B has no 'rabbit' registry row; give it a same-named mix rate directly:
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_B, 'walk', 'd30', [
      { mixKey: 'rabbit:1', rate: 44 },
    ]);
    await deletePetTypeAndScrub(env.PAWBOOK_DB, TENANT_A, 'rabbit');
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_B)).toHaveLength(1);
  });
});
