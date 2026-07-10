import { describe, expect, it } from 'vitest';
import {
  getBookingWithCustomer,
  insertBookingRequest,
  listBookingsForTenant,
  updateBookingStatus,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

describe('booking lifecycle repo', () => {
  it('lists non-blocked bookings for a tenant, excluding other tenants', async () => {
    const { env } = createTestEnv();
    const a1 = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2030-01-01',
      endDate: '2030-01-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    await insertBookingRequest(env.PAWBOOK_DB, TENANT_B, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2030-01-02',
      endDate: '2030-01-04',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    const rows = await listBookingsForTenant(env.PAWBOOK_DB, TENANT_A);
    // Verify tenant isolation: no TENANT_B rows
    expect(rows.every((r) => r.TenantId === TENANT_A)).toBe(true);
    // Verify non-blocked filtering: no 'blocked' service types
    expect(rows.every((r) => r.ServiceType !== 'blocked')).toBe(true);
    // Verify the created booking is in the list and has Declined=0
    const createdRow = rows.find((r) => r.Id === a1)!;
    expect(createdRow).toBeDefined();
    expect(createdRow.Declined).toBe(0);
  });

  it('confirms a pending booking, then blocks re-declining it; cancel is terminal', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2030-02-01',
      endDate: '2030-02-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'confirmed')).toBe(true);
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'declined')).toBe(false);
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'cancelled')).toBe(true);
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'confirmed')).toBe(false);
  });

  it('declining a pending booking sets Status=cancelled and Declined=1', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'walk',
      startDate: '2030-03-01',
      endDate: null,
      optionKey: 'd30',
      petType: 'dog',
      petCount: 1,
      estCost: 20,
      status: 'pending',
    });
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'declined')).toBe(true);
    const row = (await listBookingsForTenant(env.PAWBOOK_DB, TENANT_A)).find((r) => r.Id === id)!;
    expect(row.Status).toBe('cancelled');
    expect(row.Declined).toBe(1);
  });

  it('will not update a booking that belongs to another tenant', async () => {
    const { env } = createTestEnv();
    const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2030-04-01',
      endDate: '2030-04-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    expect(await updateBookingStatus(env.PAWBOOK_DB, TENANT_B, id, 'confirmed')).toBe(false);
  });

  it('getBookingWithCustomer returns null for an unknown id', async () => {
    const { env } = createTestEnv();
    expect(await getBookingWithCustomer(env.PAWBOOK_DB, TENANT_A, 'nope')).toBeNull();
  });
});
