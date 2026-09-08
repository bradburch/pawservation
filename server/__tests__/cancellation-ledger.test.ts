import { describe, expect, it, vi } from 'vitest';
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
  insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: null,
    serviceType: over.serviceType ?? 'boarding',
    startDate: over.startDate ?? '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    // CENTS (0015) — `makeBooking` seeds the column directly.
    estCost: over.estCost !== undefined ? over.estCost : 10000,
    status: over.status ?? 'confirmed',
  });

const pay = (env: Env, tenantId: string, bookingRequestId: string, amount: number) =>
  insertPayment(env.PAWSERVATION_DB, tenantId, {
    bookingRequestId,
    amount,
    method: 'cash',
    paidDate: '2026-07-01',
    note: null,
    externalRef: null,
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
      body: JSON.stringify({
        amountCents: 4000,
        method: 'venmo',
        paidDate: '2026-07-11',
        note: null,
      }),
    },
    env,
  );

describe('payment guard on cancelled bookings', () => {
  it('404s recording against a cancelled booking WITHOUT a fee (unchanged behavior)', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'cancelled');
    expect((await postPayment(env, id)).status).toBe(404);
  });

  it('records a payment against a cancelled booking WITH a fee, and lists it', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'cancelled', 80);
    const res = await postPayment(env, id);
    expect(res.status).toBe(201);
    const list = await app.request(
      `/api/sunny-paws/admin/bookings/${id}/payments`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const body = (await list.json()) as { payments: { amountCents: number }[] };
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0]).toMatchObject({ amountCents: 4000 });
  });
});

describe('getAnalytics outstanding includes cancelled-with-fee', () => {
  it('a cancelled booking with fee 100 and 40 paid appears with balance 60; no-fee cancelled excluded; confirmed underpaid still appears', async () => {
    const { env } = createTestEnv();
    // Cancelled WITH a $100 fee, $40 already paid -> owes $60.
    const cancelledWithFee = await makeBooking(env, TENANT_C, { estCost: 250 });
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, cancelledWithFee, 'cancelled', 100);
    await pay(env, TENANT_C, cancelledWithFee, 40);
    // Cancelled WITHOUT a fee -> never outstanding.
    const cancelledNoFee = await makeBooking(env, TENANT_C, { estCost: 200 });
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, cancelledNoFee, 'cancelled');
    // Confirmed underpaid (regression) -> owes $250.
    const confirmedUnderpaid = await makeBooking(env, TENANT_C, { estCost: 300 });
    await pay(env, TENANT_C, confirmedUnderpaid, 50);

    const { outstanding } = await getAnalytics(env.PAWSERVATION_DB, TENANT_C, TODAY);
    // Ordered by balance desc: 250 then 60.
    expect(outstanding.map((o) => o.BookingId)).toEqual([confirmedUnderpaid, cancelledWithFee]);
    expect(outstanding.find((o) => o.BookingId === cancelledWithFee)).toMatchObject({
      EstCost: 100, // the fee stands in for the expected amount
      PaidTotal: 40,
      Status: 'cancelled',
    });
    expect(outstanding.find((o) => o.BookingId === confirmedUnderpaid)).toMatchObject({
      Status: 'confirmed',
    });
    expect(outstanding.some((o) => o.BookingId === cancelledNoFee)).toBe(false);
  });

  it('/admin/analytics marks cancelled-with-fee outstanding rows with isCancellationFee, confirmed rows without', async () => {
    const { env } = createTestEnv();
    const cancelledWithFee = await makeBooking(env, TENANT_C, { estCost: 25000 });
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, cancelledWithFee, 'cancelled', 10000);
    await pay(env, TENANT_C, cancelledWithFee, 4000);
    const confirmedUnderpaid = await makeBooking(env, TENANT_C, { estCost: 30000 });
    await pay(env, TENANT_C, confirmedUnderpaid, 5000);

    const res = await app.request(
      '/api/paws-and-relax/admin/analytics',
      { headers: await adminHeaders(TENANT_C) },
      env,
    );
    const body = (await res.json()) as {
      outstanding: { bookingId: string; isCancellationFee: boolean }[];
    };
    const byId = (id: string) => body.outstanding.find((o) => o.bookingId === id)!;
    expect(byId(cancelledWithFee).isCancellationFee).toBe(true);
    expect(byId(confirmedUnderpaid).isCancellationFee).toBe(false);
  });
});

describe('admin bookings payload carries cancellation fields', () => {
  const getBookings = async (env: Env) =>
    app.request('/api/sunny-paws/admin/bookings', { headers: await adminHeaders(TENANT_A) }, env);

  it('cancelled row carries cancellationFeeCents; confirmed on a tiers service carries numeric feeIfCancelledTodayCents; no-tiers carries null', async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);

    // Confirmed boarding starting tomorrow -> inside the 100% tier -> fee equals estCost.
    const soon = addDays(getPacificDateStr(), 1);
    const confirmedTiers = await makeBooking(env, TENANT_A, {
      serviceType: 'boarding',
      startDate: soon,
      estCost: 10000,
    });
    // Confirmed on a service WITHOUT tiers (walk) -> feeIfCancelledToday null.
    const confirmedNoTiers = await makeBooking(env, TENANT_A, {
      serviceType: 'walk',
      estCost: 6000,
    });
    // Cancelled boarding with a stored $55 fee.
    const cancelled = await makeBooking(env, TENANT_A, { serviceType: 'boarding', estCost: 9000 });
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, cancelled, 'cancelled', 5500);

    const body = (await (await getBookings(env)).json()) as {
      bookings: {
        id: string;
        cancellationFeeCents: number | null;
        feeIfCancelledTodayCents: number | null;
      }[];
    };
    const byId = (id: string) => body.bookings.find((b) => b.id === id)!;

    expect(byId(cancelled)).toMatchObject({
      cancellationFeeCents: 5500,
      feeIfCancelledTodayCents: null,
    });
    expect(byId(confirmedTiers)).toMatchObject({
      cancellationFeeCents: null,
      feeIfCancelledTodayCents: 10000,
    });
    expect(byId(confirmedNoTiers)).toMatchObject({
      cancellationFeeCents: null,
      feeIfCancelledTodayCents: null,
    });
  });

  /**
   * The sitter's side of the same guarantee `/bookings/mine` carries: `cancellationFee` throws on
   * a cost it cannot round to a whole dollar, and this preview is computed for every row of her
   * whole book. One un-roundable row (an un-migrated column, or one written past both cost
   * routes) must report null for itself rather than 500 the list she runs her business from.
   */
  it("an un-roundable cost reports null for THAT row rather than 500ing the sitter's list", async () => {
    const { env, raw } = createTestEnv();
    seedBoardingTiers(raw);
    const soon = addDays(getPacificDateStr(), 1);
    const good = await makeBooking(env, TENANT_A, {
      serviceType: 'boarding',
      startDate: soon,
      estCost: 10000,
    });
    // $455.50: whole cents, not whole dollars.
    const fractional = await makeBooking(env, TENANT_A, {
      serviceType: 'boarding',
      startDate: soon,
      estCost: 45550,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await getBookings(env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bookings: { id: string; feeIfCancelledTodayCents: number | null }[];
    };
    const byId = (id: string) => body.bookings.find((b) => b.id === id)!;
    expect(byId(fractional).feeIfCancelledTodayCents).toBeNull();
    expect(byId(good).feeIfCancelledTodayCents).toBe(10000);
    expect(consoleError).toHaveBeenCalled();
    expect(consoleError.mock.calls[0]).toContain(fractional);
    consoleError.mockRestore();
  });
});
