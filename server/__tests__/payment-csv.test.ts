import { describe, expect, it } from 'vitest';
import { detectCsvShape } from '../lib/payment-csv';

const FILE = [
  'Transaction Date,Gross Amount (USD),Sender Name,Confirmation #',
  '2026-07-03,45,Thomas Finch,ZL-88213',
  '2026-07-11,120,Dana Cole,ZL-88999',
].join('\n');

describe('detectCsvShape', () => {
  it('returns the headers and a sample of data rows', () => {
    const shape = detectCsvShape(FILE);
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
