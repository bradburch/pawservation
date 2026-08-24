import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  insertAccountPayment,
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

/** The CSV body, parsed back with this codebase's own parser — the round trip that matters. */
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
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      const [[cell]] = parseCsvRows(serializeCsvRows([[`${lead}SUM(A1)`]]));
      expect(cell).toBe(`'${lead}SUM(A1)`);
    }
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
});
