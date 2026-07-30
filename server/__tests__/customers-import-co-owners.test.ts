import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminToken, createTestEnv, TENANT_A } from './helpers';
import type { DatabaseSync } from 'node:sqlite';

/**
 * CSV import, co-ownership half (task 25c). Before this, a file could not express "one pet, two
 * people" at all: the importer read four columns, resolved exactly ONE owner per row and wrote
 * exactly one PetOwners edge, so the only shape a sitter could reach for — the same pet name on two
 * rows with two emails — produced two distinct pets in two separate billing accounts.
 *
 * The fix is a fifth column, not a name-matching heuristic: two clients may each genuinely own a dog
 * called Bella, so merging by name would fuse unrelated households. See the first test, which pins
 * that shape as deliberately unmerged.
 */

type ImportResult = {
  importedCustomers: number;
  importedPets: number;
  coOwnerLinks: number;
  invitesSent: number;
  invitesFailed: number;
  skippedRows: { row: number; reason: string }[];
};

const HEADER = 'Client Email,Client Name,Pet Name,Pet Type,Co-owner Emails';

async function importCsv(
  env: Env,
  csv: string,
  opts?: { slug?: string; tenantId?: string },
): Promise<{ status: number; body: ImportResult }> {
  const token = await adminToken(opts?.tenantId ?? TENANT_A);
  const res = await app.request(
    `/api/${opts?.slug ?? 'sunny-paws'}/admin/customers/import`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv, sendInvites: false }),
    },
    env,
  );
  return { status: res.status, body: (await res.json()) as ImportResult };
}

/** Every owner email of every pet with this name, in this tenant. */
function ownersOfPet(raw: DatabaseSync, name: string): { pet: string; email: string }[] {
  return raw
    .prepare(
      `SELECT p.Id AS pet, u.Email AS email
         FROM EndUserPets p
         JOIN PetOwners po ON po.PetId = p.Id AND po.TenantId = p.TenantId
         JOIN EndUsers u ON u.Id = po.EndUserId
        WHERE p.TenantId = ? AND p.Name = ?
        ORDER BY p.Id, u.Email`,
    )
    .all(TENANT_A, name) as { pet: string; email: string }[];
}

describe('CSV import: co-ownership', () => {
  // The shape the fifth column exists to REPLACE, pinned as-is. Two people writing the same pet name
  // on two rows are two people with two same-named pets — the importer must not guess otherwise, or a
  // sitter with two clients who both own a "Bella" would find their billing merged.
  it('does NOT merge two rows that merely share a pet name', async () => {
    const { env, raw } = createTestEnv();
    const csv =
      `${HEADER}\n` +
      'tina@example.com,Tina Alvarez,Luna,dog,\n' +
      'rob@example.com,Rob Alvarez,Luna,dog,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(2);
    expect(body.importedPets).toBe(2);
    const rows = ownersOfPet(raw, 'Luna');
    expect(new Set(rows.map((r) => r.pet)).size).toBe(2); // two distinct pets, one owner each
    expect(rows).toHaveLength(2);
  });

  // The replacement shape: ONE row for the pet, the other owner's email in the fifth column, and the
  // co-owner's own row supplying their name. Their row is legitimately pet-less — the pet is Tina's
  // row's — and must not be reported as a skip.
  it('creates ONE pet with TWO owners, and does not report the co-owner row as pet-less', async () => {
    const { env, raw } = createTestEnv();
    const csv =
      `${HEADER}\n` +
      'tina@example.com,Tina Alvarez,Luna,dog,rob@example.com\n' +
      'rob@example.com,Rob Alvarez,,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedPets).toBe(1);
    expect(body.importedCustomers).toBe(2); // Tina from her row, Rob from the co-owner pass
    expect(body.coOwnerLinks).toBe(1);
    const rows = ownersOfPet(raw, 'Luna');
    expect(new Set(rows.map((r) => r.pet)).size).toBe(1);
    expect(rows.map((r) => r.email)).toEqual(['rob@example.com', 'tina@example.com']);
    // Rob is a properly named client, created with his ownership edge — never pet-less.
    const rob = raw
      .prepare('SELECT Name, Status FROM EndUsers WHERE TenantId = ? AND Email = ?')
      .get(TENANT_A, 'rob@example.com') as { Name: string; Status: string };
    expect(rob.Name).toBe('Rob Alvarez');
    expect(rob.Status).toBe('invited');
  });

  // Ordering: the co-owner reference is resolved in a DEFERRED pass, so it may name a client the file
  // creates on a LATER row — here the pet's own row comes second.
  it('resolves a co-owner named before their own row appears', async () => {
    const { env, raw } = createTestEnv();
    const csv =
      `${HEADER}\n` +
      'rob@example.com,Rob Alvarez,,,\n' +
      'tina@example.com,Tina Alvarez,Luna,dog,rob@example.com\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(ownersOfPet(raw, 'Luna').map((r) => r.email)).toEqual([
      'rob@example.com',
      'tina@example.com',
    ]);
  });

  // A co-owner who is already a client keeps everything they have and simply gains the pet — the
  // account-merge case, and the tenant-scoped one: jess@example.com exists in BOTH seeded tenants.
  it('links a pre-existing client as co-owner, in this tenant only', async () => {
    const { env, raw } = createTestEnv();
    const csv = `${HEADER}\ntina@example.com,Tina Alvarez,Luna,dog,jess@example.com\n`;
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(1); // jess already existed
    expect(body.coOwnerLinks).toBe(1);
    const edge = raw
      .prepare(
        `SELECT po.TenantId AS t, po.EndUserId AS u FROM PetOwners po
           JOIN EndUserPets p ON p.Id = po.PetId
          WHERE po.TenantId = ? AND p.Name = 'Luna' AND po.EndUserId LIKE 'eu_%'`,
      )
      .all(TENANT_A) as { t: string; u: string }[];
    expect(edge).toEqual([{ t: TENANT_A, u: 'eu_sp_jess' }]); // never eu_ht_jess
  });

  it('accepts several co-owners, semicolon-separated', async () => {
    const { env, raw } = createTestEnv();
    const csv =
      `${HEADER}\n` +
      'tina@example.com,Tina Alvarez,Luna,dog,rob@example.com;kid@example.com\n' +
      'rob@example.com,Rob Alvarez,,,\n' +
      'kid@example.com,Kid Alvarez,,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.coOwnerLinks).toBe(2);
    expect(ownersOfPet(raw, 'Luna').map((r) => r.email)).toEqual([
      'kid@example.com',
      'rob@example.com',
      'tina@example.com',
    ]);
  });

  // A co-owner with no row of their own and no client record cannot be created — there is no name to
  // create them with — but the PET is still perfectly importable, so the row is not thrown away.
  it('imports the pet and reports a co-owner it cannot create', async () => {
    const { env, raw } = createTestEnv();
    const csv = `${HEADER}\ntina@example.com,Tina Alvarez,Luna,dog,ghost@example.com\n`;
    const { body } = await importCsv(env, csv);
    expect(body.importedPets).toBe(1);
    expect(body.coOwnerLinks).toBe(0);
    expect(body.skippedRows).toHaveLength(1);
    expect(body.skippedRows[0]!.row).toBe(2);
    expect(body.skippedRows[0]!.reason).toMatch(/ghost@example\.com/);
    expect(
      raw.prepare('SELECT Id FROM EndUsers WHERE Email = ?').get('ghost@example.com'),
    ).toBeUndefined();
    expect(ownersOfPet(raw, 'Luna').map((r) => r.email)).toEqual(['tina@example.com']);
  });

  it('reports an invalid co-owner email without losing the pet', async () => {
    const { env, raw } = createTestEnv();
    const csv = `${HEADER}\ntina@example.com,Tina Alvarez,Luna,dog,not-an-email\n`;
    const { body } = await importCsv(env, csv);
    expect(body.importedPets).toBe(1);
    expect(body.skippedRows).toHaveLength(1);
    expect(body.skippedRows[0]).toEqual({
      row: 2,
      reason: "'not-an-email' is not a valid co-owner email",
    });
    expect(ownersOfPet(raw, 'Luna')).toHaveLength(1);
  });

  it('ignores a row that names its own client as co-owner', async () => {
    const { env, raw } = createTestEnv();
    const csv = `${HEADER}\ntina@example.com,Tina Alvarez,Luna,dog,tina@example.com\n`;
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.coOwnerLinks).toBe(0);
    expect(ownersOfPet(raw, 'Luna')).toHaveLength(1);
  });

  it('refuses the reserved demo identity as a co-owner', async () => {
    const { env } = createTestEnv();
    const csv = `${HEADER}\ntina@example.com,Tina Alvarez,Luna,dog,demo@pawservation.com\n`;
    const { body } = await importCsv(env, csv);
    expect(body.importedPets).toBe(1);
    expect(body.skippedRows).toHaveLength(1);
    expect(body.skippedRows[0]!.reason).toMatch(/reserved/i);
  });

  // Re-uploading the same file must converge, not duplicate: the pet is already there (reported as
  // such, unchanged from before) and the ownership edges already exist.
  it('is idempotent across a repeated import', async () => {
    const { env, raw } = createTestEnv();
    const csv =
      `${HEADER}\n` +
      'tina@example.com,Tina Alvarez,Luna,dog,rob@example.com\n' +
      'rob@example.com,Rob Alvarez,,,\n';
    await importCsv(env, csv);
    const second = await importCsv(env, csv);
    expect(second.body.importedCustomers).toBe(0);
    expect(second.body.importedPets).toBe(0);
    expect(ownersOfPet(raw, 'Luna').map((r) => r.email)).toEqual([
      'rob@example.com',
      'tina@example.com',
    ]);
    expect(
      raw
        .prepare(`SELECT COUNT(*) AS n FROM EndUserPets WHERE TenantId = ? AND Name = 'Luna'`)
        .get(TENANT_A),
    ).toEqual({ n: 1 });
  });

  // A file whose first run half-succeeded (pet imported, sharing not) converges on the second run:
  // an already-existing pet still gets its co-owner links applied.
  it('applies co-owner links on a row whose pet already exists', async () => {
    const { env, raw } = createTestEnv();
    // jess@example.com is seeded for sunny-paws owning Bella; rob is brand new.
    const csv =
      `${HEADER}\n` +
      'jess@example.com,Jess Demo,Bella,dog,rob@example.com\n' +
      'rob@example.com,Rob Alvarez,,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.importedPets).toBe(0);
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Pet already exists for this client' }]);
    expect(body.coOwnerLinks).toBe(1);
    expect(ownersOfPet(raw, 'Bella').map((r) => r.email)).toEqual([
      'jess@example.com',
      'rob@example.com',
    ]);
  });

  // Old files keep working: four columns, and five with the new cell left blank, behave identically.
  it('imports an old four-column file unchanged', async () => {
    const { env, raw } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'tina@example.com,Tina Alvarez,Luna,dog\n' +
      'tina@example.com,,Milo,cat\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(1);
    expect(body.importedPets).toBe(2);
    expect(body.coOwnerLinks).toBe(0);
    expect(ownersOfPet(raw, 'Luna').map((r) => r.email)).toEqual(['tina@example.com']);
  });

  it('caps how many co-owners one row may name', async () => {
    const { env, raw } = createTestEnv();
    const many = Array.from({ length: 6 }, (_, n) => `co${n}@example.com`).join(';');
    const csv = `${HEADER}\ntina@example.com,Tina Alvarez,Luna,dog,${many}\n`;
    const { body } = await importCsv(env, csv);
    expect(body.importedPets).toBe(1); // the pet is fine
    expect(body.coOwnerLinks).toBe(0); // …and none of the six were linked
    expect(body.skippedRows).toHaveLength(1);
    expect(body.skippedRows[0]!.reason).toMatch(/co-owner/i);
    expect(ownersOfPet(raw, 'Luna')).toHaveLength(1);
  });

  // A pet-less row's own co-owner cell has no pet to attach anyone to; it is simply inert.
  it('ignores a co-owner cell on a pet-less row', async () => {
    const { env } = createTestEnv();
    const csv =
      `${HEADER}\n` +
      'tina@example.com,Tina Alvarez,Luna,dog,\n' +
      'tina@example.com,,,,rob@example.com\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.coOwnerLinks).toBe(0);
  });

  // Deceased pets count for nothing on BOTH paths (CLAUDE.md): a co-owner-only human whose shared
  // pet has since died is pet-less again, and the deferred verdict says so.
  it('does not let a deceased pet satisfy the co-owner path', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE EndUserPets SET DeceasedAt = '2026-01-01T00:00:00.000Z' WHERE Id = 'pet_sp_bella'`,
    );
    // The row re-uses the deceased name, which is allowed and creates a NEW live Bella — the live
    // pet is what Rob is linked to.
    const csv =
      `${HEADER}\n` +
      'jess@example.com,Jess Demo,Bella,dog,rob@example.com\n' +
      'rob@example.com,Rob Alvarez,,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedPets).toBe(1);
    const live = raw
      .prepare(
        `SELECT p.Id AS pet FROM EndUserPets p
           JOIN PetOwners po ON po.PetId = p.Id
           JOIN EndUsers u ON u.Id = po.EndUserId
          WHERE p.TenantId = ? AND p.Name = 'Bella' AND p.DeceasedAt IS NULL
            AND u.Email = 'rob@example.com'`,
      )
      .all(TENANT_A) as { pet: string }[];
    expect(live).toHaveLength(1);
    expect(live[0]!.pet).not.toBe('pet_sp_bella');
  });
});
