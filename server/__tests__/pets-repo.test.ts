import { describe, expect, it } from 'vitest';
import { createTestEnv, seedPets, TENANT_A, TENANT_B } from './helpers';
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
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella')).toBe(true);
    const left = await listEndUserPets(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess');
    expect(left.map((p) => p.Name)).toEqual(['Mochi']);
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_B, 'pet_sp_mochi')).toBe(false);
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
