import { describe, expect, it } from 'vitest';
import { buildHouseholdBalances } from '../../src/shared/index.js';
import {
  addBookingPets,
  deleteCustomer,
  getAnalytics,
  getHouseholdBalances,
  getHouseholdDetail,
  getOrphanedAccountPayments,
  insertAccountPayment,
  insertBookingRequest,
  insertInvitedCustomer,
  setPetDeceased,
} from '../db/repo';
import { createTestEnv, seedPets } from './helpers';

const TENANT_C = 'tnt_pawsandrelax'; // seeded clean slate: customers, no bookings

/**
 * ORPHANED HOUSEHOLD PAYMENTS. `Payments.AccountId` stores a PET id — the lexicographically-first
 * pet of the household's component — and every reader resolves it by MEMBERSHIP, because a pet
 * added later renames the account. But the membership graph is built from `listOwnerPetLinks`,
 * which EXCLUDES DECEASED PETS. So the moment the anchor pet dies, no component contains that id:
 * the payment falls out of every household balance while `Payments` still counts it as revenue.
 * Money that exists in one view and not in another is the one defect this product cannot ship.
 *
 * The fix has two halves, and they cover two genuinely different situations:
 *
 *  1. THE HOUSEHOLD STILL EXISTS (the pet died). The deceased pet keeps its `PetOwners` edges, so
 *     its owners — and therefore its household — are still knowable from the same graph. Resolving
 *     the payment through them is not a guess: it is the identical component, read without the
 *     display-level "deceased pets are not bookable" filter that never had anything to do with
 *     where money went.
 *  2. THE ANCHOR IS GONE (`deleteCustomer` cascaded the pet row away, edges included). Nothing in
 *     the database can now say which household that payment belonged to, so it is surfaced as an
 *     ORPHAN rather than attached to a household that may not be its own.
 */
describe('a payment whose anchor pet dies stays in its household (pure)', () => {
  it('resolves a payment through the DECEASED pet that anchors it', () => {
    // Jen owns two pets; p_alpha (the account id the payment was filed under) has since died, so
    // the caller passes it as an ANCHOR edge rather than an account edge.
    const { households, unattachedPaymentAccountIds } = buildHouseholdBalances({
      links: [{ ownerId: 'o_jen', petId: 'p_beta' }],
      anchorLinks: [{ ownerId: 'o_jen', petId: 'p_alpha' }],
      bookings: [{ bookingId: 'b1', ownerId: 'o_jen', petIds: ['p_beta'], expected: 500, paid: 0 }],
      payments: [{ accountId: 'p_alpha', amount: 400 }],
    });
    expect(unattachedPaymentAccountIds).toEqual([]);
    expect(households).toHaveLength(1);
    expect(households[0]).toMatchObject({
      accountId: 'p_beta', // the account is RENAMED by the death; the money still lands on it
      paidTotal: 400,
      balance: 100,
    });
  });

  it('refuses to guess when the anchor pet resolves to no household, or to two', () => {
    // p_ghost's only owner holds no live pet at all — there is no household to attach it to.
    const homeless = buildHouseholdBalances({
      links: [{ ownerId: 'o_jen', petId: 'p_beta' }],
      anchorLinks: [{ ownerId: 'o_gone', petId: 'p_ghost' }],
      bookings: [],
      payments: [{ accountId: 'p_ghost', amount: 90 }],
    });
    expect(homeless.unattachedPaymentAccountIds).toEqual(['p_ghost']);

    // p_split's two owners have since ended up in two DIFFERENT households. Either choice would be
    // an inference about where money belongs, so it makes neither.
    const ambiguous = buildHouseholdBalances({
      links: [
        { ownerId: 'o_jen', petId: 'p_beta' },
        { ownerId: 'o_sam', petId: 'p_zeta' },
      ],
      anchorLinks: [
        { ownerId: 'o_jen', petId: 'p_split' },
        { ownerId: 'o_sam', petId: 'p_split' },
      ],
      bookings: [],
      payments: [{ accountId: 'p_split', amount: 90 }],
    });
    expect(ambiguous.unattachedPaymentAccountIds).toEqual(['p_split']);
  });
});

/** Jen, two pets, one $500 booking on the pet that survives and one $400 household payment filed
 *  against p_alpha — the account id, and the pet that is about to die. */
async function jenWithAPaymentAnchoredOnAlpha(env: Env, raw: Parameters<typeof seedPets>[0]) {
  const jen = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'jen@example.com', 'Jen');
  seedPets(raw, TENANT_C, jen.Id, [
    { id: 'p_alpha', petType: 'dog' },
    { id: 'p_beta', petType: 'dog' },
  ]);
  const bookingId = await insertBookingRequest(env.PAWBOOK_DB, TENANT_C, {
    endUserId: jen.Id,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost: 500,
    status: 'confirmed',
  });
  await addBookingPets(env.PAWBOOK_DB, TENANT_C, bookingId, ['p_beta']);
  const paymentId = await insertAccountPayment(env.PAWBOOK_DB, TENANT_C, {
    accountId: 'p_alpha',
    amount: 400,
    method: 'venmo',
    paidDate: '2026-07-01',
    note: null,
    externalRef: null,
  });
  return { jen, bookingId, paymentId };
}

describe('a payment whose anchor pet dies stays in its household (repo)', () => {
  it('keeps the $400 in the household balance after the account-id pet is marked deceased', async () => {
    const { env, raw } = createTestEnv();
    await jenWithAPaymentAnchoredOnAlpha(env, raw);
    expect(await setPetDeceased(env.PAWBOOK_DB, TENANT_C, 'p_alpha', true)).toBe(true);

    const households = await getHouseholdBalances(env.PAWBOOK_DB, TENANT_C);
    expect(households).toHaveLength(1);
    // The household is now named p_beta (p_alpha holds no live edge), and still holds the money.
    expect(households[0]).toMatchObject({
      accountId: 'p_beta',
      expectedTotal: 500,
      paidTotal: 400,
      balance: 100,
    });
    expect(await getOrphanedAccountPayments(env.PAWBOOK_DB, TENANT_C)).toEqual([]);
  });

  it('still LISTS that payment in the drill-down, under the old account id and the new one', async () => {
    const { env, raw } = createTestEnv();
    const { paymentId } = await jenWithAPaymentAnchoredOnAlpha(env, raw);
    await setPetDeceased(env.PAWBOOK_DB, TENANT_C, 'p_alpha', true);

    for (const accountId of ['p_alpha', 'p_beta']) {
      const detail = await getHouseholdDetail(env.PAWBOOK_DB, TENANT_C, accountId);
      expect(detail, `drill-down for ${accountId}`).not.toBeNull();
      expect(detail!.householdPayments).toEqual([
        expect.objectContaining({ id: paymentId, amount: 400 }),
      ]);
      // The listed payment and the counted balance are the same money — never two different sets.
      expect(detail!.paidTotal).toBe(400);
    }
  });
});

describe('a payment whose anchor pet is DELETED is surfaced, never silently dropped', () => {
  it('reports the orphan when deleteCustomer cascades the anchor pet away', async () => {
    const { env, raw } = createTestEnv();
    // A customer with no bookings of her own, who prepaid: exactly the case deleteCustomer allows
    // through, and the one where the cascade takes the payment's anchor with it.
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_ana', petType: 'dog' }]);
    const paymentId = await insertAccountPayment(env.PAWBOOK_DB, TENANT_C, {
      accountId: 'p_ana',
      amount: 250,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    expect(paymentId).not.toBeNull();
    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_C, ana.Id)).toBe('deleted');

    // The row is still in Payments — the delete never touched it — so it MUST be visible somewhere.
    expect(await getOrphanedAccountPayments(env.PAWBOOK_DB, TENANT_C)).toEqual([
      { accountId: 'p_ana', total: 250 },
    ]);
  });

  it('AGREES with analytics revenue: every dollar is in a household or named as an orphan', async () => {
    const { env, raw } = createTestEnv();
    await jenWithAPaymentAnchoredOnAlpha(env, raw); // $400, anchor about to die
    const ana = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'ana@example.com', 'Ana');
    seedPets(raw, TENANT_C, ana.Id, [{ id: 'p_ana', petType: 'dog' }]);
    await insertAccountPayment(env.PAWBOOK_DB, TENANT_C, {
      accountId: 'p_ana',
      amount: 250,
      method: 'venmo',
      paidDate: '2026-07-01',
      note: null,
      externalRef: null,
    });
    await setPetDeceased(env.PAWBOOK_DB, TENANT_C, 'p_alpha', true); // household survives: $400 stays
    await deleteCustomer(env.PAWBOOK_DB, TENANT_C, ana.Id); // anchor gone: $250 becomes an orphan

    const analytics = await getAnalytics(env.PAWBOOK_DB, TENANT_C, '2026-08-01');
    const revenue = analytics.monthly.reduce((sum, m) => sum + m.Total, 0);
    const inHouseholds = analytics.households.reduce((sum, h) => sum + h.paidTotal, 0);
    const orphaned = analytics.orphanedPayments.reduce((sum, o) => sum + o.total, 0);

    expect(revenue).toBe(650);
    expect(inHouseholds).toBe(400);
    expect(orphaned).toBe(250);
    // The invariant: revenue is fully accounted for. No dollar counts in one view and vanishes
    // from the other.
    expect(inHouseholds + orphaned).toBe(revenue);
  });
});
