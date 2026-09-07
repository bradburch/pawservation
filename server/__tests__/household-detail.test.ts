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
  /** CENTS (0015) — this goes straight into the `EstCost` column. */
  estCost: number,
  status: 'pending' | 'confirmed' = 'confirmed',
  startDate = '2030-01-01',
  endDate = '2030-01-03',
) {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_C, {
    endUserId,
    serviceType: 'boarding',
    startDate,
    endDate,
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status,
  });
  await addBookingPets(env.PAWSERVATION_DB, TENANT_C, id, petIds);
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
 * `getHouseholdBalances` sums, and `expectedTotalCents`/`paidTotalCents`/`balanceCents` are literally
 * `getHouseholdBalances`'s own numbers passed through — not a second computation that could drift
 * from the figure the sitter is questioning.
 */
describe('getHouseholdDetail (repo)', () => {
  it('lists every booking with its cost, its charges and its own payments', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    // Distinct start dates: `getHouseholdBalances` orders bookings by (StartDate, Id), and Id is a
    // random UUID — two bookings sharing a date would make the received ORDER (not its content)
    // depend on UUID luck, which is not what this test is checking.
    const b1 = await book(env, jen.Id, [rex], 10000, 'confirmed', '2030-01-01', '2030-01-03');
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: b1,
      amount: 4000,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: b1,
      label: 'Vet visit',
      amount: 4500,
    });
    const b2 = await book(env, jen.Id, [rex], 6000, 'confirmed', '2030-02-01', '2030-02-03');

    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, rex);
    expect(detail).not.toBeNull();
    expect(detail!.bookings).toEqual([
      {
        bookingId: b1,
        serviceType: 'boarding',
        startDate: '2030-01-01',
        endDate: '2030-01-03',
        status: 'confirmed',
        costCents: 10000,
        charges: [{ id: expect.any(String), label: 'Vet visit', amountCents: 4500 }],
        chargesTotalCents: 4500,
        paidTotalCents: 4000,
        expectedCents: 14500,
        outstandingCents: 10500,
      },
      {
        bookingId: b2,
        serviceType: 'boarding',
        startDate: '2030-02-01',
        endDate: '2030-02-03',
        status: 'confirmed',
        costCents: 6000,
        charges: [],
        chargesTotalCents: 0,
        paidTotalCents: 0,
        expectedCents: 6000,
        outstandingCents: 6000,
      },
    ]);
    // Every figure reconciles EXACTLY to the balance above it: ($145 + $60) expected, $40 paid —
    // in CENTS (0015), which is the unit `getHouseholdDetail` returns AND the unit the route
    // publishes, since 0015 renamed every one of these fields `*Cents` rather than dividing.
    expect(detail).toMatchObject({
      expectedTotalCents: 20500,
      paidTotalCents: 4000,
      balanceCents: 16500,
    });
    expect(detail!.bookings.reduce((sum, b) => sum + b.expectedCents, 0)).toBe(
      detail!.expectedTotalCents,
    );
  });

  it('keeps a cancellation fee attributed to its own booking, never merged into the household total', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const cancelled = await book(env, ana.Id, [mia], 20000);
    await env.PAWSERVATION_DB.prepare(
      "UPDATE BookingRequests SET Status = 'cancelled', CancellationFee = 3000 WHERE TenantId = ? AND Id = ?",
    )
      .bind(TENANT_C, cancelled)
      .run();
    const live = await book(env, ana.Id, [mia], 9000);

    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, mia);
    const cancelledRow = detail!.bookings.find((b) => b.bookingId === cancelled)!;
    const liveRow = detail!.bookings.find((b) => b.bookingId === live)!;
    // The $30 fee sits on the cancelled booking, at its own cost figure — never folded into `live`.
    expect(cancelledRow).toMatchObject({
      status: 'cancelled',
      costCents: 3000,
      expectedCents: 3000,
    });
    expect(liveRow).toMatchObject({ status: 'confirmed', costCents: 9000, expectedCents: 9000 });
    expect(detail!.expectedTotalCents).toBe(12000);
  });

  it('shows a household-level payment as household-level, never attributed to one booking', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    const b1 = await book(env, jen.Id, [rex], 5000);
    const b2 = await book(env, jen.Id, [rex], 5000);
    const paymentId = await insertAccountPayment(env.PAWSERVATION_DB, TENANT_C, {
      accountId: rex,
      amount: 10000,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: 'covers both stays',
      externalRef: null,
    });

    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, rex);
    // Neither booking picked up any of the $100 — it lives ONLY in householdPayments.
    for (const b of detail!.bookings) expect(b.paidTotalCents).toBe(0);
    expect(detail!.householdPayments).toEqual([
      {
        id: paymentId,
        amountCents: 10000,
        method: 'venmo',
        paidDate: '2026-07-01',
        note: 'covers both stays',
      },
    ]);
    expect(detail).toMatchObject({
      expectedTotalCents: 10000,
      paidTotalCents: 10000,
      balanceCents: 0,
    });
    expect([b1, b2]).toHaveLength(2); // both bookings exist and are accounted for above
  });

  /**
   * WHAT THIS ONE BOOKING STILL OWES, said by the server rather than subtracted by a caller
   * (design spec §2, "Per-booking outstanding"). Two facts in one fixture, because they only mean
   * anything together:
   *
   *  - A PART-PAID BOOKING. $250 quoted, $87.50 received against THAT booking — the first figure
   *    this ledger can hold that is not a whole number of dollars — leaves $162.50 outstanding on
   *    it. 16250 cents, computed from the same `CREDITABLE_AMOUNT_SQL`/`PAYMENTS_JOIN_SQL` figures
   *    the household balance sums, so the row and the balance above it cannot disagree.
   *  - A HOUSEHOLD PAYMENT MOVES NO BOOKING'S OUTSTANDING. A further $100 recorded against the
   *    HOUSEHOLD lowers the household's balance to $62.50 and leaves the booking at $162.50: a
   *    household payment is deliberately attributed to nothing (0011), and a per-booking figure
   *    that quietly absorbed it would be the invented split this ledger refuses to make.
   */
  it('says what each booking still owes, and leaves it alone when the household pays', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const stay = await book(env, ana.Id, [mia], 25000);
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: stay,
      amount: 8750,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });

    const before = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, mia);
    expect(before!.bookings.find((b) => b.bookingId === stay)).toMatchObject({
      paidTotalCents: 8750,
      expectedCents: 25000,
      outstandingCents: 16250,
    });
    expect(before).toMatchObject({ balanceCents: 16250 });

    await insertAccountPayment(env.PAWSERVATION_DB, TENANT_C, {
      accountId: mia,
      amount: 10000,
      method: 'venmo',
      paidDate: '2026-07-02',
      note: null,
      externalRef: null,
    });

    const after = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, mia);
    expect(after!.bookings.find((b) => b.bookingId === stay)).toMatchObject({
      paidTotalCents: 8750,
      outstandingCents: 16250,
    });
    expect(after).toMatchObject({ balanceCents: 6250 });
  });

  /**
   * A CANCELLED BOOKING WITH NO FEE ASSESSED OWES NOTHING, and an OVER-PAID booking owes nothing
   * either — never a negative. `outstandingCents` is `max(0, expectedCents − paidTotalCents)`: the
   * credit a negative would name is a household-level fact (`balanceCents`, and the Earnings page's
   * own credit list), not something a per-booking "still owes" figure may report as a debt of
   * minus money.
   */
  it('reads zero on a fee-free cancelled booking and never goes negative', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const cancelled = await book(
      env,
      ana.Id,
      [mia],
      20000,
      'confirmed',
      '2030-03-01',
      '2030-03-03',
    );
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: cancelled,
      amount: 5000,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    // Cancelled with NO fee assessed: worth nothing, though $50 was taken against it while live.
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, cancelled, 'cancelled');

    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, mia);
    expect(detail!.bookings.find((b) => b.bookingId === cancelled)).toMatchObject({
      expectedCents: 0,
      paidTotalCents: 5000,
      outstandingCents: 0,
    });
  });

  it('carries no bookings for a household that has only prepaid', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    await insertAccountPayment(env.PAWSERVATION_DB, TENANT_C, {
      accountId: mia,
      amount: 20000,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, mia);
    expect(detail).toMatchObject({
      bookings: [],
      expectedTotalCents: 0,
      paidTotalCents: 20000,
      balanceCents: -20000,
    });
  });

  it('identifies a booking with nothing recorded against it, distinct from one with a partial payment', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const unpaid = await book(env, ana.Id, [mia], 8000);
    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, mia);
    expect(detail!.bookings.find((b) => b.bookingId === unpaid)).toMatchObject({
      paidTotalCents: 0,
    });
  });

  it('returns null for an account id naming no household of this tenant', async () => {
    const { env } = createTestEnv();
    expect(await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, 'p_nonexistent')).toBeNull();
  });

  it('is tenant-isolated: another tenant cannot read this household by its account id', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    await book(env, ana.Id, [mia], 8000);
    expect(await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_A, mia)).toBeNull();
  });

  it('zeroes a declined request entirely, matching the household total it feeds', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const declined = await book(env, ana.Id, [mia], 50000, 'pending');
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: declined,
      amount: 2500,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, declined, 'declined');
    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, mia);
    const row = detail!.bookings.find((b) => b.bookingId === declined)!;
    expect(row).toMatchObject({ status: 'declined', expectedCents: 0 });
    expect(detail!.expectedTotalCents).toBe(0);
    // The $25 was still received; it just isn't billed to anything.
    expect(detail!.paidTotalCents).toBe(2500);
  });
});

describe('GET /:slug/admin/accounts/:accountId (route)', () => {
  it('serves the same figures getHouseholdDetail computes', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    // Seeded through the repo, so in CENTS (0015) — and the RESPONSE below is the same cents,
    // emitted verbatim.
    const bookingId = await book(env, jen.Id, [rex], 10000);
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: bookingId,
      amount: 2500,
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
      bookings: {
        bookingId: string;
        costCents: number;
        paidTotalCents: number;
        outstandingCents: number;
      }[];
      expectedTotalCents: number;
      paidTotalCents: number;
      balanceCents: number;
    };
    // The repo's own cents, emitted verbatim — the route no longer converts anything, so "the same
    // figures" is now literal rather than a division that has to agree.
    expect(body).toMatchObject({
      accountId: rex,
      bookings: [{ bookingId, costCents: 10000, paidTotalCents: 2500, outstandingCents: 7500 }],
      expectedTotalCents: 10000,
      paidTotalCents: 2500,
      balanceCents: 7500,
    });
  });

  /** Every money field on this payload names its unit, and the dollar-named twin is GONE rather
   *  than kept alongside — the same removal the customer's own `/:slug/account` made, on the
   *  sitter's half of the very same row. */
  it('names every money field in cents, with no dollar-named twin left', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    // $100.50 owed, $25.50 received against the booking and $10 against the household: three
    // figures no dollar-shaped wire could have carried, on one statement.
    const bookingId = await book(env, jen.Id, [rex], 10050);
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: bookingId,
      amount: 2550,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    await insertAccountPayment(env.PAWSERVATION_DB, TENANT_C, {
      accountId: rex,
      amount: 1000,
      method: 'venmo',
      paidDate: '2026-07-02',
      note: null,
      externalRef: null,
    });
    const res = await app.request(
      `/api/${SLUG_C}/admin/accounts/${rex}`,
      { headers: await adminHeaders(TENANT_C) },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      bookings: Record<string, unknown>[];
      householdPayments: Record<string, unknown>[];
    };
    expect(body).toMatchObject({
      bookings: [
        {
          bookingId,
          costCents: 10050,
          chargesTotalCents: 0,
          paidTotalCents: 2550,
          expectedCents: 10050,
          // The $10 household payment took the BALANCE to $65, and left this stay at $75.
          outstandingCents: 7500,
        },
      ],
      householdPayments: [expect.objectContaining({ amountCents: 1000 })],
      expectedTotalCents: 10050,
      paidTotalCents: 3550,
      balanceCents: 6500,
    });
    for (const gone of ['expectedTotal', 'paidTotal', 'balance'])
      expect(body).not.toHaveProperty(gone);
    for (const gone of ['cost', 'chargesTotal', 'paidTotal', 'expected'])
      expect(body.bookings[0]).not.toHaveProperty(gone);
    expect(body.householdPayments[0]).not.toHaveProperty('amount');
  });

  it('401s without a token and 404s an account id this tenant does not own', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
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
