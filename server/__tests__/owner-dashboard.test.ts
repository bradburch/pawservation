import { describe, expect, it } from 'vitest';
import { listSitterRoster, type SitterRosterRow } from '../db/repo';
import { createTestEnv } from './helpers';
import type { DatabaseSync } from 'node:sqlite';

// This is a repo-level cross-tenant test: it seeds its own two tenants (t_a/t_b) on a clean
// slate via `raw` rather than relying on the seeded TENANT_A/TENANT_B fixtures, so per-sitter
// numbers and platform totals are deterministic.

function reset(raw: DatabaseSync) {
  // child tables first (FKs are ON in the harness). sql/seed.sql populates more tables than the
  // brief's reset lists (TenantServiceOptions, TenantPetTypes, ProviderConnections, LoginCodes,
  // EndUserPets, BookingRequestPets) — all of them FK to Tenants (directly or transitively), so
  // they must be cleared too or DELETE FROM Tenants fails FK constraint.
  raw.exec(
    'DELETE FROM BookingRequestPets; DELETE FROM LoginCodes; DELETE FROM Payments;' +
      ' DELETE FROM EndUserPets; DELETE FROM BookingRequests; DELETE FROM EndUsers;' +
      ' DELETE FROM TenantServiceOptions; DELETE FROM TenantPetTypes;' +
      ' DELETE FROM ProviderConnections; DELETE FROM AllowedSitters;' +
      ' DELETE FROM TenantServices; DELETE FROM TenantUsers; DELETE FROM Tenants;',
  );
}

function seed(raw: DatabaseSync) {
  raw.exec(
    "INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t_a','alpha','Alpha Pets'),('t_b','beta','Beta Barks');",
  );
  // Alpha: 2 clients; 2 confirmed (1 recent 2026-07-10, 1 old 2026-01-01), 1 cancelled, 1 blocked; payments $100 (2026-07-15) + $50 (2026-01-05)
  raw.exec(
    "INSERT INTO EndUsers (Id, TenantId, Email) VALUES ('eu_a1','t_a','c1@a.test'),('eu_a2','t_a','c2@a.test');",
  );
  raw.exec(
    'INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, Status, CreatedAt) VALUES ' +
      "('b_a1','t_a','eu_a1','boarding','2026-07-20','confirmed','2026-07-10 09:00:00')," + // recent confirmed
      "('b_a2','t_a','eu_a1','boarding','2026-01-10','confirmed','2026-01-01 09:00:00')," + // old confirmed
      "('b_a3','t_a','eu_a2','boarding','2026-07-20','cancelled','2026-07-11 09:00:00')," + // cancelled — excluded
      "('b_a4','t_a',NULL,'blocked','2026-07-22','confirmed','2026-07-12 09:00:00');", // blocked — excluded
  );
  raw.exec(
    'INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate) VALUES ' +
      "('p_a1','t_a','b_a1',100,'cash','2026-07-15')," + // recent
      "('p_a2','t_a','b_a2',50,'cash','2026-01-05');", // old
  );
  // Beta: ZERO activity (no EndUsers, no bookings, no payments) — must still appear (LEFT JOIN, earned $0)
}

const sum = (rows: SitterRosterRow[]) => ({
  clients: rows.reduce((s, r) => s + r.Clients, 0),
  bookings: rows.reduce((s, r) => s + r.Bookings, 0),
  earned: rows.reduce((s, r) => s + r.Earned, 0),
});

describe('listSitterRoster', () => {
  it('returns all-time roster numbers, excluding cancelled/blocked bookings', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);

    const all = await listSitterRoster(env.PAWBOOK_DB, null);
    const alpha = all.find((r) => r.TenantId === 't_a')!;
    const beta = all.find((r) => r.TenantId === 't_b')!;
    expect(alpha).toMatchObject({ Clients: 2, Bookings: 2, Earned: 150 }); // cancelled + blocked excluded; earned = payments only
    expect(beta).toMatchObject({ Clients: 0, Bookings: 0, Earned: 0 }); // zero-activity sitter present
  });

  it('windows bookings/earned by sinceDate while clients stay all-time', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);

    const recent = await listSitterRoster(env.PAWBOOK_DB, '2026-06-23');
    const alphaR = recent.find((r) => r.TenantId === 't_a')!;
    expect(alphaR).toMatchObject({ Clients: 2, Bookings: 1, Earned: 100 });
  });

  it('platform totals equal the sum of the roster', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);

    const all = await listSitterRoster(env.PAWBOOK_DB, null);
    expect(sum(all)).toEqual({ clients: 2, bookings: 2, earned: 150 });
  });
});
