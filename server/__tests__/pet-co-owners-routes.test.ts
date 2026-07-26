import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertInvitedCustomer } from '../db/repo';
import { adminHeaders, createTestEnv, TENANT_A } from './helpers';

const jsonHeaders = async (tenantId: string) => ({
  ...(await adminHeaders(tenantId)),
  'Content-Type': 'application/json',
});

type CustomersPayload = {
  customers: {
    id: string;
    pets: { id: string; name: string; deceasedAt: string | null }[];
  }[];
};

const customers = async (env: Env): Promise<CustomersPayload> =>
  (await (
    await app.request(
      '/api/sunny-paws/admin/customers',
      { headers: await adminHeaders(TENANT_A) },
      env,
    )
  ).json()) as CustomersPayload;

describe('admin co-owner + deceased routes', () => {
  it('adds a co-owner, and the pet then shows under BOTH clients', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    const res = await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella/owners`,
      {
        method: 'POST',
        headers: await jsonHeaders(TENANT_A),
        body: JSON.stringify({ endUserId: co.Id }),
      },
      env,
    );
    expect(res.status).toBe(204);
    const payload = await customers(env);
    const petNamesFor = (id: string) =>
      payload.customers
        .find((c) => c.id === id)!
        .pets.map((p) => p.name)
        .sort();
    expect(petNamesFor(co.Id)).toEqual(['Bella']);
    expect(petNamesFor('eu_sp_jess')).toEqual(['Bella', 'Mochi']);
  });

  it('rejects a missing endUserId with 400 and an unknown pet with 404', async () => {
    const { env } = createTestEnv();
    const bad = await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella/owners`,
      { method: 'POST', headers: await jsonHeaders(TENANT_A), body: JSON.stringify({}) },
      env,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Choose a client.' });

    // Another tenant's pet is indistinguishable from a nonexistent one.
    const foreign = await app.request(
      `/api/sunny-paws/admin/pets/pet_ht_otis/owners`,
      {
        method: 'POST',
        headers: await jsonHeaders(TENANT_A),
        body: JSON.stringify({ endUserId: 'eu_sp_jess' }),
      },
      env,
    );
    expect(foreign.status).toBe(404);
  });

  it('removes a co-owner but refuses to remove the last one', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella/owners`,
      {
        method: 'POST',
        headers: await jsonHeaders(TENANT_A),
        body: JSON.stringify({ endUserId: co.Id }),
      },
      env,
    );
    const removed = await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella/owners/${co.Id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(removed.status).toBe(204);

    const last = await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella/owners/eu_sp_jess`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({
      error: 'A pet must keep at least one owner — remove the pet instead.',
    });
  });

  it('marks a pet deceased and back, surfacing deceasedAt to the sitter', async () => {
    const { env } = createTestEnv();
    const mark = async (deceased: boolean) =>
      app.request(
        `/api/sunny-paws/admin/pets/pet_sp_bella`,
        {
          method: 'PATCH',
          headers: await jsonHeaders(TENANT_A),
          body: JSON.stringify({ deceased }),
        },
        env,
      );
    expect((await mark(true)).status).toBe(204);
    const after = await customers(env);
    const bella = after.customers
      .find((c) => c.id === 'eu_sp_jess')!
      .pets.find((p) => p.id === 'pet_sp_bella')!;
    expect(bella.deceasedAt).not.toBeNull();

    expect((await mark(false)).status).toBe(204);
    const undone = await customers(env);
    expect(
      undone.customers
        .find((c) => c.id === 'eu_sp_jess')!
        .pets.find((p) => p.id === 'pet_sp_bella')!.deceasedAt,
    ).toBeNull();
  });

  it('validates the deceased flag and 404s a foreign pet', async () => {
    const { env } = createTestEnv();
    const bad = await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella`,
      { method: 'PATCH', headers: await jsonHeaders(TENANT_A), body: JSON.stringify({}) },
      env,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'deceased must be true or false.' });

    const foreign = await app.request(
      `/api/sunny-paws/admin/pets/pet_ht_otis`,
      {
        method: 'PATCH',
        headers: await jsonHeaders(TENANT_A),
        body: JSON.stringify({ deceased: true }),
      },
      env,
    );
    expect(foreign.status).toBe(404);
  });

  it('requires an admin token', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deceased: true }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});
