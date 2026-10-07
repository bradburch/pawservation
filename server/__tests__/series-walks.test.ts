import { describe, expect, it } from 'vitest';
import {
  estCostCentsEach,
  evaluateWalks,
  materializeSpan,
  projectSeries,
  SeriesTermsGone,
  skipReasonOf,
  type SeriesTerms,
} from '../lib/series-walks';
import { walkConflictsForSpan } from '../lib/availability';
import {
  getTenantBySlug,
  listServiceOptions,
  listServices,
  listSlotBookingCounts,
  type SeriesRow,
  type SeriesStatus,
} from '../db/repo';
import { createTestEnv, seedPets, TENANT_A } from './helpers';

type Raw = ReturnType<typeof createTestEnv>['raw'];

const USER = 'eu_sp_jess';
const SERVICE = 'swalk';
const OPTION = '30min';

/**
 * A walk service with one option "30min" at $25/walk (2500 cents), capacity 1 per slot, a
 * HolidayRate of $40, and one client with one dog. A fresh ServiceType so the seeded `walk` and
 * its options stay out of every count. Thanksgiving 2030 is Thursday 2030-11-28.
 */
async function walkWorld() {
  const { env, raw } = createTestEnv();
  raw.exec(`DELETE FROM BookingRequests WHERE Id LIKE 'seed_%'`);
  raw
    .prepare(
      `INSERT INTO TenantServices (TenantId, ServiceType, Enabled, Label, Shape, RateUnit, HasDuration, CapacityKind, HolidayRate)
       VALUES (?, ?, 1, 'Series walk', 'single', 'walk', 1, 'none', 40)`,
    )
    .run(TENANT_A, SERVICE);
  raw
    .prepare(
      `INSERT INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, Capacity)
       VALUES ('opt_sw30', ?, ?, ?, '30 minutes', 30, 25, 1)`,
    )
    .run(TENANT_A, SERVICE, OPTION);
  const [pet] = seedPets(raw, TENANT_A, USER, [{ id: 'pet_sw_rex', petType: 'dog' }]);
  const tenant = (await getTenantBySlug(env.PAWSERVATION_DB, 'sunny-paws'))!;
  const terms: SeriesTerms = {
    endUserId: USER,
    serviceType: SERVICE,
    optionKey: OPTION,
    petIds: [pet],
    weekdays: 8, // Thursday
    startTime: '09:00',
    startDate: '2030-11-01',
    endDate: null,
  };
  return { env, raw, tenant, user: USER, pet, terms };
}

function seedSeriesRow(
  raw: Raw,
  s: {
    id: string;
    endUserId: string;
    status: SeriesStatus;
    weekdays: number;
    startDate: string;
    endDate?: string | null;
    materializedThrough?: string | null;
    petId?: string;
  },
): SeriesRow {
  raw
    .prepare(
      `INSERT INTO BookingSeries (Id, TenantId, EndUserId, ServiceType, OptionKey, Weekdays, StartTime, StartDate, EndDate,
         Status, CreatedBy, MaterializedThrough, CreatedAt, UpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, '09:00', ?, ?, ?, 'client', ?, 'x', 'x')`,
    )
    .run(
      s.id,
      TENANT_A,
      s.endUserId,
      SERVICE,
      OPTION,
      s.weekdays,
      s.startDate,
      s.endDate ?? null,
      s.status,
      s.materializedThrough ?? null,
    );
  raw
    .prepare(`INSERT INTO BookingSeriesPets (SeriesId, PetId) VALUES (?, ?)`)
    .run(s.id, s.petId ?? 'pet_sw_rex');
  return raw.prepare(`SELECT * FROM BookingSeries WHERE Id = ?`).get(s.id) as unknown as SeriesRow;
}

function insertRow(
  raw: Raw,
  r: {
    id: string;
    serviceType: string;
    date: string;
    endDate?: string | null;
    status?: string;
    seriesId?: string | null;
    petCount?: number;
  },
) {
  raw
    .prepare(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, EstCost, Status, SeriesId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2500, ?, ?)`,
    )
    .run(
      r.id,
      TENANT_A,
      r.serviceType === 'blocked' || r.serviceType === 'external' ? null : USER,
      r.serviceType,
      r.date,
      r.endDate ?? null,
      r.serviceType === SERVICE ? OPTION : null,
      r.petCount ?? 1,
      r.status ?? 'confirmed',
      r.seriesId ?? null,
    );
}

describe('skipReasonOf — one table, matched', () => {
  it.each([
    ['time_off', 'time_off'],
    ['external', 'full'],
    ['slot_full', 'full'],
    ['slot_no_room', 'full'],
    ['other', 'unavailable'],
    ['unpriced-pet-set', 'unpriced_pet_set'],
    ['cost-out-of-range', 'cost_out_of_range'],
  ] as const)('%s → %s', (c, r) => expect(skipReasonOf(c)).toBe(r));
});

describe('listSlotBookingCounts — scope, and a series excluded in SQL', () => {
  it('excludes only the named series: a single booking (SeriesId NULL) still counts', async () => {
    const { env, raw } = await walkWorld();
    seedSeriesRow(raw, {
      id: 's1',
      endUserId: USER,
      status: 'active',
      weekdays: 8,
      startDate: '2030-11-01',
    });
    insertRow(raw, { id: 'single', serviceType: SERVICE, date: '2030-11-21' });
    insertRow(raw, { id: 'own', serviceType: SERVICE, date: '2030-11-21', seriesId: 's1' });
    const counts = await listSlotBookingCounts(
      env.PAWSERVATION_DB,
      TENANT_A,
      SERVICE,
      OPTION,
      '2030-11-21',
      '2030-11-22',
      undefined,
      'all-live',
      's1',
    );
    expect(counts.get('2030-11-21')).toBe(1);
  });
  it("'committed-only' leaves a pending row out", async () => {
    const { env, raw } = await walkWorld();
    insertRow(raw, { id: 'p', serviceType: SERVICE, date: '2030-11-21', status: 'pending' });
    insertRow(raw, { id: 'c', serviceType: SERVICE, date: '2030-11-21', status: 'confirmed' });
    const all = await listSlotBookingCounts(
      env.PAWSERVATION_DB,
      TENANT_A,
      SERVICE,
      OPTION,
      '2030-11-21',
      '2030-11-22',
    );
    const committed = await listSlotBookingCounts(
      env.PAWSERVATION_DB,
      TENANT_A,
      SERVICE,
      OPTION,
      '2030-11-21',
      '2030-11-22',
      undefined,
      'committed-only',
    );
    expect(all.get('2030-11-21')).toBe(2);
    expect(committed.get('2030-11-21')).toBe(1);
  });
});

describe('walkConflictsForSpan', () => {
  it('a series excluded by id does not conflict with itself; a rival single booking still does', async () => {
    const { env, raw, tenant } = await walkWorld();
    seedSeriesRow(raw, {
      id: 's1',
      endUserId: USER,
      status: 'active',
      weekdays: 8,
      startDate: '2030-11-01',
    });
    insertRow(raw, { id: 'own', serviceType: SERVICE, date: '2030-11-21', seriesId: 's1' });
    insertRow(raw, { id: 'rival', serviceType: SERVICE, date: '2030-11-28' });
    const service = (await listServices(env.PAWSERVATION_DB, TENANT_A)).find(
      (s) => s.ServiceType === SERVICE,
    )!;
    const option = (await listServiceOptions(env.PAWSERVATION_DB, TENANT_A)).find(
      (o) => o.ServiceType === SERVICE,
    )!;
    const out = await walkConflictsForSpan(
      env,
      tenant,
      service,
      option,
      ['2030-11-21', '2030-11-28'],
      1,
      's1',
    );
    expect([...out]).toEqual([
      ['2030-11-21', null],
      ['2030-11-28', 'slot_full'],
    ]);
  });
});

describe('evaluateWalks', () => {
  it('prices each date for itself, holiday rate on the holiday', async () => {
    const { env, tenant, terms } = await walkWorld();
    const out = await evaluateWalks(
      env,
      tenant,
      { ...terms, weekdays: 8 },
      ['2030-11-21', '2030-11-28'],
      {},
    );
    expect(out).toEqual([
      { date: '2030-11-21', estCostCents: 2500 },
      { date: '2030-11-28', estCostCents: 4000 },
    ]);
  });

  it('names a blocked day time_off, a calendar event full, a full slot full', async () => {
    const { env, raw, tenant, terms } = await walkWorld();
    insertRow(raw, {
      id: 'blk',
      serviceType: 'blocked',
      date: '2030-11-07',
      endDate: '2030-11-08',
    });
    insertRow(raw, {
      id: 'ext',
      serviceType: 'external',
      date: '2030-11-14',
      endDate: '2030-11-15',
    });
    insertRow(raw, { id: 'one', serviceType: SERVICE, date: '2030-11-21' });
    const out = await evaluateWalks(
      env,
      tenant,
      terms,
      ['2030-11-07', '2030-11-14', '2030-11-21', '2030-12-05'],
      {},
    );
    expect(out).toEqual([
      { date: '2030-11-07', skipped: 'time_off' },
      { date: '2030-11-14', skipped: 'full' },
      { date: '2030-11-21', skipped: 'full' },
      { date: '2030-12-05', estCostCents: 2500 },
    ]);
  });

  it('an unpriced pet set skips with no figure, never 0', async () => {
    const { env, raw, tenant, terms } = await walkWorld();
    const [second] = seedPets(raw, TENANT_A, USER, [{ id: 'pet_sw_bo', petType: 'dog' }]);
    const out = await evaluateWalks(
      env,
      tenant,
      { ...terms, petIds: [...terms.petIds, second] },
      ['2030-11-21', '2030-12-05'],
      {},
    );
    expect(out).toEqual([
      { date: '2030-11-21', skipped: 'unpriced_pet_set' },
      { date: '2030-12-05', skipped: 'unpriced_pet_set' },
    ]);
    for (const w of out) expect('estCostCents' in w).toBe(false);
  });

  it('a recorded skip wins over a computed answer', async () => {
    const { env, tenant, terms } = await walkWorld();
    const out = await evaluateWalks(env, tenant, terms, ['2030-12-05'], {
      recorded: new Map([['2030-12-05', 'paused']]),
    });
    expect(out).toEqual([{ date: '2030-12-05', skipped: 'paused' }]);
  });

  it('a pet that has died (or is no longer theirs) is SeriesTermsGone, never a one-dog price', async () => {
    const { env, raw, tenant, terms } = await walkWorld();
    raw.exec(`UPDATE EndUserPets SET DeceasedAt = 'x' WHERE Id = 'pet_sw_rex'`);
    await expect(evaluateWalks(env, tenant, terms, ['2030-12-05'], {})).rejects.toBeInstanceOf(
      SeriesTermsGone,
    );
  });

  it('a deleted option is SeriesTermsGone', async () => {
    const { env, raw, tenant, terms } = await walkWorld();
    raw.exec(`DELETE FROM TenantServiceOptions WHERE Id = 'opt_sw30'`);
    await expect(evaluateWalks(env, tenant, terms, ['2030-12-05'], {})).rejects.toBeInstanceOf(
      SeriesTermsGone,
    );
  });
});

describe('estCostCentsEach', () => {
  it('is the common figure when every priced date states one', () =>
    expect(
      estCostCentsEach([
        { date: 'a', estCostCents: 2500 },
        { date: 'b', skipped: 'full' },
        { date: 'c', estCostCents: 2500 },
      ]),
    ).toBe(2500));
  it('is null when any two priced dates differ (a holiday)', () =>
    expect(
      estCostCentsEach([
        { date: 'a', estCostCents: 2500 },
        { date: 'b', estCostCents: 4000 },
      ]),
    ).toBeNull());
  it('is null when nothing is priced', () =>
    expect(estCostCentsEach([{ date: 'a', skipped: 'full' }])).toBeNull());
});

const TUE = { weekdays: 2, startDate: '2030-11-05' };

describe('materializeSpan', () => {
  it('writes rows for bookable dates and skips for the rest, in one batch, SyncPending 0, SeriesId set', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    insertRow(raw, {
      id: 'blk',
      serviceType: 'blocked',
      date: '2030-11-12',
      endDate: '2030-11-13',
    });
    const out = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
    );
    expect(out.added.map((a) => a.date)).toEqual(['2030-11-05', '2030-11-19']);
    expect(out.skipped).toEqual([{ date: '2030-11-12', reason: 'time_off' }]);
    expect(
      raw
        .prepare(
          `SELECT StartDate, SeriesId, SyncPending, Status, EstCost, PetCount, StartTime, OptionKey, EndUserId
             FROM BookingRequests WHERE SeriesId = 's1' ORDER BY StartDate`,
        )
        .all(),
    ).toEqual(
      ['2030-11-05', '2030-11-19'].map((d) => ({
        StartDate: d,
        SeriesId: 's1',
        SyncPending: 0,
        Status: 'confirmed',
        EstCost: 2500,
        PetCount: 1,
        StartTime: '09:00',
        OptionKey: OPTION,
        EndUserId: USER,
      })),
    );
    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS n FROM BookingRequestPets p JOIN BookingRequests b ON b.Id = p.BookingRequestId
            WHERE b.SeriesId = 's1' AND p.PetId = 'pet_sw_rex'`,
        )
        .get(),
    ).toEqual({ n: 2 });
    expect(
      raw.prepare(`SELECT Date, Reason FROM BookingSeriesSkips WHERE SeriesId = 's1'`).all(),
    ).toEqual([{ Date: '2030-11-12', Reason: 'time_off' }]);
    expect(
      raw
        .prepare(`SELECT MaterializedThrough, SyncPending FROM BookingSeries WHERE Id = 's1'`)
        .get(),
    ).toEqual({
      MaterializedThrough: '2030-11-19',
      SyncPending: 1,
    });
  });

  it('is idempotent: a second pass over the same span adds nothing and records nothing new', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    insertRow(raw, {
      id: 'blk',
      serviceType: 'blocked',
      date: '2030-11-12',
      endDate: '2030-11-13',
    });
    await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
    );
    // The same span again, from a series row read BEFORE the first pass (MaterializedThrough NULL).
    const again = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
    );
    expect(again).toEqual({ added: [], skipped: [] });
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE SeriesId = 's1'`).get(),
    ).toEqual({ n: 2 });
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM BookingSeriesSkips WHERE SeriesId = 's1'`).get(),
    ).toEqual({ n: 1 });
  });

  it('a row a concurrent writer pushed over capacity is deleted after the batch and recorded full', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld(); // option capacity 1
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    // The plan reads capacity BEFORE the batch, so it sees 12 Nov free; the rival lands in the same
    // batch ahead of the series rows — exactly what a concurrent writer between read and write does.
    const rival = env.PAWSERVATION_DB.prepare(
      `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, OptionKey, PetCount, EstCost, Status, SyncPending, CreatedAt)
       VALUES ('rival', ?, ?, ?, '2030-11-12', ?, 1, 2500, 'confirmed', 1, 'x')`,
    ).bind(TENANT_A, user, SERVICE, terms.optionKey);
    const out = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
      [rival],
    );
    expect(out.added.map((a) => a.date)).toEqual(['2030-11-05', '2030-11-19']);
    expect(out.skipped).toEqual([{ date: '2030-11-12', reason: 'full' }]);
    expect(
      raw.prepare(`SELECT Id FROM BookingRequests WHERE StartDate = '2030-11-12'`).all(),
    ).toEqual([{ Id: 'rival' }]);
    expect(
      raw
        .prepare(
          `SELECT Reason FROM BookingSeriesSkips WHERE SeriesId = 's1' AND Date = '2030-11-12'`,
        )
        .get(),
    ).toEqual({
      Reason: 'full',
    });
    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS n FROM BookingRequestPets WHERE BookingRequestId NOT IN (SELECT Id FROM BookingRequests)`,
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it('the re-check deletes nothing when no rival exists (its own row is excluded on its date)', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld(); // option capacity 1
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    const out = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
    );
    expect(out.added).toHaveLength(3);
    expect(out.skipped).toEqual([]);
  });

  it('never writes a row for an unpriced date (the trap)', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const [second] = seedPets(raw, TENANT_A, USER, [{ id: 'pet_sw_bo', petType: 'dog' }]);
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    const out = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE, petIds: [...terms.petIds, second] },
      '2030-11-19',
      '2030-11-01',
      'pending',
    );
    expect(out.added).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual([
      'unpriced_pet_set',
      'unpriced_pet_set',
      'unpriced_pet_set',
    ]);
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE SeriesId = 's1'`).get(),
    ).toEqual({ n: 0 });
  });

  it('never creates a walk for today or earlier: a series that started in the past begins tomorrow', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    const out = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-26',
      '2030-11-12',
      'confirmed',
    );
    expect(out.added.map((a) => a.date)).toEqual(['2030-11-19', '2030-11-26']);
  });

  it('is bounded by the projection cap, whatever `through` it is handed', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    const out = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '9999-12-31',
      '2030-11-01',
      'confirmed',
    );
    expect(out.added[out.added.length - 1].date <= '2032-11-01').toBe(true);
    expect(
      raw.prepare(`SELECT MaterializedThrough FROM BookingSeries WHERE Id = 's1'`).get(),
    ).toEqual({
      MaterializedThrough: '2032-11-01',
    });
  });

  it('a prelude that fails rolls back the whole batch', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    const bad = env.PAWSERVATION_DB.prepare(
      `UPDATE BookingSeries SET Weekdays = 0 WHERE Id = 's1'`,
    ); // CHECK 1..127
    await expect(
      materializeSpan(
        env,
        tenant,
        series,
        { ...terms, ...TUE },
        '2030-11-19',
        '2030-11-01',
        'confirmed',
        [bad],
      ),
    ).rejects.toThrow();
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE SeriesId = 's1'`).get(),
    ).toEqual({ n: 0 });
    expect(
      raw.prepare(`SELECT MaterializedThrough FROM BookingSeries WHERE Id = 's1'`).get(),
    ).toEqual({
      MaterializedThrough: null,
    });
  });
});

describe('materializeSpan — review fixes', () => {
  it('a series with no option named writes the RESOLVED option on every row and on the series, so its walks hold the slot', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld(); // option capacity 1
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    raw.exec(`UPDATE BookingSeries SET OptionKey = NULL WHERE Id = 's1'`);
    const out = await materializeSpan(
      env,
      tenant,
      { ...series, OptionKey: null },
      { ...terms, ...TUE, optionKey: null },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
    );
    expect(out.added).toHaveLength(3);
    expect(
      raw.prepare(`SELECT DISTINCT OptionKey FROM BookingRequests WHERE SeriesId = 's1'`).all(),
    ).toEqual([{ OptionKey: OPTION }]);
    expect(raw.prepare(`SELECT OptionKey FROM BookingSeries WHERE Id = 's1'`).get()).toEqual({
      OptionKey: OPTION,
    });
    // A single booking on one of its dates now reads the slot as full.
    const service = (await listServices(env.PAWSERVATION_DB, TENANT_A)).find(
      (s) => s.ServiceType === SERVICE,
    )!;
    const option = (await listServiceOptions(env.PAWSERVATION_DB, TENANT_A)).find(
      (o) => o.ServiceType === SERVICE,
    )!;
    const single = await walkConflictsForSpan(
      env,
      tenant,
      service,
      option,
      ['2030-11-12'],
      1,
      null,
    );
    expect(single.get('2030-11-12')).toBe('slot_full');
  });

  it('the re-check still runs when the terms change between the batch and the re-check (service switched off mid-flight)', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    const db = env.PAWSERVATION_DB;
    const rival = db
      .prepare(
        `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, OptionKey, PetCount, EstCost, Status)
         VALUES ('rival', ?, ?, ?, '2030-11-12', ?, 1, 2500, 'confirmed')`,
      )
      .bind(TENANT_A, user, SERVICE, OPTION);
    const switchOff = db
      .prepare(`UPDATE TenantServices SET Enabled = 0 WHERE TenantId = ? AND ServiceType = ?`)
      .bind(TENANT_A, SERVICE);
    const out = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
      [rival, switchOff],
    );
    expect(out.skipped).toEqual([{ date: '2030-11-12', reason: 'full' }]);
    expect(
      raw.prepare(`SELECT Id FROM BookingRequests WHERE StartDate = '2030-11-12'`).all(),
    ).toEqual([{ Id: 'rival' }]);
  });

  it('a row lost in the re-check records its real reason (time off taken mid-flight is time_off)', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    const block = env.PAWSERVATION_DB.prepare(
      `INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, Status)
       VALUES ('blk', ?, 'blocked', '2030-11-12', '2030-11-13', 1, 'confirmed')`,
    ).bind(TENANT_A);
    const out = await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
      [block],
    );
    expect(out.skipped).toEqual([{ date: '2030-11-12', reason: 'time_off' }]);
    expect(
      raw
        .prepare(
          `SELECT Reason FROM BookingSeriesSkips WHERE SeriesId = 's1' AND Date = '2030-11-12'`,
        )
        .get(),
    ).toEqual({ Reason: 'time_off' });
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE SeriesId = 's1'`).get(),
    ).toEqual({ n: 2 });
  });

  it("a row is written only for a series that is the tenant's own", async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    raw.exec(`UPDATE BookingSeries SET TenantId = 'tnt_happytails' WHERE Id = 's1'`);
    await materializeSpan(
      env,
      tenant,
      series,
      { ...terms, ...TUE },
      '2030-11-19',
      '2030-11-01',
      'confirmed',
    );
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE SeriesId = 's1'`).get(),
    ).toEqual({ n: 0 });
  });
});

describe('projectSeries', () => {
  it('returns the booking shape with projected ids, current rates and computed skips, holding no capacity', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld(); // option capacity 1
    const a = seedSeriesRow(raw, {
      id: 'sa',
      endUserId: user,
      status: 'active',
      weekdays: 8,
      startDate: '2030-11-01',
    });
    const b = seedSeriesRow(raw, {
      id: 'sb',
      endUserId: user,
      status: 'active',
      weekdays: 8,
      startDate: '2030-11-01',
    });
    insertRow(raw, {
      id: 'blk',
      serviceType: 'blocked',
      date: '2030-11-14',
      endDate: '2030-11-15',
    });
    const pa = await projectSeries(env, tenant, a, terms, '2030-11-01', '2030-11-28', '2030-11-01');
    const pb = await projectSeries(env, tenant, b, terms, '2030-11-01', '2030-11-28', '2030-11-01');
    expect(pa).toEqual([
      { id: 'series:sa:2030-11-07', date: '2030-11-07', status: 'confirmed', estCostCents: 2500 },
      {
        id: 'series:sa:2030-11-14',
        date: '2030-11-14',
        status: 'confirmed',
        estCostCents: null,
        skipped: 'time_off',
      },
      { id: 'series:sa:2030-11-21', date: '2030-11-21', status: 'confirmed', estCostCents: 2500 },
      { id: 'series:sa:2030-11-28', date: '2030-11-28', status: 'confirmed', estCostCents: 4000 },
    ]);
    // Both projected onto the same capacity-1 day: both read booked — projection holds nothing.
    expect(pb.find((w) => w.date === '2030-11-21')).toEqual({
      id: 'series:sb:2030-11-21',
      date: '2030-11-21',
      status: 'confirmed',
      estCostCents: 2500,
    });
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE SeriesId IS NOT NULL`).get(),
    ).toEqual({ n: 0 });
  });

  it('reads a recorded skip (cancelled, paused) rather than computing it', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const s = seedSeriesRow(raw, {
      id: 's1',
      endUserId: user,
      status: 'active',
      weekdays: 8,
      startDate: '2030-11-01',
    });
    raw.exec(`INSERT INTO BookingSeriesSkips (SeriesId, TenantId, Date, Reason, CreatedAt) VALUES
      ('s1', '${TENANT_A}', '2030-11-07', 'cancelled', 'x'), ('s1', '${TENANT_A}', '2030-11-14', 'paused', 'x')`);
    const out = await projectSeries(
      env,
      tenant,
      s,
      terms,
      '2030-11-01',
      '2030-11-14',
      '2030-11-01',
    );
    expect(out.map((w) => [w.date, w.skipped, w.estCostCents])).toEqual([
      ['2030-11-07', 'cancelled', null],
      ['2030-11-14', 'paused', null],
    ]);
  });

  it('never projects a date that already has a row', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const s = seedSeriesRow(raw, {
      id: 's1',
      endUserId: user,
      status: 'active',
      weekdays: 8,
      startDate: '2030-11-01',
    });
    insertRow(raw, {
      id: 'own',
      serviceType: SERVICE,
      date: '2030-11-07',
      seriesId: 's1',
      status: 'cancelled',
    });
    const out = await projectSeries(
      env,
      tenant,
      s,
      terms,
      '2030-11-01',
      '2030-11-14',
      '2030-11-01',
    );
    expect(out.map((w) => w.date)).toEqual(['2030-11-14']);
  });

  it('status follows the series: active → confirmed, pending → pending, pending_client → offered', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const statusOf = async (id: string, status: SeriesStatus) => {
      const s = seedSeriesRow(raw, {
        id,
        endUserId: user,
        status,
        weekdays: 8,
        startDate: '2030-11-01',
      });
      const [w] = await projectSeries(
        env,
        tenant,
        s,
        terms,
        '2030-11-01',
        '2030-11-07',
        '2030-11-01',
      );
      return w?.status;
    };
    expect(await statusOf('s_a', 'active')).toBe('confirmed');
    expect(await statusOf('s_p', 'pending')).toBe('pending');
    expect(await statusOf('s_c', 'pending_client')).toBe('offered');
    expect(await statusOf('s_e', 'ended')).toBeUndefined();
  });

  it('is bounded by the projection cap, whatever `to` it is handed', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const s = seedSeriesRow(raw, {
      id: 's1',
      endUserId: user,
      status: 'active',
      weekdays: 8,
      startDate: '2030-11-01',
    });
    const out = await projectSeries(
      env,
      tenant,
      s,
      terms,
      '2030-11-01',
      '9999-12-31',
      '2030-11-01',
    );
    expect(out[out.length - 1].date <= '2032-11-01').toBe(true);
  });
});

describe('a switched-off service counts as gone for new walks', () => {
  const setEnabled = (raw: Raw, on: 0 | 1) =>
    raw
      .prepare(`UPDATE TenantServices SET Enabled = ? WHERE TenantId = ? AND ServiceType = ?`)
      .run(on, TENANT_A, SERVICE);

  it('materializeSpan refuses it as SeriesTermsGone and writes nothing (nor the prelude) — no rows, no skips, the mark not advanced — keeping the rows it already has', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const series = seedSeriesRow(raw, { id: 's1', endUserId: user, status: 'active', ...TUE });
    insertRow(raw, { id: 'own', serviceType: SERVICE, date: '2030-11-05', seriesId: 's1' });
    setEnabled(raw, 0);
    const prelude = env.PAWSERVATION_DB.prepare(
      `UPDATE BookingSeries SET StartTime = '10:00' WHERE Id = 's1'`,
    );
    await expect(
      materializeSpan(
        env,
        tenant,
        series,
        { ...terms, ...TUE },
        '2030-11-19',
        '2030-11-01',
        'confirmed',
        [prelude],
      ),
    ).rejects.toBeInstanceOf(SeriesTermsGone);
    expect(raw.prepare(`SELECT StartTime FROM BookingSeries WHERE Id = 's1'`).get()).toEqual({
      StartTime: '09:00',
    });
    expect(raw.prepare(`SELECT Id FROM BookingRequests WHERE SeriesId = 's1'`).all()).toEqual([
      { Id: 'own' },
    ]);
    expect(
      raw.prepare(`SELECT COUNT(*) AS n FROM BookingSeriesSkips WHERE SeriesId = 's1'`).get(),
    ).toEqual({ n: 0 });
    expect(
      raw.prepare(`SELECT MaterializedThrough FROM BookingSeries WHERE Id = 's1'`).get(),
    ).toEqual({
      MaterializedThrough: null,
    });
  });

  it('projectSeries projects nothing while it is off, and the walks come back when she switches it on', async () => {
    const { env, raw, tenant, user, terms } = await walkWorld();
    const s = seedSeriesRow(raw, {
      id: 's1',
      endUserId: user,
      status: 'active',
      weekdays: 8,
      startDate: '2030-11-01',
    });
    setEnabled(raw, 0);
    expect(
      await projectSeries(env, tenant, s, terms, '2030-11-01', '2030-11-14', '2030-11-01'),
    ).toEqual([]);
    setEnabled(raw, 1);
    const back = await projectSeries(
      env,
      tenant,
      s,
      terms,
      '2030-11-01',
      '2030-11-14',
      '2030-11-01',
    );
    expect(back.map((w) => w.date)).toEqual(['2030-11-07', '2030-11-14']);
  });

  it('evaluateWalks (a quote or a request) refuses it as SeriesTermsGone', async () => {
    const { env, raw, tenant, terms } = await walkWorld();
    setEnabled(raw, 0);
    await expect(evaluateWalks(env, tenant, terms, ['2030-12-05'], {})).rejects.toBeInstanceOf(
      SeriesTermsGone,
    );
  });
});
