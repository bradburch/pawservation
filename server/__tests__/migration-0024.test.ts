import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
  '0024_walk_rate_unit.sql',
);

/** Pre-0024 shape of the two tables carrying a RateUnit CHECK (post-0023 sql/schema.sql, minus
 *  columns this migration doesn't touch on other tables). */
const OLD_DDL = `
CREATE TABLE Tenants (Id TEXT PRIMARY KEY);
CREATE TABLE TenantServices (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1,
  Label TEXT NOT NULL,
  Icon TEXT NOT NULL DEFAULT 'paw',
  Shape TEXT NOT NULL CHECK (Shape IN ('range', 'single')),
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  HasDuration INTEGER NOT NULL DEFAULT 0,
  CapacityKind TEXT NOT NULL DEFAULT 'none' CHECK (CapacityKind IN ('boarding', 'housesit', 'none')),
  SortOrder INTEGER NOT NULL DEFAULT 0,
  Questions TEXT NOT NULL DEFAULT '[]',
  MinNights INTEGER,
  MaxNights INTEGER,
  MinPetCount INTEGER,
  MaxPetCount INTEGER,
  AcceptedPetTypes TEXT,
  MaxConcurrentPets INTEGER,
  MaxPerDay INTEGER,
  CancellationTiers TEXT,
  UNIQUE (TenantId, ServiceType)
);
CREATE TABLE TenantServiceOptions (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  Label TEXT NOT NULL,
  DurationMinutes INTEGER,
  Rate INTEGER NOT NULL,
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  StartTime TEXT,
  EndTime TEXT,
  Capacity INTEGER,
  WeekdaysOnly INTEGER NOT NULL DEFAULT 0,
  UNIQUE (TenantId, ServiceType, OptionKey)
);
`;

describe("migration 0024 — 'walk' becomes a real RateUnit", () => {
  function migratedDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(OLD_DDL);
    db.exec(`INSERT INTO Tenants (Id) VALUES ('t1'), ('t2')`);
    db.exec(`INSERT INTO TenantServices
      (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind, SortOrder, Questions, MinNights, MaxConcurrentPets, CancellationTiers) VALUES
      ('t1', 'boarding',     1, 'Boarding',     'bed',       'range',  'night', 0, 'boarding', 0, '[{"id":"q1"}]', 2, 4, '[{"withinDays":2,"percent":100}]'),
      ('t1', 'walk',         1, 'Walk',         'paw',       'single', 'visit', 1, 'none',     3, '[]', NULL, NULL, NULL),
      ('t1', 'checkin',      0, 'Check-in',     'clipboard', 'single', 'visit', 1, 'none',     4, '[]', NULL, NULL, NULL),
      ('t1', 'sunset-stroll', 1, 'Sunset Walk', 'paw',       'single', 'visit', 1, 'none',     5, '[]', NULL, NULL, NULL),
      ('t2', 'daycare',      1, 'Daycare',      'sun',       'single', 'day',   0, 'none',     2, '[]', NULL, NULL, NULL)`);
    db.exec(`INSERT INTO TenantServiceOptions
      (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity, WeekdaysOnly) VALUES
      ('o1', 't1', 'walk',     'd30', '30 minutes', 30, 20, 'visit', '10:00', '14:00', 8, 1),
      ('o2', 't1', 'checkin',  'd15', '15 minutes', 15, 12, 'visit', NULL, NULL, NULL, 0),
      ('o3', 't1', 'boarding', 'std', 'Standard',   NULL, 50, 'night', NULL, NULL, NULL, 0)`);
    db.exec('BEGIN');
    db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
    db.exec('COMMIT');
    return db;
  }

  const unit = (db: DatabaseSync, type: string) =>
    (
      db
        .prepare(`SELECT RateUnit FROM TenantServices WHERE TenantId = 't1' AND ServiceType = ?`)
        .get(type) as { RateUnit: string }
    ).RateUnit;

  it("moves walk-named services onto 'walk' and leaves check-ins on 'visit'", () => {
    const db = migratedDb();
    expect(unit(db, 'walk')).toBe('walk');
    // Matched by LABEL, not slug — the heuristic's second arm (see the migration's ponytail note).
    expect(unit(db, 'sunset-stroll')).toBe('walk');
    expect(unit(db, 'checkin')).toBe('visit');
    expect(unit(db, 'boarding')).toBe('night');
  });

  it("widens both CHECK constraints so 'walk' now inserts", () => {
    const db = migratedDb();
    db.exec('PRAGMA foreign_keys=ON');
    expect(() => {
      db.exec(`INSERT INTO TenantServices (TenantId, ServiceType, Label, Shape, RateUnit)
               VALUES ('t1', 'dawn-walk', 'Dawn walk', 'single', 'walk')`);
      db.exec(`INSERT INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, Rate, RateUnit)
               VALUES ('o9', 't1', 'dawn-walk', 'd30', '30 minutes', 22, 'walk')`);
    }).not.toThrow();
    // The old units still pass, and a bogus one is still rejected.
    expect(() => {
      db.exec(`INSERT INTO TenantServices (TenantId, ServiceType, Label, Shape, RateUnit)
               VALUES ('t1', 'teleport', 'Teleport', 'single', 'parsec')`);
    }).toThrow(/CHECK constraint failed/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('preserves every column of every row through the rebuild', () => {
    const db = migratedDb();
    expect(
      db
        .prepare(`SELECT * FROM TenantServices WHERE TenantId='t1' AND ServiceType='boarding'`)
        .get(),
    ).toMatchObject({
      Enabled: 1,
      Label: 'Boarding',
      Icon: 'bed',
      Shape: 'range',
      RateUnit: 'night',
      HasDuration: 0,
      CapacityKind: 'boarding',
      SortOrder: 0,
      Questions: '[{"id":"q1"}]',
      MinNights: 2,
      MaxConcurrentPets: 4,
      CancellationTiers: '[{"withinDays":2,"percent":100}]',
    });
    expect(db.prepare(`SELECT * FROM TenantServiceOptions WHERE Id='o1'`).get()).toMatchObject({
      TenantId: 't1',
      ServiceType: 'walk',
      OptionKey: 'd30',
      Label: '30 minutes',
      DurationMinutes: 30,
      Rate: 20,
      StartTime: '10:00',
      EndTime: '14:00',
      Capacity: 8,
      WeekdaysOnly: 1,
    });
    // Row counts intact, and the other tenant is untouched.
    expect(db.prepare('SELECT COUNT(*) AS n FROM TenantServices').get()).toMatchObject({ n: 5 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM TenantServiceOptions').get()).toMatchObject({
      n: 3,
    });
    expect(
      db.prepare(`SELECT RateUnit FROM TenantServices WHERE TenantId='t2'`).get(),
    ).toMatchObject({ RateUnit: 'day' });
  });

  it("carries the retired per-option RateUnit copy along to 'walk' (never read, must still pass the CHECK)", () => {
    const db = migratedDb();
    const opts = db.prepare(`SELECT Id, RateUnit FROM TenantServiceOptions ORDER BY Id`).all() as {
      Id: string;
      RateUnit: string;
    }[];
    expect(opts).toEqual([
      { Id: 'o1', RateUnit: 'walk' },
      { Id: 'o2', RateUnit: 'visit' },
      { Id: 'o3', RateUnit: 'night' },
    ]);
  });

  // NOT a licence to re-run the file in production. This proves only that the SQL is idempotent
  // against the 0023-era schema above. The real DB gains TenantServices.Description in 0025, which
  // is absent from the migration's explicit column list — so a second run against a 0025 database
  // silently DROPS that column and its data, and reports success. See the run-once-only warning at
  // the top of migrations/0024_walk_rate_unit.sql. This test cannot observe that by construction.
  it('is idempotent against the schema it was written for — a second run changes nothing', () => {
    const db = migratedDb();
    const before = db.prepare('SELECT * FROM TenantServices ORDER BY TenantId, ServiceType').all();
    db.exec('BEGIN');
    db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
    db.exec('COMMIT');
    expect(db.prepare('SELECT * FROM TenantServices ORDER BY TenantId, ServiceType').all()).toEqual(
      before,
    );
  });
});
