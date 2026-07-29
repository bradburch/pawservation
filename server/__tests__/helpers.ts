import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mintAdminToken } from '../lib/token';

/**
 * Test env backed by a REAL in-memory SQLite (node:sqlite, built into Node 24) behind a
 * D1-compatible shim, so isolation tests execute the actual schema + SQL instead of
 * asserting against mock call shapes.
 */

const SQL_DIR = join(import.meta.dirname, '..', '..', 'sql');

export const TENANT_A = 'tnt_sunnypaws'; // slug sunny-paws, boarding service seeded MaxConcurrentPets=2 (demo config)
export const TENANT_B = 'tnt_happytails'; // slug happy-tails, boarding service seeded MaxConcurrentPets=4 (demo config)
export const TEST_SECRET = 'test-secret-0123456789'; // ≥16 chars to pass the TOKEN_SECRET guard

// Seeded sitter logins (password "demo1234"); see sql/seed.sql.
export const ADMIN_EMAIL_A = 'admin@sunnypaws.example';
export const ADMIN_EMAIL_B = 'dana@happytails.test';
export const ADMIN_PASSWORD = 'demo1234';

// Owner + allowlist fixtures: OWNER_EMAIL is wired into createTestEnv's OWNER_EMAILS;
// ALLOWED_EMAIL is the unclaimed AllowedSitters row seeded by sql/seed.sql.
export const OWNER_EMAIL = 'owner@pawservation.test';
export const ALLOWED_EMAIL = 'newsitter@pawservation.test';

type SqlParam = string | number | null;

function makeD1(raw: DatabaseSync): D1Database {
  const makeStatement = (sql: string, params: SqlParam[]) => ({
    bind: (...next: SqlParam[]) => makeStatement(sql, next),
    all: async () => ({ results: raw.prepare(sql).all(...params), success: true, meta: {} }),
    first: async () => raw.prepare(sql).get(...params) ?? null,
    run: async () => {
      const info = raw.prepare(sql).run(...params);
      return { success: true, meta: info, results: [] };
    },
    raw: async () => {
      throw new Error('raw() not implemented in test shim');
    },
  });
  type ShimStatement = { run: () => Promise<unknown> };
  return {
    prepare: (sql: string) => makeStatement(sql, []),
    // Atomic batch shim: run statements inside a transaction so a mid-batch failure rolls back,
    // mirroring D1's all-or-nothing db.batch().
    batch: async (statements: ShimStatement[]) => {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
  } as unknown as D1Database;
}

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const value = store.get(key) ?? null;
      if (value !== null && type === 'json') return JSON.parse(value);
      return value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

export function createTestEnv(opts?: { html?: string; demoActivity?: boolean }): {
  env: Env;
  raw: DatabaseSync;
} {
  // FK enforcement stays ON (node:sqlite's default) to match production: Cloudflare D1 enforces
  // FK constraints by default and — unlike SQLite generally — cannot disable them, only defer
  // them within a transaction (see migrations/0006_custom_services.sql's defer_foreign_keys use).
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(join(SQL_DIR, 'schema.sql'), 'utf8'));
  raw.exec(readFileSync(join(SQL_DIR, 'seed.sql'), 'utf8'));
  // The lived-in demo (sql/seed-demo.sql) is OPT-IN: it adds ~30 relative-dated bookings and nine
  // clients, which is what a real account looks like but not what a deterministic fixture is. Most
  // tests want the minimal base seed; `demoActivity: true` gets the demo one, exercised end to end
  // by seed-demo.test.ts.
  if (opts?.demoActivity) raw.exec(readFileSync(join(SQL_DIR, 'seed-demo.sql'), 'utf8'));
  const env = {
    PAWBOOK_DB: makeD1(raw),
    PAWBOOK_CACHE: makeKV(),
    TOKEN_SECRET: TEST_SECRET,
    ENVIRONMENT: 'development', // lets /identify return prototypeCode when no email provider is set
    OWNER_EMAILS: OWNER_EMAIL,
    // `html` lets tests stand in a real embed.html body (e.g. to assert on JSON-LD injection)
    // without the real Vite-built asset — the ASSETS binding is otherwise just a static stub.
    ASSETS: {
      fetch: async () =>
        new Response(opts?.html ?? '<!doctype html>', {
          headers: { 'content-type': 'text/html' },
        }),
    },
  } as unknown as Env;
  return { env, raw };
}

/**
 * Seed pets for one owner, WITH their PetOwners edge — the authoritative owner list every
 * customer-facing pet read uses (CLAUDE.md). A pet inserted without the edge is invisible to its
 * own owner, which surfaces as a baffling "Unknown pet." 400 rather than a missing row.
 *
 * Synchronous on the raw handle (not the D1 shim) so a test can seed inline before its first
 * request. Ids are caller-supplied and deterministic: the quote's group key is built from pet
 * ids, so a random id would make a rate-matching assertion unwritable.
 */
export function seedPets(
  raw: DatabaseSync,
  tenantId: string,
  endUserId: string,
  specs: { id: string; petType: string; name?: string }[],
): string[] {
  const insertPet = raw.prepare(
    `INSERT OR REPLACE INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType) VALUES (?, ?, ?, ?, ?)`,
  );
  const insertOwner = raw.prepare(
    `INSERT OR REPLACE INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)`,
  );
  for (const s of specs) {
    insertPet.run(s.id, tenantId, endUserId, s.name ?? s.id, s.petType);
    insertOwner.run(tenantId, s.id, endUserId);
  }
  return specs.map((s) => s.id);
}

/** A valid admin session token for a tenant — Authorization: `Bearer ${adminToken(...)}`. */
export function adminToken(tenantId: string): Promise<string> {
  return mintAdminToken(`tu_${tenantId}`, tenantId, TEST_SECRET);
}

export const adminHeaders = async (tenantId: string): Promise<Record<string, string>> => ({
  Authorization: `Bearer ${await adminToken(tenantId)}`,
});

/** A valid end-user session token obtained by running the real identify→verify flow with the dev
 *  prototypeCode. `slug` is the URL slug (e.g. 'sunny-paws'), not the tenant ID. */
export async function endUserToken(env: Env, slug: string, email: string): Promise<string> {
  const { default: app } = await import('../index');
  const idRes = await app.request(
    `/api/${slug}/identify`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    },
    env,
  );
  const { codeId, prototypeCode } = (await idRes.json()) as {
    codeId: string;
    prototypeCode: string;
  };
  const vRes = await app.request(
    `/api/${slug}/verify`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeId, code: prototypeCode }),
    },
    env,
  );
  return ((await vRes.json()) as { token: string }).token;
}

/** Demo-login flow: identify demo@pawservation.com with an allowed forwarded host, then verify.
 *  Mirrors endUserToken above, plus the X-Pawservation-Host header the widget forwards. */
export async function demoToken(env: Env, slug: string): Promise<string> {
  const { default: app } = await import('../index');
  const idRes = await app.request(
    `/api/${slug}/identify`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pawservation-Host': 'https://pawservation.com',
      },
      body: JSON.stringify({ email: 'demo@pawservation.com' }),
    },
    env,
  );
  const { codeId, prototypeCode } = (await idRes.json()) as {
    codeId: string;
    prototypeCode: string;
  };
  const vRes = await app.request(
    `/api/${slug}/verify`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeId, code: prototypeCode }),
    },
    env,
  );
  return ((await vRes.json()) as { token: string }).token;
}
