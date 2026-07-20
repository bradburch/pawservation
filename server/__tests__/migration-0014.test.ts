import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
  '0014_custom_pet_types.sql',
);

/** Pre-0014 shapes: TenantPetTypes + EndUserPets still carry their ('dog','cat') CHECKs,
 * TenantServices has no AcceptedPetTypes column. Minimal supporting tables for FKs. */
const OLD_DDL = `
CREATE TABLE Tenants (Id TEXT PRIMARY KEY, Slug TEXT NOT NULL UNIQUE, DisplayName TEXT NOT NULL);
CREATE TABLE EndUsers (Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id));
CREATE TABLE TenantPetTypes (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  PetType TEXT NOT NULL CHECK (PetType IN ('dog', 'cat')),
  Enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (TenantId, PetType)
);
CREATE TABLE EndUserPets (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Name TEXT NOT NULL,
  PetType TEXT NOT NULL CHECK (PetType IN ('dog', 'cat')),
  Notes TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_EndUserPets_Tenant_User ON EndUserPets (TenantId, EndUserId);
CREATE TABLE BookingRequestPets (
  BookingRequestId TEXT NOT NULL,
  PetId TEXT NOT NULL REFERENCES EndUserPets(Id),
  PRIMARY KEY (BookingRequestId, PetId)
);
CREATE TABLE TenantServices (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1,
  Label TEXT NOT NULL,
  Shape TEXT NOT NULL,
  RateUnit TEXT NOT NULL,
  UNIQUE (TenantId, ServiceType)
);
`;

describe('migration 0014 — custom pet types rebuild', () => {
  function migratedDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    db.exec(OLD_DDL);
    db.exec(
      `INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t1', 's1', 'T1'), ('t2', 's2', 'T2')`,
    );
    // t1 has a dog row only (Happy Tails shape); t2 has none (fresh-signup shape).
    db.exec(`INSERT INTO TenantPetTypes (TenantId, PetType, Enabled) VALUES ('t1', 'dog', 1)`);
    db.exec(`INSERT INTO EndUsers (Id, TenantId) VALUES ('u1', 't1')`);
    db.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
             VALUES ('p1', 't1', 'u1', 'Bella', 'dog')`);
    db.exec(`INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES ('b1', 'p1')`);
    db.exec(`INSERT INTO TenantServices (TenantId, ServiceType, Label, Shape, RateUnit)
             VALUES ('t1', 'boarding', 'Boarding', 'range', 'night')`);
    // Real D1 wraps a --file execution in one implicit transaction (see the migration's own
    // header comment), which is what makes `PRAGMA defer_foreign_keys` actually defer the
    // DROP TABLE EndUserPets FK check to COMMIT. node:sqlite's db.exec() has no such implicit
    // wrapping — each statement autocommits on its own — so the test replicates D1's real
    // transactional boundary explicitly; the migration file itself must stay BEGIN/COMMIT-free
    // (nesting a literal BEGIN inside D1's own transaction errors on real D1).
    db.exec('BEGIN');
    db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
    db.exec('COMMIT');
    return db;
  }

  it('rebuilds TenantPetTypes with a backfilled Label and keeps Enabled', () => {
    const db = migratedDb();
    const dog = db
      .prepare(`SELECT Label, Enabled FROM TenantPetTypes WHERE TenantId='t1' AND PetType='dog'`)
      .get();
    expect(dog).toMatchObject({ Label: 'Dogs', Enabled: 1 });
  });

  it('backfills missing dog/cat rows DISABLED for every tenant (F1)', () => {
    const db = migratedDb();
    const t1cat = db
      .prepare(`SELECT Label, Enabled FROM TenantPetTypes WHERE TenantId='t1' AND PetType='cat'`)
      .get();
    expect(t1cat).toMatchObject({ Label: 'Cats', Enabled: 0 });
    const t2 = db
      .prepare(
        `SELECT PetType, Label, Enabled FROM TenantPetTypes WHERE TenantId='t2' ORDER BY PetType`,
      )
      .all() as { PetType: string; Label: string; Enabled: number }[];
    expect(t2).toEqual([
      { PetType: 'cat', Label: 'Cats', Enabled: 0 },
      { PetType: 'dog', Label: 'Dogs', Enabled: 0 },
    ]);
  });

  it('drops both CHECKs so custom slugs insert; existing pets and FKs survive', () => {
    const db = migratedDb();
    db.exec('PRAGMA foreign_keys=ON');
    expect(() => {
      db.exec(`INSERT INTO TenantPetTypes (TenantId, PetType, Label, Enabled)
               VALUES ('t1', 'rabbit', 'Rabbits', 1)`);
      db.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
               VALUES ('p2', 't1', 'u1', 'Peanut', 'rabbit')`);
    }).not.toThrow();
    expect(db.prepare(`SELECT Name FROM EndUserPets WHERE Id='p1'`).get()).toMatchObject({
      Name: 'Bella',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
    const indexes = db.prepare(`PRAGMA index_list('EndUserPets')`).all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_EndUserPets_Tenant_User');
  });

  it('adds TenantServices.AcceptedPetTypes, NULL for existing rows', () => {
    const db = migratedDb();
    const row = db.prepare(`SELECT AcceptedPetTypes FROM TenantServices WHERE TenantId='t1'`).get();
    expect(row).toMatchObject({ AcceptedPetTypes: null });
  });
});
