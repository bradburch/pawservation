import { describe, expect, it } from 'vitest';
import app from '../index';
import { addPetOwner, insertInvitedCustomer } from '../db/repo';
import { adminHeaders, createTestEnv, TENANT_A, TENANT_B } from './helpers';

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

  it('404s removing a customer who was never linked as an owner', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    // co was invited but never linked as an owner of Bella — no such edge exists to delete.
    const notOwner = await app.request(
      `/api/sunny-paws/admin/pets/pet_sp_bella/owners/${co.Id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(notOwner.status).toBe(404);
    expect(await notOwner.json()).toEqual({ error: 'Not found.' });
  });

  it('404s an admin for TENANT_A trying to remove TENANT_B’s real owner link, and leaves it intact', async () => {
    const { env } = createTestEnv();
    // pet_ht_otis / eu_ht_jess is a REAL edge, but it belongs to tnt_happytails. Give the pet a
    // second owner IN ITS OWN TENANT first, so the "last owner" guard can't independently explain
    // a refusal to delete — without a co-owner, pet_ht_otis has exactly one owner globally and the
    // removal would be refused by removePetOwner's own last-owner protection regardless of whether
    // tenant scoping holds, making the probe meaningless. With a genuine second owner in place, the
    // ONLY thing left to block a TENANT_A-authenticated delete of this TENANT_B row is the
    // TenantId predicate in removePetOwner's DELETE.
    const coHt = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_B,
      'co-ht@example.com',
      'Co Owner HT',
    );
    await addPetOwner(env.PAWBOOK_DB, TENANT_B, 'pet_ht_otis', coHt.Id);

    const foreign = await app.request(
      `/api/sunny-paws/admin/pets/pet_ht_otis/owners/eu_ht_jess`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'Not found.' });

    const row = await env.PAWBOOK_DB.prepare(
      'SELECT 1 AS Ok FROM PetOwners WHERE TenantId = ? AND PetId = ? AND EndUserId = ?',
    )
      .bind('tnt_happytails', 'pet_ht_otis', 'eu_ht_jess')
      .first<{ Ok: number }>();
    expect(row).toBeTruthy();
  });

  it('is idempotent when the same owner is added twice', async () => {
    const { env } = createTestEnv();
    const co = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'co@example.com', 'Co Owner');
    const addOnce = async () =>
      app.request(
        `/api/sunny-paws/admin/pets/pet_sp_bella/owners`,
        {
          method: 'POST',
          headers: await jsonHeaders(TENANT_A),
          body: JSON.stringify({ endUserId: co.Id }),
        },
        env,
      );
    expect((await addOnce()).status).toBe(204);
    expect((await addOnce()).status).toBe(204);

    const row = await env.PAWBOOK_DB.prepare(
      'SELECT COUNT(*) AS n FROM PetOwners WHERE TenantId = ? AND PetId = ? AND EndUserId = ?',
    )
      .bind(TENANT_A, 'pet_sp_bella', co.Id)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
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
