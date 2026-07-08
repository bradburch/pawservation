import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
  '0006_custom_services.sql',
);

/** Pre-0006 shapes of the three rebuilt tables (ServiceType CHECK enums still in place). */
const OLD_DDL = `
CREATE TABLE Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  MaxBoardingPets INTEGER,
  MaxHouseSitsPerDay INTEGER,
  MaxStayNights INTEGER,
  Timezone TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE EndUsers (Id TEXT PRIMARY KEY);
CREATE TABLE TenantServices (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL CHECK (ServiceType IN ('boarding', 'housesitting', 'daycare', 'walk', 'checkin')),
  Enabled INTEGER NOT NULL DEFAULT 1,
  Questions TEXT NOT NULL DEFAULT '[]',
  MinNights INTEGER,
  MaxNights INTEGER,
  MinPetCount INTEGER,
  MaxPetCount INTEGER,
  UNIQUE (TenantId, ServiceType)
);
CREATE TABLE TenantServiceOptions (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL CHECK (ServiceType IN ('boarding', 'housesitting', 'daycare', 'walk', 'checkin')),
  OptionKey TEXT NOT NULL,
  Label TEXT NOT NULL,
  DurationMinutes INTEGER,
  Rate INTEGER NOT NULL,
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit')),
  UNIQUE (TenantId, ServiceType, OptionKey)
);
CREATE TABLE BookingRequests (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL CHECK (ServiceType IN ('boarding', 'housesitting', 'daycare', 'walk', 'checkin', 'blocked')),
  StartDate TEXT NOT NULL,
  EndDate TEXT,
  OptionKey TEXT,
  PetType TEXT,
  PetCount INTEGER NOT NULL DEFAULT 1,
  StartTime TEXT,
  GCalEventId TEXT,
  EstCost INTEGER,
  Answers TEXT NOT NULL DEFAULT '{}',
  Status TEXT NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'confirmed', 'cancelled')),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_BookingRequests_Tenant_Dates ON BookingRequests (TenantId, StartDate);
CREATE INDEX idx_BookingRequests_Tenant_User ON BookingRequests (TenantId, EndUserId);
`;

describe('migration 0006 — custom services rebuild', () => {
  function migratedDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(OLD_DDL);
    db.exec(
      `INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t1', 's1', 'T1'), ('t2', 's2', 'T2')`,
    );
    // t1 has two service rows (one with config), t2 has none at all.
    db.exec(`INSERT INTO TenantServices (TenantId, ServiceType, Enabled, Questions, MinNights)
             VALUES ('t1', 'boarding', 1, '[{"id":"q1"}]', 2), ('t1', 'walk', 0, '[]', NULL)`);
    db.exec(`INSERT INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit)
             VALUES ('o1', 't1', 'walk', 'd30', '30 minutes', 30, 20, 'visit')`);
    db.exec(`INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, Status)
             VALUES ('b1', 't1', 'boarding', '2028-06-20', '2028-06-25', 2, 'confirmed'),
                    ('b2', 't1', 'blocked', '2028-07-03', '2028-07-05', 1, 'confirmed')`);
    db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
    return db;
  }

  it('backfills behavior columns from templates and preserves existing config', () => {
    const db = migratedDb();
    const boarding = db
      .prepare(`SELECT * FROM TenantServices WHERE TenantId='t1' AND ServiceType='boarding'`)
      .get() as Record<string, unknown>;
    expect(boarding).toMatchObject({
      Enabled: 1,
      Label: 'Boarding',
      Icon: 'bed',
      Shape: 'range',
      RateUnit: 'night',
      HasDuration: 0,
      CapacityKind: 'boarding',
      Questions: '[{"id":"q1"}]',
      MinNights: 2,
    });
    const walk = db
      .prepare(
        `SELECT Enabled, Shape, HasDuration, CapacityKind FROM TenantServices WHERE TenantId='t1' AND ServiceType='walk'`,
      )
      .get();
    expect(walk).toMatchObject({
      Enabled: 0,
      Shape: 'single',
      HasDuration: 1,
      CapacityKind: 'none',
    });
  });

  it('gives every tenant all five built-in rows; missing ones arrive disabled', () => {
    const db = migratedDb();
    const t1Count = db
      .prepare(`SELECT COUNT(*) AS n FROM TenantServices WHERE TenantId='t1'`)
      .get() as { n: number };
    const t2 = db
      .prepare(
        `SELECT ServiceType, Enabled FROM TenantServices WHERE TenantId='t2' ORDER BY SortOrder`,
      )
      .all() as { ServiceType: string; Enabled: number }[];
    expect(t1Count.n).toBe(5);
    expect(t2.map((r) => r.ServiceType)).toEqual([
      'boarding',
      'housesitting',
      'daycare',
      'walk',
      'checkin',
    ]);
    expect(t2.every((r) => r.Enabled === 0)).toBe(true);
  });

  it('drops the ServiceType CHECKs so custom slugs insert everywhere, preserves rows + FK integrity', () => {
    const db = migratedDb();
    // Options and bookings preserved.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM TenantServiceOptions`).get()).toMatchObject({
      n: 1,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM BookingRequests`).get()).toMatchObject({ n: 2 });

    // Custom slugs now insert into all three tables.
    db.exec('PRAGMA foreign_keys=ON');
    expect(() => {
      db.exec(`INSERT INTO TenantServices (TenantId, ServiceType, Label, Shape, RateUnit)
               VALUES ('t1', 'morning-walk', 'Morning walk', 'single', 'visit')`);
      db.exec(`INSERT INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, Rate, RateUnit)
               VALUES ('o2', 't1', 'morning-walk', 'd30', '30 minutes', 18, 'visit')`);
      db.exec(`INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate)
               VALUES ('b3', 't1', 'morning-walk', '2028-08-01')`);
    }).not.toThrow();

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    // Indexes were recreated on the rebuilt BookingRequests.
    const indexes = db.prepare(`PRAGMA index_list('BookingRequests')`).all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_BookingRequests_Tenant_Dates');
    expect(names).toContain('idx_BookingRequests_Tenant_User');
  });
});
