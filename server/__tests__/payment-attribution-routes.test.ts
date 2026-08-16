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
import { MAX_ATTRIBUTIONS_PER_REQUEST } from '../../src/shared/index.js';
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

/**
 * A SINGLE-DAY booking — one walk, on `startDate`, `EndDate` NULL. That is what every test in this
 * file that says "a stay on 2026-07-05" actually means, and it is the shape proximity was measured
 * against before it became an interval, so every distance below is exactly the number it was.
 *
 * It used to say `boarding` with a fixed `endDate: '2030-01-03'` bearing no relation to its own
 * start — invisible while only the start date mattered, and a lie the moment proximity began
 * measuring to the whole stay: a 2023 walk that "ends" in 2030 contains every payment date this
 * file uses and is 0 days from all of them. Use `bookStay` when a test means a real range.
 */
async function book(
  env: Env,
  home: Household,
  estCost: number,
  // Seven days after `credit()`'s default `paidDate` (2026-07-01), so inside the tighter
  // MAX_PREPAYMENT_DAYS window that governs a stay AHEAD of the payment — and so a test
  // that takes both defaults gets a PROPOSAL. A far-future default silently produced
  // `no-recent-booking` instead, which reads as a broken fixture rather than the floor working.
  startDate = '2026-07-08',
  status: 'pending' | 'confirmed' = 'confirmed',
  tenantId = TENANT_C,
): Promise<string> {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: home.ownerId,
    serviceType: 'walk',
    startDate,
    endDate: null,
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status,
  });
  await addBookingPets(env.PAWSERVATION_DB, tenantId, id, home.petIds);
  return id;
}

/** A RANGE-shaped stay — house sitting, `EndDate` the exclusive checkout. */
async function bookStay(
  env: Env,
  home: Household,
  estCost: number,
  startDate: string,
  endDate: string,
  tenantId = TENANT_C,
): Promise<string> {
  const id = await insertBookingRequest(env.PAWSERVATION_DB, tenantId, {
    endUserId: home.ownerId,
    serviceType: 'housesitting',
    startDate,
    endDate,
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status: 'confirmed',
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
    splits: {
      bookingId: string;
      amount: number;
      outstanding: number;
      endDate: string | null;
    }[];
    remainder: number;
  }[];
  unresolved: {
    accountId: string;
    paymentId: string;
    amount: number;
    reason: string;
    detail: string;
    bookings: { bookingId: string; outstanding: number; endDate: string | null }[];
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
  /** Part of this payment the client meant as a tip, recorded as a `BookingCharges` row on one of
   *  the bookings this attribution's own splits name. The split stays EXCLUSIVE of it. */
  tip?: { bookingId: string; amount: number };
};

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
    // Both bookings start the same day, one day BEFORE the credit's paid date — same distance on
    // the same side of the payment, so proximity cannot separate them — and $100 covers only one
    // of the two $100 bookings: a genuine tie the credit cannot fully resolve.
    const before = await book(env, home, 100, '2026-06-30');
    const after = await book(env, home, 100, '2026-06-30');
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

  it("a second tenant's households, bookings and credits are invisible to a tenant-wide preview", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const booking = await book(env, home, 100, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 250))!;

    // TENANT_A: a fully independent household, with its own booking and its own credit — ordinary
    // data that must never surface in TENANT_C's tenant-wide preview.
    const foreignHome = await household(env, raw, 'zeke', TENANT_A);
    const foreignBooking = await book(env, foreignHome, 500, '2026-07-01', 'confirmed', TENANT_A);
    const foreignPaymentId = (await credit(
      env,
      foreignHome.accountId,
      500,
      '2026-07-01',
      TENANT_A,
    ))!;

    // A booking tagged TENANT_A but pointed at TENANT_C's OWN household (`home`'s real owner and
    // pet) — the exact row shape `WHERE b.TenantId = ?` exists to exclude. `foreignHome` above
    // can't discriminate the bulk queries' tenant scoping on its own: an unrelated tenant's
    // owner/pet ids never match this tenant's account graph, so its booking falls out as
    // unattached whether or not the SQL filters by tenant (`buildHouseholdBalances` drops any
    // booking whose owner/pets resolve to no household). This one reuses `home`'s real ids, so
    // ONLY the TenantId predicate stands between it and `jen`'s statement — if the bulk read ever
    // stops filtering by tenant, this $999 booking joins the split below.
    const crossTenantBooking = await book(env, home, 999, '2026-07-02', 'confirmed', TENANT_A);

    const res = await preview(env, TENANT_C);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(1);
    const proposal = body.proposals[0];
    expect(proposal.accountId).toBe(home.accountId);
    expect(proposal.paymentId).toBe(paymentId);
    // $250 credit against ONLY the $100 real booking — $150 left over, not applied to the
    // cross-tenant booking that a leaking read would have offered it to.
    expect(proposal.remainder).toBe(150);
    expect(proposal.splits).toEqual([
      {
        bookingId: booking,
        amount: 100,
        serviceType: 'walk',
        startDate: '2026-07-01',
        endDate: null,
        status: 'confirmed',
        outstanding: 100,
      },
    ]);

    const bookingIdsInBody = new Set(
      body.proposals.flatMap((p) => p.splits.map((s) => s.bookingId)),
    );
    expect(bookingIdsInBody.has(crossTenantBooking)).toBe(false);
    expect(bookingIdsInBody.has(foreignBooking)).toBe(false);
    expect(body.proposals.some((p) => p.accountId === foreignHome.accountId)).toBe(false);
    expect(body.proposals.some((p) => p.paymentId === foreignPaymentId)).toBe(false);
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
 * a household are proposed ONE AT A TIME (the closest-pair order below decides which goes next),
 * each one's splits are subtracted from the bookings it touched before the next is considered, and a booking that reaches 0
 * outstanding drops out of the candidate list for later credits.
 */
describe('POST /:slug/admin/payments/attribute/preview — sequential attribution within a household', () => {
  it('the core case: three $40 credits against one $40 booking — only ONE is proposed', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 40, '2026-07-01');
    const first = (await credit(env, home.accountId, 40, '2026-06-01'))!;
    const second = (await credit(env, home.accountId, 40, '2026-06-02'))!;
    const third = (await credit(env, home.accountId, 40, '2026-06-03'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    // Exactly one proposal, taking the booking's entire (single) $40 outstanding. WHICH credit is
    // the closest-pair question and is pinned in its own describe below: `third`, 28 days from
    // the stay, is nearer to it than either of the other two.
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      paymentId: third,
      remainder: 0,
      splits: [{ bookingId, amount: 40 }],
    });

    // The other two credits find nothing left to attach to — the truth, not a failure.
    expect(body.unresolved).toHaveLength(2);
    const unresolvedIds = body.unresolved.map((u) => u.paymentId).sort();
    expect(unresolvedIds).toEqual([first, second].sort());
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

    // The credit NEARER the stay (06-02, 29 days from it) takes the first $60 of the booking's
    // $100 outstanding, in full.
    expect(byPaymentId.get(second)).toMatchObject({
      remainder: 0,
      splits: [{ bookingId, amount: 60 }],
    });
    // The farther credit sees only $40 of outstanding left, takes it all, and reports the $20 it
    // couldn't place as remainder.
    expect(byPaymentId.get(first)).toMatchObject({
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
      // Regardless of insertion order, the credit paid NEAREST the stay is the one that settles
      // it; the other two find nothing left.
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]).toMatchObject({
        paymentId: idByDateIndex.get(2),
        remainder: 0,
        splits: [{ bookingId, amount: 40 }],
      });
      expect(body.unresolved).toHaveLength(2);
      const unresolvedIds = body.unresolved.map((u) => u.paymentId).sort();
      expect(unresolvedIds).toEqual([idByDateIndex.get(0)!, idByDateIndex.get(1)!].sort());
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
    // One $600 booking, fully unpaid. Two unattached credits: a $40 one paid 06-02 and a $600 one
    // paid 06-01 — so the small credit is the NEARER of the two and is proposed first, which is
    // the exact shape of the false-block this test pins: A proposes first, claims $40, and
    // decrements the household's own working copy of the booking's outstanding to $560 before B
    // is ever considered. That $560 is an artifact of this preview proposing both credits against
    // each other in sequence — it is true only if the sitter applies this exact batch, unedited.
    // The booking's ACTUAL live outstanding, from the database, is $600 the whole time; both
    // splits must report that, not the sequenced figure.
    const bookingId = await book(env, home, 600, '2026-07-01');
    const farther = (await credit(env, home.accountId, 600, '2026-06-01'))!;
    const nearer = (await credit(env, home.accountId, 40, '2026-06-02'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(2);
    const byPaymentId = new Map(body.proposals.map((p) => [p.paymentId, p]));

    // The nearer credit's own proposed amount is still $40 (it can't propose more than it's
    // worth) — only the `outstanding` figure reported alongside it changes.
    expect(byPaymentId.get(nearer)).toMatchObject({
      remainder: 0,
      splits: [{ bookingId, amount: 40, outstanding: 600 }],
    });
    // The farther credit still proposes only $560 (the sequenced amount actually available to
    // IT, in this batch, is what drives the proposed split) — but the `outstanding` alongside
    // that split reads the booking's real, undecremented $600, not $560.
    expect(byPaymentId.get(farther)).toMatchObject({
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
    const alsoNear = await book(env, home, 100, '2026-08-01');
    // Nearest to 2026-07-05 is `zeroed` (4 days before it; the other two are 27 days after), and
    // $100 covers it exactly. 4 days is also the SHORTEST nearest-distance of the two credits
    // here, so this is the credit the closest-pair ordering proposes first — which is what
    // actually drives `zeroed` to a sequenced 0 before the tied credit below is considered.
    await credit(env, home.accountId, 100, '2026-07-05');
    // `near` and `alsoNear` both start 5 days before this credit's paid date — the same distance
    // on the same side of it — and it is big enough to settle either one in full but not both:
    // the one shape the proposer refuses to decide, which is what routes this credit into
    // `unresolved` rather than resolving it or reporting a remainder.
    const tied = (await credit(env, home.accountId, 150, '2026-08-06'))!;

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
 * WHICH CREDIT GOES NEXT — the sequencing above conserves money correctly and still lands it on
 * the wrong stay, because it processes a household's credits oldest-`PaidDate` first and lets each
 * one take its own nearest stay before the next is considered. Every credit optimises for itself
 * and whoever goes first gets first pick; nothing ever compares "0 days" against "28 days" ACROSS
 * credits.
 *
 * The sitter named the case: one client "almost always pays same day", and her data agrees — three
 * July walks with a payment on or beside each of them. Oldest-first proposed a June credit 28 days
 * away for the first walk, consumed it, and by the time the same-day credits were reached every
 * walk they matched was gone.
 *
 * So the household's credits are now ordered by CLOSEST PAIR: repeatedly propose the credit whose
 * nearest still-available stay is nearest, not the credit that was paid earliest. Oldest-paid-first
 * survives only as the TIE-BREAK, which is what keeps the result stable across runs.
 */
describe('POST /:slug/admin/payments/attribute/preview — closest pair goes first', () => {
  it('a stay is settled by the credit nearest it, not by the oldest credit that reaches it', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // Three weekly walks, each $40, all unpaid.
    const walk16 = await book(env, home, 40, '2026-07-16');
    const walk23 = await book(env, home, 40, '2026-07-23');
    const walk30 = await book(env, home, 40, '2026-07-30');
    // Five $40 credits. Two June ones that reach the 07-16 walk only through the 30-day
    // prepayment window (28 and 21 days ahead of it), and three that sit on or beside a walk.
    const june18 = (await credit(env, home.accountId, 40, '2026-06-18'))!;
    const june25 = (await credit(env, home.accountId, 40, '2026-06-25'))!;
    const july17 = (await credit(env, home.accountId, 40, '2026-07-17'))!;
    const july23 = (await credit(env, home.accountId, 40, '2026-07-23'))!;
    const july30 = (await credit(env, home.accountId, 40, '2026-07-30'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    // Every walk goes to the credit that obviously paid it: two same-day matches at distance 0,
    // and the 07-17 credit one day after the walk it settled.
    expect(body.proposals).toHaveLength(3);
    const byPaymentId = new Map(body.proposals.map((p) => [p.paymentId, p]));
    expect(byPaymentId.get(july23)).toMatchObject({
      remainder: 0,
      splits: [{ bookingId: walk23, amount: 40 }],
    });
    expect(byPaymentId.get(july30)).toMatchObject({
      remainder: 0,
      splits: [{ bookingId: walk30, amount: 40 }],
    });
    expect(byPaymentId.get(july17)).toMatchObject({
      remainder: 0,
      splits: [{ bookingId: walk16, amount: 40 }],
    });

    // And the June credits — the ones oldest-first proposed for all three walks — are proposed for
    // nothing at all. They are still placeable by hand; they are simply not the automatic answer.
    expect(body.unresolved.map((u) => u.paymentId).sort()).toEqual([june18, june25].sort());
    for (const u of body.unresolved) expect(u.reason).toBe('no-unpaid-bookings');
  });

  it('a same-day credit beats an older one outright, whichever was inserted first', async () => {
    // The single comparison the old ordering never made: 0 days against 28. Run both insertion
    // orders, because "the same-day credit happened to be inserted second" must not be what
    // decides it.
    async function run(sameDayFirst: boolean) {
      const { env, raw } = createTestEnv();
      const home = await household(env, raw, 'jen');
      const walk = await book(env, home, 40, '2026-07-30');
      const ids = sameDayFirst
        ? {
            sameDay: (await credit(env, home.accountId, 40, '2026-07-30'))!,
            older: (await credit(env, home.accountId, 40, '2026-07-02'))!,
          }
        : {
            older: (await credit(env, home.accountId, 40, '2026-07-02'))!,
            sameDay: (await credit(env, home.accountId, 40, '2026-07-30'))!,
          };
      const res = await preview(env, TENANT_C, home.accountId);
      expect(res.status).toBe(200);
      return { walk, ids, body: (await res.json()) as PreviewBody };
    }

    for (const { walk, ids, body } of [await run(true), await run(false)]) {
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]).toMatchObject({
        paymentId: ids.sameDay,
        remainder: 0,
        splits: [{ bookingId: walk, amount: 40 }],
      });
      expect(body.unresolved).toHaveLength(1);
      expect(body.unresolved[0].paymentId).toBe(ids.older);
    }
  });

  it('the closest-pair allocation is identical whatever order the credits were inserted in', async () => {
    // The same five credits and three walks as the first test, inserted in three different
    // orders: ranking by nearest distance must be a property of the DATA, not of `Payments`
    // insertion order or of whatever `listPaymentsForAccount` happens to return.
    const paidDates = ['2026-06-18', '2026-06-25', '2026-07-17', '2026-07-23', '2026-07-30'];

    async function run(insertOrder: number[]) {
      const { env, raw } = createTestEnv();
      const home = await household(env, raw, 'jen');
      const walks = [
        await book(env, home, 40, '2026-07-16'),
        await book(env, home, 40, '2026-07-23'),
        await book(env, home, 40, '2026-07-30'),
      ];
      const idByDateIndex = new Map<number, string>();
      for (const i of insertOrder)
        idByDateIndex.set(i, (await credit(env, home.accountId, 40, paidDates[i]))!);
      const res = await preview(env, TENANT_C, home.accountId);
      const body = (await res.json()) as PreviewBody;
      // Rendered as date-index → walk-index pairs so two runs with different generated ids are
      // directly comparable.
      const allocation = body.proposals
        .map((p) => {
          const dateIndex = [...idByDateIndex].find(([, id]) => id === p.paymentId)![0];
          return `${dateIndex}->${p.splits.map((s) => walks.indexOf(s.bookingId)).join(',')}`;
        })
        .sort();
      const unresolvedIndexes = body.unresolved
        .map((u) => [...idByDateIndex].find(([, id]) => id === u.paymentId)![0])
        .sort();
      return { allocation, unresolvedIndexes };
    }

    const forward = await run([0, 1, 2, 3, 4]);
    expect(forward.allocation).toEqual(['2->0', '3->1', '4->2']);
    expect(forward.unresolvedIndexes).toEqual([0, 1]);
    expect(await run([4, 3, 2, 1, 0])).toEqual(forward);
    expect(await run([2, 0, 4, 1, 3])).toEqual(forward);
  });

  it('credits whose nearest stays are equally close fall back to oldest-paid-first', async () => {
    // One stay, two credits exactly five days from it — one before, one after. Nothing about
    // distance separates them, so the old rule decides, and it decides the same way every run.
    // (Direction is the PROPOSER's tie-break between two stays for one credit; between two
    // CREDITS the ranking is distance alone, then paid date, then payment id.)
    async function run(reversed: boolean) {
      const { env, raw } = createTestEnv();
      const home = await household(env, raw, 'jen');
      const walk = await book(env, home, 40, '2026-07-15');
      const dates = reversed ? ['2026-07-20', '2026-07-10'] : ['2026-07-10', '2026-07-20'];
      const idByDate = new Map<string, string>();
      for (const d of dates) idByDate.set(d, (await credit(env, home.accountId, 40, d))!);
      const res = await preview(env, TENANT_C, home.accountId);
      return { walk, idByDate, body: (await res.json()) as PreviewBody };
    }

    for (const { walk, idByDate, body } of [await run(false), await run(true)]) {
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0]).toMatchObject({
        paymentId: idByDate.get('2026-07-10'),
        splits: [{ bookingId: walk, amount: 40 }],
      });
      expect(body.unresolved).toHaveLength(1);
      expect(body.unresolved[0].paymentId).toBe(idByDate.get('2026-07-20'));
    }
  });

  it('re-ordering never over-allocates: proposed splits still never exceed the household total', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // Every credit is near every stay, so the ranking genuinely reshuffles them — and the
    // decrement the ranking rides on still has to hold the total down.
    const a = await book(env, home, 40, '2026-07-16');
    const b = await book(env, home, 25, '2026-07-23');
    for (const paidDate of ['2026-07-16', '2026-07-20', '2026-07-23', '2026-07-24'])
      await credit(env, home.accountId, 40, paidDate);

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    const totalProposed = body.proposals.reduce(
      (sum, p) => sum + p.splits.reduce((s, split) => s + split.amount, 0),
      0,
    );
    expect(totalProposed).toBeLessThanOrEqual(40 + 25);
    for (const p of body.proposals)
      for (const split of p.splits) expect([a, b]).toContain(split.bookingId);
  });
});

/**
 * A SPILL MAY NOT TAKE A STAY SOME OTHER CREDIT IS SITTING ON — the half of closest-pair the
 * ranking above cannot reach.
 *
 * Ranking decides which credit gets the FIRST stay. But `proposeAttribution` is pure and per-credit:
 * once a credit is proposed it spills greedily onto every further stay inside `MAX_SPILL_DAYS` it
 * can settle in full, and nothing inside it can ask whether some other credit of the same household
 * matches those stays better. So the winner of round one could eat a stay a not-yet-proposed credit
 * was paid ON, and that credit came back `no-unpaid-bookings`.
 *
 * The fix is a filter in the route, where the household's whole credit pool lives: before proposing
 * a credit, drop from its candidate list any stay a DIFFERENT, not-yet-proposed credit is STRICTLY
 * closer to (same `intervalDistance`, same windows — one notion of closeness). Strictly, so an equal
 * distance leaves the stay with the credit being proposed and the existing ranking (and its
 * oldest-paid-first tie-break) still decides everything.
 */
describe('POST /:slug/admin/payments/attribute/preview — a spill never takes a closer credit’s stay', () => {
  it('a stay is left for the credit paid on its own date, not swallowed by an earlier credit’s spill', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    // The live shape this regressed on: a boarding the $280 was plainly paid for (the payment lands
    // on its checkout day, 0 days from the stay), and a pack walk nine days later with a $50 paid
    // ON it. Without the filter the $280 takes the boarding and then spills 9 days forward onto the
    // walk — inside MAX_SPILL_DAYS and settling it in full — and the $50 reports
    // `no-unpaid-bookings`.
    const boarding = await bookStay(env, home, 100, '2026-07-17', '2026-07-20');
    const walk = await book(env, home, 40, '2026-07-29');
    const big = (await credit(env, home.accountId, 280, '2026-07-20'))!;
    const sameDay = (await credit(env, home.accountId, 50, '2026-07-29'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(2);
    const byPaymentId = new Map(body.proposals.map((p) => [p.paymentId, p]));
    // The $280 settles the boarding and stops: the walk is not its to take.
    expect(byPaymentId.get(big)).toMatchObject({
      splits: [{ bookingId: boarding, amount: 100 }],
      remainder: 180,
    });
    expect(byPaymentId.get(big)!.splits.some((s) => s.bookingId === walk)).toBe(false);
    // And the credit paid on the walk's own day gets the walk.
    expect(byPaymentId.get(sameDay)).toMatchObject({
      splits: [{ bookingId: walk, amount: 40 }],
      remainder: 10,
    });
  });

  it('a bundled payment still spills across a fortnight of walks when no other credit is closer', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jenna');
    // The good spill the sitter named — three weekly walks settled by one transfer. Nothing else is
    // near them, so the filter must remove nothing at all: an exclusion that ignored "a DIFFERENT
    // credit" and compared the credit against itself would strand two of these three.
    const first = await book(env, home, 40, '2026-07-20');
    const second = await book(env, home, 40, '2026-07-24');
    const third = await book(env, home, 40, '2026-07-28');
    const paymentId = (await credit(env, home.accountId, 120, '2026-07-30'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ paymentId, remainder: 0 });
    expect(new Map(body.proposals[0].splits.map((s) => [s.bookingId, s.amount]))).toEqual(
      new Map([
        [third, 40],
        [second, 40],
        [first, 40],
      ]),
    );
  });

  it('an equally-distant credit does NOT take the spill away — the proposed credit keeps it', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'even');
    // `contested` is exactly 5 days from BOTH credits — 5 days ahead of the one paid 07-20, 5 days
    // behind the one paid 07-30. Equal is not closer, so the credit being proposed keeps it and the
    // spill stands. If the filter ever read "closer or equal", the $100 would settle `own` alone
    // and report a $60 remainder instead.
    const own = await book(env, home, 40, '2026-07-20');
    const contested = await book(env, home, 40, '2026-07-25');
    const proposed = (await credit(env, home.accountId, 100, '2026-07-20'))!;
    const equidistant = (await credit(env, home.accountId, 40, '2026-07-30'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ paymentId: proposed, remainder: 20 });
    expect(new Map(body.proposals[0].splits.map((s) => [s.bookingId, s.amount]))).toEqual(
      new Map([
        [own, 40],
        [contested, 40],
      ]),
    );
    // The other credit is left with nothing to claim — the ordinary sequencing outcome, and still
    // placeable by hand.
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatchObject({
      paymentId: equidistant,
      reason: 'no-unpaid-bookings',
    });
  });

  it('the closer credit actually collects the stay withheld from the spill, in a later round', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'later');
    // The withheld stay must not be stranded: `late` is 3 days from `second` and 11 days from
    // `first`, so `second` is not offered to the big credit — and `late`, ranked second because its
    // own nearest stay is 3 days out rather than 0, must then pick it up.
    const firstWalk = await book(env, home, 40, '2026-07-10');
    const secondWalk = await book(env, home, 40, '2026-07-18');
    const big = (await credit(env, home.accountId, 200, '2026-07-10'))!;
    const late = (await credit(env, home.accountId, 60, '2026-07-21'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    const byPaymentId = new Map(body.proposals.map((p) => [p.paymentId, p]));
    expect(byPaymentId.get(big)).toMatchObject({
      splits: [{ bookingId: firstWalk, amount: 40 }],
      remainder: 160,
    });
    expect(byPaymentId.get(late)).toMatchObject({
      splits: [{ bookingId: secondWalk, amount: 40 }],
      remainder: 20,
    });
  });

  it('the exclusion is a property of the data, not of the order the credits were inserted in', async () => {
    // Kelly's fixture again, both insertion orders: the filter reads the pool, and the pool is
    // sorted, so the allocation may not depend on which credit `Payments` happens to return first.
    async function run(bigFirst: boolean) {
      const { env, raw } = createTestEnv();
      const home = await household(env, raw, 'kelly');
      const boarding = await bookStay(env, home, 100, '2026-07-17', '2026-07-20');
      await book(env, home, 40, '2026-07-29');
      const ids = bigFirst
        ? {
            big: (await credit(env, home.accountId, 280, '2026-07-20'))!,
            sameDay: (await credit(env, home.accountId, 50, '2026-07-29'))!,
          }
        : {
            sameDay: (await credit(env, home.accountId, 50, '2026-07-29'))!,
            big: (await credit(env, home.accountId, 280, '2026-07-20'))!,
          };
      const res = await preview(env, TENANT_C, home.accountId);
      const body = (await res.json()) as PreviewBody;
      // Rendered by role rather than by generated id, so the two runs compare directly.
      return body.proposals
        .map(
          (p) =>
            `${p.paymentId === ids.big ? 'big' : 'sameDay'}->${p.splits
              .map((s) => `${s.bookingId === boarding ? 'boarding' : 'walk'}:${s.amount}`)
              .join(',')}+${p.remainder}`,
        )
        .sort();
    }

    const forward = await run(true);
    expect(forward).toEqual(['big->boarding:100+180', 'sameDay->walk:40+10']);
    expect(await run(false)).toEqual(forward);
  });
});

/**
 * PLACING A CREDIT THE SEQUENCING LEFT WITH NOTHING — the override the design demands and the
 * sequential decrement, on its own, forecloses.
 *
 * The decrement above is a critical fix and stays exactly as it is: without it several credits
 * each claim the same booking's full outstanding. Its side effect is that every credit after the
 * first gets `no-unpaid-bookings` — which is automatic-with-no-override, the guess
 * `docs/superpowers/specs/2026-08-10-payment-attribution-design.md` rejects in as many words
 * ("Picking the earlier one because it sorted first is exactly the guess this product does not
 * make"). Money conserves either way; the attribution simply lands on the wrong stay.
 *
 * The fix is a contract, not a new proposal: `unresolved[].bookings` means ONE thing on every
 * reason that carries it — "the candidates this credit could still be placed on, each with its
 * LIVE outstanding." So a `no-unpaid-bookings` credit whose household still has live-outstanding
 * bookings names them and is actionable; one whose household has none at all names nothing and is
 * genuinely inert (772 of 821 on the live tenant). The server proposes nothing extra and decides
 * everything: the sitter's pick goes through the ordinary apply route, which re-derives and
 * re-validates against live state exactly as before.
 */
describe('POST /:slug/admin/payments/attribute/preview — placing a credit the sequencing skipped', () => {
  it('a credit the sequencing left with nothing still names the household’s live-outstanding bookings', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // The live tenant's shape: one $40 booking, three $40 credits. The nearest to the stay is
    // proposed; the other two must still be placeable, because the sitter may know it was the
    // FIRST that paid this stay and unticking the proposal has to surface it.
    const bookingId = await book(env, home, 40, '2026-07-01');
    const first = (await credit(env, home.accountId, 40, '2026-06-01'))!;
    const second = (await credit(env, home.accountId, 40, '2026-06-02'))!;
    const third = (await credit(env, home.accountId, 40, '2026-06-03'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    // The sequencing is untouched — still exactly one proposal, now the nearest credit.
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ paymentId: third });

    expect(body.unresolved).toHaveLength(2);
    for (const u of body.unresolved) {
      expect([first, second]).toContain(u.paymentId);
      expect(u.reason).toBe('no-unpaid-bookings');
      // The booking is offered, at its LIVE $40 — not the sequenced $0 the earlier credit's
      // proposal left behind, which is what would false-block the very pick this exists for.
      expect(u.bookings).toHaveLength(1);
      expect(u.bookings[0]).toMatchObject({ bookingId, outstanding: 40 });
      // And the sentence shown verbatim beside it says what actually happened, rather than the
      // pure proposer's "no unpaid bookings", which a non-empty `bookings` flatly contradicts.
      expect(u.detail).toContain('Earlier credits');
    }
  });

  it('a credit whose household has no unpaid bookings AT ALL names none — genuinely inert, not actionable', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const settled = await book(env, home, 40, '2026-07-01');
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: settled,
      amount: 40,
      method: 'cash',
      paidDate: '2026-06-15',
      note: null,
      externalRef: null,
    });
    const paymentId = (await credit(env, home.accountId, 40, '2026-06-01'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toEqual([]);
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatchObject({ paymentId, reason: 'no-unpaid-bookings' });
    // Nothing to offer, so nothing is offered — this is the arm that stays summarised.
    expect(body.unresolved[0].bookings).toEqual([]);
    expect(body.unresolved[0].detail).not.toContain('Earlier credits');
  });

  it('a refusal that is neither ambiguous nor no-unpaid-bookings names NO candidate bookings', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // An ordinary unpaid booking is present the whole time — so a populated `bookings` here would
    // be the route emitting candidates for a credit that cannot be placed at all, which is what
    // `AttributionUnresolved`'s own type comment promises never happens.
    await book(env, home, 100, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 100, 'not-a-date'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toEqual([]);
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatchObject({ paymentId, reason: 'invalid-date' });
    expect(body.unresolved[0].bookings).toEqual([]);
  });

  it('the override end to end: the sitter places a credit the preview did NOT propose, and the other two go inert', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 40, '2026-07-01');
    const first = (await credit(env, home.accountId, 40, '2026-06-01'))!;
    const second = (await credit(env, home.accountId, 40, '2026-06-02'))!;
    const third = (await credit(env, home.accountId, 40, '2026-06-03'))!;

    const before = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, home.accountId);

    // The sitter unticks the proposed credit (the nearest one, `third`) and sends the one she
    // knows actually paid the stay. Nothing about the request is special — it is the ordinary
    // apply shape.
    const res = await apply(env, TENANT_C, {
      attributions: [
        {
          paymentId: first,
          accountId: home.accountId,
          splits: [{ bookingId, amount: 40 }],
          remainder: 0,
        } satisfies ApplyAttributionInput,
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 1, skipped: [] });

    // The money landed on the stay the sitter named, and the household's total is unmoved.
    const rows = paymentRows(raw);
    expect(rows.filter((r) => r.BookingRequestId === bookingId)).toHaveLength(1);
    expect(rows.find((r) => r.BookingRequestId === bookingId)?.Amount).toBe(40);
    const after = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    expect(after?.balance).toBe(before?.balance);

    // And now there is genuinely nothing left: both survivors report no candidates, so they fall
    // into the summarised list rather than staying interactive forever.
    const second_ = await preview(env, TENANT_C, home.accountId);
    const body = (await second_.json()) as PreviewBody;
    expect(body.proposals).toEqual([]);
    expect(body.unresolved.map((u) => u.paymentId).sort()).toEqual([second, third].sort());
    for (const u of body.unresolved) {
      expect(u.reason).toBe('no-unpaid-bookings');
      expect(u.bookings).toEqual([]);
    }
  });

  it('the server still decides: an over-claim against the live outstanding is refused with its reason', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 40, '2026-07-01');
    await credit(env, home.accountId, 40, '2026-06-01');
    const third = (await credit(env, home.accountId, 100, '2026-06-03'))!;

    // $100 named against a $40 stay. The panel caps at the booking's live outstanding, but the
    // cap is UX — the authority is here.
    const res = await apply(env, TENANT_C, {
      attributions: [
        {
          paymentId: third,
          accountId: home.accountId,
          splits: [{ bookingId, amount: 100 }],
          remainder: 0,
        } satisfies ApplyAttributionInput,
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApplyBody;
    expect(body.applied).toBe(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].paymentId).toBe(third);
    expect(body.skipped[0].reason).toContain('$40');
    expect(paymentRows(raw).every((r) => r.BookingRequestId === null)).toBe(true);
  });
});

/**
 * THE STALENESS FLOOR, THROUGH THE ROUTE — `proposeAttribution` refusing a credit no stay is near
 * enough to (`'no-recent-booking'`, see server/__tests__/payment-attribution.test.ts) is only half
 * the behaviour. The other half is that the sitter loses the automatic GUESS and not the ability
 * to attribute at all, which is a property of this route: the refusal has to come back with the
 * household's live-outstanding stays in `bookings`, the same contract `'ambiguous'` and a
 * sequencing-skipped `'no-unpaid-bookings'` already carry, or the panel renders it inert and the
 * credit is unplaceable forever.
 */
describe('POST /:slug/admin/payments/attribute/preview — the staleness floor stays placeable', () => {
  it('a credit no stay is near enough to is refused as no-recent-booking, with every live stay still offered', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // Both stays are more than a year from the payment — the live tenant's ordinary shape, where
    // proximity ordering is meaningless and the old code still proposed a confident split.
    const older = await book(env, home, 40, '2026-06-01');
    const newer = await book(env, home, 60, '2026-06-15');
    const paymentId = (await credit(env, home.accountId, 42, '2028-01-10'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toEqual([]);
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatchObject({
      accountId: home.accountId,
      paymentId,
      reason: 'no-recent-booking',
    });
    // The whole point: non-empty, at LIVE outstanding, so the panel's actionable/inert split
    // (keyed on `bookings.length`) makes this editable rather than a summarised dead end.
    expect(new Map(body.unresolved[0].bookings.map((b) => [b.bookingId, b.outstanding]))).toEqual(
      new Map([
        [older, 40],
        [newer, 60],
      ]),
    );
  });

  it('a credit with one stay inside the floor is still proposed against it, with the rest as remainder', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const near = await book(env, home, 40, '2026-07-05');
    const far = await book(env, home, 60, '2023-01-05');
    const paymentId = (await credit(env, home.accountId, 100, '2026-07-01'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({
      paymentId,
      splits: [{ bookingId: near, amount: 40 }],
      remainder: 60,
    });
    expect(body.proposals[0].splits.some((s) => s.bookingId === far)).toBe(false);
  });
});

/**
 * THE END DATE REACHES THE PROPOSER — the route half of measuring proximity to the whole stay.
 * `proposeAttribution` and `nearestCandidateDistance` are pure and already proved (see
 * server/__tests__/payment-attribution.test.ts); what only this route can prove is that the stay's
 * end date is actually IN HAND when they are called. It is read on the same statement as the start
 * date, so no query is added — the constant-prepare test above is the guard on that.
 */
describe('POST /:slug/admin/payments/attribute/preview — proximity to the whole stay', () => {
  it("THE SITTER'S CASE: money sent mid-house-sit lands on the stay, not on a nearer walk", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // Her live shape: a 23-night house sit, and a walk three days before the payment. The credit
    // covers either one but not both.
    const sit = await bookStay(env, home, 400, '2026-07-29', '2026-08-21');
    const walk = await book(env, home, 40, '2026-08-15');
    const paymentId = (await credit(env, home.accountId, 40, '2026-08-18'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.unresolved).toEqual([]);
    expect(body.proposals).toHaveLength(1);
    // 0 days from the stay it was made during, 3 from the walk. A route that dropped `endDate`
    // would measure the stay from 2026-07-29 — 20 days — and hand the money to the walk.
    expect(body.proposals[0]).toMatchObject({
      paymentId,
      splits: [{ bookingId: sit, amount: 40 }],
      remainder: 0,
    });
    expect(body.proposals[0].splits.some((s) => s.bookingId === walk)).toBe(false);
  });

  // THE WIRE GAP THIS CLOSES: `intervalDistance` has measured against the whole stay since
  // `a2e5ff3`, but the preview route only ever put `startDate` on the wire, so the panel had no
  // way to show the sitter the interval the server was actually matching against. These four
  // tests are about the RESPONSE SHAPE, not the matching — the test above already proves matching
  // is correct; these fail if `endDate` is ever dropped from the route's declared response types
  // or from the object it actually builds.
  it("a range booking's proposal split carries the stay's own end date, not just its start", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const sit = await bookStay(env, home, 400, '2026-07-29', '2026-08-21');
    const paymentId = (await credit(env, home.accountId, 400, '2026-08-05'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ paymentId });
    // Mutation this catches: dropping `endDate` from the route's inline response type, or from
    // the `staticById` entry it is spread from, turns this into `undefined` — a type error at
    // the route, not a silent pass here, since `PreviewBody` above declares the field too.
    expect(body.proposals[0].splits[0]).toMatchObject({ bookingId: sit, endDate: '2026-08-21' });
  });

  it('a single-day booking reports endDate: null on a proposal split, not its own start date', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const walk = await book(env, home, 40, '2026-07-08');
    const paymentId = (await credit(env, home.accountId, 40, '2026-07-01'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]).toMatchObject({ paymentId });
    // Mutation this catches: substituting `startDate` for a missing `endDate` (rather than
    // reporting NULL for a single-day service) would pass a naive `toBeTruthy` check but fail
    // this exact-value assertion, and would make a walk indistinguishable from a stay in the
    // panel — exactly what the task forbids.
    expect(body.proposals[0].splits[0]).toMatchObject({ bookingId: walk, endDate: null });
  });

  it("an ambiguous credit's candidate bookings each carry their own end date, range and single-day alike", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    // Same shape as the plain ambiguity test above, but one candidate is a range: a stay whose
    // CHECKOUT lands one day before the payment (distance 1, same as the walk's start one day
    // before it) so the two are genuinely tied and $100 cannot resolve both $100 bookings.
    const stay = await bookStay(env, home, 100, '2026-06-25', '2026-06-30');
    const walk = await book(env, home, 100, '2026-06-30');
    const paymentId = (await credit(env, home.accountId, 100, '2026-07-01'))!;

    const res = await preview(env, TENANT_C, home.accountId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    expect(body.proposals).toEqual([]);
    expect(body.unresolved).toHaveLength(1);
    expect(body.unresolved[0]).toMatchObject({ paymentId, reason: 'ambiguous' });
    const endDateById = new Map(body.unresolved[0].bookings.map((b) => [b.bookingId, b.endDate]));
    // Mutation this catches: dropping `endDate` from the `unresolved[].bookings` response type,
    // or from the shared `staticById` map the ambiguous path reads from, drops it here too —
    // the sitter choosing between two tied candidates would see two identical start dates and no
    // way to tell a 5-night stay from a walk.
    expect(endDateById.get(stay)).toBe('2026-06-30');
    expect(endDateById.get(walk)).toBeNull();
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

  it("carries a tip through to a Tip charge on the stay — Kelly's $50 settles a $40 walk with $10 of thanks", async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 50))!;

    const res = await apply(env, TENANT_C, {
      attributions: [
        {
          paymentId,
          accountId: home.accountId,
          // EXCLUSIVE of the tip: $40 is what the walk owed, and the server adds the $10.
          splits: [{ bookingId: walk, amount: 40 }],
          tip: { bookingId: walk, amount: 10 },
          remainder: 0,
        } satisfies ApplyAttributionInput,
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as ApplyBody).toEqual({ applied: 1, skipped: [] });

    expect(chargeRows(raw)).toEqual([
      { BookingRequestId: walk, Label: 'Tip', Amount: 10, Origin: null },
    ]);
    // One booking payment for the whole $50, and no account-level credit left looking for a stay.
    const rows = paymentRows(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ BookingRequestId: walk, AccountId: null, Amount: 50 });
    const detail = await getHouseholdDetail(env.PAWSERVATION_DB, TENANT_C, home.accountId);
    expect(detail?.balance).toBe(0);
  });

  it('a malformed tip is a 400 with nothing written', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'kelly');
    const walk = await book(env, home, 40, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 50))!;
    const before = paymentRows(raw);
    const base = {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId: walk, amount: 40 }],
    };

    // A structurally broken tip is a fault in the request, not a refusable attribution — same
    // posture as a malformed split. Each of these must 400 the WHOLE request.
    for (const tip of [
      null,
      'ten',
      { bookingId: walk },
      { amount: 10 },
      { bookingId: 42, amount: 10 },
      { bookingId: walk, amount: '10' },
      { bookingId: '', amount: 10 },
    ]) {
      const res = await apply(env, TENANT_C, {
        attributions: [{ ...base, tip, remainder: 0 }],
      });
      expect(res.status).toBe(400);
    }
    expect(paymentRows(raw)).toEqual(before);
    expect(chargeRows(raw)).toEqual([]);
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

/**
 * Wraps a test env's D1 so every `prepare` is counted, exactly as the production measurement did.
 *
 * `subrequests()` is the figure the 50-per-invocation ceiling is actually spent against, and it is
 * NOT the prepare count: a `db.batch` is ONE binding call however many statements it carries, so
 * the statements handed to it are counted out again and the batch itself counted once. Prepares
 * remain the per-attribution regression signal (they scale with the reads a code path makes);
 * subrequests are what tells you whether a request fits.
 *
 * D1 ONLY, THOUGH. KV is a binding too and `resolveTenant` spends 1–2 of it per request (a `get`,
 * plus a `put` when the tenant was not cached — the D1 read of that cold path IS counted here).
 * So a figure of 37 below is really ~39 against the ceiling, and the true headroom is ~11 rather
 * than 13. Left uncounted deliberately: this test exists to catch a per-attribution D1 regression,
 * and the constant it is asserted against carries the KV overhead in its own arithmetic
 * (MAX_ATTRIBUTIONS_PER_REQUEST, src/shared/invoicing/attribution-splits.ts).
 */
function countingEnv(env: Env): {
  env: Env;
  prepares: () => number;
  subrequests: () => number;
} {
  let count = 0;
  let batches = 0;
  let batched = 0;
  const counted = {
    prepare: (sql: string) => {
      count++;
      return env.PAWSERVATION_DB.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => {
      batches++;
      batched += statements.length;
      return env.PAWSERVATION_DB.batch(statements);
    },
  } as unknown as D1Database;
  return {
    env: { ...env, PAWSERVATION_DB: counted },
    prepares: () => count,
    subrequests: () => count - batched + batches,
  };
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

    // One household whose three credits chase a single $40 booking: the one nearest the stay
    // settles it, the other two have nothing left to claim. Pins the sequenced-vs-live separation
    // inside the bulk path — the later credits are unresolved, yet each still OFFERS the booking
    // at its LIVE $40, because a sitter may untick the first credit.
    const seq = await household(env, raw, 'seq');
    const seqBooking = await book(env, seq, 40, '2026-07-01');
    const seqFirst = (await credit(env, seq.accountId, 40, '2026-06-01'))!;
    const seqSecond = (await credit(env, seq.accountId, 40, '2026-06-02'))!;
    const seqThird = (await credit(env, seq.accountId, 40, '2026-06-03'))!;

    // A household whose declined booking still carries the $50 it took while pending: `Expected`
    // in the bulk query must stay `CREDITABLE_AMOUNT_SQL` (zeroed once declined), the same rule
    // `householdDetailFor` uses, or this booking's outstanding goes from -50 (never a candidate)
    // to 50 (offered as one) — exactly the defect the single-account test above ("a declined
    // booking is NOT offered as a candidate") already covers for the per-household path. `p_wdc`
    // sorts after `p_seq` and before `p_zzz` below, so it slots straight into the account-id order
    // the response is pinned to.
    const declinedHome = await household(env, raw, 'wdc');
    const declinedBooking = await book(env, declinedHome, 100, '2026-07-01', 'pending');
    await insertPayment(env.PAWSERVATION_DB, TENANT_C, {
      bookingRequestId: declinedBooking,
      amount: 50,
      method: 'cash',
      paidDate: '2026-06-15',
      note: null,
      externalRef: null,
    });
    expect(
      await updateBookingStatus(env.PAWSERVATION_DB, TENANT_C, declinedBooking, 'declined'),
    ).toBe(true);
    const declinedUnpaid = await book(env, declinedHome, 100, '2026-07-01');
    const declinedPaymentId = (await credit(env, declinedHome.accountId, 100))!;

    // A household with an unpaid booking and NO credit: it must appear nowhere in the response,
    // and a constant-cost reader must not pay a detail read for it either.
    const quiet = await household(env, raw, 'zzz');
    await book(env, quiet, 500, '2026-07-01');

    const counted = countingEnv(env);
    const res = await preview(counted.env, TENANT_C);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PreviewBody;

    // Households are read in account-id order (`buildAccounts` sorts them), so the response order
    // is pinned too: p_h00…p_h39, then p_seq, then p_wdc. p_zzz never appears.
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
              serviceType: 'walk',
              startDate: '2026-06-30',
              endDate: null,
              status: 'confirmed',
              outstanding: 100,
            },
            {
              bookingId: h.far,
              amount: 60,
              serviceType: 'walk',
              startDate: '2026-07-05',
              endDate: null,
              status: 'confirmed',
              outstanding: 60,
            },
          ],
          remainder: 40,
        })),
        {
          accountId: seq.accountId,
          paymentId: seqThird,
          amount: 40,
          paidDate: '2026-06-03',
          splits: [
            {
              bookingId: seqBooking,
              amount: 40,
              serviceType: 'walk',
              startDate: '2026-07-01',
              endDate: null,
              status: 'confirmed',
              outstanding: 40,
            },
          ],
          remainder: 0,
        },
        {
          accountId: declinedHome.accountId,
          paymentId: declinedPaymentId,
          amount: 100,
          paidDate: '2026-07-01',
          splits: [
            {
              bookingId: declinedUnpaid,
              amount: 100,
              serviceType: 'walk',
              startDate: '2026-07-01',
              endDate: null,
              status: 'confirmed',
              outstanding: 100,
            },
          ],
          remainder: 0,
        },
      ],
      // The two credits left with nothing are reported in the pool's own order — oldest paid
      // first — which is the order the ranking falls back to once no credit has a candidate left.
      unresolved: [seqFirst, seqSecond].map((paymentId, index) => ({
        accountId: seq.accountId,
        paymentId,
        amount: 40,
        paidDate: `2026-06-0${index + 1}`,
        reason: 'no-unpaid-bookings',
        // Not the pure proposer's "no unpaid bookings" sentence: this credit IS placeable (the
        // booking below is offered at its live $40), and only this route knows that the reason
        // it wasn't proposed is the household's own earlier credit.
        detail:
          `Earlier credits from this household were proposed for every unpaid stay first, so ` +
          `nothing is left for payment ${paymentId} in this batch. If this is the credit that ` +
          `actually paid one of them, choose the booking yourself — and untick the earlier ` +
          `proposal, or it will be refused as an overpayment.`,
        bookings: [
          {
            bookingId: seqBooking,
            serviceType: 'walk',
            startDate: '2026-07-01',
            endDate: null,
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

/**
 * THE READ COST OF AN APPLY, AND THE CAP THAT KEEPS ONE REQUEST INSIDE THE PLATFORM'S BUDGET —
 * the same production blocker the preview above hit, one route along.
 *
 * `applyAttribution` re-reads the source payment AND every target booking's LIVE outstanding on
 * every call, and that re-read is load-bearing correctness rather than overhead: it is what makes
 * two credits landing on one booking in a single request refuse the second instead of doubling the
 * money ("a batch that lands two credits on the same booking…" above). So the fix here is NOT the
 * preview's hoist-to-a-constant — the per-attribution reads must stay per-attribution. The two
 * independent things that CAN change are how much each one costs, and how many of them one request
 * is allowed to carry.
 *
 * Both are asserted here against one cap-sized request, which is by construction the most
 * expensive request this route can ever be asked to serve.
 */

/**
 * What one attribution may cost in D1 prepares, in the shape the preview actually proposes (two
 * splits plus a remainder). The reads are the account graph (2), the source payment (1), and the
 * lean candidate-bookings + booking<->pet pair the outstanding guard needs (2) — five, plus the
 * batch's own four statements. Ten leaves headroom for one honest extra read and no more: the
 * `getHouseholdDetail` this used to call cost SIX reads on its own (a second account-graph load
 * plus four detail reads, of which the household payments and the charge rows were read and thrown
 * away), which put this at thirteen and the whole request past the ceiling below.
 *
 * IT BOUNDS READS PLUS BATCH STATEMENTS, AND ONLY THE READS ARE SUBREQUESTS: the statements ride
 * inside one `db.batch`, billed as a single binding call. A TIPPED attribution therefore sits at
 * exactly ten — its charge INSERT spends the headroom in the one place where spending it costs the
 * ceiling nothing, which the tip test above measures directly rather than inferring from here.
 * What this number still guards is a sixth READ creeping in.
 */
const MAX_APPLY_PREPARES_PER_ATTRIBUTION = 10;

/**
 * Cloudflare's per-invocation subrequest ceiling on the Workers Free plan, which every D1 binding
 * call is spent against (`docs/superpowers/specs/2026-08-09-calendar-backfill-design.md:52,144` —
 * "Binding calls count."). Not a target to approach: the assertion below is what proves a
 * cap-sized Apply fits inside it with room to spare.
 */
const WORKERS_SUBREQUEST_LIMIT = 50;

describe('POST /:slug/admin/payments/attribute/apply — read cost and the per-request cap', () => {
  it('a cap-sized batch stays under the subrequest ceiling, and every attribution still applies', async () => {
    const { env, raw } = createTestEnv();

    // Every attribution carries the shape the preview proposes: two unpaid bookings at distinct
    // distances from the credit's paid date, and a credit that overshoots both — two splits and a
    // remainder, which is four statements in the batch rather than the cheapest possible one.
    const homes: { home: Household; near: string; far: string; paymentId: string }[] = [];
    for (let i = 0; i < MAX_ATTRIBUTIONS_PER_REQUEST; i++) {
      const home = await household(env, raw, `a${i}`);
      const near = await book(env, home, 100, '2026-06-30');
      const far = await book(env, home, 60, '2026-07-05');
      const paymentId = (await credit(env, home.accountId, 200))!;
      homes.push({ home, near, far, paymentId });
    }

    const counted = countingEnv(env);
    const res = await apply(counted.env, TENANT_C, {
      attributions: homes.map((h) => ({
        paymentId: h.paymentId,
        accountId: h.home.accountId,
        splits: [
          { bookingId: h.near, amount: 100 },
          { bookingId: h.far, amount: 60 },
        ],
        remainder: 40,
      })),
    });
    expect(res.status).toBe(200);
    // Cheap is worthless if it stopped applying things: every attribution landed, none skipped.
    expect((await res.json()) as ApplyBody).toEqual({
      applied: MAX_ATTRIBUTIONS_PER_REQUEST,
      skipped: [],
    });

    // The money actually moved, per booking, exactly as named — a fast path that quietly refused
    // (or quietly mis-split) would otherwise sail under both ceilings.
    const rows = paymentRows(raw);
    for (const h of homes) {
      expect(rows.filter((r) => r.BookingRequestId === h.near)).toMatchObject([{ Amount: 100 }]);
      expect(rows.filter((r) => r.BookingRequestId === h.far)).toMatchObject([{ Amount: 60 }]);
      expect(rows.filter((r) => r.Id === h.paymentId)).toEqual([]); // source consumed
    }

    expect(counted.prepares() / MAX_ATTRIBUTIONS_PER_REQUEST).toBeLessThan(
      MAX_APPLY_PREPARES_PER_ATTRIBUTION,
    );
    // The assertion the blocker is actually about. A batch is ONE binding call however many
    // statements it holds, so this counts them out again — see `countingEnv`.
    expect(counted.subrequests()).toBeLessThan(WORKERS_SUBREQUEST_LIMIT);
  });

  it('a tip costs ZERO extra subrequests — it is a statement in a batch, not a binding call', async () => {
    // THE CLAIM UNDER TEST, stated in `MAX_ATTRIBUTIONS_PER_REQUEST`'s own arithmetic: `db.batch`
    // is ONE binding call however many statements it carries, so the tip's charge INSERT is free
    // against the ceiling the cap is derived from. Asserted by running the SAME cap-sized request
    // twice over identical fixtures — once plain, once with every attribution tipped — because a
    // bare "under 50" would still pass if a tip cost a whole extra subrequest each.
    const build = async ({ env, raw }: ReturnType<typeof createTestEnv>) => {
      const homes: { home: Household; near: string; far: string; paymentId: string }[] = [];
      for (let i = 0; i < MAX_ATTRIBUTIONS_PER_REQUEST; i++) {
        const home = await household(env, raw, `t${i}`);
        const near = await book(env, home, 100, '2026-06-30');
        const far = await book(env, home, 60, '2026-07-05');
        const paymentId = (await credit(env, home.accountId, 200))!;
        homes.push({ home, near, far, paymentId });
      }
      return homes;
    };
    // Same credit, same splits, same bookings — the ONLY difference is that $10 of each payment is
    // recorded as a tip instead of staying as remainder.
    const attribution = (
      h: { home: Household; near: string; far: string; paymentId: string },
      tipped: boolean,
    ): ApplyAttributionInput => ({
      paymentId: h.paymentId,
      accountId: h.home.accountId,
      splits: [
        { bookingId: h.near, amount: 100 },
        { bookingId: h.far, amount: 60 },
      ],
      ...(tipped ? { tip: { bookingId: h.near, amount: 10 } } : {}),
      remainder: tipped ? 30 : 40,
    });

    const run = async (tipped: boolean) => {
      const fixture = createTestEnv();
      const homes = await build(fixture);
      const counted = countingEnv(fixture.env);
      const res = await apply(counted.env, TENANT_C, {
        attributions: homes.map((h) => attribution(h, tipped)),
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as ApplyBody).toEqual({
        applied: MAX_ATTRIBUTIONS_PER_REQUEST,
        skipped: [],
      });
      // Both runs actually did the work — a refusal would make the counts meaningless.
      expect(chargeRows(fixture.raw)).toHaveLength(tipped ? MAX_ATTRIBUTIONS_PER_REQUEST : 0);
      return { prepares: counted.prepares(), subrequests: counted.subrequests() };
    };

    const plain = await run(false);
    const tipped = await run(true);

    // IDENTICAL subrequests: the extra statement rode inside the batch that was already being sent.
    expect(tipped.subrequests).toBe(plain.subrequests);
    expect(tipped.subrequests).toBeLessThan(WORKERS_SUBREQUEST_LIMIT);
    // And it IS a real extra statement — one per attribution — so the equality above is a fact
    // about how batches are billed rather than about the tip having quietly done nothing.
    expect(tipped.prepares).toBe(plain.prepares + MAX_ATTRIBUTIONS_PER_REQUEST);
  });

  it('more attributions than the cap is a 400 with nothing written', async () => {
    const { env, raw } = createTestEnv();
    const home = await household(env, raw, 'jen');
    const bookingId = await book(env, home, 100, '2026-07-01');
    const paymentId = (await credit(env, home.accountId, 100))!;
    const before = paymentRows(raw);

    // One valid attribution, repeated past the cap. The FIRST one would apply cleanly on its own,
    // so nothing being written proves the cap refuses the whole request up front rather than
    // applying what fits — a client is not trusted to chunk, and a partial apply it never asked
    // for is worse than a refusal it can act on.
    const one = {
      paymentId,
      accountId: home.accountId,
      splits: [{ bookingId, amount: 100 }],
      remainder: 0,
    };
    const res = await apply(env, TENANT_C, {
      attributions: Array.from({ length: MAX_ATTRIBUTIONS_PER_REQUEST + 1 }, () => one),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      String(MAX_ATTRIBUTIONS_PER_REQUEST),
    );
    expect(paymentRows(raw)).toEqual(before);
  });

  it('exactly the cap is accepted', async () => {
    const { env, raw } = createTestEnv();
    const attributions: ApplyAttributionInput[] = [];
    for (let i = 0; i < MAX_ATTRIBUTIONS_PER_REQUEST; i++) {
      const home = await household(env, raw, `b${i}`);
      const bookingId = await book(env, home, 100, '2026-07-01');
      const paymentId = (await credit(env, home.accountId, 100))!;
      attributions.push({
        paymentId,
        accountId: home.accountId,
        splits: [{ bookingId, amount: 100 }],
        remainder: 0,
      });
    }
    const res = await apply(env, TENANT_C, { attributions });
    expect(res.status).toBe(200);
    expect((await res.json()) as ApplyBody).toEqual({
      applied: MAX_ATTRIBUTIONS_PER_REQUEST,
      skipped: [],
    });
  });
});
