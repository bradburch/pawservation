import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  // EndUserPets, BookingRequestPets, PetOwners) — all of them FK to Tenants (directly or
  // transitively), so they must be cleared too or DELETE FROM Tenants fails FK constraint.
  raw.exec(
    'DELETE FROM BookingRequestPets; DELETE FROM PetOwners; DELETE FROM LoginCodes; DELETE FROM Payments;' +
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
      // Payments.Amount is CENTS (0015): 10000 is $100. `Earned` below is the raw column sum,
      // in cents, and the /owner/sitters route publishes it unchanged as `earnedCents`.
      "('p_a1','t_a','b_a1',10000,'cash','2026-07-15')," + // recent
      "('p_a2','t_a','b_a2',5000,'cash','2026-01-05');", // old
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

    const all = await listSitterRoster(env.PAWSERVATION_DB, null);
    const alpha = all.find((r) => r.TenantId === 't_a')!;
    const beta = all.find((r) => r.TenantId === 't_b')!;
    // `Earned` is the repo's raw column sum, so cents.
    expect(alpha).toMatchObject({ Clients: 2, Bookings: 2, Earned: 15000 }); // cancelled + blocked excluded; earned = payments only
    expect(beta).toMatchObject({ Clients: 0, Bookings: 0, Earned: 0 }); // zero-activity sitter present
  });

  it('windows bookings/earned by sinceDate while clients stay all-time', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);

    const recent = await listSitterRoster(env.PAWSERVATION_DB, '2026-06-23');
    const alphaR = recent.find((r) => r.TenantId === 't_a')!;
    expect(alphaR).toMatchObject({ Clients: 2, Bookings: 1, Earned: 10000 });
  });

  it('platform totals equal the sum of the roster', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);

    const all = await listSitterRoster(env.PAWSERVATION_DB, null);
    expect(sum(all)).toEqual({ clients: 2, bookings: 2, earned: 15000 });
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
         ('p_a1','t_a','b_a1',10000,'cash', ?),
         ('p_a2','t_a','b_a2',5000,'cash', ?)`,
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
         ('b_a1','t_a','eu_a1','boarding','2026-07-20','confirmed',10000, ? || ' 09:00:00'),
         ('b_b1','t_b','eu_b1','boarding','2026-07-20','confirmed',10000, ? || ' 09:00:00')`,
      )
      .run(inWindow, inWindow);
    raw
      .prepare(
        `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate) VALUES
         ('p_a1','t_a','b_a1',8000,'cash', ?),
         ('p_b1','t_b','b_b1',8000,'cash', ?)`,
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
      totals: { sitters: number; clients: number; bookings: number; earnedCents: number };
      sitters: {
        tenantId: string;
        slug: string;
        displayName: string;
        clients: number;
        bookings: number;
        earnedCents: number;
      }[];
    };
    const a = body.sitters.find((s) => s.tenantId === 't_a');
    expect(a).toMatchObject({
      slug: 'alpha',
      displayName: 'Alpha Pets',
      clients: 2,
      bookings: 2,
      earnedCents: 15000,
    });
    // The dollar name is REMOVED, not aliased (design spec §2).
    expect(a).not.toHaveProperty('earned');
    expect(body.totals).not.toHaveProperty('earned');
    expect(body.sitters.some((s) => s.tenantId === 't_b')).toBe(true); // zero-activity sitter listed
    expect(body.totals).toEqual({
      sitters: body.sitters.length,
      clients: body.sitters.reduce((s, r) => s + r.clients, 0),
      bookings: body.sitters.reduce((s, r) => s + r.bookings, 0),
      earnedCents: body.sitters.reduce((s, r) => s + r.earnedCents, 0),
    });
    expect(body.window).toBe('all');
  });

  it('list includes premiumUntil per sitter, null when unset', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);
    raw.exec("UPDATE Tenants SET PremiumUntil = '2099-01-01 00:00:00' WHERE Id = 't_a';");

    const res = await app.request(
      '/api/owner/sitters?window=all',
      { headers: await ownerHeaders() },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sitters: { tenantId: string; premiumUntil: string | null }[];
    };
    const a = body.sitters.find((s) => s.tenantId === 't_a');
    const b = body.sitters.find((s) => s.tenantId === 't_b');
    expect(a?.premiumUntil).toBe('2099-01-01 00:00:00');
    expect(b?.premiumUntil).toBeNull();
  });

  it('publishes the SERVER’s premiumActive, so the console never re-derives the rule', async () => {
    const { env, raw } = createTestEnv();
    reset(raw);
    seed(raw);
    // One sitter comped by the owner, one paying for Pro, one paying for Solo. Only the first two
    // are premium, and the console cannot tell that from `premiumUntil` alone any more.
    raw.exec("UPDATE Tenants SET PremiumUntil = '2099-01-01 00:00:00' WHERE Id = 't_a';");
    raw.exec(
      "UPDATE Tenants SET Plan = 'pro', BilledUntil = '2099-01-01 00:00:00' WHERE Id = 't_b';",
    );

    const res = await app.request(
      '/api/owner/sitters?window=all',
      { headers: await ownerHeaders() },
      env,
    );
    const body = (await res.json()) as {
      sitters: { tenantId: string; premiumActive: boolean; premiumUntil: string | null }[];
    };
    const a = body.sitters.find((s) => s.tenantId === 't_a');
    const b = body.sitters.find((s) => s.tenantId === 't_b');
    expect(a?.premiumActive).toBe(true);
    expect(b?.premiumActive).toBe(true);
    // The date the owner is EDITING still rides along, and is still hers alone: a Pro subscriber
    // has no comp.
    expect(a?.premiumUntil).toBe('2099-01-01 00:00:00');
    expect(b?.premiumUntil).toBeNull();
  });

  it('window=30d narrows bookings/earned vs all, while clients stay all-time', async () => {
    const { env, raw } = createTestEnv();
    seedWindowed(raw);

    const r30 = (await (
      await app.request('/api/owner/sitters?window=30d', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; clients: number; bookings: number; earnedCents: number }[];
    };
    const rAll = (await (
      await app.request('/api/owner/sitters?window=all', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; clients: number; bookings: number; earnedCents: number }[];
    };

    expect(r30.window).toBe('30d');
    expect(rAll.window).toBe('all');
    const a30 = r30.sitters.find((s) => s.tenantId === 't_a')!;
    const aAll = rAll.sitters.find((s) => s.tenantId === 't_a')!;
    expect(a30.bookings).toBeLessThan(aAll.bookings);
    expect(a30.earnedCents).toBeLessThan(aAll.earnedCents);
    expect(a30.clients).toBe(aAll.clients); // clients are always all-time
  });

  it('unknown/empty window clamps to all', async () => {
    const { env, raw } = createTestEnv();
    seedWindowed(raw);

    const bogus = (await (
      await app.request('/api/owner/sitters?window=bogus', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; bookings: number; earnedCents: number }[];
    };
    const none = (await (
      await app.request('/api/owner/sitters', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; bookings: number; earnedCents: number }[];
    };
    const all = (await (
      await app.request('/api/owner/sitters?window=all', { headers: await ownerHeaders() }, env)
    ).json()) as {
      window: string;
      sitters: { tenantId: string; bookings: number; earnedCents: number }[];
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
      tiles: Record<string, unknown>;
      topClients: { name: string | null; email: string | null }[];
      outstanding: { name: string | null; email: string | null }[];
    };
    // AnalyticsPayload shape — the same `serializeAnalytics` output the sitter's own route
    // returns, so this drill-down carries the cents names too and none of the dollar ones.
    expect(dp).toHaveProperty('monthly');
    expect(dp).toHaveProperty('byService');
    expect(dp).toHaveProperty('topClients');
    expect(dp).toHaveProperty('outstanding');
    expect(dp).toHaveProperty('ytdCents');
    expect(dp).not.toHaveProperty('ytd');
    expect(dp.tiles).not.toHaveProperty('thisMonth');
    expect(dp.topClients[0]).not.toHaveProperty('total');

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

describe('the owner console does not re-derive entitlement in the browser', () => {
  const SOURCE = readFileSync(
    join(import.meta.dirname, '..', '..', 'app', 'admin', 'OwnerConsole.tsx'),
    'utf8',
  );

  it('renders the Premium chip from the server flag, not from a date comparison', () => {
    expect(SOURCE).toContain('s.premiumActive');
    // The old derivation, in the shape it had: a string compare against a hand-built `now`.
    expect(SOURCE).not.toContain("new Date().toISOString().slice(0, 19).replace('T', ' ')");
  });
});
