import { describe, expect, it } from 'vitest';
import app from '../index';
import { listAllPetGroupPricing } from '../db/repo';
import { adminHeaders, createTestEnv, TENANT_A, TENANT_B } from './helpers';

type RateRow = {
  id: string;
  serviceType: string;
  optionKey: string;
  petIds: string[];
  rate: number;
  updatedAt: string;
};

const putRate = async (env: Env, slug: string, tenantId: string, body: Record<string, unknown>) =>
  app.request(
    `/api/${slug}/admin/pet-group-rates`,
    {
      method: 'PUT',
      headers: { ...(await adminHeaders(tenantId)), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

const getRates = async (env: Env, slug: string, tenantId: string): Promise<RateRow[]> => {
  const res = await app.request(
    `/api/${slug}/admin/pet-group-rates`,
    { headers: await adminHeaders(tenantId) },
    env,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { rates: RateRow[] }).rates;
};

describe('admin pet-group rates routes', () => {
  it('requires admin auth', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/sunny-paws/admin/pet-group-rates', {}, env);
    expect(res.status).toBe(401);
  });

  it('GET is empty before any rate exists', async () => {
    const { env } = createTestEnv();
    expect(await getRates(env, 'sunny-paws', TENANT_A)).toEqual([]);
  });

  it('PUT creates; the key is sorted and deduped regardless of input order', async () => {
    const { env } = createTestEnv();
    const res = await putRate(env, 'sunny-paws', TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      petIds: ['pet_sp_mochi', 'pet_sp_bella', 'pet_sp_mochi'],
      rate: 44,
    });
    expect(res.status).toBe(200);
    const { groupKey } = (await res.json()) as { id: string; groupKey: string };
    expect(groupKey).toBe('pet_sp_bella,pet_sp_mochi');
    const rates = await getRates(env, 'sunny-paws', TENANT_A);
    expect(rates).toHaveLength(1);
    expect(rates[0].petIds).toEqual(['pet_sp_bella', 'pet_sp_mochi']);
    expect(rates[0].rate).toBe(44);
  });

  it('PUT again upserts in place — same id, new rate, still one row', async () => {
    const { env } = createTestEnv();
    const body = {
      serviceType: 'walk',
      optionKey: 'd30',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
      rate: 44,
    };
    const first = (await (await putRate(env, 'sunny-paws', TENANT_A, body)).json()) as {
      id: string;
    };
    const second = (await (
      await putRate(env, 'sunny-paws', TENANT_A, { ...body, rate: 50 })
    ).json()) as { id: string };
    expect(second.id).toBe(first.id);
    const rates = await getRates(env, 'sunny-paws', TENANT_A);
    expect(rates).toHaveLength(1);
    expect(rates[0].rate).toBe(50);
  });

  it('rejects an unknown service, an unknown option, and a bad rate', async () => {
    const { env } = createTestEnv();
    const base = { serviceType: 'walk', optionKey: 'd30', petIds: ['pet_sp_bella'] };
    expect(
      (await putRate(env, 'sunny-paws', TENANT_A, { ...base, serviceType: 'grooming', rate: 20 }))
        .status,
    ).toBe(400);
    expect(
      (await putRate(env, 'sunny-paws', TENANT_A, { ...base, optionKey: 'd45', rate: 20 })).status,
    ).toBe(400);
    for (const rate of [0, -5, 19.5, '20', null, undefined]) {
      expect((await putRate(env, 'sunny-paws', TENANT_A, { ...base, rate })).status).toBe(400);
    }
  });

  it('rejects empty, non-array, foreign-tenant, and unknown pet ids', async () => {
    const { env } = createTestEnv();
    const base = { serviceType: 'walk', optionKey: 'd30', rate: 20 };
    expect((await putRate(env, 'sunny-paws', TENANT_A, { ...base, petIds: [] })).status).toBe(400);
    expect(
      (await putRate(env, 'sunny-paws', TENANT_A, { ...base, petIds: 'pet_sp_bella' })).status,
    ).toBe(400);
    expect(
      (await putRate(env, 'sunny-paws', TENANT_A, { ...base, petIds: ['pet_ht_otis'] })).status,
    ).toBe(400);
    expect(
      (await putRate(env, 'sunny-paws', TENANT_A, { ...base, petIds: ['pet_nope'] })).status,
    ).toBe(400);
    expect(await listAllPetGroupPricing(env.PAWSERVATION_DB, TENANT_A)).toHaveLength(0);
  });

  it('rejects a deceased pet — a dead pet is never bookable, so a new rate naming one is a mistake', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        "UPDATE EndUserPets SET DeceasedAt = '2026-01-01T00:00:00Z' WHERE Id = 'pet_sp_mochi'",
      )
      .run();
    const res = await putRate(env, 'sunny-paws', TENANT_A, {
      serviceType: 'walk',
      optionKey: 'd30',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
      rate: 40,
    });
    expect(res.status).toBe(400);
  });

  it('DELETE removes one row; a second DELETE 404s', async () => {
    const { env } = createTestEnv();
    const { id } = (await (
      await putRate(env, 'sunny-paws', TENANT_A, {
        serviceType: 'walk',
        optionKey: 'd30',
        petIds: ['pet_sp_bella'],
        rate: 20,
      })
    ).json()) as { id: string };
    const del = await app.request(
      `/api/sunny-paws/admin/pet-group-rates/${id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(del.status).toBe(204);
    expect(await getRates(env, 'sunny-paws', TENANT_A)).toEqual([]);
    const again = await app.request(
      `/api/sunny-paws/admin/pet-group-rates/${id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(again.status).toBe(404);
  });

  it('tenant isolation: B cannot see or delete A’s rate', async () => {
    const { env } = createTestEnv();
    const { id } = (await (
      await putRate(env, 'sunny-paws', TENANT_A, {
        serviceType: 'walk',
        optionKey: 'd30',
        petIds: ['pet_sp_bella'],
        rate: 20,
      })
    ).json()) as { id: string };
    expect(await getRates(env, 'happy-tails', TENANT_B)).toEqual([]);
    const del = await app.request(
      `/api/happy-tails/admin/pet-group-rates/${id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_B) },
      env,
    );
    expect(del.status).toBe(404);
    expect(await getRates(env, 'sunny-paws', TENANT_A)).toHaveLength(1);
  });
});
