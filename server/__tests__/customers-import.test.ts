import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClientImportPrompt } from '../../app/admin/importPrompt.js';
import { adminToken, createTestEnv, TENANT_A, TENANT_B } from './helpers';

type ImportResult = {
  importedCustomers: number;
  importedPets: number;
  invitesSent: number;
  invitesFailed: number;
  skippedRows: { row: number; reason: string }[];
};

/**
 * The fixtures in this file predate the phone column and are about everything EXCEPT the phone
 * rule, so `importCsv` gives every data row a phone: padded to the five older columns, then the
 * sixth. Blank lines stay blank — the importer skips them, and a padded one would become a row.
 * No fixture here quotes a cell, so a plain split is exact. The phone rule's own tests pass
 * `{ asIs: true }`.
 */
function withPhone(csv: string, phone = '(555) 555-0100'): string {
  const [header, ...rows] = csv.split('\n');
  const phoned = rows.map((r) => {
    if (r === '') return r;
    const cells = r.split(',');
    while (cells.length < 5) cells.push('');
    return [...cells, phone].join(',');
  });
  return [header, ...phoned].join('\n');
}

async function importCsv(
  env: Env,
  csv: string,
  sendInvites = false,
  opts?: { asIs?: boolean },
): Promise<{ status: number; body: ImportResult }> {
  const token = await adminToken(TENANT_A);
  const res = await app.request(
    '/api/sunny-paws/admin/customers/import',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: opts?.asIs ? csv : withPhone(csv), sendInvites }),
    },
    env,
  );
  return { status: res.status, body: (await res.json()) as ImportResult };
}

describe('POST /:slug/admin/customers/import', () => {
  afterEach(() => vi.restoreAllMocks());

  // One row per pet is the canonical CSV shape: the FIRST row for an email creates the client and
  // their first pet together, later rows for the same email just add pets.
  it('imports clients and pets from a well-formed CSV', async () => {
    const { env } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'new1@example.com,New One,Fido,dog\n' +
      'new1@example.com,New One,Whiskers,cat\n' +
      'new2@example.com,New Two,Rex,dog\n';
    const { status, body } = await importCsv(env, csv);
    expect(status).toBe(200);
    expect(body.importedCustomers).toBe(2);
    expect(body.importedPets).toBe(3);
    expect(body.skippedRows).toEqual([]);
  });

  // Name is required to CREATE a client — and only then. See the two tests below it for the rows
  // that must NOT have to restate a name.
  it('skips a row with no name for a client who does not exist yet', async () => {
    const { env, raw } = createTestEnv();
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\nnameless@example.com,,Rex,dog\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Missing name' }]);
    expect(body.importedCustomers).toBe(0);
    expect(
      raw.prepare('SELECT * FROM EndUsers WHERE Email = ?').get('nameless@example.com'),
    ).toBeUndefined();
  });

  // The primary use case: a pet-only row for a client who already exists. Their name is already on
  // file, so demanding it again here would stop pets importing altogether.
  it('imports a pet-only row (no name) for a client who already exists', async () => {
    const { env } = createTestEnv();
    // jess@example.com is seeded for sunny-paws with Bella + Mochi.
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\njess@example.com,,Comet,dog\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(0);
    expect(body.importedPets).toBe(1);
  });

  // …and the same thing for a client created part-way through the very same file: one row per pet,
  // with the sitter's name typed once on the first row.
  it('imports a one-row-per-pet file with the name only on the first row', async () => {
    const { env, raw } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'multi@example.com,Multi Pet,,\n' +
      'multi@example.com,,Bella,dog\n' +
      'multi@example.com,,Mochi,cat\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(1);
    expect(body.importedPets).toBe(2);
    // The create happened on row 3, which carried no name of its own — it took the one typed on
    // row 2, so the client is recorded properly named rather than nameless.
    const owner = raw
      .prepare('SELECT Id, Name FROM EndUsers WHERE Email = ?')
      .get('multi@example.com') as { Id: string; Name: string };
    expect(owner.Name).toBe('Multi Pet');
    const pets = raw
      .prepare('SELECT Name FROM EndUserPets WHERE EndUserId = ? ORDER BY Name')
      .all(owner.Id) as { Name: string }[];
    expect(pets.map((p) => p.Name)).toEqual(['Bella', 'Mochi']);
  });

  // "No owners without pets": a pet-less row can't stand up a new client any more.
  it('skips a pet-less row for a client who would end up with no pets', async () => {
    const { env, raw } = createTestEnv();
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\nsolo@example.com,Solo,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Every client needs at least one pet' }]);
    expect(body.importedCustomers).toBe(0);
    expect(
      raw.prepare('SELECT * FROM EndUsers WHERE Email = ?').get('solo@example.com'),
    ).toBeUndefined();
  });

  // …but a repeated pet-less row is legitimate once that client HAS a pet — whether the pet came
  // from an earlier row of this same file, or from the database.
  it('accepts a pet-less row for a client whose pet arrived on an earlier row', async () => {
    const { env } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'pair@example.com,Pair,Bella,dog\n' +
      'pair@example.com,Pair,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(1);
    expect(body.importedPets).toBe(1);
  });

  // The verdict on a pet-less row is DEFERRED to the end of the file: a later row may still supply
  // the pet, and complaining early would report a client as pet-less who ends up owning one.
  it('does not report a pet-less row that a later row rescues', async () => {
    const { env } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'later@example.com,Later,,\n' +
      'other@example.com,Other,Rex,dog\n' +
      'later@example.com,Later,Bella,dog\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(2);
    expect(body.importedPets).toBe(2);
  });

  // Skips are reported in FILE order even though the pet-less verdict is reached last.
  it('reports skipped rows in file order', async () => {
    const { env } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'petless@example.com,Pet Less,,\n' +
      'not-an-email,X,Rex,dog\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([
      { row: 2, reason: 'Every client needs at least one pet' },
      { row: 3, reason: 'Invalid email address' },
    ]);
  });

  it('accepts a pet-less row for a pre-existing client who already has pets', async () => {
    const { env } = createTestEnv();
    // jess@example.com is seeded for sunny-paws and already owns Bella + Mochi.
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\njess@example.com,Jess Demo,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(0);
    expect(body.importedPets).toBe(0);
  });

  // Deceased pets count for NOTHING on both creation paths — they neither block reusing a name nor
  // satisfy "this client already has a pet". POST /admin/customers reads listEndUserPets (live
  // only); the import filters DeceasedAt out of the map it dedups against, so the two agree.
  it("re-imports a deceased pet's name as a new live pet", async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE EndUserPets SET DeceasedAt = '2026-01-01T00:00:00.000Z' WHERE Id = 'pet_sp_bella'`,
    );
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\njess@example.com,Jess Demo,Bella,dog\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedPets).toBe(1);
    const live = raw
      .prepare(
        `SELECT COUNT(*) AS n FROM EndUserPets
         WHERE EndUserId = 'eu_sp_jess' AND Name = 'Bella' AND DeceasedAt IS NULL`,
      )
      .get() as { n: number };
    expect(live.n).toBe(1);
  });

  it('skips a pet-less row for a client whose only pets are deceased', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(
      `UPDATE EndUserPets SET DeceasedAt = '2026-01-01T00:00:00.000Z' WHERE EndUserId = 'eu_sp_jess'`,
    );
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\njess@example.com,Jess Demo,,\n';
    const { body } = await importCsv(env, csv);
    // A client with no BOOKABLE pet does not satisfy the "already has a pet" escape.
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Every client needs at least one pet' }]);
  });

  it('reports the row and reason for an invalid email', async () => {
    const { env } = createTestEnv();
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\nnot-an-email,X,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Invalid email address' }]);
    expect(body.importedCustomers).toBe(0);
  });

  // A bad pet type now takes the WHOLE row down: the client can no longer be created pet-less as
  // a consolation prize.
  it('skips a disabled/unknown pet type, creating no client either', async () => {
    const { env, raw } = createTestEnv();
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\nnew3@example.com,X,Ferret,ferret\n';
    const { body } = await importCsv(env, csv);
    expect(body.importedCustomers).toBe(0);
    expect(body.importedPets).toBe(0);
    expect(body.skippedRows).toEqual([{ row: 2, reason: "'ferret' is not one of your pet types" }]);
    expect(
      raw.prepare('SELECT * FROM EndUsers WHERE Email = ?').get('new3@example.com'),
    ).toBeUndefined();
  });

  it('imports a pet of a custom registry type (rabbit)', async () => {
    const { env } = createTestEnv();
    const token = await adminToken('tnt_sunnypaws');
    const res = await app.request(
      '/api/sunny-paws/admin/customers/import',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csv: 'email,name,pet name,pet type\nhopper@example.com,Hope,Thumper,rabbit,,(555) 555-0100',
        }),
      },
      env,
    );
    const body = (await res.json()) as { importedPets: number; skippedRows: unknown[] };
    expect(body.importedPets).toBe(1);
    expect(body.skippedRows).toEqual([]);
  });

  it('skips a pet name given without a type, and vice versa', async () => {
    const { env } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'new4@example.com,X,Rex,\n' +
      'new5@example.com,Y,,dog\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([
      { row: 2, reason: 'Pet name given without a pet type' },
      { row: 3, reason: 'Pet type given without a pet name' },
    ]);
    expect(body.importedCustomers).toBe(0); // a half-given pet leaves no client behind
  });

  it('dedups a pet appearing twice in the same file, and across a repeated import', async () => {
    const { env } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'dup@example.com,X,Bella,dog\n' +
      'dup@example.com,X,Bella,dog\n';
    const first = await importCsv(env, csv);
    expect(first.body.importedPets).toBe(1);
    expect(first.body.skippedRows).toEqual([
      { row: 3, reason: 'Pet already exists for this client' },
    ]);

    const second = await importCsv(env, csv);
    expect(second.body.importedCustomers).toBe(0); // client already existed
    expect(second.body.importedPets).toBe(0);
    expect(second.body.skippedRows).toHaveLength(2);
  });

  it('only sends invites for genuinely new customers, never for a pre-existing one', async () => {
    const { env } = createTestEnv();
    // jess@example.com is a seeded pre-existing customer for sunny-paws — must not be re-invited.
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'jess@example.com,Jess,,\n' +
      'brandnew@example.com,New,Rex,dog\n';
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const envWithEmail = {
      ...env,
      RESEND_API_KEY: 'k',
      RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
      RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
    } as Env;
    const { body } = await importCsv(envWithEmail, csv, true);
    expect(body.importedCustomers).toBe(1); // only brandnew@
    expect(body.invitesSent).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(spy.mock.calls[0][1]!.body as string);
    expect(sentBody.from).toBe(envWithEmail.RESEND_FROM_BOOKING); // invite mail, not no-reply
  });

  it('does not fail the request when an invite send fails; counts it instead', async () => {
    const { env } = createTestEnv();
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\nfailmail@example.com,X,Rex,dog\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const envWithEmail = {
      ...env,
      RESEND_API_KEY: 'k',
      RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
      RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
    } as Env;
    const { status, body } = await importCsv(envWithEmail, csv, true);
    expect(status).toBe(200);
    expect(body.importedCustomers).toBe(1);
    expect(body.invitesFailed).toBe(1);
    expect(body.invitesSent).toBe(0);
  });

  it('does not send invites when sendInvites is false, even with email configured', async () => {
    const { env } = createTestEnv();
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\nnoinvite@example.com,X,Rex,dog\n';
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const envWithEmail = {
      ...env,
      RESEND_API_KEY: 'k',
      RESEND_FROM_NOREPLY: 'Pawservation <no_reply@x.com>',
      RESEND_FROM_BOOKING: 'Pawservation <booking@x.com>',
    } as Env;
    const { body } = await importCsv(envWithEmail, csv, false);
    expect(body.invitesSent).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('treats an empty file (header only) as zero imports, not an error', async () => {
    const { env } = createTestEnv();
    const { status, body } = await importCsv(env, 'Client Email,Client Name,Pet Name,Pet Type\n');
    expect(status).toBe(200);
    expect(body.importedCustomers).toBe(0);
    expect(body.skippedRows).toEqual([]);
  });

  it('rejects a file over the row cap before touching the database', async () => {
    const { env, raw } = createTestEnv();
    const countEndUsers = () =>
      (raw.prepare('SELECT COUNT(*) AS n FROM EndUsers').get() as { n: number }).n;
    const before = countEndUsers();
    const header = 'Client Email,Client Name,Pet Name,Pet Type';
    const rows = Array.from({ length: 501 }, (_, n) => `over${n}@example.com,Over ${n},,`).join(
      '\n',
    );
    const token = await adminToken(TENANT_A);
    const res = await app.request(
      '/api/sunny-paws/admin/customers/import',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: `${header}\n${rows}`, sendInvites: false }),
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/501 rows/);
    expect(body.error).toMatch(/500 or fewer/);
    expect(countEndUsers()).toBe(before); // no rows should have been processed at all
  });

  it('preserves correct row numbers after a blank line in the file', async () => {
    const { env } = createTestEnv();
    // Blank line at position 2; without the fix this shifts the reported row number for the
    // invalid-email row below by one.
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\n\nnot-an-email,X,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([{ row: 3, reason: 'Invalid email address' }]);
  });

  it('turns a single row DB failure into a skip instead of a 500', async () => {
    vi.doMock('../db/repo', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../db/repo')>();
      return {
        ...actual,
        insertInvitedCustomerWithPet: vi.fn().mockRejectedValueOnce(new Error('boom')),
      };
    });
    vi.resetModules();
    const { default: freshApp } = await import('../index');
    const { env } = createTestEnv();
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\nboom@example.com,X,Rex,dog\n';
    const token = await adminToken(TENANT_A);
    const res = await freshApp.request(
      '/api/sunny-paws/admin/customers/import',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: withPhone(csv), sendInvites: false }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResult;
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Could not import this row' }]);
    vi.doUnmock('../db/repo');
    vi.resetModules();
  });

  // ── The phone column ──────────────────────────────────────────────────────────────────────────
  // Sixth, after the co-owner column, so every older file still reads its other columns where it
  // always did. Required to CREATE a client (like the name, a phone on any earlier row of the same
  // file counts); a pet row for a client who already exists needs none.
  const PHONE_HEADER = 'Client Email,Client Name,Pet Name,Pet Type,Co-owner Emails,Phone';

  it('skips a row that would create a client with no phone, says which, and writes nothing', async () => {
    const { env, raw } = createTestEnv();
    const csv = `${PHONE_HEADER}\nnophone@example.com,No Phone,Rex,dog,,\n`;
    const { body } = await importCsv(env, csv, false, { asIs: true });
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Missing phone' }]);
    expect(body.importedCustomers).toBe(0);
    expect(
      raw.prepare('SELECT * FROM EndUsers WHERE Email = ?').get('nophone@example.com'),
    ).toBeUndefined();
  });

  it('treats a whitespace-only phone as missing', async () => {
    const { env } = createTestEnv();
    const csv = `${PHONE_HEADER}\nblank@example.com,Blank,Rex,dog,,   \n`;
    const { body } = await importCsv(env, csv, false, { asIs: true });
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Missing phone' }]);
  });

  it('skips a row whose phone is not one, naming the rule', async () => {
    const { env } = createTestEnv();
    const csv = `${PHONE_HEADER}\nbad@example.com,Bad,Rex,dog,,n/a\n`;
    const { body } = await importCsv(env, csv, false, { asIs: true });
    expect(body.skippedRows).toHaveLength(1);
    expect(body.skippedRows[0]!.row).toBe(2);
    expect(body.skippedRows[0]!.reason).toMatch(/^Phone: .*7 digits/);
    expect(body.importedCustomers).toBe(0);
  });

  it('stores the phone trimmed, and takes it from an earlier row of the same file', async () => {
    const { env, raw } = createTestEnv();
    const csv =
      `${PHONE_HEADER}\n` +
      'multi@example.com,Multi Pet,,,, (555) 555-0123 \n' +
      'multi@example.com,,Bella,dog,,\n';
    const { body } = await importCsv(env, csv, false, { asIs: true });
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(1);
    expect(
      (
        raw.prepare('SELECT Phone FROM EndUsers WHERE Email = ?').get('multi@example.com') as {
          Phone: string;
        }
      ).Phone,
    ).toBe('(555) 555-0123');
  });

  it('needs no phone for a pet row of a client who already exists, and keeps theirs', async () => {
    const { env, raw } = createTestEnv();
    const csv = `${PHONE_HEADER}\njess@example.com,,Comet,dog,,\n`;
    const { body } = await importCsv(env, csv, false, { asIs: true });
    expect(body.skippedRows).toEqual([]);
    expect(body.importedPets).toBe(1);
    expect(
      (
        raw.prepare('SELECT Phone FROM EndUsers WHERE Id = ?').get('eu_sp_jess') as {
          Phone: string;
        }
      ).Phone,
    ).toBe('(555) 555-0142');
  });

  it('fills a blank phone on an existing client from the row, and never overwrites one on file', async () => {
    const { env, raw } = createTestEnv();
    const phoneOf = () =>
      (
        raw.prepare('SELECT Phone FROM EndUsers WHERE Id = ?').get('eu_sp_jess') as {
          Phone: string;
        }
      ).Phone;
    const csv = `${PHONE_HEADER}\njess@example.com,,Comet,dog,,(555) 555-0177\n`;
    // On file: kept.
    expect((await importCsv(env, csv, false, { asIs: true })).body.skippedRows).toEqual([]);
    expect(phoneOf()).toBe('(555) 555-0142');
    // Blank: filled with the typed, trimmed phone.
    raw.prepare(`UPDATE EndUsers SET Phone = '  ' WHERE Id = 'eu_sp_jess'`).run();
    const csv2 = `${PHONE_HEADER}\njess@example.com,,Dash,dog,, (555) 555-0188 \n`;
    expect((await importCsv(env, csv2, false, { asIs: true })).body.skippedRows).toEqual([]);
    expect(phoneOf()).toBe('(555) 555-0188');
  });

  it('reads an older four-column file the same way, refusing only the clients it would create', async () => {
    const { env } = createTestEnv();
    const csv =
      'Client Email,Client Name,Pet Name,Pet Type\n' +
      'jess@example.com,Jess Demo,Comet,dog\n' +
      'newold@example.com,New Old,Rex,dog\n';
    const { body } = await importCsv(env, csv, false, { asIs: true });
    expect(body.importedPets).toBe(1);
    expect(body.importedCustomers).toBe(0);
    expect(body.skippedRows).toEqual([{ row: 3, reason: 'Missing phone' }]);
  });

  // The two copies of the example file a sitter is handed — the one the dashboard links to and the
  // one in the docs — must be the same file, and it must import cleanly as it stands.
  it('ships an example file that imports with nothing skipped, phones included', async () => {
    const root = join(import.meta.dirname, '..', '..');
    const shipped = readFileSync(join(root, 'public', 'clients-import-example.csv'), 'utf8');
    expect(readFileSync(join(root, 'docs', 'examples', 'clients-import-example.csv'), 'utf8')).toBe(
      shipped,
    );
    expect(shipped.split('\n')[0]).toBe(PHONE_HEADER);
    const { env, raw } = createTestEnv();
    // happy-tails: jess is already a client there (the "existing client" rows), sam/tina/rob are not.
    const res = await app.request(
      '/api/happy-tails/admin/customers/import',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await adminToken(TENANT_B)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ csv: shipped, sendInvites: false }),
      },
      env,
    );
    const body = (await res.json()) as ImportResult;
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(3);
    const phones = raw
      .prepare('SELECT Email, Phone FROM EndUsers WHERE TenantId = ? AND Email != ? ORDER BY Email')
      .all(TENANT_B, 'jess@example.com') as { Email: string; Phone: string | null }[];
    expect(phones.every((r) => r.Phone !== null)).toBe(true);
  });

  it('tells the AI that reformats a client list to keep the phone, in the sixth column', () => {
    const prompt = buildClientImportPrompt([{ petType: 'dog', label: 'Dog' }]);
    expect(prompt).toContain(PHONE_HEADER);
    expect(prompt).toContain('exactly 6 columns');
    expect(prompt).not.toMatch(/don't need to keep \(phone numbers/);
    expect(prompt).toMatch(/Phone[^\n]*every client needs one/i);
  });
});
