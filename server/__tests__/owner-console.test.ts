import { describe, expect, it } from 'vitest';
import app from '../index';
import { hashPassword } from '../lib/password';
import { mintAdminToken, mintOwnerToken, mintToken } from '../lib/token';
import {
  ADMIN_EMAIL_A,
  ADMIN_PASSWORD,
  ALLOWED_EMAIL,
  createTestEnv,
  OWNER_EMAIL,
  TENANT_A,
  TEST_SECRET,
} from './helpers';

// One PBKDF2 derive for the whole file (600k iterations is deliberately slow).
const OWNER_PASSWORD = 'ownerpass1';
const OWNER_HASH = await hashPassword(OWNER_PASSWORD);

type TestEnv = ReturnType<typeof createTestEnv>;
function seedOwnerRow({ raw }: TestEnv) {
  raw
    .prepare("INSERT INTO OwnerUsers (Id, Email, PasswordHash) VALUES ('ou_test', ?, ?)")
    .run(OWNER_EMAIL, OWNER_HASH);
}

const login = (env: Env, email: string, password: string) =>
  app.request(
    '/api/admin/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    env,
  );

const ownerHeaders = async () => ({
  Authorization: `Bearer ${await mintOwnerToken(OWNER_EMAIL, TEST_SECRET)}`,
});

describe('owner login + session', () => {
  it('an OWNER_EMAILS member logs in to role owner', async () => {
    const te = createTestEnv();
    seedOwnerRow(te);
    const res = await login(te.env, OWNER_EMAIL, OWNER_PASSWORD);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; role: string; email: string };
    expect(body.role).toBe('owner');
    expect(body.email).toBe(OWNER_EMAIL);

    const session = await app.request(
      '/api/admin/session',
      { headers: { Authorization: `Bearer ${body.token}` } },
      te.env,
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ role: 'owner', email: OWNER_EMAIL });
  });

  it('rejects a wrong owner password and an owner with no password yet (401)', async () => {
    const te = createTestEnv();
    seedOwnerRow(te);
    expect((await login(te.env, OWNER_EMAIL, 'wrong-pass')).status).toBe(401);
    const noRow = createTestEnv(); // OWNER_EMAILS names the email, but no OwnerUsers row
    expect((await login(noRow.env, OWNER_EMAIL, OWNER_PASSWORD)).status).toBe(401);
  });

  it('empty OWNER_EMAILS ⇒ no owners — the same login 401s even with a row present', async () => {
    const te = createTestEnv();
    seedOwnerRow(te);
    te.env.OWNER_EMAILS = ''; // unset/empty are equivalent: parseOwnerEmails yields []
    expect((await login(te.env, OWNER_EMAIL, OWNER_PASSWORD)).status).toBe(401);
  });

  it('sitter login and session now carry role admin (additive)', async () => {
    const { env } = createTestEnv();
    const res = await login(env, ADMIN_EMAIL_A, ADMIN_PASSWORD);
    const body = (await res.json()) as { role: string; slug: string; token: string };
    expect(body.role).toBe('admin');
    expect(body.slug).toBe('sunny-paws');
    const session = await app.request(
      '/api/admin/session',
      { headers: { Authorization: `Bearer ${body.token}` } },
      env,
    );
    const sBody = (await session.json()) as { role: string; slug: string };
    expect(sBody.role).toBe('admin');
    expect(sBody.slug).toBe('sunny-paws');
  });
});

describe('token audiences are mutually exclusive across middlewares', () => {
  it('owner tokens fail adminAuth and endUserAuth; admin/widget tokens fail ownerAuth', async () => {
    const { env } = createTestEnv();
    const owner = (await ownerHeaders()).Authorization;
    // ownerAuth accepts it…
    expect(
      (await app.request('/api/owner/allowlist', { headers: { Authorization: owner } }, env))
        .status,
    ).toBe(200);
    // …adminAuth (tenant-scoped) does not…
    expect(
      (
        await app.request(
          '/api/sunny-paws/admin/settings',
          { headers: { Authorization: owner } },
          env,
        )
      ).status,
    ).toBe(401);
    // …and endUserAuth does not.
    expect(
      (await app.request('/api/sunny-paws/me', { headers: { Authorization: owner } }, env)).status,
    ).toBe(401);

    // The reverse: admin and widget tokens are rejected by ownerAuth.
    const admin = `Bearer ${await mintAdminToken('tu_x', TENANT_A, TEST_SECRET)}`;
    const widget = `Bearer ${await mintToken('eu_x', TENANT_A, TEST_SECRET)}`;
    for (const auth of [admin, widget]) {
      expect(
        (await app.request('/api/owner/allowlist', { headers: { Authorization: auth } }, env))
          .status,
      ).toBe(401);
    }
    // And no token at all.
    expect((await app.request('/api/owner/allowlist', {}, env)).status).toBe(401);
  });
});

describe('owner console allowlist CRUD', () => {
  const post = async (env: Env, email: unknown) =>
    app.request(
      '/api/owner/allowlist',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await ownerHeaders()) },
        body: JSON.stringify({ email }),
      },
      env,
    );

  it('lists entries with claim status and tenant slug', async () => {
    const { env } = createTestEnv();
    const res = await app.request('/api/owner/allowlist', { headers: await ownerHeaders() }, env);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: { email: string; claimedAt: string | null; tenantSlug: string | null }[];
    };
    const seeded = entries.find((e) => e.email === ALLOWED_EMAIL);
    expect(seeded).toMatchObject({ claimedAt: null, tenantSlug: null });
  });

  it('add validates, normalizes, and is idempotent', async () => {
    const { env } = createTestEnv();
    expect((await post(env, 'not-an-email')).status).toBe(400);
    const first = await post(env, '  NewPerson@Example.COM ');
    expect(first.status).toBe(200);
    const { entry } = (await first.json()) as { entry: { email: string } };
    expect(entry.email).toBe('newperson@example.com'); // trimmed + lowercased
    expect((await post(env, 'newperson@example.com')).status).toBe(200); // idempotent re-add
  });

  it('rejects OWNER_EMAILS members (owners must not double as sitters)', async () => {
    const { env } = createTestEnv();
    expect((await post(env, OWNER_EMAIL)).status).toBe(400);
  });

  it('removes unclaimed rows (204), refuses claimed ones (409), 404s unknown', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        "INSERT INTO AllowedSitters (Email, ClaimedAt, TenantId) VALUES ('done@x.test', '2026-01-01T00:00:00Z', 'tnt_sunnypaws')",
      )
      .run();
    const del = async (email: string) =>
      app.request(
        `/api/owner/allowlist/${encodeURIComponent(email)}`,
        { method: 'DELETE', headers: await ownerHeaders() },
        env,
      );
    expect((await del(ALLOWED_EMAIL)).status).toBe(204);
    expect((await del(ALLOWED_EMAIL)).status).toBe(404); // now gone
    expect((await del('done@x.test')).status).toBe(409); // claimed — already has an account
  });

  it('surfaces a claimed row whose tenant no longer exists as orphaned, without crashing', async () => {
    // Display-level tolerance: nothing deletes Tenants rows out from under a claim in normal
    // operation, but AllowedSitters.TenantId has no ON DELETE CASCADE (D1 FKs are off in
    // production too), so a claimed row can end up pointing at a tenant that's gone. The list
    // must still render — and flag it — rather than 500 or silently look "unclaimed".
    const { env, raw } = createTestEnv();
    raw
      .prepare(
        "INSERT INTO AllowedSitters (Email, ClaimedAt, TenantId) VALUES ('ghost@x.test', '2026-01-01T00:00:00Z', 'tnt_doesnotexist')",
      )
      .run();
    const res = await app.request('/api/owner/allowlist', { headers: await ownerHeaders() }, env);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: {
        email: string;
        claimedAt: string | null;
        tenantSlug: string | null;
        orphaned: boolean;
      }[];
    };
    const ghost = entries.find((e) => e.email === 'ghost@x.test');
    expect(ghost).toMatchObject({ tenantSlug: null, orphaned: true });

    // An unclaimed row is not orphaned — same tenantSlug: null, different claim state.
    const seeded = entries.find((e) => e.email === ALLOWED_EMAIL);
    expect(seeded).toMatchObject({ claimedAt: null, orphaned: false });

    // A normal claimed row with a live tenant is not orphaned either.
    raw
      .prepare(
        "INSERT INTO AllowedSitters (Email, ClaimedAt, TenantId) VALUES ('done@x.test', '2026-01-01T00:00:00Z', 'tnt_sunnypaws')",
      )
      .run();
    const res2 = await app.request('/api/owner/allowlist', { headers: await ownerHeaders() }, env);
    const { entries: entries2 } = (await res2.json()) as {
      entries: { email: string; tenantSlug: string | null; orphaned: boolean }[];
    };
    const done = entries2.find((e) => e.email === 'done@x.test');
    expect(done).toMatchObject({ tenantSlug: 'sunny-paws', orphaned: false });
  });
});
