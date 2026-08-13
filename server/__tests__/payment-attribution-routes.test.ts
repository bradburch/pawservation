import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  addBookingPets,
  getHouseholdDetail,
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
    splits: { bookingId: string; amount: number; outstanding: number }[];
    remainder: number;
  }[];
  unresolved: {
    accountId: string;
    paymentId: string;
    reason: string;
    bookings: { bookingId: string; outstanding: number }[];
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

type ApplyAttributionInput = {
  paymentId: string;
  accountId: string;
  splits: { bookingId: string; amount: number }[];
  remainder: number;
};

type ApplyBody = {
  applied: number;
  skipped: { paymentId: string; reason: string }[];
};

async function apply(env: Env, tenantId: string, body: unknown) {
  return app.request(
    `/api/${SLUG_C}/admin/payments/attribute/apply`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await adminHeaders(tenantId)) },
      body: JSON.stringify(body),
    },
    env,
  );
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

  it('previewing every household loads the account graph ONCE, not once per household', async () => {
    const { env, raw } = createTestEnv();
    // Three households, each with real work to do, so a per-household reload would show up as a
    // per-household count rather than a constant.
    for (const key of ['jen', 'sam', 'ana']) {
      const home = await household(env, raw, key);
      await book(env, home, 100, '2026-07-01');
      await credit(env, home.accountId, 100);
    }

    // `loadAccountGraph` (server/db/repo.ts) reads `PetOwners` exactly twice per load — live
    // links and deceased links (`listOwnerPetLinks`/`listDeceasedOwnerPetLinks`). Counting
    // statements against that table is a direct proxy for "how many times was the graph loaded",
    // independent of how many other queries the per-household detail reads happen to issue.
    let graphQueries = 0;
    const counted = {
      prepare: (sql: string) => {
        if (sql.includes('FROM PetOwners po')) graphQueries++;
        return env.PAWSERVATION_DB.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => env.PAWSERVATION_DB.batch(statements),
    } as unknown as D1Database;
    const countedEnv = { ...env, PAWSERVATION_DB: counted };

    const res = await preview(countedEnv, TENANT_C);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;
    expect(body.proposals).toHaveLength(3); // sanity: all three households were genuinely read

    // Exactly ONE graph load (2 statements) for three households — not 3, not 6. A regression to
    // looping getHouseholdDetail/listPaymentsForAccount per household would make this scale with
    // household count instead of staying constant.
    expect(graphQueries).toBe(2);
  });
});

/**
 * SEQUENTIAL ATTRIBUTION WITHIN A HOUSEHOLD — a defect found against production data: the route
 * used to build `unpaidBookings` once per household and propose every one of that household's
 * credits against the SAME, never-decremented list. A household with three $40 credits and one
 * $40 unpaid booking got three proposals each allocating the full $40 to that one booking —
 * approving all three would pay $120 against a $40 stay. These tests pin the fix: credits within
 * a household are proposed in oldest-`PaidDate`-first order, each one's splits are subtracted from
 * the bookings it touched before the next credit is considered, and a booking that reaches 0
 * outstanding drops out of the candidate list for later credits.
 */
describe('POST /:slug/admin/payments/attribute/preview — sequential attribution within a household', () => {
  it('the core case: three $40 credits against one $40 booking — only the first is proposed', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 40, '2026-07-01');
    const first = (await credit(env, home.accountId, 40, '2026-06-01'))!;
    const second = (await credit(env, home.accountId, 40, '2026-06-02'))!;
    const third = (await credit(env, home.accountId, 40, '2026-06-03'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    // Exactly one proposal, against the oldest-paid credit, taking the booking's entire (single)
    // $40 outstanding.
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      paymentId: first,
      remainder: 0,
      splits: [{ bookingId, amount: 40 }],
    });

    // The other two credits find nothing left to attach to — the truth, not a failure.
    expect(body.unresolved).toHaveLength(2);
    const unresolvedIds = body.unresolved.map((u) => u.paymentId).sort();
    expect(unresolvedIds).toEqual([second, third].sort());
    for (const u of body.unresolved) expect(u.reason).toBe('no-unpaid-bookings');

    // The invariant, restated concretely: proposed money never exceeds actual outstanding.
    const totalProposed = body.proposals.reduce(
      (sum, p) => sum + p.splits.reduce((s, split) => s + split.amount, 0),
      0,
    );
    expect(totalProposed).toBeLessThanOrEqual(40);
  });

  it('partial consumption: a $100 booking against two $60 credits', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 100, '2026-07-01');
    const first = (await credit(env, home.accountId, 60, '2026-06-01'))!;
    const second = (await credit(env, home.accountId, 60, '2026-06-02'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(2);
    const byPaymentId = new Map(body.proposals.map((p) => [p.paymentId, p]));

    // The older credit takes the first $60 of the booking's $100 outstanding, in full.
    expect(byPaymentId.get(first)).toMatchObject({
      remainder: 0,
      splits: [{ bookingId, amount: 60 }],
    });
    // The younger credit sees only $40 of outstanding left, takes it all, and reports the $20 it
    // couldn't place as remainder.
    expect(byPaymentId.get(second)).toMatchObject({
      remainder: 20,
      splits: [{ bookingId, amount: 40 }],
    });
  });

  it('ordering is deterministic regardless of insertion order', async () => {
    const dates = ['2026-06-01', '2026-06-02', '2026-06-03'];

    async function run(insertOrder: number[]) {
      const { env, raw } = createTestEnv();
      const home = await household(env, raw, 'jen');
      const bookingId = await book(env, home, 40, '2026-07-01');
      const idByDateIndex = new Map<number, string>();
      for (const i of insertOrder) {
        idByDateIndex.set(i, (await credit(env, home.accountId, 40, dates[i]))!);
      }
      const res = await preview(env, TENANT_C, home.accountId);
      const body = (await res.json()) as PreviewBody;
      return { bookingId, idByDateIndex, body };
    }

    // Same three credits (same paid dates, same amounts), inserted in two different orders.
    const forward = await run([0, 1, 2]);
    const reversed = await run([2, 0, 1]);

    for (const { bookingId, idByDateIndex, body } of [forward, reversed]) {
      // Regardless of insertion order, the credit with the OLDEST paid date is the one that
      // settles the booking; the other two find nothing left.
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]).toMatchObject({
        paymentId: idByDateIndex.get(0),
        remainder: 0,
        splits: [{ bookingId, amount: 40 }],
      });
      expect(body.unresolved).toHaveLength(2);
      const unresolvedIds = body.unresolved.map((u) => u.paymentId).sort();
      expect(unresolvedIds).toEqual([idByDateIndex.get(1)!, idByDateIndex.get(2)!].sort());
    }
  });

  it('the invariant, stated once: proposed splits for a household never exceed its total outstanding', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const a = await book(env, home, 40, '2026-07-01');
    const b = await book(env, home, 25, '2026-07-10');
    await credit(env, home.accountId, 40, '2026-06-01');
    await credit(env, home.accountId, 40, '2026-06-02');
    await credit(env, home.accountId, 40, '2026-06-03');
    await credit(env, home.accountId, 30, '2026-06-04');

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    const totalOutstanding = 40 + 25; // bookings a and b
    const totalProposed = body.proposals.reduce(
      (sum, p) => sum + p.splits.reduce((s, split) => s + split.amount, 0),
      0,
    );
    expect(totalProposed).toBeLessThanOrEqual(totalOutstanding);
    // Sanity: every split lands on one of this household's two bookings.
    for (const p of body.proposals)
      for (const split of p.splits) expect([a, b]).toContain(split.bookingId);
  });

  it("a split's `outstanding` is the booking's genuinely live figure, not the batch-sequenced one earlier credits in this same preview left behind", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // One $600 booking, fully unpaid. Two unattached credits: an older $40 one and a younger
    // $600 one — the exact shape from the false-block this test pins: A proposes first, claims
    // $40, and decrements the household's own working copy of the booking's outstanding to $560
    // before B is ever considered. That $560 is an artifact of this preview proposing both
    // credits against each other in sequence — it is true only if the sitter applies this exact
    // batch, unedited. The booking's ACTUAL live outstanding, from the database, is $600 the
    // whole time; both splits must report that, not the sequenced figure.
    const bookingId = await book(env, home, 600, '2026-07-01');
    const older = (await credit(env, home.accountId, 40, '2026-06-01'))!;
    const younger = (await credit(env, home.accountId, 600, '2026-06-02'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(2);
    const byPaymentId = new Map(body.proposals.map((p) => [p.paymentId, p]));

    // The older credit's own proposed amount is still $40 (it can't propose more than it's
    // worth) — only the `outstanding` figure reported alongside it changes.
    expect(byPaymentId.get(older)).toMatchObject({
      remainder: 0,
      splits: [{ bookingId, amount: 40, outstanding: 600 }],
    });
    // The younger credit still proposes only $560 (the sequenced amount actually available to
    // IT, in this batch, is what drives the proposed split) — but the `outstanding` alongside
    // that split reads the booking's real, undecremented $600, not $560.
    expect(byPaymentId.get(younger)).toMatchObject({
      remainder: 40,
      splits: [{ bookingId, amount: 560, outstanding: 600 }],
    });
  });

  it('still offers an ambiguous credit a booking that an earlier credit in the same preview drove to zero', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // Same reasoning as the test above, one level up: WHICH bookings an ambiguous credit is
    // offered must also be decided by the live figure. `zeroed` is claimed in full by the older
    // credit, so its SEQUENCED outstanding is 0 by the time the younger credit is considered —
    // but the sitter may untick that older credit, and then `zeroed` is a perfectly legitimate
    // choice worth $100. Filtering the options on the sequenced value removed it from the list
    // entirely, so the sitter could not express that at all.
    const zeroed = await book(env, home, 100, '2026-07-01');
    const near = await book(env, home, 100, '2026-08-01');
    const alsoNear = await book(env, home, 100, '2026-08-05');
    // Nearest to 2026-06-01 is `zeroed` (30 days, vs 61 and 65), and $100 covers it exactly.
    await credit(env, home.accountId, 100, '2026-06-01');
    // Equidistant from `near` and `alsoNear` (2 days either way), and big enough to settle either
    // one in full but not both — the one shape the proposer refuses to decide, which is what
    // routes this credit into `unresolved` rather than resolving it or reporting a remainder.
    const tied = (await credit(env, home.accountId, 150, '2026-08-03'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    const ambiguous = body.unresolved.find((u) => u.paymentId === tied);
    expect(ambiguous?.reason).toBe('ambiguous');
    // All three bookings are offered, `zeroed` among them, each reporting its live outstanding.
    expect(new Map(ambiguous!.bookings.map((b) => [b.bookingId, b.outstanding]))).toEqual(
      new Map([
        [zeroed, 100],
        [near, 100],
        [alsoNear, 100],
      ]),
    );
  });
});

/**
 * THE APPLY ROUTE (Task 4) — `POST /:slug/admin/payments/attribute/apply` is the only code path
 * in this feature that moves money. It takes from the browser only WHICH payment goes on which
 * bookings and in what amounts, and re-derives everything else from live state through
 * `applyAttribution` (server/db/repo.ts, done and reviewed): the source payment is re-read, its
 * amount is the only authority, and a stale or over-claiming request is refused with a reason
 * rather than applied. A per-attribution failure is skipped, not fatal to the rest of the batch —
 * that is what makes a double-submit or a mixed-validity batch safe.
 */
describe('POST /:slug/admin/payments/attribute/apply', () => {
  it('a valid attribution applies and the household balance is unchanged', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 100, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 100))!;

    const before = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    expect(before?.balance).toBe(0); // fully covered by the household-level credit already

    const attribution: ApplyAttributionInput = {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId, amount: 100 }],
      remainder: 0,
    };
    const res = await apply(env, TENANT_C, { attributions: [attribution] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApplyBody;
    expect(body).toEqual({ applied: 1, skipped: [] });

    const after = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    expect(after?.balance).toBe(before?.balance);

    const rows = paymentRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ BookingRequestId: bookingId, AccountId: null, Amount: 100 });
  });

  it('a double-submit applies once', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 100, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 100))!;
    const attribution: ApplyAttributionInput = {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId, amount: 100 }],
      remainder: 0,
    };

    const first = await apply(env, TENANT_C, { attributions: [attribution] });
    expect(first.status).toBe(200);
    expect((await first.json()) as ApplyBody).toEqual({ applied: 1, skipped: [] });

    const second = await apply(env, TENANT_C, { attributions: [attribution] });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as ApplyBody;
    expect(secondBody.applied).toBe(0);
    expect(secondBody.skipped).toHaveLength(1);
    expect(secondBody.skipped[0].paymentId).toBe(paymentId);
    // The first call already deleted the source row, so the second's re-read of it finds nothing.
    expect(secondBody.skipped[0].reason).toContain('not a household-level payment');

    // Exactly one booking-level payment of $100 — the second call never duplicated the money.
    const rows = paymentRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ BookingRequestId: bookingId, AccountId: null, Amount: 100 });
  });

  it('an attribution whose splits do not sum is refused with nothing written', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 100, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 100))!;

    const before = paymentRows(raw);
    const attribution: ApplyAttributionInput = {
      paymentId,
      accountId: home.accountId,
      // $60 of splits + $0 remainder accounts for only $60 of a $100 payment.
      splits: [{ bookingId, amount: 60 }],
      remainder: 0,
    };
    const res = await apply(env, TENANT_C, { attributions: [attribution] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApplyBody;
    expect(body.applied).toBe(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].paymentId).toBe(paymentId);
    expect(body.skipped[0].reason).toContain('refusing rather than create or destroy money');

    expect(paymentRows(raw)).toEqual(before);
  });

  it("another tenant's payment is refused", async () => {
    const { env, raw } = createTestEnv();
    const foreignHome = await household(env, raw, 'jen', TENANT_A);
    const foreignBooking = await book(env, foreignHome, 100, '2026-07-01', 'confirmed', TENANT_A);
    const foreignPaymentId = (await credit(
      env,
      foreignHome.accountId,
      100,
      '2026-07-01',
      TENANT_A,
    ))!;

    const beforeForeign = paymentRows(raw, TENANT_A);
    const attribution: ApplyAttributionInput = {
      paymentId: foreignPaymentId,
      accountId: foreignHome.accountId,
      splits: [{ bookingId: foreignBooking, amount: 100 }],
      remainder: 0,
    };
    // Authenticated as TENANT_C, naming TENANT_A's own payment and household.
    const res = await apply(env, TENANT_C, { attributions: [attribution] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApplyBody;
    expect(body.applied).toBe(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].paymentId).toBe(foreignPaymentId);
    // Not just "some refusal" — specifically that TENANT_C's tenant-scoped re-read never found
    // TENANT_A's payment at all. Dropping tenant scoping from the source lookup would instead take
    // the foreign-booking path (also a refusal) and leave this assertion unable to tell the
    // difference; this pins the actual reason.
    expect(body.skipped[0].reason).toContain('not a household-level payment');

    expect(paymentRows(raw, TENANT_A)).toEqual(beforeForeign);
  });

  it('a malformed body is a 400 with nothing written, including a VALID attribution earlier in the same array', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 100, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 100))!;
    const other = await household(env, raw, 'sam');
    await book(env, other, 50, '2026-07-01');
    await credit(env, other.accountId, 50);

    const before = paymentRows(raw);
    const good: ApplyAttributionInput = {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId, amount: 100 }],
      remainder: 0,
    };
    // `splits` is not an array on the second item — malformed shape, not a semantically-refusable
    // attribution. A route that validated and applied each item in turn (rather than validating the
    // WHOLE body before applying ANY of it) would still apply `good` here and pass a test that only
    // checked for a malformed item alone; putting a valid item first is what makes this test able to
    // tell the difference.
    const res = await apply(env, TENANT_C, {
      attributions: [
        good,
        { paymentId: 'whatever', accountId: home.accountId, splits: 'nope', remainder: 0 },
      ],
    });
    expect(res.status).toBe(400);
    expect(paymentRows(raw)).toEqual(before);
  });

  it('a null element in attributions (or in a splits array) is a 400, not a 500', async () => {
    const { env } = createTestEnv();
    // `typeof null === 'object'`, so an unguarded property read on a null element throws instead
    // of failing the type check — this pins the fix rather than the crash.
    const res = await apply(env, TENANT_C, { attributions: [null] });
    expect(res.status).toBe(400);

    const res2 = await apply(env, TENANT_C, {
      attributions: [{ paymentId: 'p1', accountId: 'a1', splits: [null], remainder: 0 }],
    });
    expect(res2.status).toBe(400);
  });

  it('a batch that lands two credits on the same booking applies the first and refuses the second — the money is never doubled', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 100, '2026-07-01');
    const first = (await credit(env, home.accountId, 100, '2026-06-01'))!;
    const second = (await credit(env, home.accountId, 100, '2026-06-02'))!;

    const res = await apply(env, TENANT_C, {
      attributions: [
        {
          paymentId: first,
          accountId: home.accountId,
          splits: [{ bookingId, amount: 100 }],
          remainder: 0,
        },
        {
          paymentId: second,
          accountId: home.accountId,
          splits: [{ bookingId, amount: 100 }],
          remainder: 0,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApplyBody;
    expect(body.applied).toBe(1);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].paymentId).toBe(second);
    // The booking's own live outstanding, re-read after the first attribution committed — not a
    // generic conservation refusal, and not a membership refusal either (the booking IS this
    // household's; it just no longer owes $100 by the time the second attribution is checked).
    expect(body.skipped[0].reason).toContain(`Booking ${bookingId} owes $0`);

    // Exactly ONE $100 booking-level payment on the booking — the second attribution never landed
    // a second $100 on top of it. The second credit is still sitting, untouched, as a household-
    // level payment: applyAttribution refused before its own batch ever ran.
    const rows = paymentRows(raw);
    const bookingRows = rows.filter((r) => r.BookingRequestId === bookingId);
    expect(bookingRows).toHaveLength(1);
    expect(bookingRows[0].Amount).toBe(100);
    const householdRows = rows.filter((r) => r.AccountId === home.accountId);
    expect(householdRows).toHaveLength(1);
    expect(householdRows[0].Amount).toBe(100);

    // $100 expected, $200 paid ($100 on the booking + the second credit still sitting unclaimed at
    // the household level) — genuinely $100 in the household's favor, not zeroed out. The point is
    // this reads as an honest credit, not as an invisible $100 the booking silently absorbed twice.
    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    expect(detail?.balance).toBe(-100);
  });

  it('a mixed-validity batch — good, bad, good — applies both good ones and skips only the bad one', async () => {
    const { env, raw } = createTestEnv();
    const first = await household(env, raw, 'jen');
    const firstBooking = await book(env, first, 100, '2026-07-01');
    const firstPaymentId = (await credit(env, first.accountId, 100))!;

    const second = await household(env, raw, 'sam');
    const secondBooking = await book(env, second, 100, '2026-07-01');
    const secondPaymentId = (await credit(env, second.accountId, 100))!;

    const third = await household(env, raw, 'ana');
    const thirdBooking = await book(env, third, 75, '2026-07-01');
    const thirdPaymentId = (await credit(env, third.accountId, 75))!;

    const res = await apply(env, TENANT_C, {
      attributions: [
        {
          paymentId: firstPaymentId,
          accountId: first.accountId,
          splits: [{ bookingId: firstBooking, amount: 100 }],
          remainder: 0,
        },
        {
          // Splits don't sum to the $100 payment — refused on the merits, not malformed.
          paymentId: secondPaymentId,
          accountId: second.accountId,
          splits: [{ bookingId: secondBooking, amount: 40 }],
          remainder: 0,
        },
        {
          paymentId: thirdPaymentId,
          accountId: third.accountId,
          splits: [{ bookingId: thirdBooking, amount: 75 }],
          remainder: 0,
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApplyBody;
    expect(body.applied).toBe(2);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].paymentId).toBe(secondPaymentId);

    // The THIRD attribution's rows genuinely exist — a regression that returned early on the
    // second (bad) item, or a throw escaping the loop, would leave this booking still unpaid.
    const rows = paymentRows(raw);
    const thirdRows = rows.filter((r) => r.BookingRequestId === thirdBooking);
    expect(thirdRows).toHaveLength(1);
    expect(thirdRows[0].Amount).toBe(75);
    // The first attribution's rows exist too.
    const firstRows = rows.filter((r) => r.BookingRequestId === firstBooking);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0].Amount).toBe(100);
    // The second (refused) household-level credit is still sitting, unattributed.
    const secondRows = rows.filter((r) => r.Id === secondPaymentId);
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].AccountId).toBe(second.accountId);
  });
});

/**
 * THE READ COST OF A TENANT-WIDE PREVIEW — a production blocker, not a micro-optimisation.
 *
 * Cloudflare counts every binding call (each D1 query is one) against a per-invocation subrequest
 * ceiling — 50 on the Workers Free plan, the same budget `MAX_BACKFILL_EVENTS` and the CSV
 * importer's hoist to a constant 7 both exist to respect. The panel always previews TENANT-WIDE
 * (`AttributionPanel.tsx` never sends an `accountId`), so a per-household detail read made the
 * very first click on a real 53-household account issue ~216 prepares and fail outright.
 *
 * The fix is a CONSTANT read count, so these two assertions have to hold together:
 *
 *  - the prepare count is under `MAX_PREVIEW_PREPARES` for a tenant far larger than the one that
 *    broke — a reintroduced per-household query would add ~40 here and blow straight past it; and
 *  - the response body is EXACTLY what it was before the hoist, asserted whole rather than
 *    sampled, so a cheap-but-wrong implementation cannot buy its way under the ceiling. This
 *    fixture deliberately spans all three answers the route can give: multi-booking splits with a
 *    remainder, a sequenced household whose later credits find nothing left, and a household with
 *    no credit at all that must cost nothing and appear nowhere.
 */

/**
 * The ceiling one tenant-wide preview's D1 prepares must stay under, HOWEVER MANY HOUSEHOLDS the
 * tenant has. Deliberately generous next to what the route actually needs (the account graph, the
 * tenant's household payments, and one bulk read each for bookings, booking<->pet edges and
 * charges, plus the admin session lookup) and still far below Workers' 50: the gap is headroom for
 * an honest extra read, never for a per-household one, which at `READ_COST_HOUSEHOLDS` scale
 * cannot fit under this number by any margin.
 */
const MAX_PREVIEW_PREPARES = 20;

/** Households holding a credit in the read-cost fixture — comfortably past the 53-household
 *  account that hit the ceiling in production once the old 4-reads-each is applied to it. */
const READ_COST_HOUSEHOLDS = 40;

/** Wraps a test env's D1 so every `prepare` is counted, exactly as the production measurement did. */
function countingEnv(env: Env): { env: Env; prepares: () => number } {
  let count = 0;
  const counted = {
    prepare: (sql: string) => {
      count++;
      return env.PAWSERVATION_DB.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => env.PAWSERVATION_DB.batch(statements),
  } as unknown as D1Database;
  return { env: { ...env, PAWSERVATION_DB: counted }, prepares: () => count };
}

describe('POST /:slug/admin/payments/attribute/preview — read cost', () => {
  it('a tenant-wide preview costs a CONSTANT number of D1 prepares, and returns the same body', async () => {
    const { env, raw } = createTestEnv();

    // Forty ordinary households: two unpaid bookings at distinct distances from the credit's paid
    // date (so the split order is proximity, never a tie) and one credit that overshoots both.
    const homes: { home: Household; near: string; far: string; paymentId: string }[] = [];
    for (let i = 0; i < READ_COST_HOUSEHOLDS; i++) {
      const home = await household(env, raw, `h${String(i).padStart(2, '0')}`);
      const near = await book(env, home, 100, '2026-06-30');
      const far = await book(env, home, 60, '2026-07-05');
      const paymentId = (await credit(env, home.accountId, 200))!;
      homes.push({ home, near, far, paymentId });
    }

    // One household whose three credits chase a single $40 booking: the first settles it, the
    // other two have nothing left to claim. Pins the sequenced-vs-live outstanding separation
    // inside the bulk path — the later credits are unresolved, yet each still OFFERS the booking
    // at its LIVE $40, because a sitter may untick the first credit.
    const seq = await household(env, raw, 'seq');
    const seqBooking = await book(env, seq, 40, '2026-07-01');
    const seqFirst = (await credit(env, seq.accountId, 40, '2026-06-01'))!;
    const seqSecond = (await credit(env, seq.accountId, 40, '2026-06-02'))!;
    const seqThird = (await credit(env, seq.accountId, 40, '2026-06-03'))!;

    // A household with an unpaid booking and NO credit: it must appear nowhere in the response,
    // and a constant-cost reader must not pay a detail read for it either.
    const quiet = await household(env, raw, 'zzz');
    await book(env, quiet, 500, '2026-07-01');

    const counted = countingEnv(env);
    const res = await preview(counted.env, TENANT_C);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    // Households are read in account-id order (`buildAccounts` sorts them), so the response order
    // is pinned too: p_h00…p_h39, then p_seq. p_zzz never appears.
    const expected = {
      proposals: [
        ...homes.map((h) => ({
          accountId: h.home.accountId,
          paymentId: h.paymentId,
          amount: 200,
          paidDate: '2026-07-01',
          splits: [
            {
              bookingId: h.near,
              amount: 100,
              serviceType: 'boarding',
              startDate: '2026-06-30',
              status: 'confirmed',
              outstanding: 100,
            },
            {
              bookingId: h.far,
              amount: 60,
              serviceType: 'boarding',
              startDate: '2026-07-05',
              status: 'confirmed',
              outstanding: 60,
            },
          ],
          remainder: 40,
        })),
        {
          accountId: seq.accountId,
          paymentId: seqFirst,
          amount: 40,
          paidDate: '2026-06-01',
          splits: [
            {
              bookingId: seqBooking,
              amount: 40,
              serviceType: 'boarding',
              startDate: '2026-07-01',
              status: 'confirmed',
              outstanding: 40,
            },
          ],
          remainder: 0,
        },
      ],
      unresolved: [seqSecond, seqThird].map((paymentId, index) => ({
        accountId: seq.accountId,
        paymentId,
        amount: 40,
        paidDate: `2026-06-0${index + 2}`,
        reason: 'no-unpaid-bookings',
        detail: `No unpaid bookings to attribute payment ${paymentId} against.`,
        bookings: [
          {
            bookingId: seqBooking,
            serviceType: 'boarding',
            startDate: '2026-07-01',
            status: 'confirmed',
            outstanding: 40,
          },
        ],
      })),
    };
    expect(body).toEqual(expected);

    expect(counted.prepares()).toBeLessThan(MAX_PREVIEW_PREPARES);
  });
});
