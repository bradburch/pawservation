import { describe, expect, it } from 'vitest';
import app from '../index';
import { createTenantFromSignup } from '../db/repo';
import { adminToken, ALLOWED_EMAIL, createTestEnv, TENANT_A } from './helpers';

async function auth(tenantId: string, json = false): Promise<Record<string, string>> {
  const h: Record<string, string> = { Authorization: `Bearer ${await adminToken(tenantId)}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

type SettingsShape = {
  petTypes: { petType: string; label: string }[];
  services: { type: string; enabled: boolean; acceptedPetTypes: string[] | null }[];
};

const getSettings = async (env: Env, slug = 'sunny-paws', tenantId = TENANT_A) =>
  (await (
    await app.request(`/api/${slug}/admin/settings`, { headers: await auth(tenantId) }, env)
  ).json()) as SettingsShape;

describe('pet-type CRUD endpoints', () => {
  it('POST creates an enabled, slugified type that shows up in settings', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/pet-types',
      {
        method: 'POST',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ label: 'Guinea Pigs!' }),
      },
      env,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ petType: 'guinea-pigs', label: 'Guinea Pigs!' });
    const settings = await getSettings(env);
    expect(settings.petTypes.find((p) => p.petType === 'guinea-pigs')).toEqual({
      petType: 'guinea-pigs',
      label: 'Guinea Pigs!',
    });
  });

  it('POST rejects empty/punctuation labels (400) and duplicates (409)', async () => {
    const { env } = createTestEnv();
    const post = async (label: unknown) =>
      app.request(
        '/api/sunny-paws/admin/pet-types',
        { method: 'POST', headers: await auth(TENANT_A, true), body: JSON.stringify({ label }) },
        env,
      );
    expect((await post('')).status).toBe(400);
    expect((await post('---')).status).toBe(400);
    // Slugs collide with SEEDED slugs, not labels: 'Rabbit' → 'rabbit', 'Dog' → 'dog'.
    expect((await post('Rabbit')).status).toBe(409);
    expect((await post('Dog')).status).toBe(409);
  });

  it('PUT renames the label only and round-trips through settings GET; unknown slug 404s', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/pet-types/rabbit',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ label: 'Bunnies' }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const settings = await getSettings(env);
    expect(settings.petTypes.find((p) => p.petType === 'rabbit')?.label).toBe('Bunnies');
    const missing = await app.request(
      '/api/sunny-paws/admin/pet-types/dragon',
      { method: 'PUT', headers: await auth(TENANT_A, true), body: JSON.stringify({ label: 'X' }) },
      env,
    );
    expect(missing.status).toBe(404);
  });

  it('DELETE blocks a referenced slug with 409 pointing at disable; unreferenced delete scrubs services', async () => {
    const { env } = createTestEnv();
    // Reference rabbit: add a rabbit pet to Jess.
    const addPet = await app.request(
      '/api/sunny-paws/admin/customers/eu_sp_jess/pets',
      {
        method: 'POST',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ name: 'Peanut', petType: 'rabbit' }),
      },
      env,
    );
    expect(addPet.status).toBe(201);
    const petId = ((await addPet.json()) as { id: string }).id;

    const blocked = await app.request(
      '/api/sunny-paws/admin/pet-types/rabbit',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain(
      "Uncheck it under each service's Accepted pets instead",
    );

    // Give walk an explicit list naming rabbit, remove the pet, then delete succeeds + scrubs.
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              acceptedPetTypes: ['dog', 'rabbit'],
              options: [{ label: '30 min', durationMinutes: 30, rate: 20 }],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);
    await app.request(
      `/api/sunny-paws/admin/customers/eu_sp_jess/pets/${petId}`,
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    const del = await app.request(
      '/api/sunny-paws/admin/pet-types/rabbit',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ disabledServices: [] });
    const settings = await getSettings(env);
    expect(settings.petTypes.some((p) => p.petType === 'rabbit')).toBe(false);
    expect(settings.services.find((s) => s.type === 'walk')?.acceptedPetTypes).toEqual(['dog']);
    const unknown = await app.request(
      '/api/sunny-paws/admin/pet-types/rabbit',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(unknown.status).toBe(404);
  });

  it('DELETE scrubs the slug across MULTIPLE services in one call', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'walk',
              enabled: true,
              acceptedPetTypes: ['dog', 'rabbit'],
              options: [{ label: '30 min', durationMinutes: 30, rate: 20 }],
            },
            {
              type: 'checkin',
              enabled: true,
              acceptedPetTypes: ['rabbit'],
              options: [{ label: '15 min', durationMinutes: 15, rate: 12 }],
            },
          ],
        }),
      },
      env,
    );
    expect(put.status).toBe(204);

    const del = await app.request(
      '/api/sunny-paws/admin/pet-types/rabbit',
      { method: 'DELETE', headers: await auth(TENANT_A) },
      env,
    );
    expect(del.status).toBe(200);
    // The caller learns which services got silently turned off by the scrub.
    expect(await del.json()).toEqual({ disabledServices: ['checkin'] });

    const settings = await getSettings(env);
    expect(settings.petTypes.some((p) => p.petType === 'rabbit')).toBe(false);
    // Partial scrub: 'walk' keeps 'dog' and stays enabled.
    expect(settings.services.find((s) => s.type === 'walk')?.acceptedPetTypes).toEqual(['dog']);
    expect(settings.services.find((s) => s.type === 'walk')?.enabled).toBe(true);
    // Scrub-to-empty -> '[]' (never NULL/accepts-all) AND the service is disabled — 'checkin'
    // named only 'rabbit', so emptying its list turns it off instead of silently widening it.
    expect(settings.services.find((s) => s.type === 'checkin')?.acceptedPetTypes).toEqual([]);
    expect(settings.services.find((s) => s.type === 'checkin')?.enabled).toBe(false);
  });
});

describe('settings GET/PUT — rows drive pet types', () => {
  it('GET lists registry rows (petType + label), no enabled flag', async () => {
    const { env } = createTestEnv();
    const settings = await getSettings(env);
    expect(settings.petTypes).toEqual([
      { petType: 'cat', label: 'Cats' },
      { petType: 'dog', label: 'Dogs' },
      { petType: 'rabbit', label: 'Rabbits' },
    ]);
  });

  it('top-level petTypes is no longer part of the PUT body — ignored, never written', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({ petTypes: ['dog'] }), // stale client payload
      },
      env,
    );
    expect(res.status).toBe(204);
    const settings = await getSettings(env);
    // Registry untouched — behavior lives on each service's acceptance list now.
    expect(settings.petTypes.map((p) => p.petType)).toEqual(['cat', 'dog', 'rabbit']);
  });

  it('per-service acceptedPetTypes: PATCH keeps current when absent; empty on enabled -> 400; unknown slug -> 400; null clears', async () => {
    const { env } = createTestEnv();
    const put = async (services: unknown) =>
      app.request(
        '/api/sunny-paws/admin/settings',
        { method: 'PUT', headers: await auth(TENANT_A, true), body: JSON.stringify({ services }) },
        env,
      );
    const boardingOpts = [{ label: 'Standard', rate: 50 }];
    expect(
      (
        await put([
          { type: 'boarding', enabled: true, acceptedPetTypes: ['dog'], options: boardingOpts },
        ])
      ).status,
    ).toBe(204);
    let settings = await getSettings(env);
    expect(settings.services.find((s) => s.type === 'boarding')?.acceptedPetTypes).toEqual(['dog']);

    // Absent field keeps the stored list (the questions PATCH idiom).
    expect((await put([{ type: 'boarding', enabled: true, options: boardingOpts }])).status).toBe(
      204,
    );
    settings = await getSettings(env);
    expect(settings.services.find((s) => s.type === 'boarding')?.acceptedPetTypes).toEqual(['dog']);

    expect(
      (
        await put([
          { type: 'boarding', enabled: true, acceptedPetTypes: [], options: boardingOpts },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await put([
          { type: 'boarding', enabled: true, acceptedPetTypes: ['dragon'], options: boardingOpts },
        ])
      ).status,
    ).toBe(400);

    // Explicit null clears back to accepts-all.
    expect(
      (
        await put([
          { type: 'boarding', enabled: true, acceptedPetTypes: null, options: boardingOpts },
        ])
      ).status,
    ).toBe(204);
    settings = await getSettings(env);
    expect(settings.services.find((s) => s.type === 'boarding')?.acceptedPetTypes).toBeNull();
  });

  it('public config exposes the FULL registry as {slug,label} pairs plus per-service acceptance', async () => {
    const { env } = createTestEnv();
    await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: await auth(TENANT_A, true),
        body: JSON.stringify({
          services: [
            {
              type: 'boarding',
              enabled: true,
              acceptedPetTypes: ['dog'],
              options: [{ label: 'Standard', rate: 50 }],
            },
          ],
        }),
      },
      env,
    );
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      petTypes: { slug: string; label: string }[];
      services: { type: string; acceptedPetTypes: string[] | null }[];
    };
    expect(cfg.petTypes).toEqual([
      { slug: 'cat', label: 'Cats' },
      { slug: 'dog', label: 'Dogs' },
      { slug: 'rabbit', label: 'Rabbits' },
    ]);
    expect(cfg.services.find((s) => s.type === 'boarding')?.acceptedPetTypes).toEqual(['dog']);
    expect(cfg.services.find((s) => s.type === 'walk')?.acceptedPetTypes).toBeNull();
  });

  it('a fresh signup tenant lists dog + cat enabled from rows (F1)', async () => {
    const { env } = createTestEnv();
    await createTenantFromSignup(env.PAWBOOK_DB, {
      tenantId: 'tnt_fresh',
      slug: 'fresh-paws',
      displayName: 'Fresh Paws',
      userId: 'tu_fresh',
      email: ALLOWED_EMAIL,
      passwordHash: 'x',
    });
    const settings = await getSettings(env, 'fresh-paws', 'tnt_fresh');
    expect(settings.petTypes).toEqual([
      { petType: 'cat', label: 'Cats' },
      { petType: 'dog', label: 'Dogs' },
    ]);
  });
});
