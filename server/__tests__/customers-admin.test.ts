import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

describe('admin customers', () => {
  it('adds, lists, and removes a customer', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };

    const add = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: 'guest@example.com',
          name: 'Guest',
          petName: 'Rex',
          petType: 'dog',
        }),
      },
      env,
    );
    expect(add.status).toBe(201);
    const created = (await add.json()) as { id: string; status: string };
    expect(created.status).toBe('invited');

    const list = await app.request(
      `/api/${SLUG}/admin/customers`,
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    const { customers } = (await list.json()) as { customers: { email: string }[] };
    expect(customers.some((c) => c.email === 'guest@example.com')).toBe(true);

    const del = await app.request(
      `/api/${SLUG}/admin/customers/${created.id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(del.status).toBe(204);
  });

  it('rejects an invalid email with 400', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const res = await app.request(
      `/api/${SLUG}/admin/customers`,
      { method: 'POST', headers, body: JSON.stringify({ email: 'nope' }) },
      env,
    );
    expect(res.status).toBe(400);
  });

  // "No owners without pets" at the CREATION boundary: a client is a client-and-pet relationship,
  // so neither a nameless nor a pet-less create is allowed, and neither may leave a row behind.
  it('rejects a create with no name (400) and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const res = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'noname@example.com', petName: 'Rex', petType: 'dog' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/name/i) as unknown as string,
    });
    expect(
      raw.prepare('SELECT * FROM EndUsers WHERE Email = ?').get('noname@example.com'),
    ).toBeUndefined();
  });

  it('rejects a create with no pet (400) and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const res = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: 'nopet@example.com', name: 'No Pet' }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/pet/i) as unknown as string,
    });
    expect(
      raw.prepare('SELECT * FROM EndUsers WHERE Email = ?').get('nopet@example.com'),
    ).toBeUndefined();
  });

  it('rejects a pet type outside the tenant registry (400) and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const res = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: 'ferret@example.com',
          name: 'Ferret Fan',
          petName: 'Slinky',
          petType: 'ferret',
        }),
      },
      env,
    );
    expect(res.status).toBe(400);
    expect(
      raw.prepare('SELECT * FROM EndUsers WHERE Email = ?').get('ferret@example.com'),
    ).toBeUndefined();
  });

  it('creates the customer, the pet and the ownership edge together', async () => {
    const { env, raw } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const res = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: 'both@example.com',
          name: 'Both',
          phone: '(555) 555-0100',
          petName: 'Bella',
          petType: 'dog',
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const pet = raw
      .prepare('SELECT Id, Name, PetType, EndUserId FROM EndUserPets WHERE EndUserId = ?')
      .get(id) as { Id: string; Name: string; PetType: string } | undefined;
    expect(pet).toMatchObject({ Name: 'Bella', PetType: 'dog' });
    // The PetOwners edge is what every customer-facing pet list reads — a pet without it is
    // invisible to its own owner.
    expect(
      raw.prepare('SELECT * FROM PetOwners WHERE PetId = ? AND EndUserId = ?').get(pet!.Id, id),
    ).toBeDefined();
  });

  it('adds only the new pet when re-POSTing an existing customer, and never duplicates one', async () => {
    const { env, raw } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const post = (petName: string) =>
      app.request(
        `/api/${SLUG}/admin/customers`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            email: 'jess@example.com', // seeded, already owns Bella + Mochi
            name: 'Jess Demo',
            petName,
            petType: 'dog',
          }),
        },
        env,
      );
    const countPets = () =>
      (
        raw
          .prepare('SELECT COUNT(*) AS n FROM EndUserPets WHERE EndUserId = ?')
          .get('eu_sp_jess') as { n: number }
      ).n;
    const before = countPets();

    expect((await post('Bella')).status).toBe(201); // already owned — no-op, not an error
    expect(countPets()).toBe(before);

    expect((await post('Comet')).status).toBe(201);
    expect(countPets()).toBe(before + 1);
  });

  // Live pets only, exactly as the CSV import treats them: a deceased pet is neither bookable nor
  // a reason to refuse its name again. The two creation paths must not drift on this.
  it("re-uses a deceased pet's name for a new live pet", async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE EndUserPets SET DeceasedAt = '2026-01-01T00:00:00.000Z' WHERE Id = 'pet_sp_bella'`,
    );
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const res = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: 'jess@example.com',
          name: 'Jess Demo',
          petName: 'Bella',
          petType: 'dog',
        }),
      },
      env,
    );
    expect(res.status).toBe(201);
    const live = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM EndUserPets
         WHERE EndUserId = 'eu_sp_jess' AND Name = 'Bella' AND DeceasedAt IS NULL`,
      )
      .get() as { n: number };
    expect(live.n).toBe(1);
  });

  it('refuses to delete a customer with bookings (409)', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT INTO EndUsers (Id, TenantId, Email, Status) VALUES ('eu1','${TENANT_A}','has@example.com','active')`,
    );
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk1','${TENANT_A}','eu1','daycare','2030-05-01',1,'pending')`);
    const res = await app.request(
      `/api/${SLUG}/admin/customers/eu1`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(409);
  });

  // The three outcomes of DELETE /admin/customers/:id, pinned at the ROUTE so the mapping from
  // deleteCustomer's discriminated result to status codes cannot silently collapse. The 409 below
  // is the co-ownership refusal, which has no pre-check ahead of it — unlike the has-bookings 409
  // above, which the route's own countBookingsForUser catches first.
  it("refuses with 409 (not 404) when a pet the client owns is on someone else's booking", async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT INTO EndUsers (Id, TenantId, Email, Status) VALUES ('eu_own','${TENANT_A}','owner@example.com','active')`,
    );
    raw.exec(
      `INSERT INTO EndUsers (Id, TenantId, Email, Status) VALUES ('eu_bkr','${TENANT_A}','booker@example.com','active')`,
    );
    raw.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
              VALUES ('pet_own','${TENANT_A}','eu_own','Rex','dog')`);
    raw.exec(
      `INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES ('${TENANT_A}','pet_own','eu_own')`,
    );
    // The booking belongs to the OTHER client, so eu_own has none of their own and sails past the
    // route's countBookingsForUser pre-check.
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk_own','${TENANT_A}','eu_bkr','daycare','2030-05-01',1,'confirmed')`);
    raw.exec(
      `INSERT INTO BookingRequestPets (BookingRequestId, PetId) VALUES ('bk_own','pet_own')`,
    );

    const res = await app.request(
      `/api/${SLUG}/admin/customers/eu_own`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );

    expect(res.status).toBe(409);
    // The message must name the real cause — a 404 or a bare "cannot remove" sends the sitter
    // looking for a missing record instead of at the pet that is actually blocking them.
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/pet this client owns is on a booking/i);
    expect(error).not.toMatch(/not found/i);
    // And nothing was deleted.
    expect(raw.prepare('SELECT * FROM EndUsers WHERE Id = ?').get('eu_own')).toBeDefined();
    expect(raw.prepare('SELECT * FROM EndUserPets WHERE Id = ?').get('pet_own')).toBeDefined();
  });

  it('404s for a customer that does not exist in this tenant', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      `/api/${SLUG}/admin/customers/eu_nope`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'Not found.' });
  });

  it('removes a customer that has a pet and a prior login code, without a 500 (FK cascade)', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `INSERT INTO EndUsers (Id, TenantId, Email, Status) VALUES ('eu2','${TENANT_A}','pet-and-code@example.com','active')`,
    );
    raw.exec(`INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType)
              VALUES ('pet-eu2','${TENANT_A}','eu2','Buddy','dog')`);
    raw.exec(`INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt)
              VALUES ('lc-eu2','${TENANT_A}','eu2','111111','2030-01-01T00:00:00.000Z')`);

    const res = await app.request(
      `/api/${SLUG}/admin/customers/eu2`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(204);
    expect(raw.prepare('SELECT * FROM EndUsers WHERE Id = ?').get('eu2')).toBeUndefined();
    expect(raw.prepare('SELECT * FROM EndUserPets WHERE Id = ?').get('pet-eu2')).toBeUndefined();
    expect(raw.prepare('SELECT * FROM LoginCodes WHERE Id = ?').get('lc-eu2')).toBeUndefined();
  });

  it('requires admin auth', async () => {
    const { env } = createTestEnv();
    const res = await app.request(`/api/${SLUG}/admin/customers`, {}, env);
    expect(res.status).toBe(401);
  });

  it('never sends email on manual add — even for a fresh invited customer with email configured', async () => {
    const { env } = createTestEnv();
    (env as unknown as Record<string, unknown>).RESEND_API_KEY = 'test-key';
    (env as unknown as Record<string, unknown>).RESEND_FROM_NOREPLY =
      'Pawservation <no_reply@example.com>';
    (env as unknown as Record<string, unknown>).RESEND_FROM_BOOKING =
      'Pawservation <booking@example.com>';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
      const res = await app.request(
        `/api/${SLUG}/admin/customers`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            email: 'fresh@example.com',
            name: 'Fresh',
            petName: 'Rex',
            petType: 'dog',
          }),
        },
        env,
      );
      expect(res.status).toBe(201);
      expect(((await res.json()) as { status: string }).status).toBe('invited');
      // The welcome email is an explicit, separate action (POST …/customers/:id/welcome) —
      // creating a client must never email anyone.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  // The accounts UI (app/admin/sections/ClientsSection.tsx) derives billing accounts from THIS
  // payload with no extra endpoint, which is only sound because `pets` is a faithful owner<->pet
  // EDGE list: listAllEndUserPetsByTenant joins PetOwners, so a co-owned pet lands in BOTH owners'
  // buckets, and — unlike listEndUserPets/listOwnerPetLinks — it does NOT filter deceased pets, so
  // the card can show a dead pet the union-find never sees. Break either property and the Clients
  // tab silently mis-groups households; hence this test rather than a comment.
  it('lists a co-owned pet under BOTH owners, and keeps deceased pets in the payload', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };

    const create = async (email: string, name: string, petName: string) => {
      const res = await app.request(
        `/api/${SLUG}/admin/customers`,
        { method: 'POST', headers, body: JSON.stringify({ email, name, petName, petType: 'dog' }) },
        env,
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    type Row = {
      id: string;
      pets: { id: string; name: string; deceasedAt: string | null }[];
    };
    const read = async (): Promise<Row[]> => {
      const res = await app.request(
        `/api/${SLUG}/admin/customers`,
        { headers: await adminHeaders(TENANT_A) },
        env,
      );
      return ((await res.json()) as { customers: Row[] }).customers;
    };

    const tinaId = await create('tina@example.com', 'Tina', 'Fido');
    const robId = await create('rob@example.com', 'Rob', 'Rex');
    const fidoId = (await read()).find((c) => c.id === tinaId)!.pets[0]!.id;

    const link = await app.request(
      `/api/${SLUG}/admin/pets/${fidoId}/owners`,
      { method: 'POST', headers, body: JSON.stringify({ endUserId: robId }) },
      env,
    );
    expect(link.status).toBe(204);

    const linked = await read();
    expect(linked.find((c) => c.id === tinaId)!.pets.map((p) => p.name)).toEqual(['Fido']);
    expect(
      linked
        .find((c) => c.id === robId)!
        .pets.map((p) => p.name)
        .sort(),
    ).toEqual(['Fido', 'Rex']);

    const died = await app.request(
      `/api/${SLUG}/admin/pets/${fidoId}`,
      { method: 'PATCH', headers, body: JSON.stringify({ deceased: true }) },
      env,
    );
    expect(died.status).toBe(204);

    const after = await read();
    for (const ownerId of [tinaId, robId]) {
      const fido = after.find((c) => c.id === ownerId)!.pets.find((p) => p.id === fidoId);
      expect(fido?.deceasedAt).toBeTruthy();
    }
  });

  // The "no active pets" card exists because THIS is reachable: removing a customer's last pet is
  // allowed (only booking references refuse it), and the customer is still returned, pet-less.
  it('still lists a customer whose last pet was removed, with an empty pets array', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const add = await app.request(
      `/api/${SLUG}/admin/customers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: 'solo@example.com',
          name: 'Solo',
          petName: 'Only',
          petType: 'dog',
        }),
      },
      env,
    );
    const soloId = ((await add.json()) as { id: string }).id;
    type Row = { id: string; pets: { id: string }[] };
    const read = async (): Promise<Row[]> => {
      const res = await app.request(
        `/api/${SLUG}/admin/customers`,
        { headers: await adminHeaders(TENANT_A) },
        env,
      );
      return ((await res.json()) as { customers: Row[] }).customers;
    };
    const petId = (await read()).find((c) => c.id === soloId)!.pets[0]!.id;

    const del = await app.request(
      `/api/${SLUG}/admin/customers/${soloId}/pets/${petId}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(del.status).toBe(204);
    expect((await read()).find((c) => c.id === soloId)?.pets).toEqual([]);
  });
});
