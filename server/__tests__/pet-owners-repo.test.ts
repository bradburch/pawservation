import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  addEndUserPet,
  addPetOwner,
  insertInvitedCustomer,
  removeEndUserPet,
  removePetOwner,
  setPetDeceased,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

/** Owner ids linked to a pet, straight from the table — the assertions must not lean on the
 *  read functions under test in the sibling task. */
const ownersOf = (raw: DatabaseSync, petId: string): string[] =>
  (
    raw
      .prepare('SELECT EndUserId FROM PetOwners WHERE PetId = ? ORDER BY EndUserId')
      .all(petId) as { EndUserId: string }[]
  ).map((r) => r.EndUserId);

const creatingOwnerOf = (raw: DatabaseSync, petId: string): string =>
  (
    raw.prepare('SELECT EndUserId FROM EndUserPets WHERE Id = ?').get(petId) as {
      EndUserId: string;
    }
  ).EndUserId;

describe('PetOwners write-side repo', () => {
  it('addEndUserPet writes the pet AND its first ownership edge', async () => {
    const { env, raw } = createTestEnv();
    const pet = await addEndUserPet(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess', 'Rex', 'dog');
    expect(pet.DeceasedAt).toBeNull();
    expect(ownersOf(raw, pet.Id)).toEqual(['eu_sp_jess']);
  });

  it('addPetOwner adds a second owner and is idempotent', async () => {
    const { env, raw } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    expect(await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co.Id)).toBe(true);
    expect(await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co.Id)).toBe(true);
    expect(ownersOf(raw, 'pet_sp_bella')).toEqual([co.Id, 'eu_sp_jess'].sort());
  });

  it('addPetOwner refuses cross-tenant ids in BOTH directions', async () => {
    const { env, raw } = createTestEnv();
    // Tenant B scope, tenant A's pet: refused.
    expect(await addPetOwner(env.PAWBOOK_DB, TENANT_B, 'pet_sp_bella', 'eu_ht_jess')).toBe(false);
    // Tenant A scope, tenant B's customer: refused.
    expect(await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', 'eu_ht_jess')).toBe(false);
    // Tenant A scope, tenant B's pet: refused.
    expect(await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_ht_otis', 'eu_sp_jess')).toBe(false);
    expect(ownersOf(raw, 'pet_sp_bella')).toEqual(['eu_sp_jess']);
    expect(ownersOf(raw, 'pet_ht_otis')).toEqual(['eu_ht_jess']);
  });

  it('removePetOwner drops a co-owner and hands over the creating-owner column', async () => {
    const { env, raw } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co.Id);
    // Removing the CREATING owner must reassign EndUserPets.EndUserId to the survivor, or the
    // NOT NULL FK would dangle the moment that customer is deleted.
    expect(await removePetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', 'eu_sp_jess')).toBe(
      'removed',
    );
    expect(ownersOf(raw, 'pet_sp_bella')).toEqual([co.Id]);
    expect(creatingOwnerOf(raw, 'pet_sp_bella')).toBe(co.Id);
  });

  it('removePetOwner drops a NON-creating co-owner and leaves the creating-owner column alone', async () => {
    const { env, raw } = createTestEnv();
    const co1 = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co1@example.com', 'Co One');
    const co2 = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co2@example.com', 'Co Two');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co1.Id);
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co2.Id);
    // co1 is neither the creating owner nor the survivor being tested — removing it must be a
    // pure PetOwners delete: the EndUserPets.EndUserId reassignment UPDATE is scoped to rows where
    // EndUserId = the departing owner, so it must NOT fire when the departing owner isn't the one
    // in that column. Without that scoping this test fails.
    expect(await removePetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co1.Id)).toBe('removed');
    expect(ownersOf(raw, 'pet_sp_bella')).toEqual(['eu_sp_jess', co2.Id].sort());
    expect(creatingOwnerOf(raw, 'pet_sp_bella')).toBe('eu_sp_jess');
  });

  it('removePetOwner refuses to remove the LAST owner', async () => {
    const { env, raw } = createTestEnv();
    expect(await removePetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', 'eu_sp_jess')).toBe(
      'last-owner',
    );
    expect(ownersOf(raw, 'pet_sp_bella')).toEqual(['eu_sp_jess']);
  });

  it('removePetOwner reports not-found for an unlinked pair and is tenant-scoped', async () => {
    const { env, raw } = createTestEnv();
    expect(await removePetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', 'eu_ht_jess')).toBe(
      'not-found',
    );
    // Right pair, WRONG tenant: refused, and nothing is deleted.
    expect(await removePetOwner(env.PAWBOOK_DB, TENANT_B, 'pet_sp_bella', 'eu_sp_jess')).toBe(
      'not-found',
    );
    expect(ownersOf(raw, 'pet_sp_bella')).toEqual(['eu_sp_jess']);
  });

  it('removeEndUserPet clears the ownership edges first (FK) and is tenant-scoped', async () => {
    const { env, raw } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_mochi', co.Id);
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_A, 'pet_sp_mochi')).toBe(true);
    expect(ownersOf(raw, 'pet_sp_mochi')).toEqual([]);
    // Wrong tenant: no delete, edges intact.
    expect(await removeEndUserPet(env.PAWBOOK_DB, TENANT_B, 'pet_sp_bella')).toBe(false);
    expect(ownersOf(raw, 'pet_sp_bella')).toEqual(['eu_sp_jess']);
  });

  it('setPetDeceased marks and un-marks, is idempotent, and is tenant-scoped', async () => {
    const { env, raw } = createTestEnv();
    const deceasedAt = () =>
      (
        raw.prepare(`SELECT DeceasedAt FROM EndUserPets WHERE Id = 'pet_sp_bella'`).get() as {
          DeceasedAt: string | null;
        }
      ).DeceasedAt;
    expect(await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', true)).toBe(true);
    const firstMarkedAt = deceasedAt();
    expect(firstMarkedAt).not.toBeNull();
    // Repeat marking must NOT move the recorded death date forward (COALESCE keeps the original).
    expect(await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', true)).toBe(true);
    expect(deceasedAt()).toBe(firstMarkedAt);
    expect(await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', false)).toBe(true);
    expect(deceasedAt()).toBeNull();
    // Wrong tenant: refused (404 at the route, never a silent cross-tenant write).
    expect(await setPetDeceased(env.PAWBOOK_DB, TENANT_B, 'pet_sp_bella', true)).toBe(false);
    expect(deceasedAt()).toBeNull();
  });
});
