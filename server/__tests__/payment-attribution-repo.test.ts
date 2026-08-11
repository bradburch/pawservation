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

  it('refuses when a derived ExternalRef collides with one the tenant already holds', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const first = await book(env, home, 100, '2026-06-28');
    const second = await book(env, home, 60, '2026-07-04');
    // A payment already carrying the ref this attribution's FIRST split would derive.
    await credit(env, home.accountId, 25, 'venmo-7788:1');
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
    expect(rows.map((r) => r.ExternalRef).sort()).toEqual(['venmo-7788', 'venmo-7788:1']);
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
});
