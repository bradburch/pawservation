import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createTestEnv, TENANT_A } from './helpers';

const MIGRATION_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
  '0019_pet_co_ownership.sql',
);

/** Pre-0019 shape: EndUserPets with a single owner column. Minimal supporting parents only. */
const DDL = `
CREATE TABLE Tenants (Id TEXT PRIMARY KEY);
CREATE TABLE EndUsers (Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id));
CREATE TABLE EndUserPets (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Name TEXT NOT NULL,
  PetType TEXT NOT NULL,
  Notes TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  db.exec(`INSERT INTO Tenants (Id) VALUES ('t1'), ('t2');`);
  db.exec(`INSERT INTO EndUsers (Id, TenantId) VALUES ('t1_eu','t1'), ('t2_eu','t2');`);
  db.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType) VALUES
    ('t1_pet_a','t1','t1_eu','Bella','dog'),
    ('t1_pet_b','t1','t1_eu','Mochi','cat'),
    ('t2_pet_a','t2','t2_eu','Otis','dog');`);
  db.exec('BEGIN');
  db.exec(readFileSync(MIGRATION_PATH, 'utf8'));
  db.exec('COMMIT');
  return db;
}

describe('migration 0019 — pet co-ownership', () => {
  it('backfills exactly one PetOwners row per existing pet, carrying its tenant', () => {
    const db = migratedDb();
    const rows = db
      .prepare('SELECT TenantId, PetId, EndUserId FROM PetOwners ORDER BY PetId')
      .all() as { TenantId: string; PetId: string; EndUserId: string }[];
    expect(rows).toEqual([
      { TenantId: 't1', PetId: 't1_pet_a', EndUserId: 't1_eu' },
      { TenantId: 't1', PetId: 't1_pet_b', EndUserId: 't1_eu' },
      { TenantId: 't2', PetId: 't2_pet_a', EndUserId: 't2_eu' },
    ]);
  });

  it('makes (PetId, EndUserId) the primary key — a duplicate link is impossible', () => {
    const db = migratedDb();
    expect(() =>
      db.exec(
        `INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES ('t1','t1_pet_a','t1_eu');`,
      ),
    ).toThrow();
  });

  it('allows a SECOND owner for the same pet (the whole point)', () => {
    const db = migratedDb();
    db.exec(`INSERT INTO EndUsers (Id, TenantId) VALUES ('t1_eu2','t1');`);
    db.exec(
      `INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES ('t1','t1_pet_a','t1_eu2');`,
    );
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM PetOwners WHERE PetId = 't1_pet_a'`)
      .get() as { n: number };
    expect(n).toBe(2);
  });

  it('adds EndUserPets.DeceasedAt, defaulting to NULL (alive)', () => {
    const db = migratedDb();
    const row = db.prepare(`SELECT DeceasedAt FROM EndUserPets WHERE Id = 't1_pet_a'`).get() as {
      DeceasedAt: string | null;
    };
    expect(row.DeceasedAt).toBeNull();
  });
});

describe('migration 0019 is mirrored into sql/schema.sql + sql/seed.sql', () => {
  it('the harness DB has PetOwners and every seeded pet has an owner row', () => {
    const { raw } = createTestEnv();
    const orphans = raw
      .prepare(
        `SELECT p.Id FROM EndUserPets p
          WHERE NOT EXISTS (SELECT 1 FROM PetOwners po WHERE po.PetId = p.Id AND po.TenantId = p.TenantId)`,
      )
      .all() as { Id: string }[];
    expect(orphans).toEqual([]);
    const owned = raw
      .prepare('SELECT PetId FROM PetOwners WHERE TenantId = ? ORDER BY PetId')
      .all(TENANT_A) as { PetId: string }[];
    expect(owned.map((r) => r.PetId)).toEqual(['pet_sp_bella', 'pet_sp_mochi']);
  });

  it('the harness DB has EndUserPets.DeceasedAt', () => {
    const { raw } = createTestEnv();
    const row = raw
      .prepare(`SELECT DeceasedAt FROM EndUserPets WHERE Id = 'pet_sp_bella'`)
      .get() as { DeceasedAt: string | null };
    expect(row.DeceasedAt).toBeNull();
  });
});
