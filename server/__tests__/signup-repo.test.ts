import { describe, expect, it } from 'vitest';
import {
  addAllowedSitter,
  createTenantFromSignup,
  deleteUnclaimedAllowedSitter,
  getAllowedSitter,
  getOwnerUserByEmail,
  getTenantBySlug,
  getTenantUserByEmail,
  insertOwnerUser,
  listAllowedSitters,
} from '../db/repo';
import { createTestEnv } from './helpers';

describe('owner-scope repo: OwnerUsers', () => {
  it('inserts and reads an owner user by email', async () => {
    const { env } = createTestEnv();
    expect(await getOwnerUserByEmail(env.PAWBOOK_DB, 'owner@pawbook.test')).toBeNull();
    await insertOwnerUser(env.PAWBOOK_DB, 'ou_1', 'owner@pawbook.test', 'pbkdf2$1$aa$bb');
    const row = await getOwnerUserByEmail(env.PAWBOOK_DB, 'owner@pawbook.test');
    expect(row?.Id).toBe('ou_1');
    expect(row?.PasswordHash).toBe('pbkdf2$1$aa$bb');
  });

  it('enforces Email UNIQUE — a second insert throws', async () => {
    const { env } = createTestEnv();
    await insertOwnerUser(env.PAWBOOK_DB, 'ou_1', 'owner@pawbook.test', 'h1');
    await expect(
      insertOwnerUser(env.PAWBOOK_DB, 'ou_2', 'owner@pawbook.test', 'h2'),
    ).rejects.toThrow();
  });
});

describe('owner-scope repo: AllowedSitters', () => {
  it('addAllowedSitter is idempotent and reads back unclaimed', async () => {
    const { env } = createTestEnv();
    const a = await addAllowedSitter(env.PAWBOOK_DB, 'sitter@x.test');
    const b = await addAllowedSitter(env.PAWBOOK_DB, 'sitter@x.test');
    expect(a.Email).toBe('sitter@x.test');
    expect(a.ClaimedAt).toBeNull();
    expect(b.AddedAt).toBe(a.AddedAt); // second add returned the existing row, not a fresh one
    expect((await getAllowedSitter(env.PAWBOOK_DB, 'sitter@x.test'))?.Email).toBe('sitter@x.test');
  });

  it('deleteUnclaimedAllowedSitter deletes unclaimed rows only', async () => {
    const { env } = createTestEnv();
    await addAllowedSitter(env.PAWBOOK_DB, 'gone@x.test');
    expect(await deleteUnclaimedAllowedSitter(env.PAWBOOK_DB, 'gone@x.test')).toBe(true);
    expect(await getAllowedSitter(env.PAWBOOK_DB, 'gone@x.test')).toBeNull();

    await addAllowedSitter(env.PAWBOOK_DB, 'kept@x.test');
    await createTenantFromSignup(env.PAWBOOK_DB, {
      tenantId: 'tnt_kept',
      slug: 'kept-biz',
      displayName: 'Kept Biz',
      userId: 'tu_kept',
      email: 'kept@x.test',
      passwordHash: 'h',
    });
    expect(await deleteUnclaimedAllowedSitter(env.PAWBOOK_DB, 'kept@x.test')).toBe(false);
    expect((await getAllowedSitter(env.PAWBOOK_DB, 'kept@x.test'))?.ClaimedAt).toBeTruthy();
  });

  it('listAllowedSitters joins the claimed tenant slug; seed row is unclaimed', async () => {
    const { env } = createTestEnv();
    await addAllowedSitter(env.PAWBOOK_DB, 'claimed@x.test');
    await createTenantFromSignup(env.PAWBOOK_DB, {
      tenantId: 'tnt_new',
      slug: 'newbiz',
      displayName: 'New Biz',
      userId: 'tu_new',
      email: 'claimed@x.test',
      passwordHash: 'h',
    });
    const rows = await listAllowedSitters(env.PAWBOOK_DB);
    const claimed = rows.find((r) => r.Email === 'claimed@x.test');
    expect(claimed?.ClaimedAt).toBeTruthy();
    expect(claimed?.TenantSlug).toBe('newbiz');
    const seeded = rows.find((r) => r.Email === 'newsitter@pawbook.test'); // sql/seed.sql
    expect(seeded?.ClaimedAt).toBeNull();
    expect(seeded?.TenantSlug).toBeNull();
  });
});

describe('createTenantFromSignup (atomic batch)', () => {
  it('creates Tenant + TenantUser and claims the allowlist row together', async () => {
    const { env } = createTestEnv();
    await addAllowedSitter(env.PAWBOOK_DB, 'new@x.test');
    await createTenantFromSignup(env.PAWBOOK_DB, {
      tenantId: 'tnt_x',
      slug: 'x-biz',
      displayName: 'X Biz',
      userId: 'tu_x',
      email: 'new@x.test',
      passwordHash: 'pbkdf2$1$aa$bb',
      claimedAtIso: '2026-07-19T00:00:00.000Z',
    });
    const tenant = await getTenantBySlug(env.PAWBOOK_DB, 'x-biz');
    expect(tenant?.DisplayName).toBe('X Biz');
    // New-tenant timezone defaults to NULL (unlimited / instance-default).
    expect(tenant?.Timezone).toBeNull();
    const user = await getTenantUserByEmail(env.PAWBOOK_DB, 'new@x.test');
    expect(user?.TenantId).toBe('tnt_x');
    const claim = await getAllowedSitter(env.PAWBOOK_DB, 'new@x.test');
    expect(claim?.ClaimedAt).toBe('2026-07-19T00:00:00.000Z');
    expect(claim?.TenantId).toBe('tnt_x');
  });

  it('a duplicate email aborts the WHOLE batch — no orphan tenant', async () => {
    const { env, raw } = createTestEnv();
    await addAllowedSitter(env.PAWBOOK_DB, 'dup@x.test');
    await createTenantFromSignup(env.PAWBOOK_DB, {
      tenantId: 'tnt_dup',
      slug: 'dup-biz',
      displayName: 'Dup Biz',
      userId: 'tu_dup',
      email: 'dup@x.test',
      passwordHash: 'h',
    });
    const before = (raw.prepare('SELECT COUNT(*) AS n FROM Tenants').get() as { n: number }).n;
    await expect(
      createTenantFromSignup(env.PAWBOOK_DB, {
        tenantId: 'tnt_dup2',
        slug: 'dup-biz-2',
        displayName: 'Dup Again',
        userId: 'tu_dup2',
        email: 'dup@x.test', // TenantUsers.Email UNIQUE fires on statement 2 of the batch
        passwordHash: 'h',
      }),
    ).rejects.toThrow();
    const after = (raw.prepare('SELECT COUNT(*) AS n FROM Tenants').get() as { n: number }).n;
    expect(after).toBe(before); // the Tenants INSERT (statement 1) rolled back too
  });
});
