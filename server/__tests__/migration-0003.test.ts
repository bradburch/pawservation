import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const SCHEMA_DIR = join(import.meta.dirname, '..', '..', 'sql');
const MIGRATION = join(
  import.meta.dirname, '..', '..', 'migrations', '0003_calendar_oauth_and_invites.sql',
);

describe('migration 0003 — calendar tokens + invite columns', () => {
  it('upgrades a pre-0003 DB: adds columns, backfills Status=active, keeps FK integrity', () => {
    const db = new DatabaseSync(':memory:');
    // Minimal pre-0003 shape (subset of the old schema) for the affected tables.
    db.exec(`
      CREATE TABLE Tenants (Id TEXT PRIMARY KEY, Slug TEXT NOT NULL UNIQUE, DisplayName TEXT NOT NULL,
        AccentColor TEXT NOT NULL DEFAULT '#4f46e5', CreatedAt TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE EndUsers (Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id),
        Email TEXT NOT NULL, CreatedAt TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (TenantId, Email));
      CREATE TABLE BookingRequests (Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id),
        EndUserId TEXT REFERENCES EndUsers(Id), ServiceType TEXT NOT NULL, StartDate TEXT NOT NULL,
        EndDate TEXT, OptionKey TEXT, PetType TEXT, PetCount INTEGER NOT NULL DEFAULT 1, EstCost INTEGER,
        Status TEXT NOT NULL DEFAULT 'pending', CreatedAt TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE ProviderConnections (Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id),
        Capability TEXT NOT NULL, Provider TEXT NOT NULL,
        Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected','connected-stub')),
        ConnectedAt TEXT, UNIQUE (TenantId, Capability));
      INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t1','s1','T1');
      INSERT INTO EndUsers (Id, TenantId, Email) VALUES ('e1','t1','old@example.com');
      INSERT INTO ProviderConnections (Id, TenantId, Capability, Provider, Status)
        VALUES ('p1','t1','calendar','google-calendar','connected-stub');
    `);

    db.exec(readFileSync(MIGRATION, 'utf8'));

    // Grandfathered customer is 'active'.
    const eu = db.prepare(`SELECT Status, Name, InvitedAt FROM EndUsers WHERE Id='e1'`).get() as
      { Status: string; Name: null; InvitedAt: null };
    expect(eu.Status).toBe('active');
    expect(eu.Name).toBeNull();

    // New booking columns exist.
    db.prepare(`SELECT StartTime, GCalEventId FROM BookingRequests`).all();

    // Status CHECK now admits 'connected'; token columns exist.
    db.exec(`UPDATE ProviderConnections SET Status='connected', AccessToken='x', RefreshToken='y',
             TokenExpiresAt='2030-01-01T00:00:00Z', CalendarId='primary' WHERE Id='p1'`);
    const pc = db.prepare(`SELECT Status, AccessToken FROM ProviderConnections WHERE Id='p1'`).get() as
      { Status: string; AccessToken: string };
    expect(pc.Status).toBe('connected');
    expect(pc.AccessToken).toBe('x');

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('schema.sql alone (fresh install) already has every 0003 column', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(join(SCHEMA_DIR, 'schema.sql'), 'utf8'));
    db.prepare(`SELECT StartTime, GCalEventId FROM BookingRequests`).all();
    db.prepare(`SELECT Name, InvitedAt, Status FROM EndUsers`).all();
    db.prepare(`SELECT AccessToken, RefreshToken, TokenExpiresAt, CalendarId FROM ProviderConnections`).all();
  });
});
