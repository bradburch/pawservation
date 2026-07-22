import { describe, expect, it } from 'vitest';
import {
  getOwnerUserByEmail,
  getTenantUserByEmail,
  insertOwnerUser,
  updateOwnerPasswordHash,
  updateTenantUserPasswordHash,
} from '../db/repo';
import { ADMIN_EMAIL_A, createTestEnv } from './helpers';

describe('updateOwnerPasswordHash', () => {
  it('updates the hash and reports a row changed', async () => {
    const { env } = createTestEnv();
    await insertOwnerUser(env.PAWBOOK_DB, 'ou_1', 'owner@pawbook.test', 'old-hash');
    expect(await updateOwnerPasswordHash(env.PAWBOOK_DB, 'owner@pawbook.test', 'new-hash')).toBe(
      true,
    );
    const row = await getOwnerUserByEmail(env.PAWBOOK_DB, 'owner@pawbook.test');
    expect(row?.PasswordHash).toBe('new-hash');
  });

  it('reports no change for an unknown email, and touches nothing', async () => {
    const { env } = createTestEnv();
    expect(await updateOwnerPasswordHash(env.PAWBOOK_DB, 'nobody@pawbook.test', 'h')).toBe(false);
    expect(await getOwnerUserByEmail(env.PAWBOOK_DB, 'nobody@pawbook.test')).toBeNull();
  });
});

describe('updateTenantUserPasswordHash', () => {
  it('updates the seeded sitter login and reports a row changed', async () => {
    const { env } = createTestEnv();
    const before = await getTenantUserByEmail(env.PAWBOOK_DB, ADMIN_EMAIL_A);
    expect(before?.PasswordHash.startsWith('pbkdf2$')).toBe(true);
    expect(await updateTenantUserPasswordHash(env.PAWBOOK_DB, ADMIN_EMAIL_A, 'new-hash')).toBe(
      true,
    );
    const after = await getTenantUserByEmail(env.PAWBOOK_DB, ADMIN_EMAIL_A);
    expect(after?.PasswordHash).toBe('new-hash');
    expect(after?.Id).toBe(before?.Id); // same row, not a new one
  });

  it('reports no change for an unknown email', async () => {
    const { env } = createTestEnv();
    expect(await updateTenantUserPasswordHash(env.PAWBOOK_DB, 'nobody@x.test', 'h')).toBe(false);
  });
});
