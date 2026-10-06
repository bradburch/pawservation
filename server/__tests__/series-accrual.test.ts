import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  getAnalytics,
  getHouseholdBalances,
  getHouseholdDetailForOwner,
  insertPayment,
  keepBookingCredit,
  listChargesForBooking,
} from '../db/repo';
import { serializeAnalytics } from '../lib/analytics';
import { adminHeaders, createTestEnv, TENANT_A, TENANT_B } from './helpers';

/**
 * A WALK OF A SERIES IS OWED FROM ITS OWN DATE. Until its date arrives a series walk contributes
 * nothing to any money figure, so a confirmed year of Tuesdays reads as one walk at a time. The
 * date test is scoped to rows that carry a `SeriesId`: a single booking's balance never moves with
 * the calendar, which is what the last-but-three case pins.
 */

const TODAY = '2030-03-12'; // a Tuesday; every date below is relative to it and fixed
const PAST = '2030-03-05';
const NEXT_WEEK = '2030-03-19';
const LATER = '2030-03-26';
const CHARGE = 800; // a surcharge already logged against the LATER walk

// The base seed's own client and pet (sql/seed.sql): Jess and Bella at Sunny Paws, and a second
// Jess — the same email address — at Happy Tails, a different tenant.
const USER = 'eu_sp_jess';
const PET = 'pet_sp_bella';
const OTHER_TENANT_USER = 'eu_ht_jess';
const OTHER_TENANT_PET = 'pet_ht_otis';

type Raw = ReturnType<typeof createTestEnv>['raw'];

function insertSeries(raw: Raw, id: string, tenantId: string, userId: string, start: string) {
  raw
    .prepare(
      `INSERT INTO BookingSeries (Id, TenantId, EndUserId, ServiceType, Weekdays, StartDate, Status,
         CreatedBy, CreatedAt, UpdatedAt)
       VALUES (?, ?, ?, 'walk', 2, ?, 'active', 'client', '2030-03-01T00:00:00Z', '2030-03-01T00:00:00Z')`,
    )
    .run(id, tenantId, userId, start);
}

function insertBooking(
  raw: Raw,
  b: {
    id: string;
    tenantId: string;
    userId: string;
    petId: string;
    date: string;
    cost: number;
    seriesId: string | null;
  },
) {
  raw
    .prepare(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, EstCost, Status, SeriesId)
       VALUES (?, ?, ?, 'walk', ?, 1, ?, 'confirmed', ?)`,
    )
    .run(b.id, b.tenantId, b.userId, b.date, b.cost, b.seriesId);
  raw
    .prepare(`INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES (?, ?)`)
    .run(b.id, b.petId);
}

/** Jess (TENANT_A) with an active series 's1' and walks on PAST, TODAY, NEXT_WEEK and LATER at 2500
 *  cents each, all confirmed; the LATER walk carries a live CHARGE (a surcharge is owed when it is
 *  logged, whatever the walk's date); plus a single confirmed booking on NEXT_WEEK at 4000. The
 *  base seed's own bookings are removed first so the household holds only these. */
function world() {
  const { env, raw } = createTestEnv();
  raw.exec(`DELETE FROM BookingRequests WHERE Id LIKE 'seed_%'`);
  insertSeries(raw, 's1', TENANT_A, USER, PAST);
  const walk = { tenantId: TENANT_A, userId: USER, petId: PET, cost: 2500, seriesId: 's1' };
  insertBooking(raw, { ...walk, id: 'w_past', date: PAST });
  insertBooking(raw, { ...walk, id: 'w_today', date: TODAY });
  insertBooking(raw, { ...walk, id: 'w_next', date: NEXT_WEEK });
  insertBooking(raw, { ...walk, id: 'w_charged', date: LATER });
  raw
    .prepare(
      `INSERT INTO BookingCharges (Id, TenantId, BookingRequestId, Label, Amount)
       VALUES ('chg_w_charged', ?, 'w_charged', 'Holiday surcharge', ?)`,
    )
    .run(TENANT_A, CHARGE);
  insertBooking(raw, { ...walk, id: 'single_next', date: NEXT_WEEK, cost: 4000, seriesId: null });
  return { env, raw };
}

describe('a walk is owed from its own date', () => {
  it('a future walk is in neither outstanding[] nor the household balance', async () => {
    const { env } = world();
    const a = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    const ids = a.outstanding.map((o) => o.BookingId);
    expect(ids).toContain('w_past');
    expect(ids).toContain('w_today'); // on its own date it is owed
    expect(ids).toContain('single_next');
    expect(ids).not.toContain('w_next');
    expect(ids).toContain('w_charged'); // its surcharge is owed now; its walk is not
  });

  it('the household balance carries past and today walks, and the single future booking, only', async () => {
    const { env } = world();
    const [h, ...rest] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(rest).toEqual([]);
    // w_past + w_today + single_next + w_charged's surcharge; w_next and w_charged's walk are 0
    expect(h.balanceCents).toBe(2500 + 2500 + 4000 + CHARGE);
  });

  it('the same walk is owed once its date arrives', async () => {
    const { env } = world();
    const [h] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, NEXT_WEEK);
    expect(h.balanceCents).toBe(2500 * 3 + 4000 + CHARGE);
  });

  it("a single future booking's balance is UNCHANGED (the regression the SeriesId scope exists for)", async () => {
    const { env, raw } = world();
    raw.exec(
      `DELETE FROM BookingCharges WHERE BookingRequestId LIKE 'w_%';
       DELETE FROM BookingRequestPets WHERE BookingRequestId LIKE 'w_%';
       DELETE FROM BookingRequests WHERE SeriesId IS NOT NULL`,
    );
    const [h] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(h.balanceCents).toBe(4000);
    const a = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(a.outstanding.map((o) => o.BookingId)).toEqual(['single_next']);
  });

  it('a fee-bearing cancelled future walk is owed now', async () => {
    const { env, raw } = world();
    raw.exec(
      `UPDATE BookingRequests SET Status = 'cancelled', CancellationFee = 1200 WHERE Id = 'w_next'`,
    );
    const [h] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(h.balanceCents).toBe(2500 + 2500 + 4000 + CHARGE + 1200);
  });

  it("the client's own account reads the same accrual", async () => {
    const { env } = world();
    const [h] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, TODAY);
    const { detail } = await getHouseholdDetailForOwner(env.PAWSERVATION_DB, TENANT_A, USER, TODAY);
    expect(detail).not.toBeNull();
    expect(detail!.balanceCents).toBe(h.balanceCents);
    const byId = new Map(detail!.bookings.map((b) => [b.bookingId, b]));
    expect(byId.get('w_next')!.outstandingCents).toBe(0);
    expect(byId.get('w_today')!.outstandingCents).toBe(2500);
    expect(byId.get('single_next')!.outstandingCents).toBe(4000);
    expect(byId.get('w_charged')!.outstandingCents).toBe(CHARGE);
  });

  it("TENANT_B's series never moves TENANT_A's figures (same email, other tenant)", async () => {
    const { env, raw } = world();
    const [before] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, TODAY);
    insertSeries(raw, 's_b', TENANT_B, OTHER_TENANT_USER, PAST);
    insertBooking(raw, {
      id: 'w_b_past',
      tenantId: TENANT_B,
      userId: OTHER_TENANT_USER,
      petId: OTHER_TENANT_PET,
      date: PAST,
      cost: 9900,
      seriesId: 's_b',
    });
    const [after] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(after).toEqual(before);
    expect(after.balanceCents).toBe(2500 + 2500 + 4000 + CHARGE);
  });

  it('a malformed today is refused before any SQL runs', async () => {
    const { env } = world();
    await expect(
      getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, "2030-03-12' OR 1=1 --"),
    ).rejects.toThrow(RangeError);
    await expect(getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, '2030-02-30')).rejects.toThrow(
      RangeError,
    );
  });
});

const cash = (bookingRequestId: string, amount = 1) => ({
  bookingRequestId,
  amount,
  method: 'cash' as const,
  paidDate: TODAY,
  note: null,
  externalRef: null,
});

/** A payment row written straight to the table, past every guard — as a row recorded before the
 *  guard knew about series could be. Booking-level, so `AccountId` is NULL (0011's CHECK). */
function forcePayment(raw: Raw, bookingId: string, amount: number) {
  raw
    .prepare(
      `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate)
       VALUES (?, ?, ?, ?, 'cash', ?)`,
    )
    .run(`pay_forced_${bookingId}`, TENANT_A, bookingId, amount, TODAY);
}

describe('payments agree with the accrual in both directions', () => {
  it('insertPayment accepts a payment on every booking outstanding[] lists, and refuses every uncharged future walk it omits', async () => {
    const { env } = world();
    const a = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY);
    const listed = a.outstanding.map((o) => o.BookingId).sort();
    expect(listed).toEqual(['single_next', 'w_charged', 'w_past', 'w_today']);
    for (const id of listed)
      expect(await insertPayment(env.PAWSERVATION_DB, TENANT_A, cash(id), TODAY)).not.toBeNull();
    expect(await insertPayment(env.PAWSERVATION_DB, TENANT_A, cash('w_next'), TODAY)).toBeNull();
  });

  // ONE TABLE, both directions: for each booking, is it in outstanding[] (at a zero-paid start) and
  // does insertPayment take a payment on it? A disagreement is a balance whose Record payment
  // fails, or a payment the books never asked for.
  it.each([
    { label: 'a confirmed future walk', setup: '', today: TODAY, listed: false, accepted: false },
    {
      label: 'a pending future walk',
      setup: `UPDATE BookingRequests SET Status = 'pending' WHERE Id = 'w_next'`,
      today: TODAY,
      listed: false,
      accepted: false,
    },
    {
      label: 'a cancelled future walk with a fee (its fee is owed now)',
      setup: `UPDATE BookingRequests SET Status = 'cancelled', CancellationFee = 1200 WHERE Id = 'w_next'`,
      today: TODAY,
      listed: true,
      accepted: true,
    },
    {
      label: 'a cancelled future walk with no fee',
      setup: `UPDATE BookingRequests SET Status = 'cancelled', CancellationFee = 0 WHERE Id = 'w_next'`,
      today: TODAY,
      listed: false,
      accepted: false,
    },
    {
      label: 'a declined future walk',
      setup: `UPDATE BookingRequests SET Status = 'declined' WHERE Id = 'w_next'`,
      today: TODAY,
      listed: false,
      accepted: false,
    },
    {
      label: 'a charged confirmed future walk (its surcharge is owed now)',
      setup: `INSERT INTO BookingCharges (Id, TenantId, BookingRequestId, Label, Amount)
                VALUES ('chg_w_next', '${TENANT_A}', 'w_next', 'Late key', 300)`,
      today: TODAY,
      listed: true,
      accepted: true,
    },
    {
      label: 'the same walk on its own date',
      setup: '',
      today: NEXT_WEEK,
      listed: true,
      accepted: true,
    },
  ])('$label: listed=$listed, accepted=$accepted', async ({ setup, today, listed, accepted }) => {
    const { env, raw } = world();
    if (setup) raw.exec(setup);
    const a = await getAnalytics(env.PAWSERVATION_DB, TENANT_A, today);
    expect(a.outstanding.some((o) => o.BookingId === 'w_next')).toBe(listed);
    const id = await insertPayment(env.PAWSERVATION_DB, TENANT_A, cash('w_next'), today);
    expect(id !== null).toBe(accepted);
  });

  it('keepBookingCredit refuses a future walk not-yet-due, writes no charge, and the Earnings page does not offer Keep', async () => {
    const { env, raw } = world();
    forcePayment(raw, 'w_next', 2500);
    const credits = serializeAnalytics(
      await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY),
    ).credits;
    const row = credits.find((c) => c.bookingId === 'w_next');
    expect(row?.creditCents).toBe(2500);
    expect(row?.canKeep).toBe(false);
    expect(await keepBookingCredit(env.PAWSERVATION_DB, TENANT_A, 'w_next', TODAY)).toEqual({
      outcome: 'not-yet-due',
    });
    expect(await listChargesForBooking(env.PAWSERVATION_DB, TENANT_A, 'w_next')).toEqual([]);
    // On its date the prepayment nets against the walk: nothing left to keep, nothing owed.
    expect(await keepBookingCredit(env.PAWSERVATION_DB, TENANT_A, 'w_next', NEXT_WEEK)).toEqual({
      outcome: 'no-credit',
    });
  });

  it('a charged future walk overpaid past its surcharge still keeps nothing (the rest is the walk, not yet due)', async () => {
    const { env, raw } = world();
    forcePayment(raw, 'w_charged', CHARGE + 2500);
    expect(await keepBookingCredit(env.PAWSERVATION_DB, TENANT_A, 'w_charged', TODAY)).toEqual({
      outcome: 'not-yet-due',
    });
    const credits = serializeAnalytics(
      await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY),
    ).credits;
    expect(credits.find((c) => c.bookingId === 'w_charged')?.canKeep).toBe(false);
  });

  it('a past walk in credit can still be kept (the refusal is the date, not the series)', async () => {
    const { env, raw } = world();
    forcePayment(raw, 'w_past', 3000);
    const credits = serializeAnalytics(
      await getAnalytics(env.PAWSERVATION_DB, TENANT_A, TODAY),
    ).credits;
    expect(credits.find((c) => c.bookingId === 'w_past')?.canKeep).toBe(true);
    expect(await keepBookingCredit(env.PAWSERVATION_DB, TENANT_A, 'w_past', TODAY)).toEqual({
      outcome: 'kept',
      amount: 500,
    });
  });

  it('over HTTP: a booking payment on a future walk is 409 not_yet_due; the household payment is taken and nets on the date', async () => {
    const { env } = world();
    // The route reads the real clock; every date in this world is in 2030, so w_next is future.
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const body = JSON.stringify({ amountCents: 2500, method: 'cash', paidDate: TODAY });
    const refused = await app.request(
      `/api/sunny-paws/admin/bookings/w_next/payments`,
      { method: 'POST', headers, body },
      env,
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "This walk isn't due yet — record it as a payment on the household instead.",
      code: 'not_yet_due',
    });

    const [before] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, NEXT_WEEK);
    const taken = await app.request(
      `/api/sunny-paws/admin/accounts/${before.accountId}/payments`,
      { method: 'POST', headers, body },
      env,
    );
    expect(taken.status).toBe(201);
    const [after] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, NEXT_WEEK);
    expect(after.balanceCents).toBe(before.balanceCents - 2500);
  });

  it("over HTTP: keeping a future walk's credit is 409 not_yet_due", async () => {
    const { env, raw } = world();
    forcePayment(raw, 'w_next', 2500);
    const res = await app.request(
      `/api/sunny-paws/admin/bookings/w_next/credit/keep`,
      { method: 'POST', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This walk isn't due yet — record it as a payment on the household instead.",
      code: 'not_yet_due',
    });
  });

  it("over HTTP: every other refusal keeps its 404 (a declined future walk, another tenant's walk)", async () => {
    const { env, raw } = world();
    raw.exec(`UPDATE BookingRequests SET Status = 'declined' WHERE Id = 'w_next'`);
    const body = JSON.stringify({ amountCents: 100, method: 'cash', paidDate: TODAY });
    const declined = await app.request(
      `/api/sunny-paws/admin/bookings/w_next/payments`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body,
      },
      env,
    );
    expect(declined.status).toBe(404);
    insertSeries(raw, 's_b', TENANT_B, OTHER_TENANT_USER, PAST);
    insertBooking(raw, {
      id: 'w_b_next',
      tenantId: TENANT_B,
      userId: OTHER_TENANT_USER,
      petId: OTHER_TENANT_PET,
      date: NEXT_WEEK,
      cost: 2500,
      seriesId: 's_b',
    });
    const foreign = await app.request(
      `/api/sunny-paws/admin/bookings/w_b_next/payments`,
      {
        method: 'POST',
        headers: { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' },
        body,
      },
      env,
    );
    expect(foreign.status).toBe(404);
  });
});
