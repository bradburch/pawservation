import { describe, expect, it } from 'vitest';
import {
  countBookingsForUser,
  deleteCustomer,
  getEndUserByEmail,
  insertInvitedCustomer,
  listCustomers,
  promoteCustomerActive,
} from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

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

  it("deleteCustomer cascades BookingRequestPets referencing the deleted customer's pets", async () => {
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
    // addBookingPets only checks tenant match, not pet ownership vs. booking owner).
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk3','${TENANT_A}','${other.Id}','daycare','2030-04-01',1,'pending')`);
    raw.exec(`INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES ('bk3','pet2')`);

    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(true);

    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(false);
    expect(raw.prepare('SELECT * FROM EndUserPets WHERE Id = ?').get('pet2')).toBeUndefined();
    expect(
      raw.prepare('SELECT * FROM BookingRequestPets WHERE PetId = ?').get('pet2'),
    ).toBeUndefined();
    // The other customer's booking itself is untouched.
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
