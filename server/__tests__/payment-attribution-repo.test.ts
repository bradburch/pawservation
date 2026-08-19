import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  addBookingPets,
  applyAttribution,
  getHouseholdBalances,
  getHouseholdDetail,
  householdOutstandingByBooking,
  insertAccountPayment,
  insertBookingCharge,
  insertBookingRequest,
  insertInvitedCustomer,
  insertPayment,
  listPaymentsForAccount,
  listPaymentsForBooking,
  updateBookingStatus,
} from '../db/repo';
import { recoverSourceRef } from '../lib/payment-attribution';
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
  // Seven days after the credit helper's default `paidDate` (2026-07-01), so inside the tighter
  // MAX_PREPAYMENT_DAYS window that governs a stay AHEAD of the payment — a test taking both
  // defaults exercises a real proposal rather than the staleness refusal.
  startDate = '2026-07-08',
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
 *  `ExternalRef`, and how attribution derives it is exactly what needs asserting. */
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

/** Every charge row of a tenant, straight from SQL — a tip is a `BookingCharges` row and `Origin`
 *  is what says the sitter entered it herself, neither of which any repo read returns whole. */
function chargeRows(raw: DatabaseSync, tenantId = TENANT_C) {
  return raw
    .prepare(
      `SELECT BookingRequestId, Label, Amount, Origin
       FROM BookingCharges WHERE TenantId = ? ORDER BY Amount DESC, Id`,
    )
    .all(tenantId) as {
    BookingRequestId: string;
    Label: string;
    Amount: number;
    Origin: string | null;
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
    // The remainder inherits every field the splits do — it is the same money, still household-level.
    expect(accountPayments[0]).toMatchObject({
      Amount: 40,
      Method: 'venmo',
      PaidDate: '2026-07-01',
      Note: 'July cheque',
      AccountId: home.accountId,
      BookingRequestId: null,
    });
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

    // Right tenant, but the id names a payment that already settles a booking. Asserted rather
    // than discarded: if this setup call ever started refusing, the premise below would rot into a
    // test that passes for the wrong reason.
    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: jen.accountId,
        splits: [{ bookingId: only, amount: 100 }],
        remainder: 0,
      }),
    ).toEqual({ ok: true });
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

  it('refuses a split that names the same booking twice within one attribution, and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 100);
    const paymentId = (await credit(env, home.accountId, 150))!;

    // Each of these two splits is individually within the booking's $100 outstanding — the defect
    // this pins is that nothing decrements outstanding as splits are consumed, so two splits on the
    // SAME booking would otherwise both clear the per-split check while together over-funding it by
    // $50.
    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [
        { bookingId: only, amount: 100 },
        { bookingId: only, amount: 50 },
      ],
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain(only);
    expect(result.reason).toContain('more than once');

    expect(paymentRows(raw)).toHaveLength(1);
    expect(paymentRows(raw)[0]).toMatchObject({ Id: paymentId, Amount: 150 });
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, only)).toEqual([]);
  });

  it('refuses a split that overpays a booking by even $1 against a NON-ZERO outstanding — pins the boundary exactly', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 150);
    // $50 already paid directly against the booking, so its outstanding is $100 — not $0 and not
    // $150. An off-by-one loosening of the guard (e.g. `amount > outstanding + 1`) would slip past
    // a test built only on a $0-outstanding booking; this pins the boundary at a non-zero value.
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: only,
      amount: 50,
      method: 'cash',
      paidDate: '2026-06-01',
      note: null,
      externalRef: null,
    });
    const paymentId = (await credit(env, home.accountId, 101))!;

    const overResult = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: only, amount: 101 }],
      remainder: 0,
    });
    expect(overResult.ok).toBe(false);
    if (overResult.ok) throw new Error('unreachable');
    expect(overResult.reason).toContain('owes $100');
    expect(overResult.reason).toContain('names $101');
    // The source credit and the direct $50 payment, untouched.
    expect(paymentRows(raw)).toHaveLength(2);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, only)).toHaveLength(1);

    // The exact boundary — a split of precisely $100 — is allowed, confirming the guard is `>`,
    // not `>=`.
    const exactResult = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: only, amount: 100 }],
      remainder: 1,
    });
    expect(exactResult).toEqual({ ok: true });
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, only)).toHaveLength(2);
  });

  it('reports the ACTUAL outstanding when a booking is already over-paid, never clamped to $0', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 50);
    // Already $100 paid directly against a $50 booking — genuinely $50 over-paid before this
    // attribution ever runs.
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: only,
      amount: 100,
      method: 'cash',
      paidDate: '2026-06-01',
      note: null,
      externalRef: null,
    });
    const paymentId = (await credit(env, home.accountId, 10))!;

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: only, amount: 10 }],
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The real, negative figure — not "$0", which would misreport an already-over-paid booking as
    // merely settled rather than over-paid.
    expect(result.reason).toContain('is $50 over-paid');
  });

  it('marks ExternalRef per derived row — unique, and traceable back to the source', async () => {
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
    expect(refs.sort()).toEqual(['attr:1:venmo-7788', 'attr:2:venmo-7788', 'attr:r:venmo-7788']);
    expect(new Set(refs).size).toBe(refs.length);
    // Each derived row carries the source ref VERBATIM as its tail, so the original importer key
    // is recoverable from it by inspection alone — whatever characters that key contains.
    for (const ref of refs) expect(recoverSourceRef(ref!)).toBe('venmo-7788');
    // Traceability is not the same claim as re-import protection, and this test asserts only the
    // first. That the importers actually REFUSE the source file again after this write is proved
    // end to end, through both import routes, in payment-attribution-reimport.test.ts.
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
    // `CHECK (Amount > 0)` — spliced in before the LAST statement, which is the DELETE. So every
    // split insert and the remainder insert have already run when it fires, and the delete has
    // not: real writes are on the table and the source row is still there to lose. The test shim
    // runs batch inside a real BEGIN/COMMIT (helpers.ts), so this is the genuine all-or-nothing
    // question and not a simulation of it.
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

  it('applies ONCE when two overlapping calls attribute the same payment — no money from nowhere', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100, '2026-06-28');
    const second = await book(env, home, 60, '2026-07-04');
    // NO ExternalRef: the partial unique index covers only non-NULL refs, so a hand-recorded
    // household payment — the common case — is protected by nothing but the in-batch guard.
    const paymentId = (await credit(env, home.accountId, 200, null))!;
    const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);

    // The harness runs every batch on ONE SQLite connection, so two batches overlapping in real
    // time nest their BEGINs and the second dies with "cannot start a transaction within a
    // transaction" — an artifact of the shim, not of D1, which gives each batch its own
    // transaction and commits them one at a time. This db queues batches to model that guarantee.
    // The RACE ITSELF is untouched: both calls still re-read the source before either writes,
    // which is the whole of the bug.
    const db = env.PAWSERVATION_DB;
    let queue: Promise<unknown> = Promise.resolve();
    const serialised = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => {
        const next = queue.then(() => db.batch(statements));
        queue = next.catch(() => undefined);
        return next;
      },
    } as unknown as D1Database;

    const apply = () =>
      applyAttribution(serialised, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [
          { bookingId: first, amount: 100 },
          { bookingId: second, amount: 60 },
        ],
        remainder: 40,
      });
    // Both started before either is awaited — exactly the double-clicked Apply button.
    const outcomes = await Promise.allSettled([apply(), apply()]);

    const applied = outcomes.filter((o) => o.status === 'fulfilled' && o.value.ok);
    expect(applied).toHaveLength(1);
    const refused = outcomes.find((o) => !(o.status === 'fulfilled' && o.value.ok))!;
    expect(refused.status).toBe('fulfilled');
    if (refused.status !== 'fulfilled' || refused.value.ok) throw new Error('unreachable');
    expect(refused.value.reason).toContain('another request');

    // ONE set of booking rows, one remainder — and the household's money is exactly what it was.
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, first)).toHaveLength(1);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, second)).toHaveLength(1);
    expect(
      await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_C, home.accountId),
    ).toHaveLength(1);
    expect(paymentRows(raw)).toHaveLength(3);
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toEqual(before);
  });

  it('aborts rather than duplicating when the source payment vanishes between the re-read and the batch', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 100);
    const paymentId = (await credit(env, home.accountId, 100, null))!;

    // The same race as above, pinned to the exact instant it matters: a db whose batch() drops the
    // source row immediately before running. A zero-row DELETE does not raise, so without the
    // in-batch guard this would insert a full set of booking rows against money already spent.
    const db = env.PAWSERVATION_DB;
    const raced = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        raw.prepare('DELETE FROM Payments WHERE Id = ?').run(paymentId);
        return db.batch(statements);
      },
    } as unknown as D1Database;

    const result = await applyAttribution(raced, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: only, amount: 100 }],
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('another request');

    // Nothing written: the money the vanished row carried is not re-created here.
    expect(paymentRows(raw)).toEqual([]);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, only)).toEqual([]);
  });

  it('refuses the SECOND of two concurrent attributions of DIFFERENT payments onto the SAME booking', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const only = await book(env, home, 100);
    // TWO separate household credits, each big enough to settle the booking on its own. NO
    // ExternalRef on either: the partial unique index covers only non-NULL refs, so nothing but the
    // in-batch guard stands between these two and a $100 booking holding $200.
    const firstPaymentId = (await credit(env, home.accountId, 100, null))!;
    const secondPaymentId = (await credit(env, home.accountId, 100, null))!;
    const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);

    // A DIFFERENT RACE FROM THE ONE ABOVE, and the pre-batch guards cannot see it. Two requests
    // attributing the SAME payment are caught by the source row's own in-batch lookup; these two
    // name different sources, so that guard is satisfied for both. What they collide over is the
    // TARGET: both read `only`'s live outstanding ($100), both find their $100 split fits, and both
    // then write. The sequential route loop never produces this — each apply there commits before
    // the next one's read — so it takes genuinely interleaved calls to reach it.
    //
    // Batches are queued for the same reason as the overlapping-source test above: one SQLite
    // connection cannot nest two BEGINs, whereas D1 gives each batch its own transaction and
    // commits them one at a time. The read/write interleaving that IS the bug is untouched — both
    // calls have finished every pre-batch read before either batch runs.
    const db = env.PAWSERVATION_DB;
    let queue: Promise<unknown> = Promise.resolve();
    const serialised = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => {
        const next = queue.then(() => db.batch(statements));
        queue = next.catch(() => undefined);
        return next;
      },
    } as unknown as D1Database;

    const apply = (paymentId: string) =>
      applyAttribution(serialised, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [{ bookingId: only, amount: 100 }],
        remainder: 0,
      });
    const outcomes = await Promise.allSettled([apply(firstPaymentId), apply(secondPaymentId)]);

    // Exactly one applied; the other refused rather than threw, and said why.
    const applied = outcomes.filter((o) => o.status === 'fulfilled' && o.value.ok);
    expect(applied).toHaveLength(1);
    const refused = outcomes.find((o) => !(o.status === 'fulfilled' && o.value.ok))!;
    expect(refused.status).toBe('fulfilled');
    if (refused.status !== 'fulfilled' || refused.value.ok) throw new Error('unreachable');
    expect(refused.value.reason).toContain('no longer owes at least the amount');
    expect(refused.value.reason).toContain('nothing was written');

    // THE WHOLE POINT: one $100 payment against a $100 booking, never two.
    const bookingPayments = await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, only);
    expect(bookingPayments).toHaveLength(1);
    expect(bookingPayments[0]).toMatchObject({ Amount: 100 });

    // The loser's source credit survives WHOLE — household-level, its full amount, still there for
    // the sitter to attribute somewhere it actually fits.
    const survivors = await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({
      Amount: 100,
      AccountId: home.accountId,
      BookingRequestId: null,
    });
    expect([firstPaymentId, secondPaymentId]).toContain(survivors[0].Id);

    // Two rows in total, and the household holds exactly the money it started with.
    expect(paymentRows(raw)).toHaveLength(2);
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toEqual(before);
  });

  it('guards EVERY split, not just the first, when a later booking is settled underneath it', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 60, '2026-06-28');
    const second = await book(env, home, 40, '2026-07-04');
    // The credit that splits across BOTH, and a second credit that will settle `second` from
    // under it. The split onto `second` is index 1, so it carries the outstanding guard but NOT
    // the source guard — which is exactly the axis the single-split test above cannot reach.
    const splitter = (await credit(env, home.accountId, 100, null))!;
    const rival = (await credit(env, home.accountId, 40, null))!;
    const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);

    // Same queueing shim and the same reasoning as the test above: both calls finish every
    // pre-batch read before either batch runs, so both see `second` owing its full $40.
    const db = env.PAWSERVATION_DB;
    let queue: Promise<unknown> = Promise.resolve();
    const serialised = {
      prepare: (sql: string) => db.prepare(sql),
      batch: (statements: D1PreparedStatement[]) => {
        const next = queue.then(() => db.batch(statements));
        queue = next.catch(() => undefined);
        return next;
      },
    } as unknown as D1Database;

    const outcomes = await Promise.allSettled([
      applyAttribution(serialised, TENANT_C, {
        paymentId: rival,
        accountId: home.accountId,
        splits: [{ bookingId: second, amount: 40 }],
        remainder: 0,
      }),
      applyAttribution(serialised, TENANT_C, {
        paymentId: splitter,
        accountId: home.accountId,
        splits: [
          { bookingId: first, amount: 60 },
          { bookingId: second, amount: 40 },
        ],
        remainder: 0,
      }),
    ]);

    // Whichever ran second is refused WHOLE — the batch is one transaction, so the $60 split onto
    // `first`, which was still perfectly fundable, is rolled back with it. That is the correct
    // outcome: a partially-applied attribution would not conserve.
    const applied = outcomes.filter((o) => o.status === 'fulfilled' && o.value.ok);
    expect(applied).toHaveLength(1);
    const refused = outcomes.find((o) => !(o.status === 'fulfilled' && o.value.ok))!;
    if (refused.status !== 'fulfilled' || refused.value.ok) throw new Error('unreachable');
    expect(refused.value.reason).toContain('no longer owes at least the amount');

    // `second` never holds more than the $40 it owed, however the race fell out. Without the
    // guard on split index 1 it holds $80 — the rival's $40 plus the splitter's, since only the
    // first split of an attribution carries the source guard and nothing else would refuse it.
    const secondPayments = await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, second);
    expect(secondPayments.reduce((sum, p) => sum + p.Amount, 0)).toBeLessThanOrEqual(40);
    // And the household still holds exactly the money it started with — attribution moves money
    // between columns, it never creates or destroys any, whichever call won the race.
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toEqual(before);
  });

  it('refuses when a derived ExternalRef collides with one the tenant already holds', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100, '2026-06-28');
    const second = await book(env, home, 60, '2026-07-04');
    // A payment already carrying the ref this attribution's FIRST split would derive.
    await credit(env, home.accountId, 25, 'attr:1:venmo-7788');
    const paymentId = (await credit(env, home.accountId, 160, 'venmo-7788'))!;
    const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [
        { bookingId: first, amount: 100 },
        { bookingId: second, amount: 60 },
      ],
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('external reference');

    // The source survives whole — the collision is caught, never half-applied.
    const rows = paymentRows(raw);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.ExternalRef).sort()).toEqual(['attr:1:venmo-7788', 'venmo-7788']);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, first)).toEqual([]);
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toEqual(before);
  });

  it('attributes a payment filed under an account id a later pet has since RENAMED', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen'); // accountId 'p_jen'
    const only = await book(env, home, 100);
    const paymentId = (await credit(env, home.accountId, 100))!;

    // A new pet sorting FIRST renames the household: 'p_aaa' is now the account id, while the
    // payment stays filed under 'p_jen'. Membership, not equality, is what keeps it reachable —
    // the sitter can already SEE and DELETE it under the new id.
    seedPets(raw, TENANT_C, home.ownerId, [{ id: 'p_aaa', petType: 'dog' }]);
    const renamed = (await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C))[0].accountId;
    expect(renamed).toBe('p_aaa');
    expect(await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_C, renamed)).toHaveLength(1);

    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: renamed,
        splits: [{ bookingId: only, amount: 100 }],
        remainder: 0,
      }),
    ).toEqual({ ok: true });
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, only)).toHaveLength(1);
    expect(paymentRows(raw)).toHaveLength(1);
  });

  it("files the remainder under the SOURCE's account id, not the caller's", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen'); // accountId 'p_jen'
    const only = await book(env, home, 100);
    const paymentId = (await credit(env, home.accountId, 150))!; // filed under 'p_jen'

    // The two ids now DIFFER: a pet sorting first renames the household to 'p_aaa', while the
    // payment stays filed under 'p_jen'. The caller passes the current name; the leftover money
    // must nonetheless stay exactly where it was. Re-filing it under the caller's id would move
    // money between account ids as a side effect of attribution — harmless-looking here, but it is
    // how a deceased-pet anchor gets dropped and a payment is orphaned.
    seedPets(raw, TENANT_C, home.ownerId, [{ id: 'p_aaa', petType: 'dog' }]);
    const renamed = (await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C))[0].accountId;
    expect(renamed).toBe('p_aaa');
    expect(renamed).not.toBe(home.accountId);
    const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);

    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: renamed,
        splits: [{ bookingId: only, amount: 100 }],
        remainder: 50,
      }),
    ).toEqual({ ok: true });

    const remainderRow = paymentRows(raw).find((r) => r.BookingRequestId === null)!;
    expect(remainderRow).toMatchObject({ Amount: 50, AccountId: home.accountId });
    expect(remainderRow.AccountId).not.toBe(renamed);
    // And it still rolls up to the same household — the money has not moved, only its shape has.
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toEqual(before);
  });
});

/**
 * RECORDING PART OF A PAYMENT AS A TIP.
 *
 * A client can pay MORE than the stay costs because they tipped. Attribution's only answer to that
 * used to be `remainder` — an account-level credit — which says the sitter OWES the money back, and
 * which then reappears in every future preview hunting for a stay to attach itself to. The live
 * case: Kelly Snider's $50 on 2026-07-29 settles that day's $40 walk and leaves $10 the sitter was
 * being thanked with, not lent.
 *
 * THE MECHANISM IS A `BookingCharges` ROW LABELLED 'Tip', `Origin` NULL (= the sitter entered this
 * herself). `CHARGES_JOIN_SQL` already folds charges into what a booking is expected to total, so
 * the stay's own balance lands at zero with no new money rule.
 *
 * THE CALLER SENDS THE SPLIT **EXCLUSIVE** OF THE TIP, and the server adds it: conservation is
 * `sum(splits) + tip + remainder === source.Amount`, and the booking-level payment written is
 * `split + tip`. That framing is what these tests pin — the split figure is still checked against
 * the booking's PRE-TIP outstanding (the tip raises expected and payment by the same amount, so the
 * ceiling is unmoved), and a caller that sent an already-inclusive split would fail conservation
 * rather than silently double-count.
 */
describe('applyAttribution — a tip', () => {
  it("records Kelly's $10 as a Tip charge on the walk her $50 settled, leaving no credit behind", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40);
    const paymentId = (await credit(env, home.accountId, 50))!;

    expect(
      await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        // $40 is what the walk OWED; the $10 tip is named separately and added by the server.
        splits: [{ bookingId: walk, amount: 40 }],
        tip: { bookingId: walk, amount: 10 },
        remainder: 0,
      }),
    ).toEqual({ ok: true });

    // The tip is a charge the sitter owns: labelled, on the stay, with no derived-charge Origin.
    expect(chargeRows(raw)).toEqual([
      { BookingRequestId: walk, Label: 'Tip', Amount: 10, Origin: null },
    ]);

    // ONE payment against the walk, for the WHOLE $50 — split plus tip — inheriting the source's
    // method, date and note exactly as an ordinary split does.
    const payments = await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, walk);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      Amount: 50,
      Method: 'venmo',
      PaidDate: '2026-07-01',
      Note: 'July cheque',
    });

    // NO remainder row: the whole point. The $10 is income, not a debt looking for a stay.
    expect(await listPaymentsForAccount(env.PAWSERVATION_DB, TENANT_C, home.accountId)).toEqual([]);
    expect(paymentRows(raw)).toHaveLength(1);

    // Expected $50, paid $50, balance $0 — the stay is settled, not over-paid.
    const balances = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({ expectedTotal: 50, paidTotal: 50, balance: 0 });
    expect(
      (await householdOutstandingByBooking(env.PAWSERVATION_DB, TENANT_C, home.accountId)).get(
        walk,
      ),
    ).toBe(0);
  });

  it('moves the household balance by EXACTLY the tip and nothing else — money IN is untouched', async () => {
    // The design doc's "attribution leaves the household balance unchanged" is a statement about
    // MONEY RECEIVED, and that half still holds to the dollar: `paidTotal` is identical either
    // side of the write. What a tip deliberately DOES move is `expectedTotal` — the phantom $10
    // credit becomes $10 the stay was worth — so the balance rises by the tip and by nothing else.
    // Asserted against the same fixture applied WITHOUT a tip, so the difference is attributable
    // to the tip alone rather than to anything else the write does.
    type Balances = Awaited<ReturnType<typeof getHouseholdBalances>>;
    const withTip = createTestEnv();
    const withoutTip = createTestEnv();
    const run = async (
      { env, raw }: ReturnType<typeof createTestEnv>,
      tipped: boolean,
    ): Promise<{ before: Balances; after: Balances }> => {
      const home = await household(env, raw, 'kelly');
      const walk = await book(env, home, 40);
      await book(env, home, 45, '2026-08-10'); // untouched, so the totals are not just the split's
      const paymentId = (await credit(env, home.accountId, 50))!;
      const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);
      expect(before[0]).toMatchObject({ expectedTotal: 85, paidTotal: 50, balance: 35 });
      expect(
        await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
          paymentId,
          accountId: home.accountId,
          splits: [{ bookingId: walk, amount: 40 }],
          ...(tipped ? { tip: { bookingId: walk, amount: 10 } } : {}),
          remainder: tipped ? 0 : 10,
        }),
      ).toEqual({ ok: true });
      return { before, after: await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C) };
    };

    // No tip: the whole statement is byte-identical, exactly as it has always been.
    const plain = await run(withoutTip, false);
    expect(plain.after).toEqual(plain.before);

    // With a tip: paid unchanged, expected and balance each up by the $10 and not a dollar more.
    const tipped = await run(withTip, true);
    expect(tipped.after).toEqual([
      { ...tipped.before[0], expectedTotal: 95, paidTotal: 50, balance: 45 },
    ]);
  });

  it('refuses a tip that breaks conservation, over and under, naming every figure', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40);
    const paymentId = (await credit(env, home.accountId, 50))!;
    const apply = (tipAmount: number, remainder: number) =>
      applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [{ bookingId: walk, amount: 40 }],
        tip: { bookingId: walk, amount: tipAmount },
        remainder,
      });

    // UNDER: $40 + a $5 tip accounts for $45 of a $50 payment — $5 would simply evaporate.
    const under = await apply(5, 0);
    expect(under.ok).toBe(false);
    if (under.ok) throw new Error('unreachable');
    expect(under.reason).toContain('$45');
    expect(under.reason).toContain('$50');
    expect(under.reason).toContain('$5 tip');

    // OVER: $40 + a $20 tip is $60 against a $50 payment — money from nowhere.
    const over = await apply(20, 0);
    expect(over.ok).toBe(false);
    if (over.ok) throw new Error('unreachable');
    expect(over.reason).toContain('$60');
    expect(over.reason).toContain('$50');
    expect(over.reason).toContain('$20 tip');

    // A CALLER THAT SENT AN ALREADY-INCLUSIVE SPLIT lands here too, rather than silently paying
    // the tip twice: $50 of split plus a $10 tip is $60 against a $50 payment.
    const inclusive = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: walk, amount: 50 }],
      tip: { bookingId: walk, amount: 10 },
      remainder: 0,
    });
    expect(inclusive.ok).toBe(false);

    // Nothing written on any of the three: no charge, and the source credit is whole.
    expect(chargeRows(raw)).toEqual([]);
    expect(paymentRows(raw)).toHaveLength(1);
    expect(paymentRows(raw)[0]).toMatchObject({ Id: paymentId, Amount: 50 });
  });

  it('refuses a zero, fractional or negative tip, and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40);
    const paymentId = (await credit(env, home.accountId, 50))!;
    const apply = (tipAmount: number, remainder: number) =>
      applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
        paymentId,
        accountId: home.accountId,
        splits: [{ bookingId: walk, amount: 40 }],
        tip: { bookingId: walk, amount: tipAmount },
        remainder,
      });

    // The whole-dollar cases CONSERVE on paper ($40 + tip + remainder = $50), so the tip's own rule
    // is the only thing that can refuse them. The fractional one cannot be made to conserve in
    // whole dollars at all, so it is paired with a whole remainder and the assertion below carries
    // the weight: the refusal must be the TIP's, not conservation's.
    for (const [bad, remainder] of [
      [0, 10],
      [2.5, 10],
      [-10, 20],
    ] as const) {
      const result = await apply(bad, remainder);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain(String(bad));
      expect(result.reason).toContain('a tip must be a whole number of dollars greater than zero');
    }

    expect(chargeRows(raw)).toEqual([]);
    expect(paymentRows(raw)).toHaveLength(1);
  });

  it("refuses a tip naming a booking that is not among this attribution's own splits", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40);
    // The same household's OTHER stay: a perfectly real booking of this account, so nothing but
    // the splits-membership rule stands between the sitter and a tip landing on a stay this
    // payment is not settling at all.
    const boarding = await book(env, home, 90, '2026-06-28');
    const paymentId = (await credit(env, home.accountId, 50))!;

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: walk, amount: 40 }],
      tip: { bookingId: boarding, amount: 10 },
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain(boarding);

    expect(chargeRows(raw)).toEqual([]);
    expect(paymentRows(raw)).toHaveLength(1);
  });

  it("refuses a tip on ANOTHER household's booking", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40);
    const neighbour = await household(env, raw, 'sam');
    const theirs = await book(env, neighbour, 90, '2026-06-28');
    const paymentId = (await credit(env, home.accountId, 50))!;

    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: walk, amount: 40 }],
      tip: { bookingId: theirs, amount: 10 },
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain(theirs);
    expect(result.reason).toContain(home.accountId);

    expect(chargeRows(raw)).toEqual([]);
    expect(paymentRows(raw)).toHaveLength(1);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, theirs)).toEqual([]);
  });

  it('does NOT let a tip raise the ceiling a split is checked against', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40);
    const paymentId = (await credit(env, home.accountId, 50))!;

    // $41 of split against a $40 outstanding, with a $9 tip to make it conserve. The tip raises
    // what the stay is expected to total, so a naive guard that compared the split against
    // `outstanding + tip` would wave this through and the walk would end $1 over-paid. The split
    // is checked against the PRE-TIP figure, because the tip funds only itself.
    const result = await applyAttribution(env.PAWSERVATION_DB, TENANT_C, {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: walk, amount: 41 }],
      tip: { bookingId: walk, amount: 9 },
      remainder: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('owes $40');
    expect(result.reason).toContain('$41');

    expect(chargeRows(raw)).toEqual([]);
    expect(paymentRows(raw)).toHaveLength(1);
  });

  it('rolls the tip back with everything else on a mid-batch failure', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40);
    const paymentId = (await credit(env, home.accountId, 50))!;
    const before = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C);

    // Same poison as the batch-atomicity test above: one doomed statement (`Amount = -1` violates
    // `CHECK (Amount > 0)`) spliced in before the LAST statement, which is the DELETE. The charge
    // and the split insert have both already run when it fires.
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
        splits: [{ bookingId: walk, amount: 40 }],
        tip: { bookingId: walk, amount: 10 },
        remainder: 0,
      }),
    ).rejects.toThrow();

    // A tip written without its payment is a broken ledger — so NO charge row, no booking payment,
    // and the original account-level credit whole.
    expect(chargeRows(raw)).toEqual([]);
    expect(await listPaymentsForBooking(env.PAWSERVATION_DB, TENANT_C, walk)).toEqual([]);
    const rows = paymentRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Id: paymentId,
      AccountId: home.accountId,
      BookingRequestId: null,
      Amount: 50,
    });
    expect(await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_C)).toEqual(before);
  });
});

/**
 * THE TWO READERS OF "WHAT DOES THIS BOOKING STILL OWE" MUST NOT DRIFT.
 *
 * `applyAttribution`'s overpay and membership guards used to ask `getHouseholdDetail` — six reads
 * to use one derived number per booking. They now ask `householdOutstandingByBooking`, which
 * answers in two. That is only a narrowing if the answer is IDENTICAL, and "identical" is not
 * something a doc comment can promise: the second reader's money expression, its charges join and
 * its one-booking-one-household attachment rule are three separate places it can silently start
 * meaning something else, each with a real defect behind it.
 *
 * So this asserts the map itself against the one derived from `getHouseholdDetail` — the reference
 * every other household figure on the Earnings page is built from — over a fixture that puts all
 * three properties under load at once. Mechanical rather than behavioural on purpose: a guard test
 * only covers the refusals somebody thought to write, whereas equality covers every booking shape
 * this fixture can hold, including the ones added to it later.
 */
describe('householdOutstandingByBooking agrees with getHouseholdDetail', () => {
  it("over a charge, a declined booking, an assessed cancellation fee and another household's booking on our pet", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');

    // 1. AN EXTRA CHARGE IS STILL OWED. $100 quoted plus a $25 charge — reading this as
    //    `BASE_AMOUNT_SQL` would put it at $100 and refuse a legitimate $125 split as overpayment.
    const charged = await book(env, home, 100, '2026-07-01');
    expect(
      await insertBookingCharge(env.PAWSERVATION_DB, TENANT_C, {
        bookingRequestId: charged,
        label: 'Late pickup',
        amount: 25,
      }),
    ).not.toBeNull();

    // 2. A DECLINED BOOKING MAY KEEP NOTHING. It took $50 while still pending, so its creditable
    //    amount is 0 and it sits at -$50 — never a candidate. Reading this as
    //    `EXPECTED_AMOUNT_SQL` would put it at +$50 and let a credit be attributed to a booking
    //    the sitter said no to.
    const declined = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_C, {
      endUserId: home.ownerId,
      serviceType: 'boarding',
      startDate: '2026-07-02',
      endDate: '2026-07-04',
      optionKey: 'standard',
      petCount: 1,
      estCost: 100,
      status: 'pending',
    });
    await addBookingPets(env.PAWSERVATION_DB, TENANT_C, declined, home.petIds);
    expect(
      await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
        bookingRequestId: declined,
        amount: 50,
        method: 'cash',
        paidDate: '2026-06-15',
        note: null,
        externalRef: null,
      }),
    ).not.toBeNull();
    expect(await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, declined, 'declined')).toBe(
      true,
    );

    // 3. A CANCELLED BOOKING CARRYING AN ASSESSED FEE IS A LIVE RECEIVABLE — worth its fee, not
    //    its old quote, and attributable exactly that far.
    const cancelled = await book(env, home, 200, '2026-07-03');
    expect(
      await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, cancelled, 'cancelled', 30),
    ).toBe(true);

    // 4. ANOTHER HOUSEHOLD'S BOOKING, ON OUR PET. It matches the candidate predicate (our pet is
    //    on it) but attaches to its CUSTOMER's household, so it is not ours to attribute against
    //    — returning the raw candidate superset instead of running the attachment rule would make
    //    someone else's booking settleable from this household's credit.
    const neighbour = await household(env, raw, 'sam');
    const theirs = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_C, {
      endUserId: neighbour.ownerId,
      serviceType: 'boarding',
      startDate: '2026-07-05',
      endDate: '2026-07-07',
      optionKey: 'standard',
      petCount: 2,
      estCost: 400,
      status: 'confirmed',
    });
    await addBookingPets(env.PAWSERVATION_DB, TENANT_C, theirs, [
      ...neighbour.petIds,
      ...home.petIds,
    ]);

    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    const fromDetail = new Map(
      (detail?.bookings ?? []).map((b) => [b.bookingId, b.expected - b.paidTotal]),
    );
    const lean = await householdOutstandingByBooking(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    expect(lean).toEqual(fromDetail);

    // Pinned absolutely as well as relatively: equality alone would still hold if BOTH readers
    // were mutated the same way, and an empty map equals an empty map.
    expect(lean).toEqual(
      new Map([
        [charged, 125], // $100 quoted + $25 charge, nothing paid
        [declined, -50], // may keep nothing, yet holds $50 — over-paid, never a candidate
        [cancelled, 30], // the assessed fee, not the $200 quote
      ]),
    );
    expect(lean.has(theirs)).toBe(false);
  });
});
