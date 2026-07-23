import { describe, expect, it } from 'vitest';
import { listSitterRoster, type SitterRosterRow } from '../db/repo';
import { createTestEnv, OWNER_EMAIL, TENANT_A, TEST_SECRET } from './helpers';
import type { DatabaseSync } from 'node:sqlite';
import app from '../index';
import { mintAdminToken, mintOwnerToken } from '../lib/token';
import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';

const ownerHeaders = async () => ({
  Authorization: `Bearer ${await mintOwnerToken(OWNER_EMAIL, TEST_SECRET)}`,
});

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

describe('owner sitter routes', () => {
  const today = getPacificDateStr(new Date(), DEFAULT_TIMEZONE);
  const inWindow = addDays(today, -10); // within a 30d window
  const outOfWindow = addDays(today, -40); // outside a 30d window, still within 12mo (all-time)

  // Window-narrowing seed: t_a gets one confirmed booking + payment ~10 days ago (in-window for
  // 30d) and one ~40 days ago (out of a 30d window, still all-time). t_b stays zero-activity.
  function seedWindowed(raw: DatabaseSync) {
    reset(raw);
    raw.exec(
      "INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t_a','alpha','Alpha Pets'),('t_b','beta','Beta Barks');",
    );
    raw.exec(
      "INSERT INTO EndUsers (Id, TenantId, Email) VALUES ('eu_a1','t_a','c1@a.test'),('eu_a2','t_a','c2@a.test');",
    );
    raw
      .prepare(
        `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, Status, CreatedAt) VALUES
         ('b_a1','t_a','eu_a1','boarding','2026-07-20','confirmed', ? || ' 09:00:00'),
         ('b_a2','t_a','eu_a2','boarding','2026-01-10','confirmed', ? || ' 09:00:00')`,
      )
      .run(inWindow, outOfWindow);
    raw
      .prepare(
        `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate) VALUES
         ('p_a1','t_a','b_a1',100,'cash', ?),
         ('p_a2','t_a','b_a2',50,'cash', ?)`,
      )
      .run(inWindow, outOfWindow);
  }

  // Cross-tenant isolation seed: t_a and t_b each get a distinctly-named client with a payment
  // and an outstanding balance, so a detail-route leak is directly observable.
  function seedIsolation(raw: DatabaseSync) {
    reset(raw);
    raw.exec(
      "INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t_a','alpha','Alpha Pets'),('t_b','beta','Beta Barks');",
    );
    raw.exec(
      'INSERT INTO EndUsers (Id, TenantId, Name, Email) VALUES ' +
        "('eu_a1','t_a','Alice Alpha','alice@a.test'),('eu_b1','t_b','Bob Beta','bob@b.test');",
    );
    raw
      .prepare(
        `INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, Status, EstCost, CreatedAt) VALUES
         ('b_a1','t_a','eu_a1','boarding','2026-07-20','confirmed',100, ? || ' 09:00:00'),
         ('b_b1','t_b','eu_b1','boarding','2026-07-20','confirmed',100, ? || ' 09:00:00')`,
      )
      .run(inWindow, inWindow);
    raw
      .prepare(
        `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate) VALUES
         ('p_a1','t_a','b_a1',80,'cash', ?),
         ('p_b1','t_b','b_b1',80,'cash', ?)`,
      )
      .run(inWindow, inWindow);
  }

  it('list returns both tenants + totals for window=all', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);

    const res = await app.request(
      '/api/owner/sitters?window=all',
      { headers: await ownerHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: string;
      totals: { sitters: number; clients: number; bookings: number; earned: number };
      sitters: {
        tenantId: string;
        slug: string;
        displayName: string;
        clients: number;
        bookings: number;
        earned: number;
      }[];
    };
    const a = body.sitters.find((s) => s.tenantId === 't_a');
    expect(a).toMatchObject({
      slug: 'alpha',
      displayName: 'Alpha Pets',
      clients: 2,
      bookings: 2,
      earned: 150,
    });
    expect(body.sitters.some((s) => s.tenantId === 't_b')).toBe(true); // zero-activity sitter listed
    expect(body.totals).toEqual({
      sitters: body.sitters.length,
      clients: body.sitters.reduce((s, r) => s + r.clients, 0),
      bookings: body.sitters.reduce((s, r) => s + r.bookings, 0),
      earned: body.sitters.reduce((s, r) => s + r.earned, 0),
    });
    expect(body.window).toBe('all');
  });

  it('window=30d narrows bookings/earned vs all, while clients stay all-time', async () => {
    const { env, raw } = createTestEnv();
    seedWindowed(raw);

    const r30 = (await (
      await app.request('/api/owner/sitters?window=30d', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; clients: number; bookings: number; earned: number }[];
    };
    const rAll = (await (
      await app.request('/api/owner/sitters?window=all', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; clients: number; bookings: number; earned: number }[];
    };

    expect(r30.window).toBe('30d');
    expect(rAll.window).toBe('all');
    const a30 = r30.sitters.find((s) => s.tenantId === 't_a')!;
    const aAll = rAll.sitters.find((s) => s.tenantId === 't_a')!;
    expect(a30.bookings).toBeLessThan(aAll.bookings);
    expect(a30.earned).toBeLessThan(aAll.earned);
    expect(a30.clients).toBe(aAll.clients); // clients are always all-time
  });

  it('unknown/empty window clamps to all', async () => {
    const { env, raw } = createTestEnv();
    seedWindowed(raw);

    const bogus = (await (
      await app.request('/api/owner/sitters?window=bogus', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; bookings: number; earned: number }[];
    };
    const none = (await (
      await app.request('/api/owner/sitters', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; bookings: number; earned: number }[];
    };
    const all = (await (
      await app.request('/api/owner/sitters?window=all', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; bookings: number; earned: number }[];
    };

    expect(bogus.window).toBe('all');
    expect(none.window).toBe('all');
    expect(bogus.sitters).toEqual(all.sitters);
    expect(none.sitters).toEqual(all.sitters);
  });

  it("detail returns only that tenant's analytics; bad id 404s", async () => {
    const { env, raw } = createTestEnv();
    seedIsolation(raw);

    const detail = await app.request(
      '/api/owner/sitters/t_a?window=all',
      { headers: await ownerHeaders() },
      env,
    );
    expect(detail.status).toBe(200);
    const dp = (await detail.json()) as {
      monthly: unknown;
      topClients: { name: string | null; email: string | null }[];
      outstanding: { name: string | null; email: string | null }[];
    };
    // AnalyticsPayload shape.
    expect(dp).toHaveProperty('monthly');
    expect(dp).toHaveProperty('byService');
    expect(dp).toHaveProperty('topClients');
    expect(dp).toHaveProperty('outstanding');

    // Isolation, made concrete: only t_a's distinctly-named client appears, never t_b's.
    expect(dp.topClients.length).toBeGreaterThan(0);
    expect(dp.topClients.every((t) => t.name === 'Alice Alpha')).toBe(true);
    expect(dp.topClients.some((t) => t.name === 'Bob Beta')).toBe(false);
    expect(dp.outstanding.length).toBeGreaterThan(0);
    expect(dp.outstanding.every((o) => o.name === 'Alice Alpha')).toBe(true);
    expect(dp.outstanding.some((o) => o.name === 'Bob Beta')).toBe(false);

    const bad = await app.request(
      '/api/owner/sitters/t_nope?window=all',
      { headers: await ownerHeaders() },
      env,
    );
    expect(bad.status).toBe(404);
  });

  it('ISOLATION — non-owner tokens are rejected on every new route', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);

    const admin = `Bearer ${await mintAdminToken('tu_x', TENANT_A, TEST_SECRET)}`;
    for (const path of ['/api/owner/sitters?window=all', '/api/owner/sitters/t_a?window=all']) {
      expect((await app.request(path, { headers: { Authorization: admin } }, env)).status).toBe(
        401,
      );
      expect((await app.request(path, {}, env)).status).toBe(401);
    }
  });
});
