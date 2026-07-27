import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { createTestEnv, demoToken, TENANT_A } from './helpers';

const DEMO_EMAIL = 'demo@pawservation.com';
const SLUG_C = 'paws-and-relax'; // NOT in DEMO_TENANT_SLUGS — exercises the real gate, not the /demo-tenant shortcut
const TENANT_C = 'tnt_pawsandrelax';

function identify(env: Env, slug: string, email: string, host?: string) {
  return app.request(
    `/api/${slug}/identify`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(host ? { 'X-Pawservation-Host': host } : {}),
      },
      body: JSON.stringify({ email }),
    },
    env,
  );
}

describe('demo login gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('issues an on-screen code from pawservation.com and provisions the shadow customer once', async () => {
    const { env, raw } = createTestEnv();
    const res = await identify(env, SLUG_C, DEMO_EMAIL, 'https://pawservation.com');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codeId: string; prototypeCode?: string };
    expect(body.codeId).toBeTruthy();
    expect(body.prototypeCode).toMatch(/^\d{6}$/);

    await identify(env, SLUG_C, DEMO_EMAIL, 'http://localhost:8787'); // second use, dev host
    const users = raw
      .prepare(`SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = ?`)
      .all(TENANT_C, DEMO_EMAIL);
    expect(users).toHaveLength(1);
  });

  it('rejects tenant sites, missing header, and the * fallback — and provisions NOTHING', async () => {
    const { env, raw } = createTestEnv();
    for (const host of ['https://sunnypawssitting.com', '*', undefined]) {
      const res = await identify(env, SLUG_C, DEMO_EMAIL, host);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe(
        'This provider books by invitation only.',
      );
    }
    const users = raw.prepare(`SELECT Id FROM EndUsers WHERE Email = ?`).all(DEMO_EMAIL);
    expect(users).toEqual([]);
  });

  it('always shows the code on-screen and never emails, even in production with email configured', async () => {
    const { env } = createTestEnv();
    env.ENVIRONMENT = 'production';
    env.RESEND_API_KEY = 'test-key';
    env.RESEND_FROM_NOREPLY = 'Pawservation <no_reply@example.com>';
    env.RESEND_FROM_BOOKING = 'Pawservation <booking@example.com>';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await identify(env, SLUG_C, DEMO_EMAIL, 'https://pawservation.com');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { prototypeCode?: string }).prototypeCode).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('verify mints a working token; /me shows Demo Visitor with one pet', async () => {
    const { env } = createTestEnv();
    const token = await demoToken(env, SLUG_C);
    const meRes = await app.request(
      `/api/${SLUG_C}/me`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as {
      name: string | null;
      pets: { name: string; petType: string }[];
    };
    expect(me.name).toBe('Demo Visitor');
    expect(me.pets).toHaveLength(1);
    expect(me.pets[0]).toMatchObject({ name: 'Biscuit', petType: 'dog' });
  });

  it('demo tokens are tenant-scoped: a paws-and-relax token is refused by sunny-paws', async () => {
    const { env, raw } = createTestEnv();
    const token = await demoToken(env, SLUG_C);
    const res = await app.request(
      '/api/sunny-paws/me',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    expect([401, 403]).toContain(res.status);
    // And provisioning stayed per-tenant:
    expect(
      raw
        .prepare(`SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = ?`)
        .all(TENANT_A, DEMO_EMAIL),
    ).toEqual([]);
  });

  it('real customers are untouched by the gate — identify works with a tenant-site header', async () => {
    const { env } = createTestEnv();
    const res = await identify(env, SLUG_C, 'jess@example.com', 'https://sunnypawssitting.com');
    expect(res.status).toBe(200); // dev env → prototypeCode path, unchanged
    expect(((await res.json()) as { codeId: string }).codeId).toBeTruthy();
  });

  // Pet-type resolution has three fallback branches (server/routes/auth.ts): dog-in-registry
  // (covered above via paws-and-relax, which seeds both 'dog' and 'cat'), dog-NOT-in-registry
  // (first registry row wins), and an empty registry (literal 'dog'). The seeded tenants all
  // carry 'dog', so these two mutate the registry directly to exercise the other branches.
  it('pet-type fallback: first registry row is used when dog is not in the registry', async () => {
    const { env, raw } = createTestEnv();
    raw
      .prepare(`DELETE FROM TenantPetTypes WHERE TenantId = ? AND PetType = ?`)
      .run(TENANT_C, 'dog');
    const token = await demoToken(env, SLUG_C);
    const meRes = await app.request(
      `/api/${SLUG_C}/me`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const me = (await meRes.json()) as { pets: { petType: string }[] };
    expect(me.pets).toHaveLength(1);
    expect(me.pets[0].petType).toBe('cat'); // the only remaining (thus first, ORDER BY PetType) row
  });

  it('pet-type fallback: literal "dog" is used when the tenant registry is empty', async () => {
    const { env, raw } = createTestEnv();
    raw.prepare(`DELETE FROM TenantPetTypes WHERE TenantId = ?`).run(TENANT_C);
    const token = await demoToken(env, SLUG_C);
    const meRes = await app.request(
      `/api/${SLUG_C}/me`,
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
    const me = (await meRes.json()) as { pets: { petType: string }[] };
    expect(me.pets).toHaveLength(1);
    expect(me.pets[0].petType).toBe('dog');
  });
});
