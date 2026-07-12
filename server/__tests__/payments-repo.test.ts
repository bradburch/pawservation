import { describe, expect, it } from 'vitest';
import {
  deletePayment,
  insertBookingRequest,
  insertPayment,
  listBookingsForTenant,
  listPaymentsForBooking,
  updateBookingStatus,
} from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

const makeBooking = (env: Env, tenantId: string, status: 'pending' | 'confirmed' = 'confirmed') =>
  insertBookingRequest(env.PAWBOOK_DB, tenantId, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petType: 'dog',
    petCount: 1,
    estCost: 100,
    status,
  });

const pay = (env: Env, tenantId: string, bookingRequestId: string, amount = 50) =>
  insertPayment(env.PAWBOOK_DB, tenantId, {
    bookingRequestId,
    amount,
    method: 'cash',
    paidDate: '2026-07-01',
    note: null,
  });

describe('payments repo', () => {
  it('records a payment against a confirmed booking and lists it back', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const paymentId = await insertPayment(env.PAWBOOK_DB, TENANT_A, {
      bookingRequestId: bookingId,
      amount: 75,
      method: 'venmo',
      paidDate: '2026-07-02',
      note: 'deposit',
    });
    expect(paymentId).not.toBeNull();
    const rows = await listPaymentsForBooking(env.PAWBOOK_DB, TENANT_A, bookingId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Id: paymentId,
      TenantId: TENANT_A,
      BookingRequestId: bookingId,
      Amount: 75,
      Method: 'venmo',
      PaidDate: '2026-07-02',
      Note: 'deposit',
    });
  });

  it('allows payments on a PENDING booking (deposits before confirmation)', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A, 'pending');
    expect(await pay(env, TENANT_A, bookingId)).not.toBeNull();
  });

  it('refuses a payment on a cancelled booking', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, bookingId, 'cancelled');
    expect(await pay(env, TENANT_A, bookingId)).toBeNull();
  });

  it('refuses a payment on a blocked sentinel row', async () => {
    const { env } = createTestEnv();
    const blockedId = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: '2030-02-01',
      endDate: '2030-02-03',
      optionKey: null,
      petType: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    expect(await pay(env, TENANT_A, blockedId)).toBeNull();
  });

  it('refuses a cross-tenant payment (booking belongs to another tenant)', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    expect(await pay(env, TENANT_B, bookingId)).toBeNull();
  });

  it('deletePayment is tenant-scoped and requires the matching booking id', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const otherBookingId = await makeBooking(env, TENANT_A);
    const paymentId = (await pay(env, TENANT_A, bookingId))!;
    // Wrong tenant: refused.
    expect(await deletePayment(env.PAWBOOK_DB, TENANT_B, bookingId, paymentId)).toBe(false);
    // Right tenant, WRONG booking id in the pair: refused (404 at the route, never a silent delete).
    expect(await deletePayment(env.PAWBOOK_DB, TENANT_A, otherBookingId, paymentId)).toBe(false);
    // Correct pair: deleted.
    expect(await deletePayment(env.PAWBOOK_DB, TENANT_A, bookingId, paymentId)).toBe(true);
    expect(await listPaymentsForBooking(env.PAWBOOK_DB, TENANT_A, bookingId)).toHaveLength(0);
    // Gone now: a second delete reports false.
    expect(await deletePayment(env.PAWBOOK_DB, TENANT_A, bookingId, paymentId)).toBe(false);
  });

  it('deletePayment works on a cancelled booking (delete is the only correction mechanism)', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const paymentId = (await pay(env, TENANT_A, bookingId))!;
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, bookingId, 'cancelled');
    expect(await deletePayment(env.PAWBOOK_DB, TENANT_A, bookingId, paymentId)).toBe(true);
  });

  it('listPaymentsForBooking returns only that booking, newest paid-date first', async () => {
    const { env } = createTestEnv();
    const bookingId = await makeBooking(env, TENANT_A);
    const otherBookingId = await makeBooking(env, TENANT_A);
    await insertPayment(env.PAWBOOK_DB, TENANT_A, {
      bookingRequestId: bookingId,
      amount: 10,
      method: 'cash',
      paidDate: '2026-06-01',
      note: null,
    });
    await insertPayment(env.PAWBOOK_DB, TENANT_A, {
      bookingRequestId: bookingId,
      amount: 20,
      method: 'zelle',
      paidDate: '2026-07-01',
      note: null,
    });
    await pay(env, TENANT_A, otherBookingId, 999);
    const rows = await listPaymentsForBooking(env.PAWBOOK_DB, TENANT_A, bookingId);
    expect(rows.map((r) => r.Amount)).toEqual([20, 10]);
  });

  it('listBookingsForTenant aggregates PaidTotal (0 when unpaid)', async () => {
    const { env } = createTestEnv();
    const paidId = await makeBooking(env, TENANT_A);
    const unpaidId = await makeBooking(env, TENANT_A);
    await pay(env, TENANT_A, paidId, 30);
    await pay(env, TENANT_A, paidId, 45);
    const rows = await listBookingsForTenant(env.PAWBOOK_DB, TENANT_A);
    expect(rows.find((r) => r.Id === paidId)?.PaidTotal).toBe(75);
    expect(rows.find((r) => r.Id === unpaidId)?.PaidTotal).toBe(0);
  });
});
