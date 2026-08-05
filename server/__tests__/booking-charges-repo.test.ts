import { describe, expect, it } from 'vitest';
import {
  deleteBookingCharge,
  deleteTenantCompletely,
  insertBookingCharge,
  insertBookingRequest,
  listChargesForBooking,
  listChargesForTenant,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

const makeBooking = (env: Env, tenantId: string, status: 'pending' | 'confirmed' = 'confirmed') =>
  insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost: 100,
    status,
  });

const makeBlocked = (env: Env, tenantId: string) =>
  insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: null,
    serviceType: 'blocked',
    startDate: '2030-02-01',
    endDate: '2030-02-03',
    optionKey: null,
    petCount: 1,
    estCost: null,
    status: 'confirmed',
  });

describe('BookingCharges repo', () => {
  it('inserts and lists a charge for a booking', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const id = await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: bookingId,
      label: 'Vet visit',
      amount: 45,
    });
    expect(id).not.toBeNull();
    const rows = await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Label: 'Vet visit', Amount: 45 });
  });

  it('refuses a booking belonging to another tenant', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const id = await insertBookingCharge(env.PAWSERVATION_DB, TENANT_B, {
      bookingRequestId: bookingId, // tenant A's booking
      label: 'Haircut',
      amount: 30,
    });
    expect(id).toBeNull();
    expect(await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, bookingId)).toHaveLength(0);
  });

  it('refuses the blocked-day sentinel', async () => {
    const { env } = createTestEnv();
    const blockedId = await makeBlocked(env, TENANT_A);
    expect(
      await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
        bookingRequestId: blockedId,
        label: 'Nope',
        amount: 10,
      }),
    ).toBeNull();
  });

  it('deletes only the right charge, and only within its own booking and tenant', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const otherBookingId = await makeBooking(env, TENANT_A);
    const id = (await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: bookingId,
      label: 'Vet visit',
      amount: 45,
    }))!;
    expect(await deleteBookingCharge(env.PAWSERVATION_DB, TENANT_B, bookingId, id)).toBe(false);
    expect(await deleteBookingCharge(env.PAWSERVATION_DB, TENANT_A, otherBookingId, id)).toBe(
      false,
    );
    expect(await deleteBookingCharge(env.PAWSERVATION_DB, TENANT_A, bookingId, id)).toBe(true);
    expect(await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, bookingId)).toHaveLength(0);
  });

  it('lists every charge for a tenant and never another tenant’s', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: bookingId,
      label: 'Vet visit',
      amount: 45,
    });
    expect(await listChargesForTenant(env.PAWSERVATION_DB, TENANT_A)).toHaveLength(1);
    expect(await listChargesForTenant(env.PAWSERVATION_DB, TENANT_B)).toHaveLength(0);
  });

  it('is removed by deleteTenantCompletely', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: bookingId,
      label: 'Vet visit',
      amount: 45,
    });
    expect(await deleteTenantCompletely(env.PAWSERVATION_DB, TENANT_A)).toBe(true);
    expect(await listChargesForTenant(env.PAWSERVATION_DB, TENANT_A)).toHaveLength(0);
  });
});
