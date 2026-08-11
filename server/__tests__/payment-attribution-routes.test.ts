import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  addBookingPets,
  insertAccountPayment,
  insertBookingRequest,
  insertInvitedCustomer,
  insertPayment,
  updateBookingStatus,
} from '../db/repo';
import { adminHeaders, createTestEnv, seedPets, TENANT_A } from './helpers';
import app from '../index';

/**
 * THE PREVIEW ROUTE (Task 3) — `POST /:slug/admin/payments/attribute/preview` asks
 * `proposeAttribution` (server/lib/payment-attribution.ts, pure) how each of a household's
 * unapplied account-level credits WOULD settle against its unpaid bookings, and returns the
 * answer. It never calls `applyAttribution`: nothing here is allowed to move money, which is
 * exactly what the last test in this file checks directly against `Payments`.
 */

// paws-and-relax: seeded customers, no bookings — every household built below starts from a
// genuinely clean slate.
const TENANT_C = 'tnt_pawsandrelax';
const SLUG_C = 'paws-and-relax';

type Household = { ownerId: string; accountId: string; petIds: string[] };

async function household(
  env: Env,
  raw: DatabaseSync,
  key: string,
  tenantId = TENANT_C,
): Promise<Household> {
  const owner = await insertInvitedCustomer(
    env.PAWSERVATION_DB,
    tenantId,
    `${key}@example.com`,
    key,
  );
  const petIds = seedPets(raw, tenantId, owner.Id, [{ id: `p_${key}`, petType: 'dog' }]);
  return { ownerId: owner.Id, accountId: petIds[0], petIds };
}

async function book(
  env: Env,
  home: Household,
  estCost: number,
  startDate = '2030-01-01',
  status: 'pending' | 'confirmed' = 'confirmed',
  tenantId = TENANT_C,
): Promise<string> {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: home.ownerId,
    serviceType: 'boarding',
    startDate,
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status,
  });
  await addBookingPets(env.PAWSERVATION_DB, tenantId, id, home.petIds);
  return id;
}

function credit(
  env: Env,
  accountId: string,
  amount: number,
  paidDate = '2026-07-01',
  tenantId = TENANT_C,
): Promise<string | null> {
  return insertAccountPayment(env.PAWSERVATION_DB, tenantId, {
    accountId,
    amount,
    method: 'venmo',
    paidDate,
    note: null,
    externalRef: null,
  });
}

function paymentRows(raw: DatabaseSync, tenantId = TENANT_C) {
  return raw
    .prepare(
      `SELECT Id, BookingRequestId, AccountId, Amount, Method, PaidDate, Note, ExternalRef
       FROM Payments WHERE TenantId = ? ORDER BY Amount DESC, Id`,
    )
    .all(tenantId) as {
    Id: string;
    BookingRequestId: string | null;
    AccountId: string | null;
    Amount: number;
  }[];
}

type PreviewBody = {
  proposals: {
    accountId: string;
    paymentId: string;
    amount: number;
    splits: { bookingId: string; amount: number }[];
    remainder: number;
  }[];
  unresolved: {
    accountId: string;
    paymentId: string;
    reason: string;
    bookings: { bookingId: string }[];
  }[];
};

async function preview(env: Env, tenantId: string, accountId?: string) {
  const res = await app.request(
    `/api/${SLUG_C}/admin/payments/attribute/preview`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await adminHeaders(tenantId)) },
      body: JSON.stringify(accountId === undefined ? {} : { accountId }),
    },
    env,
  );
  return res;
}

describe('POST /:slug/admin/payments/attribute/preview', () => {
  it('a household with one credit and two unpaid bookings returns a split proposal naming both', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100, '2026-06-28');
    const second = await book(env, home, 60, '2026-07-04');
    const paymentId = (await credit(env, home.accountId, 200))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(1);
    const proposal = body.proposals[0];
    expect(proposal.accountId).toBe(home.accountId);
    expect(proposal.paymentId).toBe(paymentId);
    expect(proposal.remainder).toBe(40);
    expect(new Set(proposal.splits.map((s) => s.bookingId))).toEqual(new Set([first, second]));
    expect(proposal.splits.find((s) => s.bookingId === first)?.amount).toBe(100);
    expect(proposal.splits.find((s) => s.bookingId === second)?.amount).toBe(60);
  });

  it('a household with no unpaid bookings reports no-unpaid-bookings, not an empty success', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const paymentId = (await credit(env, home.accountId, 150))!;
    // Deliberately no bookings at all — the household has only ever prepaid.

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toEqual([]);
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatchObject({
      accountId: home.accountId,
      paymentId,
      reason: 'no-unpaid-bookings',
    });
  });

  it('an ambiguous credit is reported as ambiguous, not resolved', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // Both bookings sit exactly 1 day from the credit's paid date, and $100 covers only one of
    // the two $100 bookings — a genuine tie the credit cannot fully resolve.
    const before = await book(env, home, 100, '2026-06-30');
    const after = await book(env, home, 100, '2026-07-02');
    const paymentId = (await credit(env, home.accountId, 100, '2026-07-01'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toEqual([]);
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatchObject({
      accountId: home.accountId,
      paymentId,
      reason: 'ambiguous',
    });
    expect(new Set(body.unresolved[0].bookings.map((b) => b.bookingId))).toEqual(
      new Set([before, after]),
    );
  });

  it('a declined booking is NOT offered as a candidate', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // Paid while pending, then declined: expected drops to 0 (CREDITABLE_AMOUNT_SQL zeroes a
    // declined booking) while its $50 payment stands, so its outstanding is NEGATIVE — exactly
    // the case that must never reach proposeAttribution, whose own guard would otherwise refuse
    // the whole credit as an unreadable amount instead of simply skipping this booking.
    const declined = await book(env, home, 100, '2026-07-01', 'pending');
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: declined,
      amount: 50,
      method: 'cash',
      paidDate: '2026-06-15',
      note: null,
      externalRef: null,
    });
    expect(await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, declined, 'declined')).toBe(
      true,
    );
    const unpaid = await book(env, home, 100, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 100))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ paymentId, remainder: 0 });
    expect(body.proposals[0].splits).toHaveLength(1);
    expect(body.proposals[0].splits[0]).toMatchObject({ bookingId: unpaid, amount: 100 });
  });

  it("another tenant's accountId is refused", async () => {
    const { env, raw } = createTestEnv();
    // A household of TENANT_A, complete with its own unpaid booking and credit.
    const home = await household(env, raw, 'jen', TENANT_A);
    await book(env, home, 100, '2026-07-01', 'confirmed', TENANT_A);
    await credit(env, home.accountId, 100, '2026-07-01', TENANT_A);

    // TENANT_C, authenticated on its own slug, asks for TENANT_A's household id.
    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(404);
  });

  it('nothing is written — the Payments table is unchanged after a preview', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    await book(env, home, 100, '2026-06-28');
    await book(env, home, 60, '2026-07-04');
    await credit(env, home.accountId, 200);

    const before = paymentRows(raw);
    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    expect(body.proposals).toHaveLength(1); // sanity: the route actually did something

    expect(paymentRows(raw)).toEqual(before);
  });

  it('omitting accountId previews every household of the tenant', async () => {
    const { env, raw } = createTestEnv();
    const jen = await household(env, raw, 'jen');
    const sam = await household(env, raw, 'sam');
    const jensBooking = await book(env, jen, 100, '2026-07-01');
    const samsBooking = await book(env, sam, 50, '2026-07-01');
    const jensPaymentId = (await credit(env, jen.accountId, 100))!;
    const samsPaymentId = (await credit(env, sam.accountId, 50))!;

    const res = await preview(env, TENANT_C);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toHaveLength(2);
    const byPaymentId = new Map(body.proposals.map((p) => [p.paymentId, p]));
    expect(byPaymentId.get(jensPaymentId)).toMatchObject({
      accountId: jen.accountId,
      splits: [{ bookingId: jensBooking, amount: 100 }],
    });
    expect(byPaymentId.get(samsPaymentId)).toMatchObject({
      accountId: sam.accountId,
      splits: [{ bookingId: samsBooking, amount: 50 }],
    });
  });
});
