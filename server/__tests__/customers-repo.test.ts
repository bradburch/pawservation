import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  addEndUserPet,
  addPetOwner,
  countBookingsForUser,
  deleteCustomer,
  getEndUserByEmail,
  insertInvitedCustomer,
  listCustomers,
  listEndUserPets,
  promoteCustomerActive,
  removePetOwner,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

describe('customer repo', () => {
  it('inserts an invited customer and is idempotent (no active downgrade)', async () => {
    const { env } = createTestEnv();
    const a = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'new@example.com',
      'New Person',
    );
    expect(a.Status).toBe('invited');
    expect(a.Name).toBe('New Person');

    await promoteCustomerActive(env.PAWBOOK_DB, TENANT_A, a.Id);
    const again = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'new@example.com',
      'Ignored',
    );
    expect(again.Id).toBe(a.Id);
    expect(again.Status).toBe('active'); // not downgraded
  });

  it('getEndUserByEmail returns null for unknown', async () => {
    const { env } = createTestEnv();
    expect(await getEndUserByEmail(env.PAWBOOK_DB, TENANT_A, 'nobody@example.com')).toBeNull();
  });

  it('lists customers and counts bookings', async () => {
    const { env, raw } = createTestEnv();
    const c = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'c@example.com', null);
    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(true);
    expect(await countBookingsForUser(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(0);

    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk1','${TENANT_A}','${c.Id}','daycare','2030-04-01',1,'pending')`);
    expect(await countBookingsForUser(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(1);
  });

  it('deleteCustomer refuses when the customer has bookings (TOCTOU guard)', async () => {
    const { env, raw } = createTestEnv();
    const c = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'withbooking@example.com',
      null,
    );
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk2','${TENANT_A}','${c.Id}','daycare','2030-04-01',1,'pending')`);
    // With a booking: must return false and leave both rows intact
    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(false);
    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(true);
    expect(await countBookingsForUser(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(1);
  });

  it('deleteCustomer succeeds with no bookings; returns false for missing id', async () => {
    const { env } = createTestEnv();
    const c = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'nobooking@example.com', null);
    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(true);
    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(false);
    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, 'missing')).toBe(false);
  });

  it('deleteCustomer refuses cross-tenant, leaving the customer, their pet and its edges intact', async () => {
    const { env, raw } = createTestEnv();
    const c = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'cross@example.com', null);
    // A pet WITH a co-owner, so the wrong-tenant call has something to damage via each of the two
    // co-ownership statements: the creating-owner reassignment UPDATE and the PetOwners delete.
    // Without these rows the test cannot see whether either statement is tenant-scoped at all.
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'crossco@example.com', null);
    const pet = await addEndUserPet(env.PAWBOOK_DB, TENANT_A, c.Id, 'Cross', 'dog');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, pet.Id, co.Id);

    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_B, c.Id)).toBe(false);

    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(true);
    // The pet is untouched AND still stamped with its creating owner (not handed to the co-owner).
    expect(
      raw.prepare('SELECT Id, EndUserId FROM EndUserPets WHERE Id = ?').get(pet.Id),
    ).toMatchObject({ Id: pet.Id, EndUserId: c.Id });
    // Both ownership edges survive — the cross-tenant call deleted neither.
    expect(
      (
        raw.prepare('SELECT COUNT(*) AS n FROM PetOwners WHERE PetId = ?').get(pet.Id) as {
          n: number;
        }
      ).n,
    ).toBe(2);
  });

  it('deleteCustomer cascades EndUserPets and LoginCodes (no FK violation, no orphans)', async () => {
    const { env, raw } = createTestEnv();
    const c = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'haspet@example.com', null);
    raw.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
              VALUES ('pet1','${TENANT_A}','${c.Id}','Fido','dog')`);
    raw.exec(`INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt)
              VALUES ('lc1','${TENANT_A}','${c.Id}','123456','2030-01-01T00:00:00.000Z')`);

    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(true);

    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(false);
    expect(raw.prepare('SELECT * FROM EndUserPets WHERE Id = ?').get('pet1')).toBeUndefined();
    expect(raw.prepare('SELECT * FROM LoginCodes WHERE Id = ?').get('lc1')).toBeUndefined();
  });

  it("deleteCustomer refuses when ANOTHER customer's booking holds a pet that would cascade", async () => {
    const { env, raw } = createTestEnv();
    const c = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'haspetbooked@example.com',
      null,
    );
    const other = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'other@example.com', null);
    raw.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
              VALUES ('pet2','${TENANT_A}','${c.Id}','Rex','dog')`);
    // A booking owned by a DIFFERENT customer that references this customer's pet (the app's
    // addBookingPets only checks tenant match, not pet ownership vs. booking owner). Deleting c
    // would cascade pet2 — nobody else owns it — and strip the last pet off a live booking, so the
    // whole delete is refused rather than silently gutting bk3.
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk3','${TENANT_A}','${other.Id}','daycare','2030-04-01',1,'pending')`);
    raw.exec(`INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES ('bk3','pet2')`);

    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(false);

    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(true);
    expect(raw.prepare('SELECT * FROM EndUserPets WHERE Id = ?').get('pet2')).toBeDefined();
    expect(
      raw.prepare('SELECT * FROM BookingRequestPets WHERE PetId = ?').get('pet2'),
    ).toBeDefined();
    expect(raw.prepare('SELECT * FROM BookingRequests WHERE Id = ?').get('bk3')).toBeDefined();
  });

  it('deleteCustomer guard still refuses (leaving pets/login codes intact) when the customer has bookings', async () => {
    const { env, raw } = createTestEnv();
    const c = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'withbookingandpet@example.com',
      null,
    );
    raw.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
              VALUES ('pet3','${TENANT_A}','${c.Id}','Milo','dog')`);
    raw.exec(`INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt)
              VALUES ('lc3','${TENANT_A}','${c.Id}','654321','2030-01-01T00:00:00.000Z')`);
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk4','${TENANT_A}','${c.Id}','daycare','2030-04-01',1,'pending')`);
    raw.exec(`INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES ('bk4','pet3')`);

    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(false);

    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(true);
    expect(raw.prepare('SELECT * FROM EndUserPets WHERE Id = ?').get('pet3')).toBeDefined();
    expect(raw.prepare('SELECT * FROM LoginCodes WHERE Id = ?').get('lc3')).toBeDefined();
    expect(
      raw.prepare('SELECT * FROM BookingRequestPets WHERE PetId = ?').get('pet3'),
    ).toBeDefined();
  });
});

describe('deleteCustomer under co-ownership', () => {
  const petRow = (raw: DatabaseSync, petId: string) =>
    raw.prepare('SELECT Id, EndUserId FROM EndUserPets WHERE Id = ?').get(petId) as
      { Id: string; EndUserId: string } | undefined;
  const ownerCount = (raw: DatabaseSync, petId: string) =>
    (raw.prepare('SELECT COUNT(*) AS n FROM PetOwners WHERE PetId = ?').get(petId) as { n: number })
      .n;

  it('keeps a co-owned pet alive and hands it to the surviving owner', async () => {
    const { env, raw } = createTestEnv();
    const creator = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'creator@example.com',
      'Creator',
    );
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    const pet = await addEndUserPet(env.PAWBOOK_DB, TENANT_A, creator.Id, 'Rex', 'dog');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, pet.Id, co.Id);

    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, creator.Id)).toBe(true);

    // The pet survives, now stamped with the survivor (EndUserPets.EndUserId is NOT NULL + FK).
    expect(petRow(raw, pet.Id)).toEqual({ Id: pet.Id, EndUserId: co.Id });
    expect(ownerCount(raw, pet.Id)).toBe(1);
    // The survivor still sees it.
    expect((await listEndUserPets(env.PAWBOOK_DB, TENANT_A, co.Id)).map((p) => p.Name)).toEqual([
      'Rex',
    ]);
  });

  it('still deletes a pet nobody else owns', async () => {
    const { env, raw } = createTestEnv();
    const solo = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'solo@example.com', 'Solo');
    const pet = await addEndUserPet(env.PAWBOOK_DB, TENANT_A, solo.Id, 'Only', 'dog');
    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, solo.Id)).toBe(true);
    expect(petRow(raw, pet.Id)).toBeUndefined();
    expect(ownerCount(raw, pet.Id)).toBe(0);
  });

  it('refuses outright once an unlink leaves a BOOKED pet with only the departing owner', async () => {
    const { env, raw } = createTestEnv();
    const creator = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'creator@example.com',
      'Creator',
    );
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    const pet = await addEndUserPet(env.PAWBOOK_DB, TENANT_A, creator.Id, 'Rex', 'dog');
    // Every step below is a supported product action, which is what makes this reachable:
    // 1. the sitter co-owns `co` onto the creator's pet;
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, pet.Id, co.Id);
    // 2. `co` books the shared pet — legal, listEndUserPets returns co-owned pets;
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk_co','${TENANT_A}','${co.Id}','daycare','2030-04-01',1,'confirmed')`);
    raw.exec(
      `INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES ('bk_co','${pet.Id}')`,
    );
    // 3. the sitter unlinks `co` from the pet (removePetOwner has no booking check, by design),
    //    leaving the creator as sole owner of a pet that someone else's confirmed booking names.
    expect(await removePetOwner(env.PAWBOOK_DB, TENANT_A, pet.Id, co.Id)).toBe('removed');
    raw.exec(`INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt)
              VALUES ('lc_co','${TENANT_A}','${creator.Id}','111111','2030-01-01T00:00:00.000Z')`);

    // 4. the sitter deletes the creator. They have no bookings of their own, so the has-bookings
    //    guard passes — but cascading the pet would strip the last pet off bk_co, so: refused.
    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, creator.Id)).toBe(false);

    // Nothing at all was written: the batch fails as a unit, not statement by statement.
    expect(petRow(raw, pet.Id)).toEqual({ Id: pet.Id, EndUserId: creator.Id });
    expect(ownerCount(raw, pet.Id)).toBe(1);
    expect(
      raw.prepare('SELECT * FROM BookingRequestPets WHERE PetId = ?').get(pet.Id),
    ).toBeDefined();
    expect(raw.prepare('SELECT * FROM EndUsers WHERE Id = ?').get(creator.Id)).toBeDefined();
    expect(raw.prepare('SELECT * FROM LoginCodes WHERE Id = ?').get('lc_co')).toBeDefined();
  });

  it('deletes the creating owner of a BOOKED co-owned pet, keeping its BookingRequestPets rows', async () => {
    const { env, raw } = createTestEnv();
    const creator = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'creator@example.com',
      'Creator',
    );
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    const pet = await addEndUserPet(env.PAWBOOK_DB, TENANT_A, creator.Id, 'Rex', 'dog');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, pet.Id, co.Id);
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk_keep','${TENANT_A}','${co.Id}','daycare','2030-04-01',1,'confirmed')`);
    raw.exec(
      `INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES ('bk_keep','${pet.Id}')`,
    );

    // The pet is REASSIGNED, not cascaded, so its bookings are none of this delete's business.
    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, creator.Id)).toBe(true);

    expect(raw.prepare('SELECT * FROM EndUsers WHERE Id = ?').get(creator.Id)).toBeUndefined();
    expect(petRow(raw, pet.Id)).toEqual({ Id: pet.Id, EndUserId: co.Id });
    expect(ownerCount(raw, pet.Id)).toBe(1);
    // The survivor's booking still names the pet.
    expect(
      raw.prepare('SELECT * FROM BookingRequestPets WHERE BookingRequestId = ?').get('bk_keep'),
    ).toMatchObject({ PetId: pet.Id });
    expect(raw.prepare('SELECT * FROM BookingRequests WHERE Id = ?').get('bk_keep')).toBeDefined();
  });

  it('removes only the departing owner from a pet they merely co-own', async () => {
    const { env, raw } = createTestEnv();
    const creator = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_A,
      'creator@example.com',
      'Creator',
    );
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    const pet = await addEndUserPet(env.PAWBOOK_DB, TENANT_A, creator.Id, 'Rex', 'dog');
    await addPetOwner(env.PAWBOOK_DB, TENANT_A, pet.Id, co.Id);

    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, co.Id)).toBe(true);

    expect(petRow(raw, pet.Id)).toEqual({ Id: pet.Id, EndUserId: creator.Id });
    expect(ownerCount(raw, pet.Id)).toBe(1);
  });
});
