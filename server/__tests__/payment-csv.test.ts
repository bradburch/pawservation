import { describe, expect, it } from 'vitest';
import { applyMapping, detectCsvShape, MAX_CSV_REFERENCE } from '../lib/payment-csv';

const SHAPE_FILE = [
  'Transaction Date,Gross Amount (USD),Sender Name,Confirmation #',
  '2026-07-03,45,Thomas Finch,ZL-88213',
  '2026-07-11,120,Dana Cole,ZL-88999',
].join('\n');

describe('detectCsvShape', () => {
  it('returns the headers and a sample of data rows', () => {
    const shape = detectCsvShape(SHAPE_FILE);
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;
    expect(shape.headers).toEqual([
      'Transaction Date',
      'Gross Amount (USD)',
      'Sender Name',
      'Confirmation #',
    ]);
    expect(shape.sample[0]).toEqual(['2026-07-03', '45', 'Thomas Finch', 'ZL-88213']);
    expect(shape.dataRowCount).toBe(2);
  });

  it('refuses an empty file', () => {
    expect(detectCsvShape('')).toEqual({ ok: false, error: 'That file is empty.' });
  });

  it('refuses a file with a header row and nothing else', () => {
    const shape = detectCsvShape('A,B,C');
    expect(shape.ok).toBe(false);
  });

  it('sanitizes a formula in a header or a sample cell', () => {
    const shape = detectCsvShape('=CMD(),B\n1,2');
    expect(shape.ok && shape.headers[0]).toBe("'=CMD()");
  });

  it('refuses a file over the row cap, naming the count', () => {
    const many = ['A,B', ...Array.from({ length: 501 }, (_, i) => `${i},x`)].join('\n');
    const shape = detectCsvShape(many);
    expect(shape.ok).toBe(false);
    expect(shape.ok === false && shape.error).toContain('501');
  });
});

const MAP = { date: 0, amount: 1, payer: 2, reference: 3 };
const FILE = [
  'Date,Amount,Payer,Ref',
  '2026-07-03,45,Thomas Finch,ZL-1',
  '2026-07-04,45.50,Dana Cole,ZL-2',
  '2026-07-05,-20,Refund Person,ZL-3',
  'nope,10,Bad Date,ZL-4',
].join('\n');

describe('applyMapping', () => {
  it('maps a good row and reports the bad ones with their file line numbers', () => {
    const out = applyMapping(FILE, MAP, 'zelle', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(1);
    expect(out.payments[0]).toMatchObject({
      row: 2,
      date: '2026-07-03',
      amount: 45,
      payer: 'Thomas Finch',
      method: 'zelle',
      reference: 'ZL-1',
      // namespaced so it can never collide with a raw Venmo transaction id in the same
      // ExternalRef column / unique index.
      dedupeKey: 'csv:ZL-1',
    });
    // 1-indexed against the sitter's own file, so "row 3" means row 3 in their spreadsheet.
    expect(out.problems.map((p) => p.row)).toEqual([3, 4, 5]);
    expect(out.problems[0].reason).toMatch(/whole dollar/i);
    // The refund row (row 4) and the bad-date row (row 5) are told apart, not lumped in with the
    // cents problem.
    expect(out.problems[1].reason).toMatch(/refund/i);
  });

  it("names the format a date must be in, rather than only saying it couldn't be read", () => {
    // A US bank or PayPal export writes 07/03/2026, which turns EVERY row into a problem row.
    // The reason has to say what is expected — guessing the order is not an option, since
    // 03/07/2026 is ambiguous between US and European order and a wrong guess misdates money.
    const f = ['Date,Amount,Payer', '07/03/2026,40,Finch'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(0);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0].reason).toContain('07/03/2026');
    expect(out.problems[0].reason).toContain('YYYY-MM-DD');
    expect(out.problems[0].reason).toContain('2026-07-03');
  });

  it('reports a reference longer than the cap as a problem row instead of storing it', () => {
    // The reference becomes `csv:<reference>` in ExternalRef and in its unique index; Venmo caps
    // its own transaction id at 64.
    const long = 'R'.repeat(MAX_CSV_REFERENCE + 1);
    const f = ['Date,Amount,Payer,Ref', `2026-07-03,40,Finch,${long}`].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2, reference: 3 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(0);
    expect(out.problems).toHaveLength(1);
    expect(out.problems[0].row).toBe(2);
    expect(out.problems[0].reason).toContain(String(MAX_CSV_REFERENCE));
    // A reference exactly at the cap is fine — the bound is a limit, not a margin.
    const ok = [
      'Date,Amount,Payer,Ref',
      `2026-07-03,40,Finch,${'R'.repeat(MAX_CSV_REFERENCE)}`,
    ].join('\n');
    const out2 = applyMapping(ok, { date: 0, amount: 1, payer: 2, reference: 3 }, 'cash', 'tnt_x');
    expect(out2.ok && out2.payments).toHaveLength(1);
    expect(out2.ok && out2.problems).toEqual([]);
  });

  it('gives a $0 row its own reason rather than saying it records whole dollars', () => {
    const f = ['Date,Amount,Payer', '2026-07-03,$0.00,Finch', '2026-07-04,0,Cole'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(0);
    expect(out.problems.map((p) => p.row)).toEqual([2, 3]);
    for (const problem of out.problems) {
      expect(problem.reason).toMatch(/zero/i);
      expect(problem.reason).not.toMatch(/whole dollar/i);
    }
  });

  it('parses a raw "+ $45.00"-style amount before sanitizing it, per the ordering constraint', () => {
    // sanitizeCell would prefix a leading '+' with an apostrophe ("'+ $45.00"), which parseAmount
    // would then fail to match — so amount MUST be parsed from the raw cell, never the sanitized
    // one. A sanitize-first implementation would turn this into a problem row instead of $45.
    const f = ['Date,Amount,Payer', '2026-07-03,+ $45.00,Finch'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.problems).toEqual([]);
    expect(out.payments).toHaveLength(1);
    expect(out.payments[0].amount).toBe(45);
  });

  it('reports each repeat of a mapped reference within the file instead of silently dropping it', () => {
    // A batch/settlement id repeated on every row of a bank export would otherwise become one key
    // for all of them: the unique index inserts the first and silently refuses the rest.
    const f = [
      'Date,Amount,Payer,Ref',
      '2026-07-03,40,Finch,BATCH-1',
      '2026-07-04,55,Cole,BATCH-1',
      '2026-07-05,60,Reyes,BATCH-1',
    ].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2, reference: 3 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(1);
    expect(out.payments[0].row).toBe(2);
    expect(out.problems.map((p) => p.row)).toEqual([3, 4]);
    expect(out.problems[0].reason).toContain('BATCH-1');
    expect(out.problems[0].reason).toMatch(/more than once/i);
  });

  it('falls back to the derived hash when reference is mapped but the cell is empty', () => {
    const f = ['Date,Amount,Payer,Ref', '2026-07-03,40,Finch,'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2, reference: 3 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(1);
    expect(out.payments[0].reference).toBeNull();
    expect(out.payments[0].dedupeKey).toMatch(/^csv:[0-9a-f]{16}:0$/);
  });

  it('gives two identical unreferenced rows different keys, so both import', () => {
    const f = ['Date,Amount,Payer', '2026-07-03,40,Finch', '2026-07-03,40,Finch'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(out.ok && out.payments).toHaveLength(2);
    expect(out.ok && out.payments[0].dedupeKey).not.toBe(out.ok && out.payments[1].dedupeKey);
    expect(out.ok && out.payments[0].dedupeKey).toMatch(/^csv:[0-9a-f]{16}:0$/);
    expect(out.ok && out.payments[1].dedupeKey).toMatch(/^csv:[0-9a-f]{16}:1$/);
  });

  it('gives the same file the same keys twice, so a re-upload records nothing new', () => {
    const f = ['Date,Amount,Payer', '2026-07-03,40,Finch'].join('\n');
    const a = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    const b = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(a.ok && b.ok && a.payments[0].dedupeKey).toBe(b.ok ? b.payments[0].dedupeKey : '');
  });

  it('keys the same file identically whether or not Note is mapped, so a remapped re-upload records nothing twice', () => {
    // The panel resets the mapping on every upload, so the second import of an overlapping export
    // is genuinely likely to map Note differently — or not at all. A key that moved with the
    // mapping would record every row a second time, silently.
    const f = ['Date,Amount,Payer,Note', '2026-07-03,40,Finch,rent'].join('\n');
    const withNote = applyMapping(f, { date: 0, amount: 1, payer: 2, note: 3 }, 'cash', 'tnt_x');
    const without = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(withNote.ok && without.ok).toBe(true);
    if (!withNote.ok || !without.ok) return;
    expect(withNote.payments[0].dedupeKey).toBe(without.payments[0].dedupeKey);
    // The note is still carried on the payment itself — it is descriptive, not identifying.
    expect(withNote.payments[0].note).toBe('rent');
  });

  it('still gives two rows differing only in note distinct keys, via the rank — a genuine second payment is never lost', () => {
    const f = [
      'Date,Amount,Payer,Note',
      '2026-07-03,40,Finch,first walk',
      '2026-07-03,40,Finch,second walk',
    ].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2, note: 3 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(2);
    expect(out.payments[0].dedupeKey).toMatch(/^csv:[0-9a-f]{16}:0$/);
    expect(out.payments[1].dedupeKey).toMatch(/^csv:[0-9a-f]{16}:1$/);
    expect(out.payments[0].dedupeKey).not.toBe(out.payments[1].dedupeKey);
  });

  it('scopes the key to the tenant', () => {
    const f = ['Date,Amount,Payer', '2026-07-03,40,Finch'].join('\n');
    const a = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_a');
    const b = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_b');
    expect(a.ok && b.ok && a.payments[0].dedupeKey).not.toBe(b.ok ? b.payments[0].dedupeKey : '');
  });

  it('does not let a delimiter-bearing tenant/payer split collide with a different split of the same characters', () => {
    // Without escaping, a bare `|` join makes tenant="tnt|a", payer="b" and tenant="tnt",
    // payer="a|b" build the identical hash input — two tenants sharing one key.
    const f1 = ['Date,Amount,Payer', '2026-07-03,40,b'].join('\n');
    const f2 = ['Date,Amount,Payer', '2026-07-03,40,a|b'].join('\n');
    const out1 = applyMapping(f1, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt|a');
    const out2 = applyMapping(f2, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt');
    expect(out1.ok && out2.ok && out1.payments[0].dedupeKey).not.toBe(
      out2.ok ? out2.payments[0].dedupeKey : '',
    );
  });

  it('reports a row with no payer name as a problem', () => {
    const f = ['Date,Amount,Payer', '2026-07-03,40,'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(0);
    expect(out.problems).toEqual([{ row: 2, reason: 'This row has no payer name' }]);
  });

  it('caps a mapped note at 200 characters', () => {
    const longNote = 'x'.repeat(250);
    const f = ['Date,Amount,Payer,Note', `2026-07-03,40,Finch,${longNote}`].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2, note: 3 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments[0].note).toBe('x'.repeat(200));
  });

  it('falls back to the chosen default for an unrecognised method, never to other', () => {
    const f = ['Date,Amount,Payer,Method', '2026-07-03,40,Finch,ACH credit'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2, method: 3 }, 'zelle', 'tnt_x');
    expect(out.ok && out.payments[0].method).toBe('zelle');
  });

  it('takes a mapped method that matches the enum, case-insensitively', () => {
    const f = ['Date,Amount,Payer,Method', '2026-07-03,40,Finch,VENMO'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2, method: 3 }, 'zelle', 'tnt_x');
    expect(out.ok && out.payments[0].method).toBe('venmo');
  });

  it('refuses a mapping naming a column the file does not have', () => {
    const out = applyMapping(FILE, { date: 0, amount: 1, payer: 99 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(false);
  });

  it('defuses a formula in a mapped payer or note cell, not just in a header', () => {
    const f = ['Date,Amount,Payer,Note', '2026-07-03,40,=CMD(),+1 234'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2, note: 3 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments[0].payer).toBe("'=CMD()");
    expect(out.payments[0].note).toBe("'+1 234");
  });

  it('agrees with detectCsvShape about which row is the header when the file opens with a blank line', () => {
    const f = ['', 'Date,Amount,Payer', '2026-07-03,40,Finch'].join('\n');
    const shape = detectCsvShape(f);
    expect(shape.ok && shape.headers).toEqual(['Date', 'Amount', 'Payer']);

    const out = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payments).toHaveLength(1);
    // 1-indexed against the sitter's actual file: the data row is line 3, not line 2, because
    // the blank line above is line 1.
    expect(out.payments[0].row).toBe(3);
  });
});
