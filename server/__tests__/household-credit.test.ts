import { describe, expect, it } from 'vitest';
import {
  addBookingPets,
  getHouseholdBalances,
  insertAccountPayment,
  insertBookingRequest,
  insertInvitedCustomer,
} from '../db/repo';
import { createTestEnv, seedPets } from './helpers';

// Seeded clean-slate tenant (sql/seed.sql): customers but NO bookings, same reason Story 2.1/2.2's
// tests use it — household assertions can be exact.
const TENANT_C = 'tnt_pawsandrelax';

const book = (env: Env, tenantId: string, endUserId: string, petIds: string[], estCost: number) =>
  insertBookingRequest(env.PAWBOOK_DB, tenantId, {
    endUserId,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status: 'confirmed',
  }).then(async (id) => {
    await addBookingPets(env.PAWBOOK_DB, tenantId, id, petIds);
    return id;
  });

const prepay = (env: Env, tenantId: string, accountId: string, amount: number) =>
  insertAccountPayment(env.PAWBOOK_DB, tenantId, {
    accountId,
    amount,
    method: 'venmo',
    paidDate: '2026-07-01',
    note: null,
    externalRef: null,
  });

/**
 * Story 2.3 — PREPAYMENT READS AS CREDIT, NOT AS AN ERROR (FR-7b). Stories 2.1/2.2 already gave a
 * prepaying household a negative balance; this file locks in the two guarantees that make that
 * number safe to act on rather than a coincidence of the current test data:
 *
 *  - a payment recorded before the booking it will cover exists counts exactly like any other
 *    payment — the arithmetic in `buildHouseholdBalances` has no notion of "when", only "how much";
 *  - a household's credit is drawn down by the SAME live computation a new booking triggers, because
 *    there is no stored balance anywhere to reconcile — `getHouseholdBalances` recomputes from the
 *    Payments/BookingRequests tables on every call.
 *
 * No production code changes accompany this file: it exists to pin down, with a name on it, the
 * specific scenarios FR-7b describes that Stories 2.1/2.2 exercised only in passing (a single
 * "prepaid, no booking yet" snapshot, never a payment-then-booking sequence).
 */
describe('household credit (Story 2.3)', () => {
  it('counts a payment recorded before its booking exists exactly as it would after', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);

    await prepay(env, TENANT_C, mia, 300);
    // No booking exists yet: pure prepayment reads as credit, not an error or a dangling reference.
    const [before] = await getHouseholdBalances(env.PAWBOOK_DB, TENANT_C);
    expect(before).toMatchObject({ expectedTotal: 0, paidTotal: 300, balance: -300 });

    // The booking arrives AFTER the payment. Timing carries no meaning in the arithmetic: the same
    // subtraction runs whether the payment or the booking was recorded first.
    await book(env, TENANT_C, ana.Id, [mia], 120);
    const [after] = await getHouseholdBalances(env.PAWBOOK_DB, TENANT_C);
    expect(after).toMatchObject({ expectedTotal: 120, paidTotal: 300, balance: -180 });
  });

  it('draws the credit down automatically as more bookings are added, with no reconciliation step', async () => {
    const { env, raw } = createTestEnv();
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);
    await prepay(env, TENANT_C, mia, 300);

    await book(env, TENANT_C, ana.Id, [mia], 100);
    expect((await getHouseholdBalances(env.PAWBOOK_DB, TENANT_C))[0].balance).toBe(-200);

    // A second booking pushes the household from credit into owing money — same computation, no
    // special-cased "apply the credit" call anywhere in between.
    await book(env, TENANT_C, ana.Id, [mia], 250);
    expect((await getHouseholdBalances(env.PAWBOOK_DB, TENANT_C))[0].balance).toBe(50);
  });

  it('never lets a household in credit read as owing money in a filtered outstanding list', async () => {
    const { env, raw } = createTestEnv();
    const jen = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'jen@example.com', 'Jen');
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    const [rex] = seedPets(raw, TENANT_C, jen.Id, [{ id: 'p_rex', petType: 'dog' }]);
    const [mia] = seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_mia', petType: 'dog' }]);

    await prepay(env, TENANT_C, mia, 500); // Ana prepays with no booking at all — pure credit.
    await book(env, TENANT_C, jen.Id, [rex], 90); // Jen genuinely owes $90.

    const households = await getHouseholdBalances(env.PAWBOOK_DB, TENANT_C);
    // Any "who owes me money" list is built by filtering this same server-computed balance, never a
    // second money rule — so a credit household filters itself out by the sign of its own balance.
    const outstanding = households.filter((h) => h.balance > 0);
    expect(outstanding.map((h) => h.accountId)).toEqual([rex]);
    expect(outstanding.some((h) => h.accountId === mia)).toBe(false);
  });
});
