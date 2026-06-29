import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = join(
  import.meta.dirname,
  '..',
  '..',
  'migrations',
  '0002_tenant_config_limits.sql',
);

const OLD_TENANTS_DDL = `
CREATE TABLE Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  MaxBoardingPets INTEGER NOT NULL DEFAULT 2,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const CHILD_DDL = `
CREATE TABLE TenantServices (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1
);
`;

describe('migration 0002 — Tenants rebuild does not break child FKs', () => {
  it('preserves values, adds new nullable columns, and keeps FK integrity', () => {
    const db = new DatabaseSync(':memory:');

    // 1. Set up old schema + child table
    db.exec(OLD_TENANTS_DDL);
    db.exec(CHILD_DDL);

    // 2. Insert a tenant and a child row
    db.exec(`INSERT INTO Tenants (Id, Slug, DisplayName, AccentColor, MaxBoardingPets)
             VALUES ('t1', 's1', 'T1', '#4f46e5', 2)`);
    db.exec(`INSERT INTO TenantServices (TenantId, ServiceType) VALUES ('t1', 'boarding')`);

    // 3. Apply the real migration file
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    db.exec(sql);

    // 4a. The existing tenant's MaxBoardingPets value is preserved
    const row = db.prepare(`SELECT MaxBoardingPets FROM Tenants WHERE Id='t1'`).get() as {
      MaxBoardingPets: number;
    };
    expect(row.MaxBoardingPets).toBe(2);

    // 4b. New columns exist and are NULL for the migrated row
    const newCols = db
      .prepare(`SELECT MaxHouseSitsPerDay, MaxStayNights, Timezone FROM Tenants WHERE Id='t1'`)
      .get() as { MaxHouseSitsPerDay: null; MaxStayNights: null; Timezone: null };
    expect(newCols.MaxHouseSitsPerDay).toBeNull();
    expect(newCols.MaxStayNights).toBeNull();
    expect(newCols.Timezone).toBeNull();

    // 4c. No dangling foreign keys anywhere in the DB
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
    expect(fkViolations).toHaveLength(0);

    // 4d. The child table's FK still points to 'Tenants' (not 'Tenants_new' or 'Tenants_old')
    const fkList = db.prepare(`PRAGMA foreign_key_list('TenantServices')`).all() as {
      table: string;
    }[];
    expect(fkList.length).toBeGreaterThan(0);
    expect(fkList[0].table).toBe('Tenants');

    // 4e. Inserting a new child row with FK enforcement ON succeeds
    db.exec('PRAGMA foreign_keys=ON');
    expect(() => {
      db.exec(`INSERT INTO TenantServices (TenantId, ServiceType) VALUES ('t1', 'housesitting')`);
    }).not.toThrow();
  });
});
