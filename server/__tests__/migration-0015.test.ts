import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
  '0015_service_level_attributes.sql',
);

/** Pre-0015 shapes: Tenants still carries the three caps, TenantServices has no cap columns,
 * TenantPetTypes still has a meaningful Enabled. Minimal supporting columns only. */
const OLD_DDL = `
CREATE TABLE Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  MaxBoardingPets INTEGER,
  MaxHouseSitsPerDay INTEGER,
  MaxStayNights INTEGER
);
CREATE TABLE TenantServices (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1,
  Label TEXT NOT NULL,
  Shape TEXT NOT NULL CHECK (Shape IN ('range', 'single')),
  CapacityKind TEXT NOT NULL DEFAULT 'none' CHECK (CapacityKind IN ('boarding', 'housesit', 'none')),
  MinNights INTEGER,
  MaxNights INTEGER,
  AcceptedPetTypes TEXT,
  UNIQUE (TenantId, ServiceType)
);
CREATE TABLE TenantPetTypes (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  PetType TEXT NOT NULL,
  Label TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (TenantId, PetType)
);
`;

describe('migration 0015 — service-level caps + acceptance materialization', () => {
  function migratedDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(OLD_DDL);
    // t1: capped tenant with a disabled cat row — exercises copies, effective-min, and steps 4–6.
    db.exec(`INSERT INTO Tenants (Id, Slug, DisplayName, MaxBoardingPets, MaxHouseSitsPerDay, MaxStayNights)
             VALUES ('t1', 's1', 'T1', 4, 2, 14)`);
    // t2: fully-unlimited tenant, no disabled types — everything must copy through as NULL/untouched.
    db.exec(`INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t2', 's2', 'T2')`);
    db.exec(`INSERT INTO TenantServices (TenantId, ServiceType, Label, Shape, CapacityKind, MaxNights, AcceptedPetTypes, Enabled) VALUES
      ('t1', 'boarding',      'Boarding',      'range',  'boarding', NULL, NULL,            1),
      ('t1', 'kitty-condo',   'Kitty condo',   'range',  'boarding', 30,   NULL,            1),
      ('t1', 'housesitting',  'House sitting', 'range',  'housesit', 7,    NULL,            1),
      ('t1', 'walk',          'Walks',         'single', 'none',     NULL, '["dog","cat"]', 1),
      ('t1', 'checkin',       'Check-ins',     'single', 'none',     NULL, '["cat"]',       1),
      ('t2', 'boarding',      'Boarding',      'range',  'boarding', 10,   '["dog"]',       1),
      ('t2', 'housesitting',  'House sitting', 'range',  'housesit', NULL, NULL,            1)`);
    db.exec(`INSERT INTO TenantPetTypes (TenantId, PetType, Label, Enabled) VALUES
      ('t1', 'dog', 'Dogs', 1), ('t1', 'cat', 'Cats', 0),
      ('t2', 'dog', 'Dogs', 1), ('t2', 'cat', 'Cats', 1)`);
    // Real D1 wraps a --file execution in one implicit transaction; replicate that boundary
    // (the migration file itself must stay BEGIN/COMMIT-free — the 0014 test precedent).
    db.exec('BEGIN');
    db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
    db.exec('COMMIT');
    return db;
  }

  const svc = (db: DatabaseSync, tenant: string, type: string) =>
    db
      .prepare(
        `SELECT Enabled, MaxNights, MaxConcurrentPets, MaxPerDay, AcceptedPetTypes
         FROM TenantServices WHERE TenantId = ? AND ServiceType = ?`,
      )
      .get(tenant, type) as {
      Enabled: number;
      MaxNights: number | null;
      MaxConcurrentPets: number | null;
      MaxPerDay: number | null;
      AcceptedPetTypes: string | null;
    };

  it('copies MaxBoardingPets onto EVERY boarding-kind service (per-kind copy)', () => {
    const db = migratedDb();
    expect(svc(db, 't1', 'boarding').MaxConcurrentPets).toBe(4);
    expect(svc(db, 't1', 'kitty-condo').MaxConcurrentPets).toBe(4); // two pools of 4 — accepted as designed
    expect(svc(db, 't1', 'housesitting').MaxConcurrentPets).toBeNull();
    expect(svc(db, 't1', 'walk').MaxConcurrentPets).toBeNull(); // none-kind untouched
  });

  it('copies MaxHouseSitsPerDay onto housesit-kind services only', () => {
    const db = migratedDb();
    expect(svc(db, 't1', 'housesitting').MaxPerDay).toBe(2);
    expect(svc(db, 't1', 'boarding').MaxPerDay).toBeNull();
    expect(svc(db, 't1', 'walk').MaxPerDay).toBeNull();
  });

  it('NULL tenant caps copy through as NULL (unlimited preserved)', () => {
    const db = migratedDb();
    expect(svc(db, 't2', 'boarding').MaxConcurrentPets).toBeNull();
    expect(svc(db, 't2', 'housesitting').MaxPerDay).toBeNull();
  });

  it('folds MaxStayNights into MaxNights as the effective MIN (all four cases)', () => {
    const db = migratedDb();
    expect(svc(db, 't1', 'boarding').MaxNights).toBe(14); // NULL svc / 14 tenant -> 14
    expect(svc(db, 't1', 'kitty-condo').MaxNights).toBe(14); // 30 svc / 14 tenant -> min = 14 (F2)
    expect(svc(db, 't1', 'housesitting').MaxNights).toBe(7); // 7 svc / 14 tenant -> min = 7
    expect(svc(db, 't2', 'boarding').MaxNights).toBe(10); // 10 svc / NULL tenant -> 10
    expect(svc(db, 't2', 'housesitting').MaxNights).toBeNull(); // NULL / NULL -> NULL
    expect(svc(db, 't1', 'walk').MaxNights).toBeNull(); // single-shape untouched
  });

  it('materializes the enabled list into NULL-acceptance services of tenants with a disabled type (F1)', () => {
    const db = migratedDb();
    expect(svc(db, 't1', 'boarding').AcceptedPetTypes).toBe('["dog"]');
    expect(svc(db, 't1', 'kitty-condo').AcceptedPetTypes).toBe('["dog"]');
    expect(svc(db, 't1', 'housesitting').AcceptedPetTypes).toBe('["dog"]');
    // A tenant with no disabled rows keeps NULL (accepts-all) untouched.
    expect(svc(db, 't2', 'housesitting').AcceptedPetTypes).toBeNull();
  });

  it('scrubs disabled slugs from explicit lists; untouched tenants keep theirs verbatim', () => {
    const db = migratedDb();
    expect(svc(db, 't1', 'walk').AcceptedPetTypes).toBe('["dog"]'); // cat scrubbed
    expect(svc(db, 't2', 'boarding').AcceptedPetTypes).toBe('["dog"]'); // no disabled rows -> untouched
  });

  it('disables an enabled service whose explicit list emptied (was already unbookable)', () => {
    const db = migratedDb();
    const checkin = svc(db, 't1', 'checkin');
    expect(checkin.Enabled).toBe(0);
    expect(checkin.AcceptedPetTypes).toBe('[]');
  });

  it('leaves the retired columns and their old values in place (retire-in-place)', () => {
    const db = migratedDb();
    const t1 = db
      .prepare(
        `SELECT MaxBoardingPets, MaxHouseSitsPerDay, MaxStayNights FROM Tenants WHERE Id='t1'`,
      )
      .get();
    expect(t1).toMatchObject({ MaxBoardingPets: 4, MaxHouseSitsPerDay: 2, MaxStayNights: 14 });
    const cat = db
      .prepare(`SELECT Enabled FROM TenantPetTypes WHERE TenantId='t1' AND PetType='cat'`)
      .get();
    expect(cat).toMatchObject({ Enabled: 0 });
  });
});
