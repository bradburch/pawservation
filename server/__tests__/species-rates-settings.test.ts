import { describe, expect, it } from 'vitest';
import app from '../index';
import { replaceServicePetRates, upsertPetGroupRate } from '../db/repo';
import { adminHeaders, createTestEnv, TENANT_A } from './helpers';

type SettingsOption = { optionKey: string; petRates: { mixKey: string; rate: number }[] };
type SettingsService = {
  type: string;
  multiPetGroupRateCount: number;
  options: SettingsOption[];
};

const getSettings = async (env: Env): Promise<{ services: SettingsService[] }> => {
  const res = await app.request(
    '/api/sunny-paws/admin/settings',
    { headers: await adminHeaders(TENANT_A) },
    env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { services: SettingsService[] };
};

describe('settings GET carries species-count rates per option', () => {
  it('returns each option’s petRates, empty arrays when none', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'd30', [
      { mixKey: 'dog:2', rate: 35 },
      { mixKey: 'cat:1|dog:1', rate: 30 },
    ]);
    const { services } = await getSettings(env);
    const walk = services.find((s) => s.type === 'walk')!;
    const d30 = walk.options.find((o) => o.optionKey === 'd30')!;
    expect(d30.petRates).toEqual(
      expect.arrayContaining([
        { mixKey: 'dog:2', rate: 35 },
        { mixKey: 'cat:1|dog:1', rate: 30 },
      ]),
    );
    expect(d30.petRates).toHaveLength(2);
    expect(walk.options.find((o) => o.optionKey === 'd60')!.petRates).toEqual([]);
    // Rates never bleed across services:
    const boarding = services.find((s) => s.type === 'boarding')!;
    expect(boarding.options.every((o) => o.petRates.length === 0)).toBe(true);
  });

  it('multiPetGroupRateCount counts ONLY 2+-pet group rows, per service', async () => {
    const { env } = createTestEnv();
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'pet_sp_bella',
      rate: 20, // single pet — not multi
    });
    await upsertPetGroupRate(env.PAWBOOK_DB, TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      groupKey: 'pet_sp_bella,pet_sp_mochi',
      rate: 36,
    });
    const { services } = await getSettings(env);
    expect(services.find((s) => s.type === 'walk')!.multiPetGroupRateCount).toBe(1);
    expect(services.find((s) => s.type === 'boarding')!.multiPetGroupRateCount).toBe(0);
  });
});
