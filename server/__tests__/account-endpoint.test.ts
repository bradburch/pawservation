import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  addBookingPets,
  addPetOwner,
  insertAccountPayment,
  insertBookingRequest,
  insertInvitedCustomer,
  insertPayment,
} from '../db/repo';
import { mintToken } from '../lib/token';
import { createTestEnv, endUserToken, seedPets, TENANT_A, TENANT_B, TEST_SECRET } from './helpers';

type AccountBody = {
  accountId: string | null;
  bookings: {
    bookingId: string;
    costCents: number;
    expectedCents: number;
    paidTotalCents: number;
  }[];
  householdPayments: { id: string; amountCents: number }[];
  expectedTotalCents: number;
  paidTotalCents: number;
  balanceCents: number;
};

const book = (
  env: Env,
  tenantId: string,
  endUserId: string,
  petIds: string[],
  /** CENTS (0015) — a repo seed writes the column directly, and the route answers in cents too. */
  estCost: number,
  status: 'pending' | 'confirmed' = 'confirmed',
) =>
  insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status,
  }).then(async (id) => {
    await addBookingPets(env.PAWSERVATION_DB, tenantId, id, petIds);
    return id;
  });

/**
 * GET /:slug/account — the customer's own household balance (buildHouseholdBalances, reused
 * verbatim from getHouseholdDetail/getAccountIdsByOwner, the same computation the admin dashboard
 * reads). Story: a signed-in customer can already see their bookings but had no way to see what
 * they OWE, even though the household balance computation existed all along.
 */
describe('GET /:slug/account', () => {
  it('returns the caller own household balance, matching the bookings and payments behind it', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_A, jen.Id, [{ id: 'p_rex_acct', petType: 'dog' }]);
    const bookingId = await book(env, TENANT_A, jen.Id, [rex], 10000);
    await insertPayment(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: bookingId,
      amount: 2500,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    const token = await endUserToken(env, 'sunny-paws', 'jen@example.com');

    const res = await app.request(
      '/api/sunny-paws/account',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountBody;
    expect(body).toMatchObject({
      accountId: rex,
      bookings: [{ bookingId, costCents: 10000, expectedCents: 10000, paidTotalCents: 2500 }],
      expectedTotalCents: 10000,
      paidTotalCents: 2500,
      balanceCents: 7500,
    });
  });

  /** The statement says its unit (design spec §2): every money field is `*Cents`, and the
   *  dollar-named field is GONE rather than kept alongside, so a reader cannot keep treating a
   *  renamed figure as dollars. */
  it('names every money field in cents, and carries no dollar-named twin', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_A, jen.Id, [{ id: 'p_rex_cents', petType: 'dog' }]);
    const bookingId = await book(env, TENANT_A, jen.Id, [rex], 10050);
    await insertPayment(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: bookingId,
      amount: 2550,
      method: 'cash',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    const token = await endUserToken(env, 'sunny-paws', 'jen@example.com');

    const res = await app.request(
      '/api/sunny-paws/account',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & {
      bookings: Record<string, unknown>[];
    };
    expect(body).toMatchObject({
      accountId: rex,
      bookings: [{ bookingId, costCents: 10050, expectedCents: 10050, paidTotalCents: 2550 }],
      expectedTotalCents: 10050,
      paidTotalCents: 2550,
      balanceCents: 7500,
    });
    expect(body.balance).toBeUndefined();
    expect(body.paidTotal).toBeUndefined();
    expect(body.expectedTotal).toBeUndefined();
    expect(body.bookings[0].cost).toBeUndefined();
    expect(body.bookings[0].expected).toBeUndefined();
    expect(body.bookings[0].paidTotal).toBeUndefined();
  });

  it('gives a prepaying caller a NEGATIVE balance, not an error (mirrors Story 2.3)', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_A, ana.Id, [{ id: 'p_mia_acct', petType: 'dog' }]);
    await insertAccountPayment(env.PAWSERVATION_DB, TENANT_A, {
      accountId: mia,
      amount: 30000,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    const token = await endUserToken(env, 'sunny-paws', 'ana@example.com');

    const res = await app.request(
      '/api/sunny-paws/account',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountBody;
    expect(body.balanceCents).toBe(-30000);
    expect(body.bookings).toEqual([]);
    expect(body.householdPayments).toEqual([expect.objectContaining({ amountCents: 30000 })]);
  });

  it('answers zero for a brand-new customer with no bookings, no payments and no pets', async () => {
    const { env } = createTestEnv();
    await insertInvitedCustomer(env.PAWSERVATION_DB, TENANT_A, 'new@example.com', 'New');
    const token = await endUserToken(env, 'sunny-paws', 'new@example.com');

    const res = await app.request(
      '/api/sunny-paws/account',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as AccountBody;
    expect(body).toEqual({
      accountId: null,
      bookings: [],
      householdPayments: [],
      expectedTotalCents: 0,
      paidTotalCents: 0,
      balanceCents: 0,
    });
  });

  it('401s without a token', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/sunny-paws/account', {}, env);
    expect(res.status).toBe(401);
  });

  it('SECURITY: never publishes another household under the same tenant', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_A, jen.Id, [{ id: 'p_rex_iso', petType: 'dog' }]);
    await book(env, TENANT_A, jen.Id, [rex], 999); // another household's money

    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'ana@example.com',
      'Ana',
    );
    seedPets(raw, TENANT_A, ana.Id, [{ id: 'p_mia_iso', petType: 'cat' }]);
    const token = await endUserToken(env, 'sunny-paws', 'ana@example.com');

    const res = await app.request(
      '/api/sunny-paws/account',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const body = (await res.json()) as AccountBody;
    expect(body.balanceCents).toBe(0);
    expect(body.bookings).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('999');
  });

  it('SECURITY: the same email under two tenants resolves to two different people, and a tenant-A token cannot read tenant B', async () => {
    const { env, raw } = createTestEnv();
    const userA = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'dual@example.com',
      null,
    );
    const userB = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_B,
      'dual@example.com',
      null,
    );
    expect(userA.Id).not.toBe(userB.Id);

    const [petB] = seedPets(raw, TENANT_B, userB.Id, [{ id: 'p_dual_b', petType: 'dog' }]);
    await book(env, TENANT_B, userB.Id, [petB], 500); // tenant B's own money

    const tokenForA = await mintToken(userA.Id, TENANT_A, TEST_SECRET);
    const res = await app.request(
      '/api/happy-tails/account', // happy-tails is TENANT_B's slug
      { headers: { Authorization: `Bearer ${tokenForA}` } },
      env,
    );
    // endUserAuth refuses a tenant-A token on a tenant-B route outright.
    expect(res.status).toBe(403);
  });

  it('SHARED HOUSEHOLD: a caller who co-owns a pet with someone else sees the same combined balance as that person, not two separate ones', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_A,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_A, jen.Id, [{ id: 'p_rex_shared', petType: 'dog' }]);
    const co = await insertInvitedCustomer(env.PAWSERVATION_DB, TENANT_A, 'co@example.com', 'Co');
    await addPetOwner(env.PAWSERVATION_DB, TENANT_A, rex, co.Id);
    const bookingId = await book(env, TENANT_A, jen.Id, [rex], 200);

    const jenToken = await endUserToken(env, 'sunny-paws', 'jen@example.com');
    const coToken = await endUserToken(env, 'sunny-paws', 'co@example.com');

    const jenRes = (await (
      await app.request(
        '/api/sunny-paws/account',
        { headers: { Authorization: `Bearer ${jenToken}` } },
        env,
      )
    ).json()) as AccountBody;
    const coRes = (await (
      await app.request(
        '/api/sunny-paws/account',
        { headers: { Authorization: `Bearer ${coToken}` } },
        env,
      )
    ).json()) as AccountBody;

    // Same household, same numbers, same booking — the shared pet legitimately puts them in one
    // account (buildAccounts), unlike the wholly-unrelated-household case above.
    expect(jenRes.accountId).toBe(rex);
    expect(coRes).toEqual(jenRes);
    expect(jenRes.bookings.map((b) => b.bookingId)).toEqual([bookingId]);
  });
});
