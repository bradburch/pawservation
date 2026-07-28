import { describe, expect, it } from 'vitest';
import {
  deletePetGroupRateById,
  deleteTenantCompletely,
  listAllPetGroupPricing,
  listPetGroupPricing,
  listServicePetRates,
  replaceServicePetRates,
  upsertPetGroupRate,
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

describe('pet-group rates repo (upsert/delete-one — never whole-set replace)', () => {
  it('upsert creates a row, then updates it IN PLACE — same id, new rate', async () => {
    const { env } = createTestEnv();
    const first = await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_a,p_b',
      rate: 44,
    });
    const second = await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_a,p_b',
      rate: 50,
    });
    expect(second.id).toBe(first.id);
    const rows = await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(rows).toHaveLength(1);
    expect(rows[0].Rate).toBe(50);
  });

  it('upsert never clobbers a SIBLING row — the anti-replace lock (PR 2 GATE)', async () => {
    const { env } = createTestEnv();
    // Three siblings differing in exactly one key component each:
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_a,p_b',
      rate: 44,
    });
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd60',
      groupKey: 'p_a,p_b',
      rate: 60,
    });
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_c',
      rate: 20,
    });
    // Updating one leaves the other two standing:
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_a,p_b',
      rate: 48,
    });
    const rows = await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.OptionKey === 'd60')?.Rate).toBe(60);
    expect(rows.find((r) => r.GroupKey === 'p_c')?.Rate).toBe(20);
  });

  it('delete-one removes exactly one row and reports found/not-found', async () => {
    const { env } = createTestEnv();
    const { id } = await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_a',
      rate: 20,
    });
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_b',
      rate: 22,
    });
    expect(await deletePetGroupRateById(env.PAWBOOK_DB, TENANT_A, id)).toBe(true);
    expect(await deletePetGroupRateById(env.PAWBOOK_DB, TENANT_A, id)).toBe(false);
    const rows = await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk');
    expect(rows).toHaveLength(1);
    expect(rows[0].GroupKey).toBe('p_b');
  });

  it('delete-one is tenant-scoped — tenant B cannot delete tenant A’s row', async () => {
    const { env } = createTestEnv();
    const { id } = await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_a',
      rate: 20,
    });
    expect(await deletePetGroupRateById(env.PAWBOOK_DB, TENANT_B, id)).toBe(false);
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk')).toHaveLength(1);
  });

  it('listAllPetGroupPricing spans services but never tenants', async () => {
    const { env } = createTestEnv();
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_a',
      rate: 20,
    });
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'boarding',
      optionKey: 'standard',
      groupKey: 'p_a,p_b',
      rate: 80,
    });
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_B, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'p_a',
      rate: 99,
    });
    const all = await listAllPetGroupPricing(env.PAWBOOK_DB, TENANT_A);
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.TenantId === TENANT_A)).toBe(true);
  });
});

describe('deleteTenantCompletely clears both rate tables', () => {
  it('removes the deleted tenant’s rows and leaves the other tenant’s', async () => {
    const { env } = createTestEnv();
    for (const t of [TENANT_A, TENANT_B]) {
      await replaceServicePetRates(env.PAWBOOK_DB, t, 'walk', 'w30', [
        { mixKey: 'dog:2', rate: 35 },
      ]);
      await upsertPetGroupRate(env.PAWBOOK_DB, t, {
        serviceType: 'walk',
        optionKey: 'w30',
        groupKey: 'p_a',
        rate: 20,
      });
    }
    await deleteTenantCompletely(env.PAWBOOK_DB, TENANT_A);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_A, 'walk')).toHaveLength(0);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_B)).toHaveLength(1);
    expect(await listPetGroupPricing(env.PAWBOOK_DB, TENANT_B, 'walk')).toHaveLength(1);
  });
});
