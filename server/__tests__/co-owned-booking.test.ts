import { describe, expect, it } from 'vitest';
import app from '../index';
import { addPetOwner, insertInvitedCustomer, setPetDeceased } from '../db/repo';
import { adminHeaders, createTestEnv, endUserToken, TENANT_A } from './helpers';

const me = async (env: Env, token: string) =>
  (await (
    await app.request('/api/sunny-paws/me', { headers: { Authorization: `Bearer ${token}` } }, env)
  ).json()) as { name: string | null; pets: { id: string; name: string }[] };

const book = (env: Env, token: string, petIds: string[]) =>
  app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'boarding',
        optionKey: 'standard',
        startDate: '2026-09-01',
        endDate: '2026-09-03',
        petIds,
      }),
    },
    env,
  );

describe('co-owned pets in the widget', () => {
  it('a co-owner sees the co-owned pet on /me and can book it', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'co@example.com',
      'Co Owner',
    );
    await addPetOwner(env.PAWSERVATION_DB, TENANT_A, 'pet_sp_bella', co.Id);
    const token = await endUserToken(env, 'sunny-paws', 'co@example.com');

    expect((await me(env, token)).pets.map((p) => p.name)).toEqual(['Bella']);
    const res = await book(env, token, ['pet_sp_bella']);
    expect(res.status).toBe(201);
  });

  it("a non-owner still cannot book another customer's pet", async () => {
    const { env } = createTestEnv();
    await insertInvitedCustomer(env.PAWSERVATION_DB, TENANT_A, 'stranger@example.com', 'Stranger');
    const token = await endUserToken(env, 'sunny-paws', 'stranger@example.com');

    expect((await me(env, token)).pets).toEqual([]);
    const res = await book(env, token, ['pet_sp_bella']);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown pet.', code: 'unknown_pet' });
  });

  it('a removed co-owner immediately loses access again', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'co@example.com',
      'Co Owner',
    );
    await addPetOwner(env.PAWSERVATION_DB, TENANT_A, 'pet_sp_bella', co.Id);
    const token = await endUserToken(env, 'sunny-paws', 'co@example.com');
    await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella/owners/${co.Id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect((await book(env, token, ['pet_sp_bella'])).status).toBe(400);
  });

  it('a deceased pet disappears from /me and cannot be booked', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    await setPetDeceased(env.PAWSERVATION_DB, TENANT_A, 'pet_sp_bella', true);

    expect((await me(env, token)).pets.map((p) => p.name)).toEqual(['Mochi']);
    const res = await book(env, token, ['pet_sp_bella']);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Unknown pet.', code: 'unknown_pet' });
  });

  it('the pet still appears on a booking made before it died', async () => {
    const { env } = createTestEnv();
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const created = await book(env, token, ['pet_sp_bella']);
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    await setPetDeceased(env.PAWSERVATION_DB, TENANT_A, 'pet_sp_bella', true);

    const mine = (await (
      await app.request(
        '/api/sunny-paws/bookings/mine',
        { headers: { Authorization: `Bearer ${token}` } },
        env,
      )
    ).json()) as { bookings: { id: string; pets: string[] }[] };
    expect(mine.bookings.find((b) => b.id === id)!.pets).toEqual(['Bella']);
  });
});
