import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { adminToken, createTestEnv, TENANT_A } from './helpers';

type ImportResult = {
  importedCustomers: number;
  importedPets: number;
  invitesSent: number;
  invitesFailed: number;
  skippedRows: { row: number; reason: string }[];
};

async function importCsv(
  env: Env,
  csv: string,
  sendInvites = false,
): Promise<{ status: number; body: ImportResult }> {
  const token = await adminToken(TENANT_A);
  const res = await app.request(
    '/api/sunny-paws/admin/customers/import',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv, sendInvites }),
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

  it('skips a row with no name', async () => {
    const { env, raw } = createTestEnv();
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\nnameless@example.com,,Rex,dog\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Missing name' }]);
    expect(body.importedCustomers).toBe(0);
    expect(
      raw.prepare('SELECT * FROM EndUsers WHERE Email = ?').get('nameless@example.com'),
    ).toBeUndefined();
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

  it('accepts a pet-less row for a pre-existing client who already has pets', async () => {
    const { env } = createTestEnv();
    // jess@example.com is seeded for sunny-paws and already owns Bella + Mochi.
    const csv = 'Client Email,Client Name,Pet Name,Pet Type\njess@example.com,Jess Demo,,\n';
    const { body } = await importCsv(env, csv);
    expect(body.skippedRows).toEqual([]);
    expect(body.importedCustomers).toBe(0);
    expect(body.importedPets).toBe(0);
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
          csv: 'email,name,pet name,pet type\nhopper@example.com,Hope,Thumper,rabbit',
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
        body: JSON.stringify({ csv, sendInvites: false }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResult;
    expect(body.skippedRows).toEqual([{ row: 2, reason: 'Could not import this row' }]);
    vi.doUnmock('../db/repo');
    vi.resetModules();
  });
});
