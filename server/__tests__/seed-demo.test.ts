import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import app from '../index';
import { createTestEnv, endUserToken, TENANT_A } from './helpers';
import {
  addDays,
  buildCapacity,
  getPacificDateStr,
  rangeHasConflict,
} from '../../src/shared/index.js';
import type { CapacityRequest } from '../../src/shared/index.js';
import { getTenantBySlug, listCapacityRows, listServices } from '../db/repo';
import { monthAvailability, rowsToCapacityEvents, type MonthDay } from '../lib/availability';
import type { Tenant, TenantService, TenantServiceOption } from '../types';

/**
 * sql/seed-demo.sql — the lived-in demo seed. Its whole point is that the demo tenants show a
 * calendar a working sitter would recognise: bookings against every enabled service, and days the
 * widget paints `partial`/`unavailable` rather than an unbroken wall of green.
 *
 * A conflict the capacity engine does not actually see is worse than no conflict at all, so these
 * assertions go through the SAME paths the widget and the sitter do — the real
 * `/availability/month` route, and the real capacity engine over `listCapacityRows` — never a
 * re-derivation of the rules inside the test.
 *
 * Every date is read back OUT of the row that carries it (the seed writes them with
 * `date('now', '+N days')`), so the test asserts on the dates the seed actually produced and
 * cannot drift from them, whatever day it runs.
 *
 * TIME-STABILITY. The demo's dates slide forward every day, so an assertion that holds today can
 * fail on some future date if anything in the database is pinned to a static one — which is
 * exactly what sql/seed.sql's seven hardcoded rows used to do (they collided on 35 of the next 900
 * days). The demo seed re-stamps those rows relative to `now`, so the demo database has NO static
 * dates and its geometry is identical whatever "today" is. Two tests hold that line: the "no
 * booking outside the relative window" guard below, and the sweep at the bottom, which rebuilds
 * the whole fixture for hundreds of simulated `now` values and re-runs the real availability
 * derivation against each one.
 */

type Row = { StartDate: string; EndDate: string | null };

const bookingDates = (raw: DatabaseSync, id: string): Row =>
  raw.prepare(`SELECT StartDate, EndDate FROM BookingRequests WHERE Id = ?`).get(id) as Row;

/** The widget's own month-grid call, for the month containing `date`. */
async function dayStatus(
  env: Env,
  token: string,
  slug: string,
  serviceType: string,
  date: string,
  optionKey?: string,
): Promise<MonthDay> {
  const query = new URLSearchParams({ type: serviceType, month: date.slice(0, 7) });
  if (optionKey) query.set('option', optionKey);
  const res = await app.request(
    `/api/${slug}/availability/month?${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
    env,
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { days: MonthDay[] };
  return body.days.find((d) => d.date === date)!;
}

/** Every date in [start, endExclusive). */
const daysIn = (start: string, endExclusive: string): string[] => {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
};

describe('sql/seed-demo.sql — shape', () => {
  it('gives every enabled service of every tenant at least one booking', () => {
    const { raw } = createTestEnv({ demoActivity: true });
    const idle = raw
      .prepare(
        `SELECT s.TenantId, s.ServiceType FROM TenantServices s
          WHERE s.Enabled = 1
            AND NOT EXISTS (SELECT 1 FROM BookingRequests b
                             WHERE b.TenantId = s.TenantId AND b.ServiceType = s.ServiceType)`,
      )
      .all();
    expect(idle).toEqual([]);
  });

  it('mixes pending and confirmed work into every tenant', () => {
    const { raw } = createTestEnv({ demoActivity: true });
    for (const tenantId of ['tnt_sunnypaws', 'tnt_happytails', 'tnt_pawsandrelax']) {
      const counts = raw
        .prepare(
          `SELECT Status, COUNT(*) AS n FROM BookingRequests
            WHERE TenantId = ? AND ServiceType NOT IN ('blocked', 'external') GROUP BY Status`,
        )
        .all(tenantId) as { Status: string; n: number }[];
      const byStatus = new Map(counts.map((c) => [c.Status, c.n]));
      expect(byStatus.get('pending') ?? 0).toBeGreaterThan(0);
      expect(byStatus.get('confirmed') ?? 0).toBeGreaterThan(0);
    }
  });

  it('books ONE pet at a time, and every booking names the pet its owner owns', () => {
    // The demo-only rows are the difference between the two fixtures, so this stays true as the
    // seed grows without anyone having to re-list ids here.
    const ids = (raw: DatabaseSync) =>
      (raw.prepare(`SELECT Id FROM BookingRequests`).all() as { Id: string }[]).map((r) => r.Id);
    const base = new Set(ids(createTestEnv().raw));
    const { raw } = createTestEnv({ demoActivity: true });
    const demoOnly = ids(raw).filter((id) => !base.has(id));
    expect(demoOnly.length).toBeGreaterThan(20);

    for (const id of demoOnly) {
      const row = raw
        .prepare(`SELECT ServiceType, EndUserId, PetCount FROM BookingRequests WHERE Id = ?`)
        .get(id) as { ServiceType: string; EndUserId: string | null; PetCount: number };
      // A set of 2+ pets with no stored pet-set rate is REFUSED at pricing (`unpriced_pet_set`),
      // and a demo that shows an unpriceable booking is a bad demo.
      expect({ id, petCount: row.PetCount }).toEqual({ id, petCount: 1 });
      if (row.ServiceType === 'blocked') {
        expect({ id, endUserId: row.EndUserId }).toEqual({ id, endUserId: null });
        continue;
      }
      // Pet references flow through BookingRequestPets -> EndUserPets, and PetOwners is the
      // authority on who may see/book that pet.
      const owned = raw
        .prepare(
          `SELECT COUNT(*) AS n FROM BookingRequestPets brp
             JOIN PetOwners po ON po.PetId = brp.PetId
            WHERE brp.BookingRequestId = ? AND po.EndUserId = ?`,
        )
        .get(id, row.EndUserId) as { n: number };
      expect({ id, ownedPets: owned.n }).toEqual({ id, ownedPets: 1 });
    }
  });

  it('leaves NO static date in the demo database — every booking rides the sliding window', () => {
    const { raw } = createTestEnv({ demoActivityAsOf: '2027-03-09' });
    // With `now` simulated, a row still carrying a hardcoded date is instantly obvious: it sits
    // nowhere near the simulated window. This is the guard that keeps the suite time-stable — a
    // statically-dated booking added to sql/seed.sql and not re-stamped in seed-demo.sql fails
    // HERE, at the point of the mistake, instead of on some random future morning in CI.
    const strays = raw
      .prepare(
        `SELECT Id, StartDate FROM BookingRequests
          WHERE StartDate < '2027-03-09' OR StartDate > date('2027-03-09', '+70 days')
             OR (EndDate IS NOT NULL AND EndDate > date('2027-03-09', '+70 days'))
          ORDER BY Id`,
      )
      .all();
    expect(strays).toEqual([]);
  });

  it('respects the weekday-only custom service (`weekday N` modifier, not a fixed date)', () => {
    const { raw } = createTestEnv({ demoActivity: true });
    // opt_sp_mw30 is WeekdaysOnly=1: the server rejects a weekend morning walk, so seeded ones
    // that landed on a Saturday would be data the app itself would refuse to create.
    const weekendMorningWalks = raw
      .prepare(
        `SELECT Id, StartDate FROM BookingRequests
          WHERE ServiceType = 'morning-walk' AND strftime('%w', StartDate) IN ('0', '6')`,
      )
      .all();
    expect(weekendMorningWalks).toEqual([]);
    expect(
      raw
        .prepare(`SELECT COUNT(*) AS n FROM BookingRequests WHERE ServiceType = 'morning-walk'`)
        .get(),
    ).toEqual({ n: 2 });
  });

  it('is idempotent — applying it twice leaves the same rows', () => {
    const { raw } = createTestEnv({ demoActivity: true });
    const snapshot = () =>
      JSON.stringify([
        raw.prepare(`SELECT * FROM BookingRequests ORDER BY Id`).all(),
        raw.prepare(`SELECT * FROM BookingRequestPets ORDER BY BookingRequestId, PetId`).all(),
        raw.prepare(`SELECT Id, TenantId, Email, Name, Status FROM EndUsers ORDER BY Id`).all(),
        raw
          .prepare(`SELECT Id, TenantId, EndUserId, Name, PetType FROM EndUserPets ORDER BY Id`)
          .all(),
        raw.prepare(`SELECT * FROM PetOwners ORDER BY PetId, EndUserId`).all(),
      ]);
    const before = snapshot();
    raw.exec(readFileSync(join(import.meta.dirname, '..', '..', 'sql', 'seed-demo.sql'), 'utf8'));
    expect(snapshot()).toBe(before);
  });

  it('accepts every pet it books — no booking names a species its service refuses', () => {
    // The demo tenants materialize src/shared/service-templates.ts's `defaultAcceptedPetTypes`
    // (dog-only walks/daycare/boarding, cat-only check-ins, house sitting open to anything), so a
    // seeded booking could easily end up naming a pet the booking POST would itself have refused
    // on `validatePetTypeAcceptance`. That is a self-contradicting demo, and this is the guard.
    // AcceptedPetTypes is read straight off the row and matched with json_each, so it stays true
    // however the acceptance lists are edited.
    const { raw } = createTestEnv({ demoActivity: true });
    const rejected = raw
      .prepare(
        `SELECT b.Id, p.Name AS Pet, p.PetType, b.ServiceType
           FROM BookingRequests b
           JOIN BookingRequestPets brp ON brp.BookingRequestId = b.Id
           JOIN EndUserPets p ON p.Id = brp.PetId
           JOIN TenantServices s ON s.TenantId = b.TenantId AND s.ServiceType = b.ServiceType
          WHERE s.AcceptedPetTypes IS NOT NULL
            AND p.PetType NOT IN (SELECT value FROM json_each(s.AcceptedPetTypes))
          ORDER BY b.Id`,
      )
      .all();
    expect(rejected).toEqual([]);
  });

  it('keeps every accepted species inside its tenant pet-type registry', () => {
    // A service may only accept types the tenant actually registers, and an ENABLED service may
    // not accept nothing at all — server/routes/admin.ts rejects both on the next settings PUT,
    // so a demo violating either is a demo the sitter cannot save.
    const { raw } = createTestEnv({ demoActivity: true });
    expect(
      raw
        .prepare(
          `SELECT s.TenantId, s.ServiceType, j.value AS PetType
             FROM TenantServices s, json_each(s.AcceptedPetTypes) j
            WHERE s.AcceptedPetTypes IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM TenantPetTypes t
                               WHERE t.TenantId = s.TenantId AND t.PetType = j.value)
            ORDER BY s.TenantId, s.ServiceType`,
        )
        .all(),
    ).toEqual([]);
    expect(
      raw
        .prepare(
          `SELECT TenantId, ServiceType FROM TenantServices
            WHERE Enabled = 1 AND AcceptedPetTypes = '[]' ORDER BY TenantId, ServiceType`,
        )
        .all(),
    ).toEqual([]);
  });

  it('touches ONLY the three seeded demo tenants — a real tenant is untouched', () => {
    // CLAUDE.md's central invariant is "every write is scoped by TenantId". This file is chained
    // onto `seed:remote` (package.json), so an unscoped statement here would not just be a demo
    // wart: applied against a real database it would rewrite real sitters' rows. Seed a FOURTH
    // tenant — unrelated to the three this file knows about — with its own services, apply
    // seed-demo.sql, and prove those rows survive unchanged. Every column this file UPDATEs needs
    // a witness here, and one per statement: PetRateMode, plus an AcceptedPetTypes row for each of
    // the three acceptance writes (dog-only, cat-only, and the NULL that opens house sitting) —
    // each seeded to a DIFFERENT value than the statement would write, so an unscoped write is
    // visible rather than accidentally idempotent.
    const { raw } = createTestEnv(); // base seed only — demoActivity applied by hand below
    raw
      .prepare(
        `INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('tnt_other', 'other-co', 'Other Co')`,
      )
      .run();
    const addService = (type: string, accepted: string | null) =>
      raw
        .prepare(
          `INSERT INTO TenantServices
             (TenantId, ServiceType, Label, Shape, RateUnit, PetRateMode, AcceptedPetTypes)
           VALUES ('tnt_other', ?, 'Service', 'range', 'night', 'exact', ?)`,
        )
        .run(type, accepted);
    addService('boarding', '["cat","dog"]'); // the '["dog"]' statement must not narrow it
    addService('checkin', null); // the '["cat"]' statement must not fill it
    addService('housesitting', '["dog"]'); // the NULL statement must not clear it

    raw.exec(readFileSync(join(import.meta.dirname, '..', '..', 'sql', 'seed-demo.sql'), 'utf8'));

    expect(
      raw
        .prepare(
          `SELECT ServiceType, PetRateMode, AcceptedPetTypes FROM TenantServices
            WHERE TenantId = 'tnt_other' ORDER BY ServiceType`,
        )
        .all(),
    ).toEqual([
      { ServiceType: 'boarding', PetRateMode: 'exact', AcceptedPetTypes: '["cat","dog"]' },
      { ServiceType: 'checkin', PetRateMode: 'exact', AcceptedPetTypes: null },
      { ServiceType: 'housesitting', PetRateMode: 'exact', AcceptedPetTypes: '["dog"]' },
    ]);
  });
});

describe('sql/seed-demo.sql — the conflicts are real', () => {
  it('Sunny Paws: the over-booked boarding week paints unavailable, its shoulders partial', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const a = bookingDates(raw, 'seed_sp_board_a'); // now+5 .. now+12, confirmed
    const b = bookingDates(raw, 'seed_sp_board_b'); // now+7 .. now+11, confirmed

    // Two 1-pet stays overlap: MaxConcurrentPets=2 is reached (and the pending third pushes the
    // middle two days past it), so every night b occupies is closed.
    for (const date of daysIn(b.StartDate, b.EndDate!)) {
      const day = await dayStatus(env, token, 'sunny-paws', 'boarding', date);
      expect({ date, status: day.status, max: day.max }).toEqual({
        date,
        status: 'unavailable',
        max: 2,
      });
      expect(day.used).toBeGreaterThanOrEqual(2);
    }

    // Shoulders: one pet in a two-pet pool.
    for (const date of [...daysIn(a.StartDate, b.StartDate), b.EndDate!]) {
      const day = await dayStatus(env, token, 'sunny-paws', 'boarding', date);
      expect({ date, status: day.status, used: day.used }).toEqual({
        date,
        status: 'partial',
        used: 1,
      });
    }

    // Checkout day is free — EndDate is exclusive, there is no overnight on it.
    const after = await dayStatus(env, token, 'sunny-paws', 'boarding', a.EndDate!);
    expect(after.status).toBe('available');
  });

  it('Sunny Paws: the pending request over those dates really is in conflict', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const c = bookingDates(raw, 'seed_sp_board_c');
    const status = raw
      .prepare(`SELECT Status FROM BookingRequests WHERE Id = 'seed_sp_board_c'`)
      .get() as { Status: string };
    expect(status.Status).toBe('pending');

    const request: CapacityRequest = {
      serviceType: 'boarding',
      kind: 'boarding',
      cap: 2, // Sunny Paws boarding MaxConcurrentPets
      petCount: 1,
    };
    // Exactly what the sitter's confirm path asks: is there room for this booking, ignoring the
    // booking itself? Bookend sharing does not rescue it — its endpoints are interior days of two
    // already-confirmed stays, and the day after is full too.
    const rows = await listCapacityRows(
      env.PAWBOOK_DB,
      TENANT_A,
      c.StartDate,
      addDays(c.EndDate!, 1),
      'seed_sp_board_c',
    );
    const capacity = buildCapacity(rowsToCapacityEvents(rows));
    expect(rangeHasConflict(c.StartDate, c.EndDate!, request, capacity)).toBe(true);

    // Control: the same request four weeks later is fine, so the `true` above comes from the
    // seeded rows and not from a mis-built request.
    const clearStart = addDays(c.StartDate, 60);
    const clearEnd = addDays(c.EndDate!, 60);
    const clearRows = await listCapacityRows(
      env.PAWBOOK_DB,
      TENANT_A,
      clearStart,
      addDays(clearEnd, 1),
    );
    expect(
      rangeHasConflict(
        clearStart,
        clearEnd,
        request,
        buildCapacity(rowsToCapacityEvents(clearRows)),
      ),
    ).toBe(false);
  });

  it('Happy Tails: four nested stays plus a pending one fill the 4-pet pool', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const a = bookingDates(raw, 'seed_ht_board_a'); // now+14 .. now+21
    const b = bookingDates(raw, 'seed_ht_board_b'); // now+15 .. now+20
    const c = bookingDates(raw, 'seed_ht_board_c'); // now+16 .. now+19

    for (const date of daysIn(c.StartDate, c.EndDate!)) {
      const day = await dayStatus(env, token, 'happy-tails', 'boarding', date);
      expect({ date, status: day.status, max: day.max }).toEqual({
        date,
        status: 'unavailable',
        max: 4,
      });
      expect(day.used).toBeGreaterThanOrEqual(4);
    }
    for (const date of [...daysIn(a.StartDate, c.StartDate), c.EndDate!, b.EndDate!]) {
      const day = await dayStatus(env, token, 'happy-tails', 'boarding', date);
      expect({ date, status: day.status }).toEqual({ date, status: 'partial' });
    }
  });

  it('a blocked stretch closes every service, and reopens on its exclusive end date', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const block = bookingDates(raw, 'seed_sp_block2');

    for (const date of daysIn(block.StartDate, block.EndDate!)) {
      // Boarding draws on a pool; walks are block-only. A blocked day stops both.
      for (const serviceType of ['boarding', 'walk']) {
        const day = await dayStatus(env, token, 'sunny-paws', serviceType, date);
        expect({ serviceType, date, status: day.status }).toEqual({
          serviceType,
          date,
          status: 'unavailable',
        });
      }
    }
    const reopens = await dayStatus(env, token, 'sunny-paws', 'walk', block.EndDate!);
    expect(reopens.status).toBe('available');
  });

  it('Happy Tails: the 3-dog group walk sells out for that option only', async () => {
    const { env, raw } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
    const { StartDate } = bookingDates(raw, 'seed_ht_grp_a');

    const full = await dayStatus(env, token, 'happy-tails', 'walk', StartDate, 'group-8-9');
    expect(full.status).toBe('unavailable');
    // The slot is full, not the day: a different walk option on the same date is still open.
    const open = await dayStatus(env, token, 'happy-tails', 'walk', StartDate, 'd30');
    expect(open.status).toBe('available');
  });

  it('seeds no house sit the engine would itself refuse', async () => {
    // A house sit may overlap occupied boarding — on ANY boarding-kind service, tenant-wide — by
    // at most ONE day (capacity.ts's structural rule). A seeded CONFIRMED stay breaking it would
    // be showing a booking the POST would have rejected, which is worse than showing none.
    const { env, raw } = createTestEnv({ demoActivity: true });
    for (const [tenantId, id] of [
      [TENANT_A, 'seed_sp_house_a'],
      ['tnt_pawsandrelax', 'seed_pr_house_a'],
    ] as const) {
      const stay = bookingDates(raw, id);
      const rows = await listCapacityRows(
        env.PAWBOOK_DB,
        tenantId,
        stay.StartDate,
        addDays(stay.EndDate!, 1),
        id, // exclude itself: would the sitter have been able to accept this request?
      );
      const request: CapacityRequest = {
        serviceType: 'housesitting',
        kind: 'housesit',
        cap: null, // both tenants' house sitting is unlimited
        petCount: 1,
      };
      expect({
        id,
        conflict: rangeHasConflict(
          stay.StartDate,
          stay.EndDate!,
          request,
          buildCapacity(rowsToCapacityEvents(rows)),
        ),
      }).toEqual({ id, conflict: false });
    }
  });

  it("prices Sunny Paws house sitting for Jess's two pets — the multi-pet default the widget selects", async () => {
    // The embed widget pre-selects every ACCEPTED pet by default. Jess has two at Sunny Paws,
    // Bella (dog) and Mochi (cat), and house sitting is the demo's one open-to-any-species
    // service, so it is where that default really is a two-pet set. sql/seed.sql's services
    // predate PetRateMode (default 'exact'), which would refuse the set outright; seed-demo.sql
    // opts boarding/housesitting/daycare into 'linear' so the default quotes a real number instead
    // of landing on "hasn't set a price for this group of pets yet."
    const { env } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    // Far past every conflict this file seeds (the latest is the blocked stretch at now+60..+62),
    // so this is an ordinary open range — the test is about pricing, not availability.
    const today = getPacificDateStr();
    const start = addDays(today, 100);
    const end = addDays(start, 3);
    const res = await app.request(
      `/api/sunny-paws/availability?type=housesitting&start=${start}&end=${end}&petIds=pet_sp_bella,pet_sp_mochi`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // opt_sp_house's Rate is $70/night (sql/seed.sql); 3 nights x 2 distinct pets under the
    // 'linear' mode seed-demo.sql turns on. Pinned so a silent change to either number fails here.
    expect(body).toMatchObject({ available: true, priced: true, estCost: 420, billedUnits: 3 });
  });

  it("refuses Jess's cat on dog-only boarding — the demo carries the acceptance rule", async () => {
    // The counterpart to the quote above: boarding is dog-only in the demo, so the same pair is
    // not bookable there at all. This is what makes Mochi render greyed-out and unchecked in the
    // widget's roster, and what makes the default boarding selection Bella alone.
    const { env } = createTestEnv({ demoActivity: true });
    const token = await endUserToken(env, 'sunny-paws', 'jess@example.com');
    const today = getPacificDateStr();
    const start = addDays(today, 100);
    const end = addDays(start, 3);
    const url = (petIds: string) =>
      `/api/sunny-paws/availability?type=boarding&start=${start}&end=${end}&petIds=${petIds}`;
    const both = await app.request(
      url('pet_sp_bella,pet_sp_mochi'),
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(both.status).toBe(400);

    // Bella alone — the widget's actual default for boarding now — is a plain single-pet quote at
    // opt_sp_board's $50/night, so narrowing boarding did not strand the demo's first screen.
    const bella = await app.request(
      url('pet_sp_bella'),
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(bella.status).toBe(200);
    expect(await bella.json()).toMatchObject({
      available: true,
      priced: true,
      estCost: 150,
      billedUnits: 3,
    });
  });
});

/**
 * The demo's dates slide; anything static in the database does not. This sweep rebuilds the entire
 * fixture for a long run of simulated `now` values and re-runs the REAL availability derivation
 * (`monthAvailability`, not a copy of its rule) against each one, so a collision that would only
 * surface months from now fails here instead of turning `main` red on a random morning.
 */
describe('sql/seed-demo.sql — time stability sweep', () => {
  const SWEEP_DAYS = 900;

  /** Every day of the months this span touches, merged, keyed by date. */
  async function grid(
    env: Env,
    tenant: Tenant,
    service: TenantService,
    from: string,
    to: string,
    option: TenantServiceOption | null = null,
  ): Promise<Map<string, MonthDay>> {
    const months = new Set([from.slice(0, 7), to.slice(0, 7)]);
    const out = new Map<string, MonthDay>();
    for (const month of months) {
      const { days } = await monthAvailability(env, tenant, service, month, 'eu_sp_jess', option);
      for (const day of days) out.set(day.date, day);
    }
    return out;
  }

  it(`holds every conflict for ${SWEEP_DAYS}+ simulated values of "today"`, async () => {
    const today = getPacificDateStr();
    // Consecutive days cover every month length and weekday alignment many times over; the four
    // late-February anchors are computed from today so at least one always lands in a leap year,
    // whenever this runs.
    const year = Number(today.slice(0, 4));
    const anchors = [
      ...Array.from({ length: SWEEP_DAYS }, (_, i) => addDays(today, i)),
      ...[1, 2, 3, 4].map((i) => `${year + i}-02-27`),
    ];

    const failures: string[] = [];
    for (const asOf of anchors) {
      const { env, raw } = createTestEnv({ demoActivityAsOf: asOf });
      const tenants = {
        sp: (await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws'))!,
        ht: (await getTenantBySlug(env.PAWBOOK_DB, 'happy-tails'))!,
      };
      const svc = async (tenant: Tenant, type: string) =>
        (await listServices(env.PAWBOOK_DB, tenant.Id)).find((s) => s.ServiceType === type)!;
      const spBoarding = await svc(tenants.sp, 'boarding');
      const htBoarding = await svc(tenants.ht, 'boarding');

      const check = (label: string, date: string, actual: unknown, expected: unknown) => {
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          failures.push(`${asOf} -> ${label} ${date}: expected ${expected}, got ${actual}`);
        }
      };

      // Sunny Paws' over-booked week + its blocked stretch (the two windows that collided with
      // sql/seed.sql's static rows before those were re-stamped).
      const a = bookingDates(raw, 'seed_sp_board_a');
      const b = bookingDates(raw, 'seed_sp_board_b');
      const block = bookingDates(raw, 'seed_sp_block2');
      const sp = await grid(env, tenants.sp, spBoarding, a.StartDate, block.EndDate!);
      for (const date of daysIn(b.StartDate, b.EndDate!)) {
        check('SP full', date, sp.get(date)!.status, 'unavailable');
      }
      for (const date of [...daysIn(a.StartDate, b.StartDate), b.EndDate!]) {
        check('SP shoulder', date, [sp.get(date)!.status, sp.get(date)!.used], ['partial', 1]);
      }
      check('SP checkout', a.EndDate!, sp.get(a.EndDate!)!.status, 'available');
      for (const date of daysIn(block.StartDate, block.EndDate!)) {
        check('SP blocked', date, sp.get(date)!.status, 'unavailable');
      }
      check('SP reopen', block.EndDate!, sp.get(block.EndDate!)!.status, 'available');

      // Happy Tails' filling week.
      const ha = bookingDates(raw, 'seed_ht_board_a');
      const hc = bookingDates(raw, 'seed_ht_board_c');
      const ht = await grid(env, tenants.ht, htBoarding, ha.StartDate, ha.EndDate!);
      for (const date of daysIn(hc.StartDate, hc.EndDate!)) {
        check('HT full', date, ht.get(date)!.status, 'unavailable');
      }
      for (const date of daysIn(ha.StartDate, hc.StartDate)) {
        check('HT shoulder', date, ht.get(date)!.status, 'partial');
      }
    }

    // The slice first: a regression usually breaks a whole run of days, and ten readable lines
    // name the failing date and what it painted instead. The length check then catches the rest.
    expect(failures.slice(0, 10)).toEqual([]);
    expect(failures).toHaveLength(0);
    // 900 fixture rebuilds is ~2.5s alone and more under the suite's parallelism — comfortably
    // inside this, and far outside Vitest's 5s default.
  }, 60_000);
});
