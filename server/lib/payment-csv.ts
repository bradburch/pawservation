/**
 * Detects the shape of a sitter-uploaded payment CSV: its headers and a sample of real data rows,
 * so the sitter can map their own columns against actual values rather than header names alone.
 * This module never decides what a payment means — only what the file says.
 *
 * PURE. No D1, no env, no fetch.
 */
import { isPaymentMethod, type PaymentMethod } from '../../src/shared/index.js';
import { parseCsvRows } from './csv';
import { parseAmount, sanitizeCell } from './payment-import';
import { isRealDate } from './validation';

/** Each confirmed row costs a D1 write and the preview holds the file in memory. Mirrors
 *  MAX_VENMO_ROWS, with its own constant because the two files share no other property. */
export const MAX_CSV_ROWS = 500;

/** How many data rows the sitter sees while mapping. Enough to recognise a column, few enough
 *  to render beside a dropdown. */
const SAMPLE_ROWS = 3;

/** A note is free text a client typed; cap what we store and echo. Mirrors MAX_VENMO_NOTE. */
const MAX_NOTE_LENGTH = 200;

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

/** Which column (0-indexed, against the file's own header row) holds each field. `date`,
 *  `amount` and `payer` are required to import anything at all; the rest are optional. */
export type ColumnMapping = {
  date: number;
  amount: number;
  payer: number;
  method?: number;
  reference?: number;
  note?: number;
};

export type CsvPayment = {
  row: number; // 1-indexed against the sitter's own file
  date: string; // 'YYYY-MM-DD'
  amount: number; // whole dollars, positive
  payer: string;
  method: PaymentMethod;
  reference: string | null;
  note: string;
  dedupeKey: string;
};

export type CsvProblem = { row: number; reason: string };

export type ApplyMappingResult =
  { ok: true; payments: CsvPayment[]; problems: CsvProblem[] } | { ok: false; error: string };

/**
 * Synchronous, non-cryptographic 32-bit hash (FNV-1a) used only to build a dedupe key. Not a
 * security boundary — collisions are fine to be astronomically unlikely, not impossible — and
 * synchronous is the point: `crypto.subtle` is async, which would force every caller of
 * `applyMapping` (and everything upstream of it) to become async for no real benefit here.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Turn a sitter-uploaded CSV plus their own column mapping into whole-dollar payments, exactly
 * as `parseVenmoCsv` does for Venmo's fixed format — reusing the same amount/date/sanitize rules
 * from `payment-import.ts` so the two importers can never quietly disagree about what a valid
 * amount or a safe cell is.
 *
 * THE DEDUPE KEY (spec: "derived key including duplicate-rank"). When `reference` is mapped and
 * the cell is non-empty, that reference IS the key. Otherwise the key is a hash of
 * `tenantId | date | amount | payer | note`, suffixed with how many identical rows preceded this
 * one in THIS file (rank 0, 1, 2, ...):
 *  - re-uploading the same file produces the same ranks in the same order, so every key repeats
 *    and the unique index on the way in refuses all of them — nothing is recorded twice;
 *  - a client who genuinely paid the same amount twice in one day produces rank 0 and rank 1, two
 *    different keys, so BOTH import. Collapsing them onto one key would silently drop a real
 *    second payment — the worst failure this feature could have.
 */
export function applyMapping(
  text: string,
  mapping: ColumnMapping,
  defaultMethod: PaymentMethod,
  tenantId: string,
): ApplyMappingResult {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: 'That file is empty.' };
  }
  const allRows = parseCsvRows(text);
  if (allRows.length === 0) return { ok: false, error: 'That file is empty.' };

  const columnCount = allRows[0].length;
  const mappedIndices = [
    mapping.date,
    mapping.amount,
    mapping.payer,
    mapping.method,
    mapping.reference,
    mapping.note,
  ].filter((i): i is number => typeof i === 'number');
  if (mappedIndices.some((i) => !Number.isInteger(i) || i < 0 || i >= columnCount)) {
    return { ok: false, error: "That mapping points at a column this file doesn't have." };
  }

  const dataRows = allRows
    .slice(1)
    .map((cells, i) => ({ row: i + 2, cells })) // 1-indexed against the sitter's own file
    .filter(({ cells }) => cells.some((c) => c.trim() !== ''));

  if (dataRows.length > MAX_CSV_ROWS) {
    return {
      ok: false,
      error:
        `This file has ${dataRows.length} rows. Split it by date range and ` +
        `import ${MAX_CSV_ROWS} or fewer at a time.`,
    };
  }

  const payments: CsvPayment[] = [];
  const problems: CsvProblem[] = [];
  const rankByHash = new Map<string, number>();

  for (const { row, cells } of dataRows) {
    const cell = (i: number) => cells[i] ?? '';

    // Parsed from the RAW cell, never a sanitized one — see sanitizeCell's ordering comment.
    const rawAmount = cell(mapping.amount);
    const amount = parseAmount(rawAmount);
    if (!amount) {
      problems.push({
        row,
        reason: `Couldn’t read the amount "${rawAmount.trim()}" — Pawservation records whole dollars`,
      });
      continue;
    }
    if (amount.sign === '-') {
      // A negative amount is a refund, which this model cannot represent. Reported, never
      // coerced positive.
      problems.push({
        row,
        reason: `"${rawAmount.trim()}" is a refund (negative amount) — refunds can't be imported, record them manually`,
      });
      continue;
    }

    const rawDate = cell(mapping.date).trim();
    if (!isRealDate(rawDate)) {
      problems.push({ row, reason: `Couldn’t read the date "${rawDate}"` });
      continue;
    }

    const payer = sanitizeCell(cell(mapping.payer));
    if (payer === '') {
      problems.push({ row, reason: 'This row has no payer name' });
      continue;
    }

    let method: PaymentMethod = defaultMethod;
    if (mapping.method !== undefined) {
      const rawMethod = cell(mapping.method).trim().toLowerCase();
      // An unrecognised mapped method falls back to the sitter's own chosen default — never
      // silently to 'other'.
      if (isPaymentMethod(rawMethod)) method = rawMethod;
    }

    let reference: string | null = null;
    if (mapping.reference !== undefined) {
      const rawReference = sanitizeCell(cell(mapping.reference));
      if (rawReference !== '') reference = rawReference;
    }

    const note =
      mapping.note !== undefined ? sanitizeCell(cell(mapping.note)).slice(0, MAX_NOTE_LENGTH) : '';

    let dedupeKey: string;
    if (reference !== null) {
      dedupeKey = reference;
    } else {
      const contentHash = fnv1a(`${tenantId}|${rawDate}|${amount.dollars}|${payer}|${note}`);
      const rank = rankByHash.get(contentHash) ?? 0;
      rankByHash.set(contentHash, rank + 1);
      dedupeKey = `${contentHash}:${rank}`;
    }

    payments.push({
      row,
      date: rawDate,
      amount: amount.dollars,
      payer,
      method,
      reference,
      note,
      dedupeKey,
    });
  }

  return { ok: true, payments, problems };
}
