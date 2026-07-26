import { describe, expect, it } from 'vitest';
import {
  deleteTenantCompletely,
  listPetGroupPricing,
  listServicePetRates,
  replacePetGroupPricing,
  replaceServicePetRates,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

describe('species-count rates repo', () => {
  it('round-trips rates for one service option', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'w30', [
      { mixKey: 'dog:2', rate: 35 },
      { mixKey: 'cat:1|dog:1', rate: 30 },
    ]);
    const rows = await listServicePetRates(env.PAWBOOK_DB, TENANT_A);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.MixKey === 'dog:2')?.Rate).toBe(35);
    expect(rows.every((r) => r.TenantId === TENANT_A)).toBe(true);
  });

  it('replace is scoped to one (serviceType, optionKey)', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'w30', [
      { mixKey: 'dog:2', rate: 35 },
    ]);
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'w60', [
      { mixKey: 'dog:2', rate: 55 },
    ]);
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'w30', [
      { mixKey: 'dog:2', rate: 40 },
    ]);
    const rows = await listServicePetRates(env.PAWBOOK_DB, TENANT_A);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.OptionKey === 'w30')?.Rate).toBe(40);
    expect(rows.find((r) => r.OptionKey === 'w60')?.Rate).toBe(55);
  });

  it('an empty list clears that option', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'w30', [
      { mixKey: 'dog:2', rate: 35 },
    ]);
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'w30', []);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
  });

  it('is tenant-scoped', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'w30', [
      { mixKey: 'dog:2', rate: 35 },
    ]);
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_B, 'walk', 'w30', [
      { mixKey: 'dog:2', rate: 99 },
    ]);
    expect((await listServicePetRates(env.PAWBOOK_DB, TENANT_A))[0].Rate).toBe(35);
    expect((await listServicePetRates(env.PAWBOOK_DB, TENANT_B))[0].Rate).toBe(99);
  });

  it('keeps ServiceType separate from OptionKey — same mixKey, two service types', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'standard', [
      { mixKey: 'dog:2', rate: 35 },
    ]);
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'boarding', 'standard', [
      { mixKey: 'dog:2', rate: 80 },
    ]);
    const rows = await listServicePetRates(env.PAWBOOK_DB, TENANT_A);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.ServiceType === 'walk')?.Rate).toBe(35);
    expect(rows.find((r) => r.ServiceType === 'boarding')?.Rate).toBe(80);
  });
});

describe('pet-group rates repo', () => {
  it('round-trips and is scoped by service type', async () => {
    const { env } = createTestEnv();
    await replacePetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk', [
      { id: 'pgp_1', optionKey: 'w60', groupKey: 'p_a,p_b', rate: 44 },
    ]);
    await replacePetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'boarding', [
      { id: 'pgp_2', optionKey: 'standard', groupKey: 'p_a,p_b', rate: 80 },
    ]);
    const walk = await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(walk).toHaveLength(1);
    expect(walk[0].GroupKey).toBe('p_a,p_b');
    expect(walk[0].OptionKey).toBe('w60');
    expect(walk[0].Rate).toBe(44);
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'boarding')).toHaveLength(1);
  });

  it('is tenant-scoped', async () => {
    const { env } = createTestEnv();
    await replacePetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk', [
      { id: 'pgp_a', optionKey: 'w30', groupKey: 'p_a', rate: 20 },
    ]);
    await replacePetGroupPricing(env.PAWBOOK_DB, TENANT_B, 'walk', [
      { id: 'pgp_b', optionKey: 'w30', groupKey: 'p_a', rate: 99 },
    ]);
    expect((await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk'))[0].Rate).toBe(20);
    expect((await listPetGroupPricing(env.PAWBOOK_DB, TENANT_B, 'walk'))[0].Rate).toBe(99);
  });

  it('replace is scoped to the whole service, across options — a second option is not a sibling row that survives', async () => {
    const { env } = createTestEnv();
    await replacePetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk', [
      { id: 'pgp_1', optionKey: 'w30', groupKey: 'p_a,p_b', rate: 44 },
      { id: 'pgp_2', optionKey: 'w60', groupKey: 'p_a,p_b', rate: 60 },
    ]);
    // A replace call for the same service always supplies the FULL set for that service (the
    // admin editor is per-service, not per-option), so it is correct for this call to drop the
    // w60 row: it is not in the new set.
    await replacePetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk', [
      { id: 'pgp_3', optionKey: 'w30', groupKey: 'p_a,p_b', rate: 50 },
    ]);
    const rows = await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(rows).toHaveLength(1);
    expect(rows[0].OptionKey).toBe('w30');
    expect(rows[0].Rate).toBe(50);
  });
});

describe('deleteTenantCompletely clears both rate tables', () => {
  it('removes the deleted tenant’s rows and leaves the other tenant’s', async () => {
    const { env } = createTestEnv();
    for (const t of [TENANT_A, TENANT_B]) {
      await replaceServicePetRates(env.PAWBOOK_DB, t, 'walk', 'w30', [
        { mixKey: 'dog:2', rate: 35 },
      ]);
      await replacePetGroupPricing(env.PAWBOOK_DB, t, 'walk', [
        { id: `pgp_${t}`, optionKey: 'w30', groupKey: 'p_a', rate: 20 },
      ]);
    }
    await deleteTenantCompletely(env.PAWBOOK_DB, TENANT_A);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk')).toHaveLength(0);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_B)).toHaveLength(1);
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_B, 'walk')).toHaveLength(1);
  });
});
