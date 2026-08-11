import { describe, expect, it } from 'vitest';
import { applyMapping, detectCsvShape } from '../lib/payment-csv';

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
    });
    // 1-indexed against the sitter's own file, so "row 3" means row 3 in their spreadsheet.
    expect(out.problems.map((p) => p.row)).toEqual([3, 4, 5]);
    expect(out.problems[0].reason).toMatch(/whole dollar/i);
  });

  it('gives two identical unreferenced rows different keys, so both import', () => {
    const f = ['Date,Amount,Payer', '2026-07-03,40,Finch', '2026-07-03,40,Finch'].join('\n');
    const out = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(out.ok && out.payments).toHaveLength(2);
    expect(out.ok && out.payments[0].dedupeKey).not.toBe(out.ok && out.payments[1].dedupeKey);
  });

  it('gives the same file the same keys twice, so a re-upload records nothing new', () => {
    const f = ['Date,Amount,Payer', '2026-07-03,40,Finch'].join('\n');
    const a = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    const b = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_x');
    expect(a.ok && b.ok && a.payments[0].dedupeKey).toBe(b.ok ? b.payments[0].dedupeKey : '');
  });

  it('scopes the key to the tenant', () => {
    const f = ['Date,Amount,Payer', '2026-07-03,40,Finch'].join('\n');
    const a = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_a');
    const b = applyMapping(f, { date: 0, amount: 1, payer: 2 }, 'cash', 'tnt_b');
    expect(a.ok && b.ok && a.payments[0].dedupeKey).not.toBe(b.ok ? b.payments[0].dedupeKey : '');
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
});
