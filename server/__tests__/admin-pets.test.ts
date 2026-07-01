import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminToken, createTestEnv } from './helpers';

describe('admin customer pets', () => {
  it('lists customers with their pets', async () => {
    const { env } = createTestEnv();
    const token = await adminToken('tnt_sunnypaws');
    const res = await app.request(
      '/api/sunny-paws/admin/customers',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await res.json()) as { customers: any[] };
    const jess = body.customers.find((c) => c.email === 'jess@example.com');
    expect(jess.pets.map((p: any) => p.name).sort()).toEqual(['Bella', 'Mochi']);
  });

  it('adds and removes a pet; rejects a disabled species', async () => {
    const { env } = createTestEnv();
    const token = await adminToken('tnt_sunnypaws');
    const add = await app.request(
      '/api/sunny-paws/admin/customers/eu_sp_jess/pets',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Rex', petType: 'dog' }),
      },
      env,
    );
    expect(add.status).toBe(201);
    const petId = ((await add.json()) as { id: string }).id;
    const del = await app.request(
      `/api/sunny-paws/admin/customers/eu_sp_jess/pets/${petId}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(del.status).toBe(204);

    const tokenB = await adminToken('tnt_happytails');
    const bad = await app.request(
      '/api/happy-tails/admin/customers/eu_ht_jess/pets',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenB}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Whiskers', petType: 'cat' }), // Happy Tails = dogs only
      },
      env,
    );
    expect(bad.status).toBe(400);
  });
});
