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

export const TENANT_A = 'tnt_bradpaws'; // slug brad-paws, max 2 boarding pets
export const TENANT_B = 'tnt_happytails'; // slug happy-tails, max 4 boarding pets
export const TEST_SECRET = 'test-secret';

// Seeded sitter logins (password "demo1234"); see sql/seed.sql.
export const ADMIN_EMAIL_A = 'brad@bradpaws.test';
export const ADMIN_EMAIL_B = 'dana@happytails.test';
export const ADMIN_PASSWORD = 'demo1234';

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
  return { prepare: (sql: string) => makeStatement(sql, []) } as unknown as D1Database;
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

export function createTestEnv(): { env: Env; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(join(SQL_DIR, 'schema.sql'), 'utf8'));
  raw.exec(readFileSync(join(SQL_DIR, 'seed.sql'), 'utf8'));
  const env = {
    EMBED_PROTO_DB: makeD1(raw),
    EMBED_PROTO_CACHE: makeKV(),
    TOKEN_SECRET: TEST_SECRET,
    ASSETS: { fetch: async () => new Response('<!doctype html>') },
  } as unknown as Env;
  return { env, raw };
}

/** A valid admin session token for a tenant — Authorization: `Bearer ${adminToken(...)}`. */
export function adminToken(tenantId: string): Promise<string> {
  return mintAdminToken(`tu_${tenantId}`, tenantId, TEST_SECRET);
}

export const adminHeaders = async (tenantId: string): Promise<Record<string, string>> => ({
  Authorization: `Bearer ${await adminToken(tenantId)}`,
});
