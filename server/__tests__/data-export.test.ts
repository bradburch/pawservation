import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  insertAccountPayment,
  insertBookingRequest,
  insertPayment,
  setPetDeceased,
  updateBookingStatus,
} from '../db/repo';
import { parseCsvRows, serializeCsvRows } from '../lib/csv';
import { adminHeaders, createTestEnv, TENANT_A, TENANT_B } from './helpers';

/**
 * A sitter may take her book with her. These tests pin the three things that would make the export
 * worse than useless: it must never carry another tenant's rows, it must not quietly drop the rows
 * she would most notice missing (a pet who died, a booking that was cancelled), and it must not
 * hand a spreadsheet a formula that a client typed into a name or a note.
 */

const DATASETS = ['clients', 'pets', 'bookings', 'payments'] as const;

const get = async (env: Env, dataset: string, tenantId = TENANT_A, slug = 'sunny-paws') =>
  app.request(
    `/api/${slug}/admin/export/${dataset}`,
    { headers: await adminHeaders(tenantId) },
    env,
  );

/**
 * The CSV body, parsed back with this codebase's own parser — the round trip that matters.
 *
 * No BOM handling needed: the route prepends one (see its own test below), but `Response.text()`
 * runs a UTF-8 decode, which strips a leading BOM by specification. Reading the bytes is the only
 * way to see it, which is exactly what that test does.
 */
const rowsOf = async (res: Response): Promise<string[][]> => parseCsvRows(await res.text());

/** Every cell of every data row, flattened — enough to ask "does this file mention X at all". */
const cellsOf = (rows: string[][]): string[] => rows.slice(1).flat();

describe('CSV serializer', () => {
  it('round-trips a field holding a comma, a double quote and a newline', () => {
    const value = 'Smith, "Bob"\nsecond line';
    const csv = serializeCsvRows([['Name'], [value]]);
    expect(parseCsvRows(csv)).toEqual([['Name'], [value]]);
  });

  it('uses CRLF between rows and quotes only what needs it', () => {
    expect(serializeCsvRows([['a', 'b'], ['plain']])).toBe('a,b\r\nplain');
  });

  it('neutralises every formula lead character, and no number', () => {
    // Space and LF belong here for the same reason tab and CR do: an importer that trims leading
    // whitespace before judging the first character hands ` =1+1` and `\n=1+1` to its formula
    // parser as `=1+1`. Review found both of them getting through — the space one un-neutralised
    // AND unquoted, which is the worst version.
    for (const lead of ['=', '+', '-', '@', '\t', '\r', ' ', '\n']) {
      const [[cell]] = parseCsvRows(serializeCsvRows([[`${lead}SUM(A1)`]]));
      expect(cell).toBe(`'${lead}SUM(A1)`);
    }
    // The apostrophe must be the FIRST byte the importer sees, which is what the quoting is for.
    expect(serializeCsvRows([[' =1+1']])).toBe(`"' =1+1"`);
    expect(serializeCsvRows([['\n=1+1']])).toBe(`"'\n=1+1"`);
    // A negative amount is a number, not a formula: neutralising it would corrupt real money.
    expect(serializeCsvRows([[-45]])).toBe('-45');
  });

  it('writes null and undefined as empty cells', () => {
    expect(serializeCsvRows([[null, undefined, '']])).toBe(',,');
  });
});

describe('admin data export route', () => {
  it('refuses an unauthenticated request', async () => {
    const { env } = createTestEnv();
    for (const dataset of DATASETS) {
      const res = await app.request(`/api/sunny-paws/admin/export/${dataset}`, {}, env);
      expect(res.status).toBe(401);
    }
  });

  it('404s an unknown dataset', async () => {
    const { env } = createTestEnv();
    const res = await get(env, 'invoices');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found.' });
  });

  it('serves CSV as a dated attachment named for the tenant and dataset', async () => {
    const { env } = createTestEnv();
    for (const dataset of DATASETS) {
      const res = await get(env, dataset);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
      expect(res.headers.get('Content-Disposition')).toMatch(
        new RegExp(
          `^attachment; filename="pawservation-sunny-paws-${dataset}-\\d{4}-\\d{2}-\\d{2}\\.csv"$`,
        ),
      );
    }
  });

  it('exports only this tenant, never the other one', async () => {
    const { env } = createTestEnv();
    await insertPayment(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: 'seed_sp_board1',
      amount: 100,
      method: 'venmo',
      paidDate: '2028-06-19',
      note: 'Sunny Paws deposit',
      externalRef: null,
    });
    await insertPayment(env.PAWSERVATION_DB, TENANT_B, {
      bookingRequestId: 'seed_ht_board1',
      amount: 200,
      method: 'cash',
      paidDate: '2028-06-19',
      note: 'Happy Tails deposit',
      externalRef: null,
    });

    // Sunny Paws' own rows, and NONE of Happy Tails': the fixture gives each tenant its own pet,
    // its own booking ids and its own payment note, so a leak in either direction is nameable.
    const sunnyMarkers = ['Bella', 'seed_sp_board1', 'Sunny Paws deposit'];
    const happyMarkers = ['Otis', 'seed_ht_board1', 'Happy Tails deposit'];
    const sunny = new Set<string>();
    const happy = new Set<string>();
    for (const dataset of DATASETS) {
      const a = cellsOf(await rowsOf(await get(env, dataset)));
      const b = cellsOf(await rowsOf(await get(env, dataset, TENANT_B, 'happy-tails')));
      for (const cell of a) {
        if (happyMarkers.some((m) => cell.includes(m)))
          throw new Error(`${dataset}: Sunny Paws' export leaked "${cell}"`);
        sunny.add(cell);
      }
      for (const cell of b) {
        if (sunnyMarkers.some((m) => cell.includes(m)))
          throw new Error(`${dataset}: Happy Tails' export leaked "${cell}"`);
        happy.add(cell);
      }
    }
    // …and each export really did contain its own rows, so the assertions above weren't vacuous.
    for (const marker of sunnyMarkers)
      expect([...sunny].some((cell) => cell.includes(marker))).toBe(true);
    for (const marker of happyMarkers)
      expect([...happy].some((cell) => cell.includes(marker))).toBe(true);
  });

  it('includes deceased pets and cancelled bookings, with their status in a column', async () => {
    const { env } = createTestEnv();
    await setPetDeceased(env.PAWSERVATION_DB, TENANT_A, 'pet_sp_mochi', true);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, 'seed_sp_board1', 'cancelled', 75);
    await updateBookingStatus(env.PAWSERVATION_DB, TENANT_A, 'seed_sp_pend1', 'declined');

    const petRows = await rowsOf(await get(env, 'pets'));
    const deceasedIndex = petRows[0].indexOf('Deceased');
    const mochi = petRows.find((r) => r[0] === 'Mochi');
    expect(mochi).toBeDefined();
    expect(mochi![deceasedIndex]).not.toBe('');
    // The deceased pet's owner still lists her among their pets — it is the sitter's record.
    const clientRows = await rowsOf(await get(env, 'clients'));
    const petsIndex = clientRows[0].indexOf('Pets');
    expect(clientRows.find((r) => r[1] === 'jess@example.com')![petsIndex]).toContain('Mochi');

    const bookingRows = await rowsOf(await get(env, 'bookings'));
    const statusIndex = bookingRows[0].indexOf('Status');
    const feeIndex = bookingRows[0].indexOf('Cancellation fee');
    const byId = new Map(bookingRows.slice(1).map((r) => [r[0], r]));
    expect(byId.get('seed_sp_board1')![statusIndex]).toBe('cancelled');
    expect(byId.get('seed_sp_board1')![feeIndex]).toBe('75');
    expect(byId.get('seed_sp_pend1')![statusIndex]).toBe('declined');
  });

  it('names what a payment settles — a booking or a household', async () => {
    const { env } = createTestEnv();
    await insertPayment(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: 'seed_sp_board1',
      amount: 100,
      method: 'venmo',
      paidDate: '2028-06-19',
      note: null,
      externalRef: null,
    });
    // Bella sorts before Mochi, so she is this household's account id.
    const accountPaymentId = await insertAccountPayment(env.PAWSERVATION_DB, TENANT_A, {
      accountId: 'pet_sp_bella',
      amount: 60,
      method: 'cash',
      paidDate: '2028-07-01',
      note: 'monthly',
      externalRef: null,
    });
    expect(accountPaymentId).not.toBeNull();

    const rows = await rowsOf(await get(env, 'payments'));
    const idx = (name: string) => rows[0].indexOf(name);
    const settles = rows.slice(1).map((r) => r[idx('Settles')]);
    expect(settles.sort()).toEqual(['booking', 'household']);
    const household = rows.slice(1).find((r) => r[idx('Settles')] === 'household')!;
    expect(household[idx('Household')]).toBe('Bella');
    expect(household[idx('Booking ID')]).toBe('');
    const booking = rows.slice(1).find((r) => r[idx('Settles')] === 'booking')!;
    expect(booking[idx('Booking ID')]).toBe('seed_sp_board1');
    expect(booking[idx('Client email')]).toBe('jess@example.com');
  });

  it('neutralises a client name and a care note that a spreadsheet would run as a formula', async () => {
    const { env } = createTestEnv();
    const evilName = '=HYPERLINK("http://evil.test","Click")';
    const evilNote = "@SUM(1+1)*cmd|'/c calc'!A1";
    const messyNote = 'Feeds at 7, "twice"\nWalks after.';
    await env.PAWSERVATION_DB.prepare(
      "INSERT INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES (?, ?, ?, ?, 'active')",
    )
      .bind('eu_sp_evil', TENANT_A, 'evil@example.com', evilName)
      .run();
    await env.PAWSERVATION_DB.prepare(
      'INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType, Notes) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind('pet_sp_evil', TENANT_A, 'eu_sp_evil', 'Rex', 'dog', `${evilNote}\n${messyNote}`)
      .run();
    await env.PAWSERVATION_DB.prepare(
      'INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)',
    )
      .bind(TENANT_A, 'pet_sp_evil', 'eu_sp_evil')
      .run();

    const clientRows = await rowsOf(await get(env, 'clients'));
    const client = clientRows.find((r) => r[1] === 'evil@example.com')!;
    // Prefixed, and otherwise byte-identical: the guard defuses the cell without editing what she
    // actually has stored.
    expect(client[0]).toBe(`'${evilName}`);

    const petRows = await rowsOf(await get(env, 'pets'));
    const notesIndex = petRows[0].indexOf('Care notes');
    const rex = petRows.find((r) => r[0] === 'Rex')!;
    expect(rex[notesIndex]).toBe(`'${evilNote}\n${messyNote}`);
    // The owner column carries the neutralised name too — a formula is a formula in any column.
    expect(rex[petRows[0].indexOf('Owners')]).toBe(`'${evilName}`);
  });

  it('renders intake answers under the question labels the sitter wrote', async () => {
    const { env } = createTestEnv();
    await env.PAWSERVATION_DB.prepare(
      'UPDATE TenantServices SET Questions = ? WHERE TenantId = ? AND ServiceType = ?',
    )
      .bind(
        JSON.stringify([{ id: 'q1', label: 'Vet phone', type: 'text', required: false }]),
        TENANT_A,
        'boarding',
      )
      .run();
    await env.PAWSERVATION_DB.prepare('UPDATE BookingRequests SET Answers = ? WHERE Id = ?')
      .bind(JSON.stringify({ q1: '555-0100', q9: 'orphaned' }), 'seed_sp_board1')
      .run();

    const rows = await rowsOf(await get(env, 'bookings'));
    const answers = rows.slice(1).find((r) => r[0] === 'seed_sp_board1')![
      rows[0].indexOf('Answers')
    ];
    expect(answers).toContain('Vet phone: 555-0100');
    // A question deleted since the booking keeps its answer under its raw id rather than vanishing.
    expect(answers).toContain('q9: orphaned');
  });

  it('refuses one tenant\u2019s admin token on another tenant\u2019s export URL', async () => {
    const { env } = createTestEnv();
    // The whole risk of this route is cross-tenant, and `adminAuth` is the only thing standing
    // between a valid token and somebody else's client list.
    const res = await app.request(
      '/api/happy-tails/admin/export/clients',
      { headers: await adminHeaders(TENANT_A) },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('still downloads when the stored timezone is not a real IANA name', async () => {
    const { env } = createTestEnv();
    await env.PAWSERVATION_DB.prepare('UPDATE Tenants SET Timezone = ? WHERE Id = ?')
      .bind('Pacific/Nowhere', TENANT_A)
      .run();

    // `Intl` throws a RangeError on a name it does not know, and only the FILENAME reads this
    // value. This is the route whose whole promise is "you can always get your data out", so a
    // bad string in one settings column must cost her a filename, never the download.
    const res = await get(env, 'clients');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="pawservation-sunny-paws-clients-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect((await rowsOf(res)).length).toBeGreaterThan(1);
  });

  it('marks every export no-store', async () => {
    const { env } = createTestEnv();
    // Unlike every other admin response this one is a file of names, emails and phone numbers:
    // it must stay out of shared caches and out of the browser's back/forward cache.
    for (const dataset of DATASETS) {
      expect((await get(env, dataset)).headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('leads with a UTF-8 BOM, and the rows after it still parse', async () => {
    const { env } = createTestEnv();
    await env.PAWSERVATION_DB.prepare(
      "INSERT INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES (?, ?, ?, ?, 'active')",
    )
      .bind('eu_sp_jose', TENANT_A, 'jose@example.com', 'Jos\u00e9 M\u00fcller')
      .run();

    // Read as BYTES: `Response.text()` runs a UTF-8 decode, which strips a leading BOM by
    // specification, so a string comparison here would pass with or without the fix.
    const bytes = new Uint8Array(await (await get(env, 'clients')).arrayBuffer());
    // Excel on Windows ignores the HTTP charset once the file is opened from disk and falls back
    // to the system codepage, so without these three bytes 'Jos\u00e9' arrives as mojibake.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const rows = parseCsvRows(new TextDecoder().decode(bytes.slice(3)));
    // Exactly one BOM, and the header immediately after it is the real first column.
    expect(rows[0][0]).toBe('Name');
    expect(rows.find((r) => r[1] === 'jose@example.com')![0]).toBe('Jos\u00e9 M\u00fcller');
  });

  it('never exports a payment\u2019s Venmo transaction id', async () => {
    const { env } = createTestEnv();
    await insertPayment(env.PAWSERVATION_DB, TENANT_A, {
      bookingRequestId: 'seed_sp_board1',
      amount: 41,
      method: 'venmo',
      paidDate: '2028-06-19',
      note: null,
      externalRef: 'venmo-txn-9f3c1',
    });

    const rows = await rowsOf(await get(env, 'payments'));
    // ExternalRef is the importer's idempotency key, absent from PaymentRow and every wire
    // payload; the export is one more surface it must not leak through.
    expect(rows.flat().some((cell) => cell.includes('venmo-txn-9f3c1'))).toBe(false);
    expect(rows[0].some((h) => /external|ref/i.test(h))).toBe(false);
    // Not vacuous: the payment itself really is in the file.
    expect(rows.slice(1).some((r) => r[rows[0].indexOf('Amount')] === '41')).toBe(true);
  });

  it('answers a tenant with nothing in it with a header row and no more', async () => {
    const { env } = createTestEnv();
    await env.PAWSERVATION_DB.prepare(
      'INSERT INTO Tenants (Id, Slug, DisplayName) VALUES (?, ?, ?)',
    )
      .bind('tnt_empty', 'empty-paws', 'Empty Paws')
      .run();

    // A sitter on her first day must get a file with column headings, not a 500 and not a blank.
    for (const dataset of DATASETS) {
      const res = await app.request(
        `/api/empty-paws/admin/export/${dataset}`,
        { headers: await adminHeaders('tnt_empty') },
        env,
      );
      expect(res.status).toBe(200);
      const rows = await rowsOf(res);
      expect(rows).toHaveLength(1);
      expect(rows[0].length).toBeGreaterThan(1);
      expect(rows[0].every((h) => h !== '')).toBe(true);
    }
  });

  it('exports a booking that names no pets', async () => {
    const { env } = createTestEnv();
    // BookingRequestPets is a join table with no NOT NULL edge forcing a row, and the calendar
    // backfill creates exactly this shape: a booking with a pet count and no named pets.
    const id = await insertBookingRequest(env.PAWSERVATION_DB, TENANT_A, {
      endUserId: 'eu_sp_jess',
      serviceType: 'boarding',
      startDate: '2028-09-01',
      endDate: '2028-09-03',
      optionKey: null,
      petCount: 1,
      estCost: 120,
      status: 'pending',
    });

    const rows = await rowsOf(await get(env, 'bookings'));
    const row = rows.slice(1).find((r) => r[0] === id);
    expect(row).toBeDefined();
    expect(row![rows[0].indexOf('Pets')]).toBe('');
  });

  it('names the person behind a household payment, once, even when the pet is co-owned', async () => {
    const { env } = createTestEnv();
    // A second owner on Bella. A plain join through PetOwners would emit this payment once per
    // owner — one sum of money appearing twice in her own file.
    await env.PAWSERVATION_DB.prepare(
      "INSERT INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES (?, ?, ?, ?, 'active')",
    )
      .bind('eu_sp_alex', TENANT_A, 'alex@example.com', 'Alex Co-owner')
      .run();
    await env.PAWSERVATION_DB.prepare(
      'INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)',
    )
      .bind(TENANT_A, 'pet_sp_bella', 'eu_sp_alex')
      .run();
    await insertAccountPayment(env.PAWSERVATION_DB, TENANT_A, {
      accountId: 'pet_sp_bella',
      amount: 60,
      method: 'cash',
      paidDate: '2028-07-01',
      note: 'monthly',
      externalRef: null,
    });

    const rows = await rowsOf(await get(env, 'payments'));
    const idx = (name: string) => rows[0].indexOf(name);
    const household = rows.slice(1).filter((r) => r[idx('Settles')] === 'household');
    expect(household).toHaveLength(1);
    // Reached through the account pet's owners, not through a booking it does not have — that
    // route left every household payment with a blank client.
    expect(household[0][idx('Client')]).toBe('Alex Co-owner');
    // The pick is the lowest email, which UNIQUE (TenantId, Email) makes a total order, so it is
    // the same owner on every export rather than whatever SQLite visited first.
    expect(household[0][idx('Client email')]).toBe('alex@example.com');
    expect(household[0][idx('Household')]).toBe('Bella');
  });

  it('keeps a household payment traceable after its anchor pet is deleted', async () => {
    const { env } = createTestEnv();
    // Its own client and pet, so deleting them cannot disturb anything the fixture asserts on.
    await env.PAWSERVATION_DB.prepare(
      "INSERT INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES (?, ?, ?, ?, 'active')",
    )
      .bind('eu_sp_gone', TENANT_A, 'gone@example.com', 'Gone Client')
      .run();
    await env.PAWSERVATION_DB.prepare(
      'INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('pet_sp_gone', TENANT_A, 'eu_sp_gone', 'Rufus', 'dog')
      .run();
    await env.PAWSERVATION_DB.prepare(
      'INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)',
    )
      .bind(TENANT_A, 'pet_sp_gone', 'eu_sp_gone')
      .run();
    const paymentId = await insertAccountPayment(env.PAWSERVATION_DB, TENANT_A, {
      accountId: 'pet_sp_gone',
      amount: 77,
      method: 'zelle',
      paidDate: '2028-07-02',
      note: null,
      externalRef: null,
    });
    expect(paymentId).not.toBeNull();

    // The detached case CLAUDE.md names `unattachedPaymentAccountIds`: Payments.AccountId carries
    // no foreign key, so the anchor pet can go while the money stays.
    await env.PAWSERVATION_DB.prepare('DELETE FROM PetOwners WHERE TenantId = ? AND PetId = ?')
      .bind(TENANT_A, 'pet_sp_gone')
      .run();
    await env.PAWSERVATION_DB.prepare('DELETE FROM EndUserPets WHERE TenantId = ? AND Id = ?')
      .bind(TENANT_A, 'pet_sp_gone')
      .run();

    const rows = await rowsOf(await get(env, 'payments'));
    const idx = (name: string) => rows[0].indexOf(name);
    const row = rows.slice(1).find((r) => r[idx('Amount')] === '77')!;
    expect(row).toBeDefined();
    // No pet name and no booking left to name it, so the raw account id is the last thread back to
    // what this money was filed against. A blank here is money with no attribution at all.
    expect(row[idx('Household')]).toBe('pet_sp_gone');
    expect(row[idx('Booking ID')]).toBe('');
  });
});

/**
 * WHAT THE PANEL PROMISES MUST BE WHAT THE FILES HOLD. The first version of this copy said
 * "Everything you have put into Pawservation \u2026 Nothing is left out", and the export has never
 * carried her time off, her services, her rates, her cancellation tiers, her intake question
 * definitions, or her charges line by line. Over-claiming here is worse than a missing feature: she
 * finds out from a file that turned out not to have what she needed.
 *
 * Asserted against the component's own source, the way `seo.test.ts` asserts against the files it
 * guards — there is no DOM harness for the admin bundle in this suite, and the copy is plain JSX
 * text, so the source IS the string a reader sees. Whitespace is collapsed first so a Prettier
 * re-wrap cannot break the guard.
 */
describe('export panel copy', () => {
  const SOURCE = readFileSync(
    join(import.meta.dirname, '..', '..', 'app', 'admin', 'ExportPanel.tsx'),
    'utf8',
  )
    .replace(/\s+/g, ' ')
    .toLowerCase();

  it('claims no completeness the export does not have', () => {
    for (const phrase of ['everything', 'nothing is left out', 'complete backup', 'full backup']) {
      expect(SOURCE).not.toContain(phrase);
    }
  });

  it('names the omission a sitter would most notice: her time off', () => {
    expect(SOURCE).toContain('time off');
    expect(SOURCE).toContain('blocked days are in none of these files');
  });
});
