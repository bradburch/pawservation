import { describe, expect, it } from 'vitest';
import { deleteTenantCompletely } from '../db/repo';
import { createTestEnv } from './helpers';
import type { DatabaseSync } from 'node:sqlite';

// Every table that FKs to Tenants (directly or transitively via BookingRequestPets).
const TENANT_TABLES = [
  'TenantUsers', 'TenantServices', 'TenantServiceOptions', 'TenantPetTypes',
  'EndUsers', 'LoginCodes', 'BookingRequests', 'EndUserPets', 'Payments',
  'ProviderConnections',
] as const;

function seedFullTenant(raw: DatabaseSync, t: string, slug: string) {
  raw.exec(`INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('${t}','${slug}','Full ${t}');`);
  raw.exec(`INSERT INTO AllowedSitters (Email, ClaimedAt, TenantId) VALUES ('${t}@x.test','2026-01-01','${t}');`);
  raw.exec(`INSERT INTO TenantUsers (Id, TenantId, Email, PasswordHash) VALUES ('${t}_u','${t}','${t}@x.test','h');`);
  raw.exec(`INSERT INTO TenantServices (TenantId, ServiceType, Label, Shape, RateUnit) VALUES ('${t}','boarding','Boarding','range','night');`);
  raw.exec(`INSERT INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, Rate, RateUnit) VALUES ('${t}_opt','${t}','boarding','std','Standard',50,'night');`);
  raw.exec(`INSERT INTO TenantPetTypes (TenantId, PetType, Label) VALUES ('${t}','dog','Dogs');`);
  raw.exec(`INSERT INTO EndUsers (Id, TenantId, Email) VALUES ('${t}_eu','${t}','client@x.test');`);
  raw.exec(`INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt) VALUES ('${t}_lc','${t}','${t}_eu','123456','2026-12-31');`);
  raw.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType) VALUES ('${t}_pet','${t}','${t}_eu','Rex','dog');`);
  raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, Status) VALUES ('${t}_b','${t}','${t}_eu','boarding','2026-07-20','confirmed');`);
  raw.exec(`INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES ('${t}_b','${t}_pet');`);
  raw.exec(`INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate) VALUES ('${t}_p','${t}','${t}_b',50,'cash','2026-07-21');`);
  raw.exec(`INSERT INTO ProviderConnections (Id, TenantId, Capability, Provider, Status) VALUES ('${t}_pc','${t}','calendar','google','connected');`);
}

const countFor = (raw: DatabaseSync, table: string, t: string) =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE TenantId = ?`).get(t) as { n: number }).n;

describe('deleteTenantCompletely', () => {
  it('deletes every tenant-keyed row + allowlist + tenant, leaves other tenants untouched', async () => {
    const { env, raw } = createTestEnv();
    seedFullTenant(raw, 't_gone', 'gone');
    seedFullTenant(raw, 't_keep', 'keep');

    expect(await deleteTenantCompletely(env.PAWBOOK_DB, 't_gone')).toBe(true);

    for (const table of TENANT_TABLES) expect(countFor(raw, table, 't_gone')).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM BookingRequestPets WHERE BookingRequestId='t_gone_b'").get() as { n: number }).n).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM AllowedSitters WHERE TenantId='t_gone'").get() as { n: number }).n).toBe(0);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM Tenants WHERE Id='t_gone'").get() as { n: number }).n).toBe(0);

    // Isolation: the other tenant is fully intact.
    for (const table of TENANT_TABLES) expect(countFor(raw, table, 't_keep')).toBe(1);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM Tenants WHERE Id='t_keep'").get() as { n: number }).n).toBe(1);
  });

  it('returns false for a non-existent tenant', async () => {
    const { env } = createTestEnv();
    expect(await deleteTenantCompletely(env.PAWBOOK_DB, 'nope')).toBe(false);
  });
});
