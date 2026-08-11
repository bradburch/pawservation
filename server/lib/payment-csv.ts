/**
 * Detects the shape of a sitter-uploaded payment CSV: its headers and a sample of real data rows,
 * so the sitter can map their own columns against actual values rather than header names alone.
 * This module never decides what a payment means — only what the file says.
 *
 * PURE. No D1, no env, no fetch.
 */
import { parseCsvRows } from './csv';
import { sanitizeCell } from './payment-import';

/** Each confirmed row costs a D1 write and the preview holds the file in memory. Mirrors
 *  MAX_VENMO_ROWS, with its own constant because the two files share no other property. */
export const MAX_CSV_ROWS = 500;

/** How many data rows the sitter sees while mapping. Enough to recognise a column, few enough
 *  to render beside a dropdown. */
const SAMPLE_ROWS = 3;

export type CsvShape =
  | { ok: true; headers: string[]; sample: string[][]; dataRowCount: number }
  | { ok: false; error: string };

export function detectCsvShape(text: string): CsvShape {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'That file is empty.' };
  }
  const rows = parseCsvRows(text).filter((cells) => cells.some((c) => c.trim() !== ''));
  if (rows.length === 0) return { ok: false, error: 'That file is empty.' };

  const headers = rows[0].map(sanitizeCell);
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    return { ok: false, error: 'That file has a header row and no payments under it.' };
  }
  if (dataRows.length > MAX_CSV_ROWS) {
    return {
      ok: false,
      error:
        `This file has ${dataRows.length} rows. Split it by date range and ` +
        `import ${MAX_CSV_ROWS} or fewer at a time.`,
    };
  }
  return {
    ok: true,
    headers,
    sample: dataRows.slice(0, SAMPLE_ROWS).map((cells) => cells.map(sanitizeCell)),
    dataRowCount: dataRows.length,
  };
}
