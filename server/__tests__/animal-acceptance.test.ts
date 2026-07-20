import { describe, expect, it } from 'vitest';
import app from '../index';
import { setServiceAcceptedPetTypes } from '../db/repo';
import { adminToken, createTestEnv, endUserToken, TENANT_A } from './helpers';

const book = async (env: Env, token: string, petIds: string[], type = 'boarding') =>
  app.request(
    '/api/sunny-paws/bookings',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        optionKey: type === 'boarding' ? 'standard' : 'd30',
        startDate: '2026-10-01',
        ...(type === 'boarding' ? { endDate: '2026-10-03' } : {}),
        petIds,
      }),
    },
    env,
  );

describe('per-service pet-type acceptance (booking POST)', () => {
  it('rejects a pet whose type is off the service list, with the plain-language message', async () => {
    const { env } = createTestEnv();
    await setServiceAcceptedPetTypes(env.PAWBOOK_DB, TENANT_A, 'boarding', ['dog']);
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await book(env, token, ['pet_sp_mochi']); // Mochi is a cat
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Boarding doesn't accept cats — Mochi can't join this booking.",
    );
  });

  it('a mixed dog+cat selection is rejected too — any offending pet fails the booking', async () => {
    const { env } = createTestEnv();
    await setServiceAcceptedPetTypes(env.PAWBOOK_DB, TENANT_A, 'boarding', ['dog']);
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await book(env, token, ['pet_sp_bella', 'pet_sp_mochi']);
    expect(res.status).toBe(400);
  });

  it('NULL acceptance accepts every enabled type, including a fresh custom one', async () => {
    const { env } = createTestEnv();
    const admin = await adminToken(TENANT_A);
    const addPet = await app.request(
      '/api/sunny-paws/admin/customers/eu_sp_jess/pets',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Peanut', petType: 'rabbit' }),
      },
      env,
    );
    expect(addPet.status).toBe(201);
    const petId = ((await addPet.json()) as { id: string }).id;
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await book(env, token, [petId]); // boarding AcceptedPetTypes is NULL
    expect(res.status).toBe(201);
  });

  it('a type excluded from the chosen service is rejected by acceptance; an unknown slug still 400s', async () => {
    const { env, raw } = createTestEnv();
    await setServiceAcceptedPetTypes(env.PAWBOOK_DB, TENANT_A, 'boarding', ['dog']);
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    // Excluded-but-registered type: the per-service acceptance gate fires with its rich copy.
    const excluded = await book(env, token, ['pet_sp_mochi']);
    expect(excluded.status).toBe(400);
    expect(((await excluded.json()) as { error: string }).error).toBe(
      "Boarding doesn't accept cats — Mochi can't join this booking.",
    );
    // A pet whose slug is NOT in the registry at all (corrupt data) hits the membership gate.
    raw.prepare(`UPDATE EndUserPets SET PetType = 'dragon' WHERE Id = 'pet_sp_mochi'`).run();
    const unknown = await book(env, token, ['pet_sp_mochi']);
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe(
      'That pet type is not accepted.',
    );
  });

  it('post-migration Happy Tails: a cat books nowhere — every service accepts dogs only (F1, end to end)', async () => {
    const { env } = createTestEnv();
    // The registry still HAS cat (recording one is allowed — registry membership)…
    const admin = await adminToken('tnt_happytails');
    const addPet = await app.request(
      '/api/happy-tails/admin/customers/eu_ht_jess/pets',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Whiskers', petType: 'cat' }),
      },
      env,
    );
    expect(addPet.status).toBe(201);
    const petId = ((await addPet.json()) as { id: string }).id;
    // …but no service accepts it: the seeded '["dog"]' lists (0015 materialization) reject the booking.
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const res = await app.request(
      '/api/happy-tails/bookings',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'boarding',
          optionKey: 'standard',
          startDate: '2026-10-01',
          endDate: '2026-10-03',
          petIds: [petId],
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "Boarding doesn't accept cats — Whiskers can't join this booking.",
    );
  });
});
