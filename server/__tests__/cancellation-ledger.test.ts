import { describe, expect, it } from 'vitest';
import { getAnalytics, insertBookingRequest, insertPayment, updateBookingStatus } from '../db/repo';
import { adminHeaders, createTestEnv, TENANT_A } from './helpers';
import app from '../index';
import { addDays, getPacificDateStr } from '../../src/shared/index.js';
import type { DatabaseSync } from 'node:sqlite';

// paws-and-relax: seeded customers but NO bookings, so outstanding assertions are exact.
const TENANT_C = 'tnt_pawsandrelax';
// Fixed anchor for the repo-level analytics test — window is 2025-08 .. 2026-07.
const TODAY = '2026-07-15';

const makeBooking = (
  env: Env,
  tenantId: string,
  over: {
    serviceType?: string;
    startDate?: string;
    estCost?: number | null;
    status?: 'pending' | 'confirmed';
  } = {},
) =>
  insertBookingRequest(env.PAWBOOK_DB, tenantId, {
    endUserId: null,
    serviceType: over.serviceType ?? 'boarding',
    startDate: over.startDate ?? '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petType: 'dog',
    petCount: 1,
    estCost: over.estCost !== undefined ? over.estCost : 100,
    status: over.status ?? 'confirmed',
  });

const pay = (env: Env, tenantId: string, bookingRequestId: string, amount: number) =>
  insertPayment(env.PAWBOOK_DB, tenantId, {
    bookingRequestId,
    amount,
    method: 'cash',
    paidDate: '2026-07-01',
    note: null,
  });

/** Seeds a two-tier cancellation policy on sunny-paws' boarding service. */
function seedBoardingTiers(raw: DatabaseSync): void {
  raw.exec(
    `UPDATE TenantServices SET CancellationTiers =
       '[{"withinDays":2,"percent":100},{"withinDays":7,"percent":50}]'
     WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'boarding'`,
  );
}

const postPayment = async (env: Env, bookingId: string) =>
  app.request(
    `/api/sunny-paws/admin/bookings/${bookingId}/payments`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 40, method: 'venmo', paidDate: '2026-07-11', note: null }),
    },
    env,
  );

describe('payment guard on cancelled bookings', () => {
  it('404s recording against a cancelled booking WITHOUT a fee (unchanged behavior)', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A);
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'cancelled');
    expect((await postPayment(env, id)).status).toBe(404);
  });

  it('records a payment against a cancelled booking WITH a fee, and lists it', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A);
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, id, 'cancelled', 80);
    const res = await postPayment(env, id);
    expect(res.status).toBe(201);
    const list = await app.request(
      `/api/sunny-paws/admin/bookings/${id}/payments`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const body = (await list.json()) as { payments: { amount: number }[] };
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ amount: 40 });
  });
});

describe('getAnalytics outstanding includes cancelled-with-fee', () => {
  it('a cancelled booking with fee 100 and 40 paid appears with balance 60; no-fee cancelled excluded; confirmed underpaid still appears', async () => {
    const { env } = createTestEnv();
    // Cancelled WITH a $100 fee, $40 already paid -> owes $60.
    const cancelledWithFee = await makeBooking(env, TENANT_C, { estCost: 250 });
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_C, cancelledWithFee, 'cancelled', 100);
    await pay(env, TENANT_C, cancelledWithFee, 40);
    // Cancelled WITHOUT a fee -> never outstanding.
    const cancelledNoFee = await makeBooking(env, TENANT_C, { estCost: 200 });
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_C, cancelledNoFee, 'cancelled');
    // Confirmed underpaid (regression) -> owes $250.
    const confirmedUnderpaid = await makeBooking(env, TENANT_C, { estCost: 300 });
    await pay(env, TENANT_C, confirmedUnderpaid, 50);

    const { outstanding } = await getAnalytics(env.PAWBOOK_DB, TENANT_C, TODAY);
    // Ordered by balance desc: 250 then 60.
    expect(outstanding.map((o) => o.BookingId)).toEqual([confirmedUnderpaid, cancelledWithFee]);
    expect(outstanding.find((o) => o.BookingId === cancelledWithFee)).toMatchObject({
      EstCost: 100, // the fee stands in for the expected amount
      PaidTotal: 40,
    });
    expect(outstanding.some((o) => o.BookingId === cancelledNoFee)).toBe(false);
  });
});

describe('admin bookings payload carries cancellation fields', () => {
  const getBookings = async (env: Env) =>
    app.request('/api/sunny-paws/admin/bookings', { headers: await adminHeaders(TENANT_A) }, env);

  it('cancelled row carries cancellationFee; confirmed on a tiers service carries numeric feeIfCancelledToday; no-tiers carries null', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);

    // Confirmed boarding starting tomorrow -> inside the 100% tier -> fee equals estCost.
    const soon = addDays(getPacificDateStr(), 1);
    const confirmedTiers = await makeBooking(env, TENANT_A, {
      serviceType: 'boarding',
      startDate: soon,
      estCost: 100,
    });
    // Confirmed on a service WITHOUT tiers (walk) -> feeIfCancelledToday null.
    const confirmedNoTiers = await makeBooking(env, TENANT_A, {
      serviceType: 'walk',
      estCost: 60,
    });
    // Cancelled boarding with a stored $55 fee.
    const cancelled = await makeBooking(env, TENANT_A, { serviceType: 'boarding', estCost: 90 });
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_A, cancelled, 'cancelled', 55);

    const body = (await (await getBookings(env)).json()) as {
      bookings: {
        id: string;
        cancellationFee: number | null;
        feeIfCancelledToday: number | null;
      }[];
    };
    const byId = (id: string) => body.bookings.find((b) => b.id === id)!;

    expect(byId(cancelled)).toMatchObject({ cancellationFee: 55, feeIfCancelledToday: null });
    expect(byId(confirmedTiers)).toMatchObject({ cancellationFee: null, feeIfCancelledToday: 100 });
    expect(byId(confirmedNoTiers)).toMatchObject({
      cancellationFee: null,
      feeIfCancelledToday: null,
    });
  });
});
