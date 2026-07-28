import { describe, expect, it } from 'vitest';
import app from '../index';
import { listServicePetRates, replaceServicePetRates, upsertPetGroupRate } from '../db/repo';
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

const putSettings = async (env: Env, body: Record<string, unknown>) =>
  app.request(
    '/api/sunny-paws/admin/settings',
    {
      method: 'PUT',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

/** Sunny Paws' walk options, re-sent with existing keys so identity is preserved. */
const walkOptions = (d30Extra: Record<string, unknown> = {}) => [
  { optionKey: 'd30', label: '30 minutes', durationMinutes: 30, rate: 20, ...d30Extra },
  { optionKey: 'd60', label: '1 hour', durationMinutes: 60, rate: 35 },
  { optionKey: 'd90', label: '90 minutes', durationMinutes: 90, rate: 30 },
];

describe('settings PUT species-count rates', () => {
  it('writes an option’s petRates and round-trips through GET', async () => {
    const { env } = createTestEnv();
    const res = await putSettings(env, {
      services: [
        {
          type: 'walk',
          enabled: true,
          options: walkOptions({
            petRates: [
              { mixKey: 'dog:2', rate: 35 },
              { mixKey: 'cat:1|dog:1', rate: 30 },
            ],
          }),
        },
      ],
    });
    expect(res.status).toBe(204);
    const { services } = await getSettings(env);
    const d30 = services
      .find((s) => s.type === 'walk')!
      .options.find((o) => o.optionKey === 'd30')!;
    expect(d30.petRates).toHaveLength(2);
    expect(d30.petRates).toEqual(expect.arrayContaining([{ mixKey: 'dog:2', rate: 35 }]));
  });

  it('PATCH semantics: an option sent WITHOUT petRates keeps its stored rows', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'd30', [
      { mixKey: 'dog:2', rate: 35 },
    ]);
    const res = await putSettings(env, {
      services: [{ type: 'walk', enabled: true, options: walkOptions() }],
    });
    expect(res.status).toBe(204);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(1);
  });

  it('an explicit empty petRates clears the option’s set', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'd30', [
      { mixKey: 'dog:2', rate: 35 },
    ]);
    const res = await putSettings(env, {
      services: [{ type: 'walk', enabled: true, options: walkOptions({ petRates: [] }) }],
    });
    expect(res.status).toBe(204);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
  });

  it('a DROPPED option loses its rates via the replaceServiceOptions scrub', async () => {
    const { env } = createTestEnv();
    await replaceServicePetRates(env.PAWBOOK_DB, TENANT_A, 'walk', 'd90', [
      { mixKey: 'dog:2', rate: 44 },
    ]);
    const res = await putSettings(env, {
      services: [
        {
          type: 'walk',
          enabled: true,
          options: walkOptions().slice(0, 2), // d90 dropped
        },
      ],
    });
    expect(res.status).toBe(204);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
  });

  it('rejects a species outside the EFFECTIVE accepted list — including one set in the same PUT', async () => {
    const { env } = createTestEnv();
    const res = await putSettings(env, {
      services: [
        {
          type: 'walk',
          enabled: true,
          acceptedPetTypes: ['dog'],
          options: walkOptions({ petRates: [{ mixKey: 'cat:1|dog:1', rate: 30 }] }),
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
  });

  it('rejects an unknown species slug', async () => {
    const { env } = createTestEnv();
    const res = await putSettings(env, {
      services: [
        {
          type: 'walk',
          enabled: true,
          options: walkOptions({ petRates: [{ mixKey: 'lizard:1', rate: 30 }] }),
        },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('rejects non-canonical keys, bad rates, and duplicate mixes', async () => {
    const { env } = createTestEnv();
    const cases: Record<string, unknown>[] = [
      { petRates: [{ mixKey: 'dog:2|cat:1', rate: 30 }] }, // wrong order
      { petRates: [{ mixKey: 'dog:0', rate: 30 }] },
      { petRates: [{ mixKey: '', rate: 30 }] },
      { petRates: [{ rate: 30 }] },
      { petRates: [{ mixKey: 'dog:2', rate: 0 }] },
      { petRates: [{ mixKey: 'dog:2', rate: 19.5 }] },
      { petRates: [{ mixKey: 'dog:2', rate: '35' }] },
      { petRates: [{ mixKey: 'dog:2' }] },
      {
        petRates: [
          { mixKey: 'dog:2', rate: 30 },
          { mixKey: 'dog:2', rate: 40 },
        ],
      }, // duplicate
      { petRates: { mixKey: 'dog:2', rate: 30 } }, // not an array
    ];
    for (const extra of cases) {
      const res = await putSettings(env, {
        services: [{ type: 'walk', enabled: true, options: walkOptions(extra) }],
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(await listServicePetRates(env.PAWBOOK_DB, TENANT_A)).toHaveLength(0);
  });
});
