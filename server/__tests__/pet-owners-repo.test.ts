import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  addEndUserPet,
  addPetOwner,
  insertInvitedCustomer,
  listAllEndUserPetsByTenant,
  listEndUserPets,
  listOwnerPetLinks,
  listPetIdsForOwner,
  removeEndUserPet,
  removePetOwner,
  setPetDeceased,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';
import { buildAccounts } from '../../src/shared/index.js';

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
    // Deterministic ids, NOT insertInvitedCustomer's crypto.randomUUID() — both id and CreatedAt
    // are candidate tie-breakers in the reassignment UPDATE's ORDER BY, and in a fast test run
    // every PetOwners row here (seed + these two) lands in the same datetime('now') second, so the
    // tie always falls to EndUserId. 'eu_co1'/'eu_co2' both sort before 'eu_sp_jess' ('eu_c' <
    // 'eu_s'), so if the reassignment UPDATE's `AND EndUserId = ?` scoping were dropped, it would
    // deterministically reassign the creating-owner column away from 'eu_sp_jess' every run —
    // a random co-owner id could occasionally sort AFTER 'eu_sp_jess' and mask the mutation.
    raw
      .prepare(
        `INSERT INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES (?, ?, ?, ?, 'invited')`,
      )
      .run('eu_co1', TENANT_A, 'co1@example.com', 'Co One');
    raw
      .prepare(
        `INSERT INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES (?, ?, ?, ?, 'invited')`,
      )
      .run('eu_co2', TENANT_A, 'co2@example.com', 'Co Two');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', 'eu_co1');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', 'eu_co2');
    // co1 is neither the creating owner nor the survivor being tested — removing it must be a
    // pure PetOwners delete: the EndUserPets.EndUserId reassignment UPDATE is scoped to rows where
    // EndUserId = the departing owner, so it must NOT fire when the departing owner isn't the one
    // in that column. Without that scoping this test fails.
    expect(await removePetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', 'eu_co1')).toBe(
      'removed',
    );
    expect(ownersOf(raw, 'pet_sp_bella')).toEqual(['eu_co2', 'eu_sp_jess']);
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
    expect(deceasedAt()).not.toBeNull();
    // Repeat marking must NOT move the recorded death date forward (COALESCE keeps the original).
    // datetime('now') is second-granular, so re-marking microseconds later and comparing against
    // a captured "first" value would pass even WITHOUT the COALESCE fix (both writes land in the
    // same second). Pin a pre-existing value that is clearly not "now" instead, so a regression to
    // unconditional `datetime('now')` fails deterministically, not by wall-clock luck.
    raw
      .prepare(
        `UPDATE EndUserPets SET DeceasedAt = '2020-01-01 00:00:00' WHERE Id = 'pet_sp_bella'`,
      )
      .run();
    expect(await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', true)).toBe(true);
    expect(deceasedAt()).toBe('2020-01-01 00:00:00');
    expect(await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', false)).toBe(true);
    expect(deceasedAt()).toBeNull();
    // Wrong tenant: refused (404 at the route, never a silent cross-tenant write).
    expect(await setPetDeceased(env.PAWBOOK_DB, TENANT_B, 'pet_sp_bella', true)).toBe(false);
    expect(deceasedAt()).toBeNull();
  });
});

describe('PetOwners read-side repo', () => {
  it('listEndUserPets returns co-owned pets and hides deceased ones', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co.Id);
    expect((await listEndUserPets(env.PAWBOOK_DB, TENANT_A, co.Id)).map((p) => p.Name)).toEqual([
      'Bella',
    ]);
    await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', true);
    expect(await listEndUserPets(env.PAWBOOK_DB, TENANT_A, co.Id)).toEqual([]);
    expect(
      (await listEndUserPets(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess')).map((p) => p.Name),
    ).toEqual(['Mochi']);
  });

  it('listEndUserPets is tenant-scoped', async () => {
    const { env } = createTestEnv();
    expect(await listEndUserPets(env.PAWBOOK_DB, TENANT_B, 'eu_sp_jess')).toEqual([]);
  });

  it('listPetIdsForOwner reads PetOwners, excludes deceased, and is tenant-scoped', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_mochi', co.Id);
    expect(await listPetIdsForOwner(env.PAWBOOK_DB, TENANT_A, co.Id)).toEqual(['pet_sp_mochi']);
    expect(await listPetIdsForOwner(env.PAWBOOK_DB, TENANT_A, 'eu_sp_jess')).toEqual([
      'pet_sp_bella',
      'pet_sp_mochi',
    ]);
    await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_mochi', true);
    expect(await listPetIdsForOwner(env.PAWBOOK_DB, TENANT_A, co.Id)).toEqual([]);
    // Tenant B scope with tenant A's customer: nothing.
    expect(await listPetIdsForOwner(env.PAWBOOK_DB, TENANT_B, 'eu_sp_jess')).toEqual([]);
  });

  it('listOwnerPetLinks returns every edge for the tenant, deceased excluded', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co.Id);
    expect(await listOwnerPetLinks(env.PAWBOOK_DB, TENANT_A)).toEqual(
      [
        { EndUserId: co.Id, PetId: 'pet_sp_bella' },
        { EndUserId: 'eu_sp_jess', PetId: 'pet_sp_bella' },
        { EndUserId: 'eu_sp_jess', PetId: 'pet_sp_mochi' },
      ].sort((a, b) => (a.PetId + a.EndUserId < b.PetId + b.EndUserId ? -1 : 1)),
    );
    await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', true);
    expect(await listOwnerPetLinks(env.PAWBOOK_DB, TENANT_A)).toEqual([
      { EndUserId: 'eu_sp_jess', PetId: 'pet_sp_mochi' },
    ]);
  });

  it('listOwnerPetLinks never leaks another tenant edge', async () => {
    const { env } = createTestEnv();
    const links = await listOwnerPetLinks(env.PAWBOOK_DB, TENANT_B);
    expect(links).toEqual([{ EndUserId: 'eu_ht_jess', PetId: 'pet_ht_otis' }]);
  });

  it('listOwnerPetLinks feeds buildAccounts: two owners of one pet are ONE account', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co.Id);
    const accounts = buildAccounts(
      (await listOwnerPetLinks(env.PAWBOOK_DB, TENANT_A)).map((l) => ({
        ownerId: l.EndUserId,
        petId: l.PetId,
      })),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.ownerIds.sort()).toEqual([co.Id, 'eu_sp_jess'].sort());
    expect(accounts[0]!.petIds).toEqual(['pet_sp_bella', 'pet_sp_mochi']);
    expect(accounts[0]!.id).toBe('pet_sp_bella');
  });

  it('listAllEndUserPetsByTenant returns one row per LINK and keeps deceased pets visible', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, 'pet_sp_bella', co.Id);
    await setPetDeceased(env.PAWBOOK_DB, TENANT_A, 'pet_sp_mochi', true);
    const rows = await listAllEndUserPetsByTenant(env.PAWBOOK_DB, TENANT_A);
    // Bella appears under BOTH owners; Mochi is still listed for the sitter, flagged deceased.
    expect(
      rows
        .filter((r) => r.Id === 'pet_sp_bella')
        .map((r) => r.EndUserId)
        .sort(),
    ).toEqual([co.Id, 'eu_sp_jess'].sort());
    expect(rows.find((r) => r.Id === 'pet_sp_mochi')!.DeceasedAt).not.toBeNull();
    expect(await listAllEndUserPetsByTenant(env.PAWBOOK_DB, TENANT_B)).toHaveLength(1);
  });
});
