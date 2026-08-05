import { describe, expect, it, vi } from 'vitest';
import app from '../index';
import { adminToken, createTestEnv, TENANT_A, TENANT_B } from './helpers';
import { buildAccounts } from '../../src/shared/index.js';
import { insertInvitedCustomerAsCoOwner, listOwnerPetLinks } from '../db/repo';

/**
 * A second HUMAN on an existing account (task 25a). The many-to-many model already exists — PetOwners
 * is the edge table and union-find over it forms the billing account — so the only gap this route
 * closes is CREATING a person who brings no new pet of their own, without ever committing them
 * pet-less. The whole point is the ONE batch: a bad pet id must leave no client standing.
 */

type CoOwnerBody = {
  email: string;
  name: string;
  phone?: string;
  petIds: string[];
};

async function addCoOwner(
  env: Env,
  body: Partial<CoOwnerBody>,
  opts?: { slug?: string; tenantId?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const token = await adminToken(opts?.tenantId ?? TENANT_A);
  const res = await app.request(
    `/api/${opts?.slug ?? 'sunny-paws'}/admin/customers/co-owner`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const ownerRows = (raw: ReturnType<typeof createTestEnv>['raw'], email: string) =>
  raw
    .prepare(
      `SELECT po.PetId AS PetId FROM PetOwners po
        JOIN EndUsers u ON u.Id = po.EndUserId
       WHERE u.Email = ? ORDER BY po.PetId`,
    )
    .all(email) as { PetId: string }[];

describe('POST /:slug/admin/customers/co-owner', () => {
  it('creates the person and links them to every pet of the account in one write', async () => {
    const { env, raw } = createTestEnv();
    const { status, body } = await addCoOwner(env, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      phone: '(555) 555-0101',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(status).toBe(201);
    expect(body.created).toBe(true);
    const row = raw
      .prepare('SELECT Id, Name, Phone, Status FROM EndUsers WHERE TenantId = ? AND Email = ?')
      .get(TENANT_A, 'rob@example.com') as { Name: string; Phone: string; Status: string };
    expect(row.Name).toBe('Rob Alvarez');
    expect(row.Phone).toBe('(555) 555-0101');
    expect(row.Status).toBe('invited');
    expect(ownerRows(raw, 'rob@example.com').map((r) => r.PetId)).toEqual([
      'pet_sp_bella',
      'pet_sp_mochi',
    ]);
  });

  // The consequence that matters: they share ONE billing account with the client they joined.
  it('puts the new person on the SAME billing account as the pets they now share', async () => {
    const { env } = createTestEnv();
    await addCoOwner(env, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    const links = await listOwnerPetLinks(env.PAWSERVATION_DB, TENANT_A);
    const accounts = buildAccounts(links.map((l) => ({ ownerId: l.EndUserId, petId: l.PetId })));
    const account = accounts.find((a) => a.petIds.includes('pet_sp_bella'))!;
    expect(account.ownerIds).toHaveLength(2);
    expect(account.petIds).toEqual(['pet_sp_bella', 'pet_sp_mochi']);
  });

  // "No owners without pets" is what the single batch buys: a pet id that isn't linkable must leave
  // NO client behind, not a pet-less one to be cleaned up by hand.
  it('creates no client at all when one pet id in the list is unknown', async () => {
    const { env, raw } = createTestEnv();
    const { status } = await addCoOwner(env, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      petIds: ['pet_sp_bella', 'pet_nope'],
    });
    expect(status).toBe(404);
    expect(
      raw.prepare('SELECT Id FROM EndUsers WHERE Email = ?').get('rob@example.com'),
    ).toBeUndefined();
    expect(ownerRows(raw, 'rob@example.com')).toEqual([]);
  });

  // PetOwners' FKs carry no TenantId, so nothing but an explicit check stops a cross-tenant edge.
  it("refuses another tenant's pet and writes nothing", async () => {
    const { env, raw } = createTestEnv();
    const { status } = await addCoOwner(env, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      petIds: ['pet_ht_otis'], // tnt_happytails
    });
    expect(status).toBe(404);
    expect(
      raw.prepare('SELECT Id FROM EndUsers WHERE Email = ?').get('rob@example.com'),
    ).toBeUndefined();
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM PetOwners WHERE PetId = ?').get('pet_ht_otis'),
    ).toEqual({ n: 1 });
    // …and the mirror direction: tenant B cannot reach tenant A's pet either.
    const other = await addCoOwner(
      env,
      { email: 'rob@example.com', name: 'Rob', petIds: ['pet_sp_bella'] },
      { slug: 'happy-tails', tenantId: TENANT_B },
    );
    expect(other.status).toBe(404);
  });

  // The merge case: the email already belongs to a client who has pets of their own, so the two
  // accounts become one. Their stored name/phone is kept (the manual-add route's rule).
  it('links an EXISTING client instead of creating one, and merges the two accounts', async () => {
    const { env, raw } = createTestEnv();
    const token = await adminToken(TENANT_A);
    const created = await app.request(
      '/api/sunny-paws/admin/customers',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'sam@example.com',
          name: 'Sam Diaz',
          phone: '(555) 555-0199',
          petName: 'Rex',
          petType: 'dog',
        }),
      },
      env,
    );
    expect(created.status).toBe(201);

    const { status, body } = await addCoOwner(env, {
      email: 'sam@example.com',
      name: 'Ignored Name',
      petIds: ['pet_sp_bella'],
    });
    expect(status).toBe(201);
    expect(body.created).toBe(false);
    const row = raw
      .prepare('SELECT Name, Phone FROM EndUsers WHERE TenantId = ? AND Email = ?')
      .get(TENANT_A, 'sam@example.com') as { Name: string; Phone: string };
    expect(row.Name).toBe('Sam Diaz'); // never overwritten by the co-owner form
    expect(row.Phone).toBe('(555) 555-0199');

    const links = await listOwnerPetLinks(env.PAWSERVATION_DB, TENANT_A);
    const accounts = buildAccounts(links.map((l) => ({ ownerId: l.EndUserId, petId: l.PetId })));
    const merged = accounts.find((a) => a.petIds.includes('pet_sp_bella'))!;
    expect(merged.ownerIds).toHaveLength(2);
    expect(merged.petIds).toHaveLength(3); // Bella, Mochi and Rex now bill together
  });

  it('is idempotent for an owner who is already linked', async () => {
    const { env, raw } = createTestEnv();
    const first = await addCoOwner(env, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      petIds: ['pet_sp_bella'],
    });
    expect(first.status).toBe(201);
    const second = await addCoOwner(env, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      petIds: ['pet_sp_bella', 'pet_sp_mochi'],
    });
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(false);
    expect(ownerRows(raw, 'rob@example.com').map((r) => r.PetId)).toEqual([
      'pet_sp_bella',
      'pet_sp_mochi',
    ]);
  });

  // A pet that has passed away is not a pet for the "no owners without pets" rule — the manual and
  // import paths both count LIVE pets only, and so does this one.
  it('refuses a deceased pet, creating no client', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE EndUserPets SET DeceasedAt = '2026-01-01T00:00:00.000Z' WHERE Id = 'pet_sp_bella'`,
    );
    const { status, body } = await addCoOwner(env, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      petIds: ['pet_sp_bella'],
    });
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/passed away/i);
    expect(
      raw.prepare('SELECT Id FROM EndUsers WHERE Email = ?').get('rob@example.com'),
    ).toBeUndefined();
  });

  it('refuses an empty pet list — there is no pet-less client', async () => {
    const { env, raw } = createTestEnv();
    const { status } = await addCoOwner(env, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      petIds: [],
    });
    expect(status).toBe(400);
    expect(
      raw.prepare('SELECT Id FROM EndUsers WHERE Email = ?').get('rob@example.com'),
    ).toBeUndefined();
  });

  it('validates the email, the name and the reserved demo identity', async () => {
    const { env } = createTestEnv();
    expect(
      (await addCoOwner(env, { email: 'nope', name: 'X', petIds: ['pet_sp_bella'] })).status,
    ).toBe(400);
    expect(
      (await addCoOwner(env, { email: 'rob@example.com', name: '', petIds: ['pet_sp_bella'] }))
        .status,
    ).toBe(400);
    expect(
      (
        await addCoOwner(env, {
          email: 'demo@pawservation.com',
          name: 'Demo',
          petIds: ['pet_sp_bella'],
        })
      ).status,
    ).toBe(400);
  });

  // Manual add sends no email, ever — the welcome mail is the explicit
  // POST /:slug/admin/customers/:id/welcome. Adding a person is data entry, not an introduction.
  it('sends no email', async () => {
    const { env } = createTestEnv();
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const envWithEmail = {
      ...env,
      RESEND_API_KEY: 'k',
      RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
      RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
    } as Env;
    const { status } = await addCoOwner(envWithEmail, {
      email: 'rob@example.com',
      name: 'Rob Alvarez',
      petIds: ['pet_sp_bella'],
    });
    expect(status).toBe(201);
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // The route's pre-read only picks the WORDING. What actually makes "never pet-less" true is the
  // guard inside the batch, so it is tested where a future call site would hit it: at the repo.
  it('aborts the whole batch in SQL, not just at the route, for an unlinkable pet', async () => {
    const { env, raw } = createTestEnv();
    await expect(
      insertInvitedCustomerAsCoOwner(
        env.PAWSERVATION_DB,
        TENANT_A,
        'rob@example.com',
        'Rob Alvarez',
        null,
        ['pet_sp_bella', 'pet_ht_otis'], // second one belongs to tnt_happytails
      ),
    ).rejects.toThrow();
    expect(
      raw.prepare('SELECT Id FROM EndUsers WHERE Email = ?').get('rob@example.com'),
    ).toBeUndefined();
    expect(ownerRows(raw, 'rob@example.com')).toEqual([]);
  });

  it('refuses a zero-pet call at the repo too', async () => {
    const { env } = createTestEnv();
    await expect(
      insertInvitedCustomerAsCoOwner(
        env.PAWSERVATION_DB,
        TENANT_A,
        'rob@example.com',
        'Rob',
        null,
        [],
      ),
    ).rejects.toThrow(/at least one pet/);
  });

  it('requires an admin session', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/customers/co-owner',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'rob@example.com', name: 'Rob', petIds: ['pet_sp_bella'] }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});
