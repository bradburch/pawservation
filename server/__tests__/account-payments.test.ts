import { describe, expect, it } from 'vitest';
import {
  addBookingPets,
  addPetOwner,
  deleteAccountPayment,
  getHouseholdBalances,
  insertAccountPayment,
  insertBookingRequest,
  insertInvitedCustomer,
  insertPayment,
  listPaymentsForAccount,
  listPaymentsForBooking,
} from '../db/repo';
import { adminHeaders, createTestEnv, seedPets, TENANT_A, TENANT_B } from './helpers';
import app from '../index';

const TENANT_C = 'tnt_pawsandrelax'; // seeded clean slate: customers, no bookings
const SLUG_C = 'paws-and-relax';

/**
 * Story 2.2 — ONE PAYMENT, ONE ROW, AGAINST THE HOUSEHOLD. A client who pays monthly writes one
 * cheque covering eight bookings; the sitter must never be asked to carve it into eight amounts
 * nobody agreed to.
 */
async function household(env: Env, raw: Parameters<typeof seedPets>[0]) {
  const jen = await insertInvitedCustomer(env.PAWSERVATION_DB, TENANT_C, 'jen@example.com', 'Jen');
  const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
  return { jen, accountId: rex };
}

async function book(env: Env, endUserId: string, petIds: string[], estCost: number) {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_C, {
    endUserId,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status: 'confirmed',
  });
  await addBookingPets(env.PAWSERVATION_DB, TENANT_C, id, petIds);
  return id;
}

const accountPayment = (env: Env, tenantId: string, accountId: string, amount: number) =>
  insertAccountPayment(env.PAWSERVATION_DB, tenantId, {
    accountId,
    amount,
    method: 'venmo',
    paidDate: '2026-07-01',
    note: null,
    externalRef: null,
  });

describe('account payments (repo)', () => {
  it('stores ONE row for a payment covering several bookings, and counts it once', async () => {
    const { env, raw } = createTestEnv();
    const { jen, accountId } = await household(env, raw);
    const bookings = [];
    for (let i = 0; i < 8; i++) bookings.push(await book(env, jen.Id, [accountId], 50));

    const paymentId = await accountPayment(env, TENANT_C, accountId, 400);
    expect(paymentId).not.toBeNull();

    // ONE row — no split across the eight bookings, and none of them acquired a payment of its own.
    const rows = await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_C, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Id: paymentId, Amount: 400, BookingRequestId: null });
    for (const bookingId of bookings) {
      expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, bookingId)).toEqual([]);
    }

    // The household balance reflects the $400 exactly once: 8 × $50 owed, $400 received.
    const [balance] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(balance).toMatchObject({ expectedTotal: 400, paidTotal: 400, balance: 0 });
  });

  it('adds to whatever was already paid per booking, never replacing it', async () => {
    const { env, raw } = createTestEnv();
    const { jen, accountId } = await household(env, raw);
    const bookingId = await book(env, jen.Id, [accountId], 300);
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: bookingId,
      amount: 100,
      method: 'cash',
      paidDate: '2026-06-01',
      note: null,
      externalRef: null,
    });
    await accountPayment(env, TENANT_C, accountId, 150);
    const [balance] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(balance).toMatchObject({ expectedTotal: 300, paidTotal: 250, balance: 50 });
  });

  it('lands on the household even when the account id names a co-owned pet', async () => {
    const { env, raw } = createTestEnv();
    const { jen, accountId } = await household(env, raw);
    const sam = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'sam@example.com',
      'Sam',
    );
    await addPetOwner(env.PAWSERVATION_DB, TENANT_C, accountId, sam.Id);
    await book(env, jen.Id, [accountId], 100);
    await accountPayment(env, TENANT_C, accountId, 60);
    const households = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(households).toHaveLength(1); // still one household, one balance
    expect(households[0]).toMatchObject({ paidTotal: 60, balance: 40 });
  });

  it('leaves a household that has only prepaid in credit, with no booking yet', async () => {
    const { env, raw } = createTestEnv();
    const { accountId } = await household(env, raw);
    await accountPayment(env, TENANT_C, accountId, 200);
    const [balance] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(balance).toMatchObject({ expectedTotal: 0, paidTotal: 200, balance: -200 });
  });

  it('refuses an account id belonging to another tenant, and stays invisible to it', async () => {
    const { env, raw } = createTestEnv();
    const { accountId } = await household(env, raw);
    // TENANT_A cannot pay into TENANT_C's household…
    expect(await accountPayment(env, TENANT_A, accountId, 100)).toBeNull();
    // …nor can an id that is no pet at all.
    expect(await accountPayment(env, TENANT_C, 'p_nonexistent', 100)).toBeNull();
    await accountPayment(env, TENANT_C, accountId, 100);
    expect(await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_A, accountId)).toEqual([]);
    // TENANT_B has households of its own (seed.sql), and not a dollar of C's money is in them.
    const otherTenant = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_B);
    expect(otherTenant.some((h) => h.accountId === accountId)).toBe(false);
    expect(otherTenant.reduce((sum, h) => sum + h.paidTotal, 0)).toBe(0);
  });

  it('deleting a household payment is tenant-scoped and needs the matching account id', async () => {
    const { env, raw } = createTestEnv();
    const { accountId } = await household(env, raw);
    const other = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, other.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const paymentId = (await accountPayment(env, TENANT_C, accountId, 100))!;
    expect(await deleteAccountPayment(env.PAWSERVATION_DB, TENANT_A, accountId, paymentId)).toBe(
      false,
    );
    expect(await deleteAccountPayment(env.PAWSERVATION_DB, TENANT_C, mia, paymentId)).toBe(false);
    expect(await deleteAccountPayment(env.PAWSERVATION_DB, TENANT_C, accountId, paymentId)).toBe(
      true,
    );
    expect(await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_C, accountId)).toEqual([]);
    expect(await deleteAccountPayment(env.PAWSERVATION_DB, TENANT_C, accountId, paymentId)).toBe(
      false,
    );
  });
});

describe('account payments (admin routes)', () => {
  const post = async (env: Env, tenantId: string, accountId: string, body: unknown) =>
    app.request(
      `/api/${SLUG_C}/admin/accounts/${accountId}/payments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await adminHeaders(tenantId)) },
        body: JSON.stringify(body),
      },
      env,
    );

  const valid = { amount: 400, method: 'venmo', paidDate: '2026-07-01' };

  it('records one payment against the household and reports the new balance', async () => {
    const { env, raw } = createTestEnv();
    const { jen, accountId } = await household(env, raw);
    await book(env, jen.Id, [accountId], 250);
    const res = await post(env, TENANT_C, accountId, { ...valid, amount: 100, note: 'July' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: {
        id: string;
        amount: number;
        method: string;
        paidDate: string;
        note: string | null;
      };
      balance: number;
    };
    expect(body.payment).toMatchObject({ amount: 100, method: 'venmo', note: 'July' });
    expect(body.balance).toBe(150); // computed server-side, never sent by the client
  });

  it('lists and deletes household payments', async () => {
    const { env, raw } = createTestEnv();
    const { accountId } = await household(env, raw);
    const created = (await (await post(env, TENANT_C, accountId, valid)).json()) as {
      payment: { id: string };
    };
    const listed = await app.request(
      `/api/${SLUG_C}/admin/accounts/${accountId}/payments`,
      { headers: await adminHeaders(TENANT_C) },
      env,
    );
    expect(((await listed.json()) as { payments: { id: string }[] }).payments).toHaveLength(1);
    const del = await app.request(
      `/api/${SLUG_C}/admin/accounts/${accountId}/payments/${created.payment.id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_C) },
      env,
    );
    expect(del.status).toBe(204);
    expect(await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_C, accountId)).toEqual([]);
  });

  it('401s without a token and 404s an account this tenant does not own', async () => {
    const { env, raw } = createTestEnv();
    const { accountId } = await household(env, raw);
    const anon = await app.request(
      `/api/${SLUG_C}/admin/accounts/${accountId}/payments`,
      { method: 'POST', body: JSON.stringify(valid) },
      env,
    );
    expect(anon.status).toBe(401);
    expect((await post(env, TENANT_C, 'p_nonexistent', valid)).status).toBe(404);
  });

  it('validates the amount, the method and the date the way the booking route does', async () => {
    const { env, raw } = createTestEnv();
    const { accountId } = await household(env, raw);
    expect((await post(env, TENANT_C, accountId, { ...valid, amount: 0 })).status).toBe(400);
    expect((await post(env, TENANT_C, accountId, { ...valid, amount: 12.5 })).status).toBe(400);
    expect((await post(env, TENANT_C, accountId, { ...valid, method: 'bitcoin' })).status).toBe(
      400,
    );
    expect(
      (await post(env, TENANT_C, accountId, { ...valid, paidDate: '2026-13-40' })).status,
    ).toBe(400);
  });
});
