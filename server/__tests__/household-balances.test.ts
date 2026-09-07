import { describe, expect, it } from 'vitest';
import { buildHouseholdBalances } from '../../src/shared/index.js';
import {
  addBookingPets,
  addPetOwner,
  getAnalytics,
  getHouseholdBalances,
  insertBookingCharge,
  insertBookingRequest,
  insertInvitedCustomer,
  insertPayment,
  updateBookingStatus,
} from '../db/repo';
import { adminHeaders, createTestEnv, seedPets, TENANT_B } from './helpers';
import app from '../index';
import { serializeAnalytics } from '../lib/analytics';

/**
 * Story 2.1 — the PURE half. A household is the connected component `buildAccounts` already
 * derives (two customers who share a single pet are one household), and its balance is
 * Σ(booking costs + charges) − Σ(payments) over every booking belonging to it. No schema change is
 * involved anywhere in this file: every figure comes from per-booking money that exists today.
 */
/**
 * `buildHouseholdBalances` is pure and unit-agnostic — integer addition and subtraction, no
 * scaling — so 0015 did not change it. The figures below are nevertheless written in CENTS, the
 * unit its one production caller (`computeHouseholdRollup`, server/db/repo.ts) actually hands it,
 * so the pure half and the repo half of this file cannot be read as speaking different money.
 */
describe('buildHouseholdBalances (pure)', () => {
  const links = [
    { ownerId: 'o_jen', petId: 'p_rex' },
    { ownerId: 'o_sam', petId: 'p_rex' }, // co-owner: same household as Jen
    { ownerId: 'o_ana', petId: 'p_mia' }, // a second, unrelated household
  ];

  it('sums costs and payments across every booking of one household', () => {
    const { households } = buildHouseholdBalances({
      links,
      bookings: [
        { bookingId: 'b1', ownerId: 'o_jen', petIds: ['p_rex'], expected: 10000, paid: 4000 },
        { bookingId: 'b2', ownerId: 'o_jen', petIds: ['p_rex'], expected: 25000, paid: 0 },
      ],
    });
    expect(households).toHaveLength(1);
    expect(households[0]).toMatchObject({
      accountId: 'p_rex',
      ownerIds: ['o_jen', 'o_sam'],
      bookingIds: ['b1', 'b2'],
      expectedTotal: 35000,
      paidTotal: 4000,
      balance: 31000,
    });
  });

  it('two customers who share a pet are ONE household with one balance', () => {
    // Sam books under his own name; the money lands on the household he shares with Jen.
    const { households } = buildHouseholdBalances({
      links,
      bookings: [
        { bookingId: 'b1', ownerId: 'o_jen', petIds: ['p_rex'], expected: 10000, paid: 0 },
        { bookingId: 'b2', ownerId: 'o_sam', petIds: ['p_rex'], expected: 6000, paid: 1000 },
      ],
    });
    expect(households.map((h) => h.accountId)).toEqual(['p_rex']);
    expect(households[0].balance).toBe(15000);
  });

  it('never nets one household against another', () => {
    const { households } = buildHouseholdBalances({
      links,
      bookings: [
        { bookingId: 'b1', ownerId: 'o_jen', petIds: ['p_rex'], expected: 10000, paid: 0 },
        { bookingId: 'b2', ownerId: 'o_ana', petIds: ['p_mia'], expected: 0, paid: 10000 },
      ],
    });
    expect(households.map((h) => [h.accountId, h.balance])).toEqual([
      ['p_mia', -10000],
      ['p_rex', 10000],
    ]);
  });

  it('attaches a booking with no customer through its pets', () => {
    // Widget-era bookings can carry a NULL EndUserId; the pets still name the household.
    const { households, unattachedBookingIds } = buildHouseholdBalances({
      links,
      bookings: [{ bookingId: 'b1', ownerId: null, petIds: ['p_rex'], expected: 8000, paid: 0 }],
    });
    expect(households).toMatchObject([{ accountId: 'p_rex', balance: 8000 }]);
    expect(unattachedBookingIds).toEqual([]);
  });

  it('counts a booking exactly once even when its pets span two households', () => {
    const { households } = buildHouseholdBalances({
      links,
      bookings: [
        { bookingId: 'b1', ownerId: null, petIds: ['p_mia', 'p_rex'], expected: 9000, paid: 0 },
      ],
    });
    expect(households.filter((h) => h.bookingIds.includes('b1'))).toHaveLength(1);
    expect(households.reduce((sum, h) => sum + h.expectedTotal, 0)).toBe(9000);
  });

  it('surfaces a booking that belongs to no household rather than dropping its money', () => {
    const { households, unattachedBookingIds } = buildHouseholdBalances({
      links,
      bookings: [{ bookingId: 'b1', ownerId: 'o_ghost', petIds: [], expected: 7000, paid: 0 }],
    });
    expect(households).toEqual([]);
    expect(unattachedBookingIds).toEqual(['b1']);
  });

  /**
   * Story 2.2's half of the sum. A payment recorded against the HOUSEHOLD is one row covering
   * however many bookings; it is resolved by MEMBERSHIP — "the household whose pets contain this
   * id" — rather than by equality on the account id, because the account id is the
   * lexicographically-first pet and a new pet can rename it.
   */
  it('subtracts a payment recorded against the household exactly once', () => {
    const { households } = buildHouseholdBalances({
      links,
      bookings: [
        { bookingId: 'b1', ownerId: 'o_jen', petIds: ['p_rex'], expected: 20000, paid: 0 },
        { bookingId: 'b2', ownerId: 'o_sam', petIds: ['p_rex'], expected: 20000, paid: 0 },
      ],
      payments: [{ accountId: 'p_rex', amount: 40000 }],
    });
    expect(households).toMatchObject([{ expectedTotal: 40000, paidTotal: 40000, balance: 0 }]);
  });

  it('resolves a household payment stored against any pet of the household', () => {
    // 'p_zed' sorts after 'p_rex', so the account id is 'p_rex' — a payment stored under either
    // pet belongs to the same household.
    const { households } = buildHouseholdBalances({
      links: [
        { ownerId: 'o_jen', petId: 'p_rex' },
        { ownerId: 'o_jen', petId: 'p_zed' },
      ],
      bookings: [],
      payments: [{ accountId: 'p_zed', amount: 7500 }],
    });
    expect(households).toMatchObject([{ accountId: 'p_rex', paidTotal: 7500, balance: -7500 }]);
  });

  it('surfaces a household payment that resolves to no household', () => {
    const { households, unattachedPaymentAccountIds } = buildHouseholdBalances({
      links,
      bookings: [],
      payments: [{ accountId: 'p_gone', amount: 5000 }],
    });
    expect(households).toEqual([]);
    expect(unattachedPaymentAccountIds).toEqual(['p_gone']);
  });

  it('returns households in a deterministic order however the rows arrive', () => {
    const bookings = [
      { bookingId: 'b1', ownerId: 'o_jen', petIds: ['p_rex'], expected: 10000, paid: 0 },
      { bookingId: 'b2', ownerId: 'o_ana', petIds: ['p_mia'], expected: 10000, paid: 0 },
    ];
    const forward = buildHouseholdBalances({ links, bookings });
    const reversed = buildHouseholdBalances({
      links: [...links].reverse(),
      bookings: [...bookings].reverse(),
    });
    expect(reversed).toEqual(forward);
  });
});

// Seeded clean-slate tenant (sql/seed.sql): customers but NO bookings, so household assertions can
// be exact — the same tenant analytics.test.ts uses for the same reason.
const TENANT_C = 'tnt_pawsandrelax';
const SLUG_C = 'paws-and-relax';

/** A confirmed booking for `endUserId`, optionally carrying pets. */
async function book(
  env: Env,
  tenantId: string,
  over: {
    endUserId?: string | null;
    petIds?: string[];
    estCost?: number | null;
    status?: 'pending' | 'confirmed';
  } = {},
): Promise<string> {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: over.endUserId ?? null,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: Math.max(1, over.petIds?.length ?? 1),
    // CENTS (0015): a $100 stay is 10000 in the column.
    estCost: over.estCost !== undefined ? over.estCost : 10000,
    status: over.status ?? 'confirmed',
  });
  if (over.petIds?.length) await addBookingPets(env.PAWSERVATION_DB, tenantId, id, over.petIds);
  return id;
}

const pay = (env: Env, tenantId: string, bookingRequestId: string, amount: number) =>
  insertPayment(env.PAWSERVATION_DB, tenantId, {
    bookingRequestId,
    amount,
    method: 'cash',
    paidDate: '2026-07-01',
    note: null,
    externalRef: null,
  });

/**
 * Story 2.1 — the DB half. Same arithmetic, now over real rows: no migration is involved, the
 * rollup is computed from the per-booking payments that already exist.
 */
describe('getHouseholdBalances (repo)', () => {
  it('rolls two customers who share a pet into ONE balance', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'jen@example.com',
      'Jen',
    );
    const sam = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'sam@example.com',
      'Sam',
    );
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    await addPetOwner(env.PAWSERVATION_DB, TENANT_C, rex, sam.Id);

    // Jen books $100 and pays $40; Sam books $60 against the pet they share and pays nothing.
    const jensBooking = await book(env, TENANT_C, { endUserId: jen.Id, petIds: [rex] });
    await pay(env, TENANT_C, jensBooking, 4000);
    await book(env, TENANT_C, { endUserId: sam.Id, petIds: [rex], estCost: 6000 });

    const households = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(households).toHaveLength(1);
    expect(households[0]).toMatchObject({
      accountId: rex,
      expectedTotal: 16000,
      paidTotal: 4000,
      balance: 12000,
    });
    expect(households[0].owners.map((o) => o.email).sort()).toEqual([
      'jen@example.com',
      'sam@example.com',
    ]);
  });

  it('counts extra charges and leaves a prepaying household in credit', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const bookingId = await book(env, TENANT_C, { endUserId: ana.Id, petIds: [mia] });
    await insertBookingCharge(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: bookingId,
      label: 'Vet visit',
      amount: 4500,
    });
    await pay(env, TENANT_C, bookingId, 20000);
    const [household] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(household).toMatchObject({ expectedTotal: 14500, paidTotal: 20000, balance: -5500 });
  });

  it('bills a cancelled booking for its assessed fee, and a declined one for nothing', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const cancelled = await book(env, TENANT_C, { endUserId: ana.Id, petIds: [mia] });
    await env.PAWSERVATION_DB.prepare(
      "UPDATE BookingRequests SET Status = 'cancelled', CancellationFee = 3000 WHERE TenantId = ? AND Id = ?",
    )
      .bind(TENANT_C, cancelled)
      .run();
    const declined = await book(env, TENANT_C, {
      endUserId: ana.Id,
      petIds: [mia],
      estCost: 50000,
      status: 'pending',
    });
    await pay(env, TENANT_C, declined, 2500); // a deposit, taken before she said no
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, declined, 'declined');
    const [household] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    // $30 owed on the cancellation, nothing owed on the declined request, $25 of her money held.
    expect(household).toMatchObject({ expectedTotal: 3000, paidTotal: 2500, balance: 500 });
  });

  it('holds a balance that is not a whole number of dollars — the point of the unit', async () => {
    // THE FIRST NON-WHOLE-DOLLAR FIGURE THIS LEDGER HAS EVER HELD. Before 0015 a $87.50 payment
    // was unrepresentable: `Payments.Amount` was whole dollars, so the sitter had to round it and
    // the household's balance was wrong by the difference, permanently. $250 owed less $87.50 paid
    // is $162.50 — 16250 cents, exactly, with no rounding anywhere in the expression.
    //
    // Seeded through the repo rather than through the payment route on purpose: the WIRE is still
    // whole dollars in this commit, so the route could not carry 87.50 yet. The ledger can.
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    const bookingId = await book(env, TENANT_C, {
      endUserId: ana.Id,
      petIds: [mia],
      estCost: 25000,
    });
    await pay(env, TENANT_C, bookingId, 8750);
    const [household] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(household).toMatchObject({ expectedTotal: 25000, paidTotal: 8750, balance: 16250 });
  });

  it('is tenant-isolated', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    await book(env, TENANT_C, { endUserId: ana.Id, petIds: [mia] });
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toHaveLength(1);
    const other = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_B);
    expect(other.some((h) => h.accountId === mia)).toBe(false);
    expect(other.flatMap((h) => h.owners.map((o) => o.email))).not.toContain('ana@example.com');
  });
});

describe('household balances on the earnings payload', () => {
  it('publishes one server-computed balance per household, never netted across households', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'jen@example.com',
      'Jen',
    );
    const ana = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'ana@example.com',
      'Ana',
    );
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    await book(env, TENANT_C, { endUserId: jen.Id, petIds: [rex] }); // owes 100
    const anas = await book(env, TENANT_C, { endUserId: ana.Id, petIds: [mia] });
    await pay(env, TENANT_C, anas, 20000); // $100 in credit

    const payload = serializeAnalytics(
      await getAnalytics(env.PAWSERVATION_DB, TENANT_C, '2026-07-15'),
    );
    expect(payload.households.map((h) => [h.accountId, h.balance])).toEqual([
      [mia, -100],
      [rex, 100],
    ]);
    // The tiles keep their own rule: a debt and a credit of equal size are NOT a settled book.
    expect(payload.tiles.outstandingTotal).toBe(100);
    expect(payload.tiles.creditTotal).toBe(100);
  });

  it('is on the admin analytics route, computed server-side', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(
      env.PAWSERVATION_DB,
      TENANT_C,
      'jen@example.com',
      'Jen',
    );
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    const bookingId = await book(env, TENANT_C, { endUserId: jen.Id, petIds: [rex] });
    await pay(env, TENANT_C, bookingId, 2500);
    const res = await app.request(
      `/api/${SLUG_C}/admin/analytics`,
      { headers: await adminHeaders(TENANT_C) },
      env,
    );
    const body = (await res.json()) as {
      households: {
        accountId: string;
        owners: { endUserId: string; name: string | null; email: string | null }[];
        petIds: string[];
        anchorPetIds: string[];
        bookingIds: string[];
        expectedTotal: number;
        paidTotal: number;
        balance: number;
      }[];
    };
    expect(body.households).toEqual([
      {
        accountId: rex,
        owners: [{ endUserId: jen.Id, name: 'Jen', email: 'jen@example.com' }],
        petIds: [rex],
        // Empty until one of this household's pets dies holding a payment filed under its id.
        anchorPetIds: [],
        bookingIds: [bookingId],
        expectedTotal: 100,
        paidTotal: 25,
        balance: 75,
      },
    ]);
  });
});
