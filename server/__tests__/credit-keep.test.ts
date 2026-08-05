import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  getAnalytics,
  insertBookingCharge,
  insertBookingRequest,
  insertPayment,
  listChargesForBooking,
  listPaymentsForBooking,
  updateBookingStatus,
} from '../db/repo';
import { serializeAnalytics } from '../lib/analytics';
import { adminHeaders, createTestEnv, TENANT_A, TENANT_B } from './helpers';

/**
 * CLOSING OUT AN OVER-PAYMENT.
 *
 * The credit itself is only a display: `CREDIT_WHERE_SQL` surfaces money the client no longer owes,
 * and until now it displayed forever with no way to resolve it. Two things resolve one in real life,
 * and the two must be kept apart because they mean opposite things about the sitter's revenue:
 *
 *  1. **The money went back.** Correct the payment ledger (`DELETE /payments/:id`, then re-record
 *     what was actually kept). Revenue must fall, and it does — every earnings figure sums Payments.
 *  2. **The client agreed she keeps it** (toward the next stay, a tip, a rounding). The money really
 *     was received, so revenue must NOT move; what changes is what this booking is owed. That is a
 *     `BookingCharges` row, and `POST /credit/keep` is the one place that writes it — with the amount
 *     computed IN SQL from the same expressions the Earnings page displays the credit with, so the
 *     figure can never disagree with the figure she was shown and is never client-supplied (the same
 *     doctrine as the cancellation fee).
 *
 * `insertPayment`'s guard and `OUTSTANDING_WHERE_SQL` must agree in both directions; this is the
 * mirror of that rule, on the credit side. Every action the Earnings page offers on a credit row has
 * to actually CLOSE it — which is why a DECLINED booking (`Keepable` is 0 by rule, and a charge
 * cannot raise it) refuses the keep path outright and the payload says so up front (`canKeep`).
 */

const TODAY = '2026-07-15';
const SLUG_A = 'sunny-paws';

const makeBooking = (
  env: Env,
  tenantId: string,
  estCost: number,
  status: 'confirmed' | 'pending' = 'confirmed',
) =>
  insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: null,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status,
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

const keep = async (env: Env, slug: string, tenantId: string, bookingId: string, body?: unknown) =>
  app.request(
    `/api/${slug}/admin/bookings/${bookingId}/credit/keep`,
    {
      method: 'POST',
      headers: { ...(await adminHeaders(tenantId)), 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );

const creditsOf = async (env: Env, tenantId: string) =>
  serializeAnalytics(await getAnalytics(env.PAWSERVATION_DB, tenantId, TODAY)).credits;

describe('POST /admin/bookings/:id/credit/keep', () => {
  it('closes the credit by logging exactly the displayed amount as a charge', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 250);
    expect(await creditsOf(env, TENANT_A)).toMatchObject([{ bookingId: id, credit: 150 }]);

    const res = await keep(env, SLUG_A, TENANT_A, id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kept: 150 });

    // The charge carries the figure she was shown…
    const charges = await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, id);
    expect(charges.map((c) => ({ Label: c.Label, Amount: c.Amount }))).toEqual([
      { Label: 'Overpayment kept', Amount: 150 },
    ]);
    // …the credit is gone, and the booking is NOT now outstanding either: 250 owed, 250 paid.
    const after = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(after.credits).toEqual([]);
    expect(after.outstanding.find((o) => o.BookingId === id)).toBeUndefined();
    // Revenue is untouched — the money really was received and really was kept.
    expect(serializeAnalytics(after).ytd).toBe(250);
  });

  it('the amount is computed server-side: a body asking for more is ignored', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 250);
    const res = await keep(env, SLUG_A, TENANT_A, id, { amount: 9999, kept: 9999 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kept: 150 });
    const charges = await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, id);
    expect(charges.map((c) => c.Amount)).toEqual([150]);
  });

  it('counts existing charges, so the two sides agree on what is left over', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 250);
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: id,
      label: 'Vet visit',
      amount: 45,
    });
    expect(await creditsOf(env, TENANT_A)).toMatchObject([{ bookingId: id, credit: 105 }]);
    expect(await (await keep(env, SLUG_A, TENANT_A, id)).json()).toEqual({ kept: 105 });
    expect(await creditsOf(env, TENANT_A)).toEqual([]);
  });

  it('refuses a booking with no credit, and writes nothing', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 60);
    const res = await keep(env, SLUG_A, TENANT_A, id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('not in credit');
    expect(await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, id)).toEqual([]);
  });

  it('refuses a DECLINED request: it may keep nothing, so a charge could not close it', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 250, 'pending');
    await pay(env, TENANT_A, id, 100);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'declined');
    const res = await keep(env, SLUG_A, TENANT_A, id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error.toLowerCase()).toContain('declined');
    expect(await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, id)).toEqual([]);
    // …and the row itself says so, so the UI never offers the button in the first place.
    expect(await creditsOf(env, TENANT_A)).toMatchObject([{ bookingId: id, canKeep: false }]);
  });

  it('every OTHER credit row advertises the keep path, because it really does close it', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 250);
    expect(await creditsOf(env, TENANT_A)).toMatchObject([{ bookingId: id, canKeep: true }]);
  });

  it('the refund path is what closes a declined deposit: delete the payment', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 250, 'pending');
    const paymentId = await pay(env, TENANT_A, id, 100);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, id, 'declined');
    const res = await app.request(
      `/api/${SLUG_A}/admin/bookings/${id}/payments/${paymentId}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(204);
    expect(await creditsOf(env, TENANT_A)).toEqual([]);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_A, id)).toEqual([]);
  });

  it('is reversible: deleting the charge re-opens the credit', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 250);
    await keep(env, SLUG_A, TENANT_A, id);
    const [charge] = await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, id);
    const res = await app.request(
      `/api/${SLUG_A}/admin/bookings/${id}/charges/${charge.Id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(204);
    expect(await creditsOf(env, TENANT_A)).toMatchObject([{ bookingId: id, credit: 150 }]);
  });

  it('is not repeatable: the second call has nothing left to close', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 250);
    expect((await keep(env, SLUG_A, TENANT_A, id)).status).toBe(200);
    expect((await keep(env, SLUG_A, TENANT_A, id)).status).toBe(409);
    expect((await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, id)).length).toBe(1);
  });

  it("another tenant's booking id is a 404 and writes nothing", async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 250);
    const res = await keep(env, 'happy-tails', TENANT_B, id);
    expect(res.status).toBe(404);
    expect(await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, id)).toEqual([]);
    expect(await creditsOf(env, TENANT_A)).toMatchObject([{ bookingId: id, credit: 150 }]);
  });

  it('an unknown booking id is a 404', async () => {
    const { env } = createTestEnv();
    expect((await keep(env, SLUG_A, TENANT_A, 'nope')).status).toBe(404);
  });

  it('requires the sitter session', async () => {
    const { env } = createTestEnv();
    const id = await makeBooking(env, TENANT_A, 100);
    await pay(env, TENANT_A, id, 250);
    const res = await app.request(
      `/api/${SLUG_A}/admin/bookings/${id}/credit/keep`,
      { method: 'POST' },
      env,
    );
    expect(res.status).toBe(401);
  });
});
