import { describe, expect, it, vi } from 'vitest';
import {
  createTenantAccessToken,
  findLiveTenantAccessToken,
  revokeTenantAccessToken,
} from '../db/repo';
import { generatePersonalAccessToken, hashPersonalAccessToken } from '../lib/personal-access-token';
import {
  generateTenantAccessToken,
  looksLikeTenantAccessToken,
} from '../lib/personal-access-token';
import { createTestEnv, TENANT_A, TENANT_B } from './helpers';

/**
 * Tenant access tokens: the mirror of the end-user personal access token (0012), for the sitter
 * side — the credential that lets `adminAuth` accept a Bearer token wherever it accepts the
 * admin session JWT (Task 2). This file covers only what Task 1 builds: the generator and the
 * repo functions the table sits behind. No route exists yet.
 */

describe('tenant access tokens — generator', () => {
  it('starts with pawsa_ and carries at least 256 bits of CSPRNG entropy', () => {
    const randomSpy = vi.spyOn(Math, 'random');
    const csprngSpy = vi.spyOn(crypto, 'getRandomValues');
    try {
      const token = generateTenantAccessToken();
      expect(token.startsWith('pawsa_')).toBe(true);
      expect(token.length).toBe('pawsa_'.length + 43); // 32 CSPRNG bytes, base64url, no padding
      expect(csprngSpy).toHaveBeenCalled();
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
      csprngSpy.mockRestore();
    }
  });

  it('mints a distinct secret every time', () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 25; i++) secrets.add(generateTenantAccessToken());
    expect(secrets.size).toBe(25);
  });

  it('looksLikeTenantAccessToken accepts pawsa_ and rejects the end-user pawsv_ prefix', () => {
    expect(looksLikeTenantAccessToken(generateTenantAccessToken())).toBe(true);
    expect(looksLikeTenantAccessToken(generatePersonalAccessToken())).toBe(false);
    expect(looksLikeTenantAccessToken('not-a-token')).toBe(false);
  });
});

describe('tenant access tokens — at rest', () => {
  it('stores only the hash: no pawsa_ token appears anywhere in its row', async () => {
    const { env, raw } = createTestEnv();
    const token = generateTenantAccessToken();
    const tokenHash = await hashPersonalAccessToken(token);
    const created = await createTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, {
      tenantUserId: 'tu_sunny',
      name: 'CI bot',
      tokenHash,
    });
    expect(created.Name).toBe('CI bot');
    expect(created.Id).toBeTruthy();
    expect(created.CreatedAt).toEqual(expect.any(String));

    const row = raw
      .prepare('SELECT * FROM TenantAccessTokens WHERE Id = ?')
      .get(created.Id) as Record<string, unknown>;
    expect(row.TokenHash).toBe(tokenHash);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('finds a live token scoped to its own tenant, and not under a different tenant', async () => {
    const { env } = createTestEnv();
    const token = generateTenantAccessToken();
    const tokenHash = await hashPersonalAccessToken(token);
    const created = await createTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, {
      tenantUserId: 'tu_sunny',
      name: 'Home laptop',
      tokenHash,
    });

    const foundOwnTenant = await findLiveTenantAccessToken(
      env.PAWSERVATION_DB,
      TENANT_A,
      tokenHash,
    );
    expect(foundOwnTenant).toEqual({
      Id: created.Id,
      TenantUserId: 'tu_sunny',
      LastUsedAt: null,
    });

    // Same hash, wrong tenant: the row belongs to TENANT_A and must be invisible from TENANT_B,
    // even though the digest matches exactly — Model A holds by construction (TenantId is bound
    // in the WHERE clause, not filtered afterward in application code).
    const foundOtherTenant = await findLiveTenantAccessToken(
      env.PAWSERVATION_DB,
      TENANT_B,
      tokenHash,
    );
    expect(foundOtherTenant).toBeNull();
  });

  it('revokes a token so it stops resolving, and is idempotent and scoped by owner', async () => {
    const { env } = createTestEnv();
    const token = generateTenantAccessToken();
    const tokenHash = await hashPersonalAccessToken(token);
    const created = await createTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, {
      tenantUserId: 'tu_sunny',
      name: 'Revoke me',
      tokenHash,
    });

    // Another tenant user's id (belongs to a different tenant entirely) can neither revoke nor
    // probe for this token: the 404-shaped false the route above this will report.
    expect(
      await revokeTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, 'tu_dana', created.Id),
    ).toBe(false);
    expect(
      await findLiveTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, tokenHash),
    ).not.toBeNull();

    expect(
      await revokeTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, 'tu_sunny', created.Id),
    ).toBe(true);
    expect(await findLiveTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, tokenHash)).toBeNull();

    // Revoking twice is idempotent: SQLite still counts the row as changed, so the second call
    // reports success rather than a confusing 404 for a token the caller can plainly see is dead.
    expect(
      await revokeTenantAccessToken(env.PAWSERVATION_DB, TENANT_A, 'tu_sunny', created.Id),
    ).toBe(true);
  });
});
