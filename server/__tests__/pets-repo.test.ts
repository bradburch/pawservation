import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, endUserToken, seedPets, TENANT_A, TENANT_B } from './helpers';
import { addEndUserPet, listEndUserPets, removeEndUserPet } from '../db/repo';

describe('EndUserPets repo', () => {
  it('adds, lists, and scopes pets by tenant', async () => {
    const { env } = createTestEnv();
    const pet = await addEndUserPet(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess', 'Rex', 'dog');
    expect(pet.Name).toBe('Rex');
    const forA = await listEndUserPets(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess');
    expect(forA.map((p) => p.Name).sort()).toEqual(['Bella', 'Mochi', 'Rex']);
    const forB = await listEndUserPets(env.PAWBOOK_DB, TENANT_B, 'eu_sp_jess');
    expect(forB).toEqual([]);
  });

  it('removes a pet scoped to its tenant', async () => {
    const { env } = createTestEnv();
    // 'removed'/'not-found' rather than true/false: the function grew a THIRD outcome
    // ('has-bookings', see below). Same two behaviours this test always described.
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella')).toBe('removed');
    const left = await listEndUserPets(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess');
    expect(left.map((p) => p.Name)).toEqual(['Mochi']);
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_B, 'pet_sp_mochi')).toBe('not-found');
  });
});

describe('seedPets test helper', () => {
  it('makes every seeded pet visible to its owner through the PetOwners authority', async () => {
    const { env, raw } = createTestEnv();
    const ids = seedPets(raw, TENANT_A, 'eu_sp_jess', [
      { id: 'pet_x1', petType: 'dog' },
      { id: 'pet_x2', petType: 'dog', name: 'Rex' },
    ]);
    expect(ids).toEqual(['pet_x1', 'pet_x2']);
    const pets = await listEndUserPets(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess');
    expect(pets.map((p) => p.Id)).toEqual(expect.arrayContaining(['pet_x1', 'pet_x2']));
    expect(pets.find((p) => p.Id === 'pet_x2')!.Name).toBe('Rex');
  });
});

/**
 * A pet on a booking is part of that booking's RECORD. Deleting it used to depend on the admin
 * route's caller-side pre-check (`countBookingPetRefs`); the repo function itself just tried the
 * delete, and `BookingRequestPets` has no ON DELETE CASCADE — so any path that reached it with a
 * booked pet (a new caller, or a booking POST landing between the check and the delete) got a raw
 * FK constraint error, i.e. a 500. The refusal now lives in the SQL, next to the write.
 */
describe('removeEndUserPet refuses a pet that is on a booking', () => {
  const bookBella = async (env: Env) => {
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request(
      '/api/sunny-paws/bookings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'boarding',
          startDate: '2028-10-01',
          endDate: '2028-10-03',
          petIds: ['pet_sp_bella'],
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
  };

  it('reports has-bookings instead of throwing an FK error', async () => {
    const { env } = createTestEnv();
    await bookBella(env);
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella')).toBe('has-bookings');
  });

  it('writes NOTHING on refusal — the pet and its ownership edges survive', async () => {
    const { env, raw } = createTestEnv();
    await bookBella(env);
    await removeEndUserPet(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella');
    const pets = await listEndUserPets(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess');
    expect(pets.map((p) => p.Id)).toContain('pet_sp_bella');
    const owners = raw
      .prepare(`SELECT EndUserId FROM PetOwners WHERE TenantId = ? AND PetId = ?`)
      .all(TENANT_A, 'pet_sp_bella') as { EndUserId: string }[];
    expect(owners.map((o) => o.EndUserId)).toEqual(['eu_sp_jess']);
    // The booking still says what it always said it was for.
    const refs = raw
      .prepare(`SELECT COUNT(*) AS n FROM BookingRequestPets WHERE PetId = ?`)
      .get('pet_sp_bella') as { n: number };
    expect(refs.n).toBe(1);
  });

  it('a CANCELLED booking still protects the pet — cancel is soft, the record stands', async () => {
    const { env, raw } = createTestEnv();
    await bookBella(env);
    raw.exec(`UPDATE BookingRequests SET Status = 'cancelled' WHERE TenantId = '${TENANT_A}'`);
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella')).toBe('has-bookings');
  });

  it('the admin route reports the refusal, and points at the remedy that keeps history', async () => {
    const { env } = createTestEnv();
    await bookBella(env);
    const res = await app.request(
      '/api/sunny-paws/admin/customers/eu_sp_jess/pets/pet_sp_bella',
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Pet has bookings; cannot remove. Mark them as passed away instead.',
    });
  });

  it('an unbooked pet is still removed, and an unknown/foreign id is still not-found', async () => {
    const { env } = createTestEnv();
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella')).toBe('removed');
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella')).toBe('not-found');
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_B, 'pet_sp_mochi')).toBe('not-found');
  });
});
