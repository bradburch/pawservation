import { describe, expect, it } from 'vitest';
import {
  addBookingPets,
  getHouseholdDetail,
  insertBookingCharge,
  insertBookingRequest,
  insertInvitedCustomer,
  insertAccountPayment,
  insertPayment,
  updateBookingStatus,
} from '../db/repo';
import { adminHeaders, createTestEnv, seedPets, TENANT_A } from './helpers';
import app from '../index';

const TENANT_C = 'tnt_pawsandrelax'; // clean-slate tenant: customers, no bookings
const SLUG_C = 'paws-and-relax';

async function book(
  env: Env,
  endUserId: string,
  petIds: string[],
  estCost: number,
  status: 'pending' | 'confirmed' = 'confirmed',
  startDate = '2030-01-01',
  endDate = '2030-01-03',
) {
  const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_C, {
    endUserId,
    serviceType: 'boarding',
    startDate,
    endDate,
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status,
  });
  await addBookingPets(env.PAWBOOK_DB, TENANT_C, id, petIds);
  return id;
}

/**
 * Story 2.4 — BOOKING DETAIL BENEATH THE HOUSEHOLD BALANCE (FR-7c). `getHouseholdBalances` answers
 * "does this household owe money"; this is the drill-down that answers "what is that number made
 * of" — every booking, its cost, its extra charges, and every payment, with a cancellation fee
 * staying on ITS booking and a household-level payment staying at the household rather than being
 * pinned to whichever booking happened to be open.
 *
 * Every figure here is read from the SAME `CREDITABLE_AMOUNT_SQL`/`PAYMENTS_JOIN_SQL` expressions
 * `getHouseholdBalances` sums, and `expectedTotal`/`paidTotal`/`balance` are literally
 * `getHouseholdBalances`'s own numbers passed through — not a second computation that could drift
 * from the figure the sitter is questioning.
 */
describe('getHouseholdDetail (repo)', () => {
  it('lists every booking with its cost, its charges and its own payments', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'jen@example.com', 'Jen');
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    // Distinct start dates: `getHouseholdBalances` orders bookings by (StartDate, Id), and Id is a
    // random UUID — two bookings sharing a date would make the received ORDER (not its content)
    // depend on UUID luck, which is not what this test is checking.
    const b1 = await book(env, jen.Id, [rex], 100, 'confirmed', '2030-01-01', '2030-01-03');
    await insertPayment(env.PAWBOOK_DB, TENANT_C, {
      bookingRequestId: b1,
      amount: 40,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    await insertBookingCharge(env.PAWBOOK_DB, TENANT_C, {
      bookingRequestId: b1,
      label: 'Vet visit',
      amount: 45,
    });
    const b2 = await book(env, jen.Id, [rex], 60, 'confirmed', '2030-02-01', '2030-02-03');

    const detail = await getHouseholdDetail(env.PAWBOOK_DB, TENANT_C, rex);
    expect(detail).not.toBeNull();
    expect(detail!.bookings).toEqual([
      {
        bookingId: b1,
        serviceType: 'boarding',
        startDate: '2030-01-01',
        status: 'confirmed',
        cost: 100,
        charges: [{ id: expect.any(String), label: 'Vet visit', amount: 45 }],
        chargesTotal: 45,
        paidTotal: 40,
        expected: 145,
      },
      {
        bookingId: b2,
        serviceType: 'boarding',
        startDate: '2030-02-01',
        status: 'confirmed',
        cost: 60,
        charges: [],
        chargesTotal: 0,
        paidTotal: 0,
        expected: 60,
      },
    ]);
    // Every figure reconciles EXACTLY to the balance above it: (145 + 60) expected, 40 paid.
    expect(detail).toMatchObject({ expectedTotal: 205, paidTotal: 40, balance: 165 });
    expect(detail!.bookings.reduce((sum, b) => sum + b.expected, 0)).toBe(detail!.expectedTotal);
  });

  it('keeps a cancellation fee attributed to its own booking, never merged into the household total', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const cancelled = await book(env, ana.Id, [mia], 200);
    await env.PAWBOOK_DB.prepare(
      "UPDATE BookingRequests SET Status = 'cancelled', CancellationFee = 30 WHERE TenantId = ? AND Id = ?",
    )
      .bind(TENANT_C, cancelled)
      .run();
    const live = await book(env, ana.Id, [mia], 90);

    const detail = await getHouseholdDetail(env.PAWBOOK_DB, TENANT_C, mia);
    const cancelledRow = detail!.bookings.find((b) => b.bookingId === cancelled)!;
    const liveRow = detail!.bookings.find((b) => b.bookingId === live)!;
    // The $30 fee sits on the cancelled booking, at its own cost figure — never folded into `live`.
    expect(cancelledRow).toMatchObject({ status: 'cancelled', cost: 30, expected: 30 });
    expect(liveRow).toMatchObject({ status: 'confirmed', cost: 90, expected: 90 });
    expect(detail!.expectedTotal).toBe(120);
  });

  it('shows a household-level payment as household-level, never attributed to one booking', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'jen@example.com', 'Jen');
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    const b1 = await book(env, jen.Id, [rex], 50);
    const b2 = await book(env, jen.Id, [rex], 50);
    const paymentId = await insertAccountPayment(env.PAWBOOK_DB, TENANT_C, {
      accountId: rex,
      amount: 100,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: 'covers both stays',
      externalRef: null,
    });

    const detail = await getHouseholdDetail(env.PAWBOOK_DB, TENANT_C, rex);
    // Neither booking picked up any of the $100 — it lives ONLY in householdPayments.
    for (const b of detail!.bookings) expect(b.paidTotal).toBe(0);
    expect(detail!.householdPayments).toEqual([
      {
        id: paymentId,
        amount: 100,
        method: 'venmo',
        paidDate: '2026-07-01',
        note: 'covers both stays',
      },
    ]);
    expect(detail).toMatchObject({ expectedTotal: 100, paidTotal: 100, balance: 0 });
    expect([b1, b2]).toHaveLength(2); // both bookings exist and are accounted for above
  });

  it('carries no bookings for a household that has only prepaid', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    await insertAccountPayment(env.PAWBOOK_DB, TENANT_C, {
      accountId: mia,
      amount: 200,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    const detail = await getHouseholdDetail(env.PAWBOOK_DB, TENANT_C, mia);
    expect(detail).toMatchObject({ bookings: [], expectedTotal: 0, paidTotal: 200, balance: -200 });
  });

  it('identifies a booking with nothing recorded against it, distinct from one with a partial payment', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const unpaid = await book(env, ana.Id, [mia], 80);
    const detail = await getHouseholdDetail(env.PAWBOOK_DB, TENANT_C, mia);
    expect(detail!.bookings.find((b) => b.bookingId === unpaid)).toMatchObject({ paidTotal: 0 });
  });

  it('returns null for an account id naming no household of this tenant', async () => {
    const { env } = createTestEnv();
    expect(await getHouseholdDetail(env.PAWBOOK_DB, TENANT_C, 'p_nonexistent')).toBeNull();
  });

  it('is tenant-isolated: another tenant cannot read this household by its account id', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    await book(env, ana.Id, [mia], 80);
    expect(await getHouseholdDetail(env.PAWBOOK_DB, TENANT_A, mia)).toBeNull();
  });

  it('zeroes a declined request entirely, matching the household total it feeds', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const declined = await book(env, ana.Id, [mia], 500, 'pending');
    await insertPayment(env.PAWBOOK_DB, TENANT_C, {
      bookingRequestId: declined,
      amount: 25,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    await updateBookingStatus(env.PAWBOOK_DB, TENANT_C, declined, 'declined');
    const detail = await getHouseholdDetail(env.PAWBOOK_DB, TENANT_C, mia);
    const row = detail!.bookings.find((b) => b.bookingId === declined)!;
    expect(row).toMatchObject({ status: 'declined', expected: 0 });
    expect(detail!.expectedTotal).toBe(0);
    expect(detail!.paidTotal).toBe(25); // the $25 was still received; it just isn't billed to anything
  });
});

describe('GET /:slug/admin/accounts/:accountId (route)', () => {
  it('serves the same figures getHouseholdDetail computes', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'jen@example.com', 'Jen');
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    const bookingId = await book(env, jen.Id, [rex], 100);
    await insertPayment(env.PAWBOOK_DB, TENANT_C, {
      bookingRequestId: bookingId,
      amount: 25,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    const res = await app.request(
      `/api/${SLUG_C}/admin/accounts/${rex}`,
      { headers: await adminHeaders(TENANT_C) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accountId: string;
      bookings: { bookingId: string; cost: number; paidTotal: number }[];
      expectedTotal: number;
      paidTotal: number;
      balance: number;
    };
    expect(body).toMatchObject({
      accountId: rex,
      bookings: [{ bookingId, cost: 100, paidTotal: 25 }],
      expectedTotal: 100,
      paidTotal: 25,
      balance: 75,
    });
  });

  it('401s without a token and 404s an account id this tenant does not own', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const anon = await app.request(`/api/${SLUG_C}/admin/accounts/${mia}`, {}, env);
    expect(anon.status).toBe(401);
    const missing = await app.request(
      `/api/${SLUG_C}/admin/accounts/p_nonexistent`,
      { headers: await adminHeaders(TENANT_C) },
      env,
    );
    expect(missing.status).toBe(404);
  });
});
