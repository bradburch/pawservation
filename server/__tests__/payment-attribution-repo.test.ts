import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  addBookingPets,
  applyAttribution,
  getHouseholdBalances,
  insertAccountPayment,
  insertBookingRequest,
  insertInvitedCustomer,
  listPaymentsForAccount,
  listPaymentsForBooking,
} from '../db/repo';
import { createTestEnv, seedPets, TENANT_A } from './helpers';

/**
 * APPLYING an attribution — the one place in this feature where real money moves. The proposer
 * (`server/lib/payment-attribution.ts`, tested in payment-attribution.test.ts) only decides a
 * split; this writes it, and `Payments`'
 * `CHECK ((BookingRequestId IS NULL) <> (AccountId IS NULL))` means writing it is a DELETE of the
 * household-level row plus INSERTs of the booking-level ones. Money is destroyed and re-created in
 * the same breath, so every assertion below is ultimately about one question: did the household
 * end up holding exactly the money it started with?
 */

const TENANT_C = 'tnt_pawsandrelax'; // seeded clean slate: customers, no bookings

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
    status: 'confirmed',
  });
  await addBookingPets(env.PAWSERVATION_DB, tenantId, id, home.petIds);
  return id;
}

/** The imported credit every test below attributes: one household-level row, carrying every
 *  field a derived row must inherit. */
function credit(
  env: Env,
  accountId: string,
  amount: number,
  externalRef: string | null = 'venmo-7788',
): Promise<string | null> {
  return insertAccountPayment(env.PAWSERVATION_DB, TENANT_C, {
    accountId,
    amount,
    method: 'venmo',
    paidDate: '2026-07-01',
    note: 'July cheque',
    externalRef,
  });
}

/** Every payment row of a tenant, straight from SQL — `PaymentRow` deliberately omits
 *  `ExternalRef`, and the suffixing is exactly what needs asserting. */
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
    Method: string;
    PaidDate: string;
    Note: string | null;
    ExternalRef: string | null;
  }[];
}

describe('applyAttribution (repo)', () => {
  it('writes one booking-level payment per split and deletes the household row it came from', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100, '2026-06-28');
    const second = await book(env, home, 60, '2026-07-04');
    const paymentId = (await credit(env, home.accountId, 200))!;

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [
        { bookingId: first, amount: 100 },
        { bookingId: second, amount: 60 },
      ],
      remainder: 40,
    });
    expect(result).toEqual({ ok: true });

    // Each split is a real booking-level payment inheriting the source's method, date and note.
    const firstPayments = await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, first);
    expect(firstPayments).toHaveLength(1);
    expect(firstPayments[0]).toMatchObject({
      Amount: 100,
      Method: 'venmo',
      PaidDate: '2026-07-01',
      Note: 'July cheque',
      AccountId: null,
    });
    const secondPayments = await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, second);
    expect(secondPayments).toHaveLength(1);
    expect(secondPayments[0]).toMatchObject({ Amount: 60, Method: 'venmo', Note: 'July cheque' });

    // The source row is GONE, replaced by a household row for the remainder alone.
    const accountPayments = await listPaymentsForAccount(
      env.PAWSERVATION_DB,
      TENANT_C,
      home.accountId,
    );
    expect(accountPayments).toHaveLength(1);
    expect(accountPayments[0].Amount).toBe(40);
    expect(accountPayments.map((p) => p.Id)).not.toContain(paymentId);
  });

  it('writes no remainder row when the splits consume the whole payment', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 150);
    const paymentId = (await credit(env, home.accountId, 150))!;

    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [{ bookingId: only, amount: 150 }],
        remainder: 0,
      }),
    ).toEqual({ ok: true });

    expect(await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_C, home.accountId)).toEqual([]);
    expect(paymentRows(raw)).toHaveLength(1);
  });

  it('refuses splits that OVER-sum the payment, naming both figures, and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100);
    const second = await book(env, home, 100, '2026-07-04');
    const paymentId = (await credit(env, home.accountId, 150))!;

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [
        { bookingId: first, amount: 100 },
        { bookingId: second, amount: 100 },
      ],
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('200');
    expect(result.reason).toContain('150');

    // Untouched: the source is still the tenant's only payment row.
    const rows = paymentRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Id: paymentId, Amount: 150, ExternalRef: 'venmo-7788' });
  });

  it('refuses splits that UNDER-sum the payment, naming both figures, and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 100);
    const paymentId = (await credit(env, home.accountId, 150))!;

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: only, amount: 100 }],
      remainder: 10, // 110, not 150 — $40 would simply evaporate
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('110');
    expect(result.reason).toContain('150');

    const rows = paymentRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ Id: paymentId, Amount: 150 });
  });

  it('refuses a booking belonging to another household of the SAME tenant', async () => {
    const { env, raw } = createTestEnv();
    const jen = await household(env, raw, 'jen');
    const sam = await household(env, raw, 'sam');
    const sams = await book(env, sam, 90);
    const paymentId = (await credit(env, jen.accountId, 90))!;

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: jen.accountId,
      splits: [{ bookingId: sams, amount: 90 }],
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain(sams);

    expect(paymentRows(raw)).toHaveLength(1);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, sams)).toEqual([]);
  });

  it('refuses a booking belonging to another TENANT', async () => {
    const { env, raw } = createTestEnv();
    const jen = await household(env, raw, 'jen');
    const stranger = await household(env, raw, 'stranger', TENANT_A);
    const theirs = await book(env, stranger, 90, '2030-01-01', TENANT_A);
    const paymentId = (await credit(env, jen.accountId, 90))!;

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: jen.accountId,
      splits: [{ bookingId: theirs, amount: 90 }],
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain(theirs);

    expect(paymentRows(raw)).toHaveLength(1);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_A, theirs)).toEqual([]);
  });

  it('refuses a payment of another tenant, and a booking-level payment, as the source', async () => {
    const { env, raw } = createTestEnv();
    const jen = await household(env, raw, 'jen');
    const only = await book(env, jen, 100);
    const paymentId = (await credit(env, jen.accountId, 100))!;

    // Right payment id, wrong tenant.
    const wrongTenant = await applyAttribution(env.PAWSERVATION_DB, TENANT_A, {
      paymentId,
      accountId: jen.accountId,
      splits: [{ bookingId: only, amount: 100 }],
      remainder: 0,
    });
    expect(wrongTenant.ok).toBe(false);

    // Right tenant, but the id names a payment that already settles a booking.
    await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: jen.accountId,
      splits: [{ bookingId: only, amount: 100 }],
      remainder: 0,
    });
    const bookingPaymentId = (await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, only))[0]
      .Id;
    const notAccountLevel = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId: bookingPaymentId,
      accountId: jen.accountId,
      splits: [{ bookingId: only, amount: 100 }],
      remainder: 0,
    });
    expect(notAccountLevel.ok).toBe(false);
    expect(paymentRows(raw)).toHaveLength(1);
  });

  it('refuses a non-integer, zero or negative split, and a negative remainder', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 100);
    const paymentId = (await credit(env, home.accountId, 100))!;
    const apply = (splits: { bookingId: string; amount: number }[], remainder: number) =>
      applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits,
        remainder,
      });

    expect((await apply([{ bookingId: only, amount: 33.5 }], 66.5)).ok).toBe(false);
    expect((await apply([{ bookingId: only, amount: 0 }], 100)).ok).toBe(false);
    expect((await apply([{ bookingId: only, amount: 150 }], -50)).ok).toBe(false);
    expect((await apply([{ bookingId: only, amount: -50 }], 150)).ok).toBe(false);
    expect((await apply([], 100)).ok).toBe(false);

    expect(paymentRows(raw)).toHaveLength(1);
    expect(paymentRows(raw)[0]).toMatchObject({ Id: paymentId, Amount: 100 });
  });

  it('suffixes ExternalRef per derived row — unique, and traceable back to the source', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100, '2026-06-28');
    const second = await book(env, home, 60, '2026-07-04');
    const paymentId = (await credit(env, home.accountId, 200, 'venmo-7788'))!;

    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [
          { bookingId: first, amount: 100 },
          { bookingId: second, amount: 60 },
        ],
        remainder: 40,
      }),
    ).toEqual({ ok: true });

    const refs = paymentRows(raw).map((r) => r.ExternalRef);
    expect(refs.sort()).toEqual(['venmo-7788:1', 'venmo-7788:2', 'venmo-7788:r']);
    expect(new Set(refs).size).toBe(refs.length);
    // Every derived row traces back to the source ref, which is what stops a re-import of the
    // original CSV recreating money this attribution has already placed.
    for (const ref of refs) expect(ref!.startsWith('venmo-7788:')).toBe(true);
  });

  it('derives no ExternalRef when the source payment has none', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 80);
    const paymentId = (await credit(env, home.accountId, 100, null))!;

    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [{ bookingId: only, amount: 80 }],
        remainder: 20,
      }),
    ).toEqual({ ok: true });

    expect(paymentRows(raw).map((r) => r.ExternalRef)).toEqual([null, null]);
  });

  it("leaves the household's balance EXACTLY unchanged — attribution moves money, never makes or loses it", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100, '2026-06-28');
    const second = await book(env, home, 60, '2026-07-04');
    await book(env, home, 45, '2026-08-10'); // untouched, so the total is not just the split's own sum
    const paymentId = (await credit(env, home.accountId, 200))!;

    const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ expectedTotal: 205, paidTotal: 200, balance: 5 });

    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [
          { bookingId: first, amount: 100 },
          { bookingId: second, amount: 60 },
        ],
        remainder: 40,
      }),
    ).toEqual({ ok: true });

    // The whole statement, not just the balance: what was expected, what was paid, and which
    // bookings it covers must all read identically either side of the move.
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toEqual(before);
  });

  it('rolls the WHOLE batch back on a mid-batch failure — the source payment survives intact', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100, '2026-06-28');
    const second = await book(env, home, 60, '2026-07-04');
    const paymentId = (await credit(env, home.accountId, 200))!;
    const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);

    // A db whose batch() carries one extra, doomed statement — `Amount = -1` violates
    // `CHECK (Amount > 0)` — placed after the delete and the split inserts have already run. The
    // test shim runs batch inside a real BEGIN/COMMIT (helpers.ts), so this is the genuine
    // all-or-nothing question and not a simulation of it.
    const db = env.PAWSERVATION_DB;
    const poisoned = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (statements: D1PreparedStatement[]) =>
        db.batch([
          ...statements.slice(0, -1),
          db
            .prepare(
              `INSERT INTO Payments (Id, TenantId, AccountId, Amount, Method, PaidDate)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .bind('p_poison', TENANT_C, home.accountId, -1, 'cash', '2026-07-01'),
          ...statements.slice(-1),
        ]),
    } as unknown as D1Database;

    await expect(
      applyAttribution(poisoned, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [
          { bookingId: first, amount: 100 },
          { bookingId: second, amount: 60 },
        ],
        remainder: 40,
      }),
    ).rejects.toThrow();

    // The ORIGINAL account-level payment, whole, with its original ref — and not one booking row.
    const rows = paymentRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Id: paymentId,
      AccountId: home.accountId,
      BookingRequestId: null,
      Amount: 200,
      ExternalRef: 'venmo-7788',
    });
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, first)).toEqual([]);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, second)).toEqual([]);
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toEqual(before);
  });
});
