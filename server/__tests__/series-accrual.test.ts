import { describe, expect, it } from 'vitest';
import { getAnalytics, getHouseholdBalances, getHouseholdDetailForOwner } from '../db/repo';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

/**
 * A WALK OF A SERIES IS OWED FROM ITS OWN DATE. Until its date arrives a series walk contributes
 * nothing to any money figure, so a confirmed year of Tuesdays reads as one walk at a time. The
 * date test is scoped to rows that carry a `SeriesId`: a single booking's balance never moves with
 * the calendar, which is what the last-but-three case pins.
 */

const TODAY = '2030-03-12'; // a Tuesday; every date below is relative to it and fixed
const PAST = '2030-03-05';
const NEXT_WEEK = '2030-03-19';

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

/** Jess (TENANT_A) with an active series 's1' and walks on PAST, TODAY and NEXT_WEEK at 2500 cents
 *  each, all confirmed; plus a single confirmed booking on NEXT_WEEK at 4000. The base seed's own
 *  bookings are removed first so the household holds only these. */
function world() {
  const { env, raw } = createTestEnv();
  raw.exec(`DELETE FROM BookingRequests WHERE Id LIKE 'seed_%'`);
  insertSeries(raw, 's1', TENANT_A, USER, PAST);
  const walk = { tenantId: TENANT_A, userId: USER, petId: PET, cost: 2500, seriesId: 's1' };
  insertBooking(raw, { ...walk, id: 'w_past', date: PAST });
  insertBooking(raw, { ...walk, id: 'w_today', date: TODAY });
  insertBooking(raw, { ...walk, id: 'w_next', date: NEXT_WEEK });
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
  });

  it('the household balance carries past and today walks, and the single future booking, only', async () => {
    const { env } = world();
    const [h, ...rest] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, TODAY);
    expect(rest).toEqual([]);
    expect(h.balanceCents).toBe(2500 + 2500 + 4000); // w_past + w_today + single_next; w_next is 0
  });

  it('the same walk is owed once its date arrives', async () => {
    const { env } = world();
    const [h] = await getHouseholdBalances(env.PAWSERVATION_DB, TENANT_A, NEXT_WEEK);
    expect(h.balanceCents).toBe(2500 * 3 + 4000);
  });

  it("a single future booking's balance is UNCHANGED (the regression the SeriesId scope exists for)", async () => {
    const { env, raw } = world();
    raw.exec(
      `DELETE FROM BookingRequestPets WHERE BookingRequestId LIKE 'w_%';
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
    expect(h.balanceCents).toBe(2500 + 2500 + 4000 + 1200);
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
    expect(after.balanceCents).toBe(2500 + 2500 + 4000);
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
