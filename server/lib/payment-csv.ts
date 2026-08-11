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
 * One FNV-1a lane, seeded from `seed` instead of the algorithm's usual fixed offset basis so two
 * lanes over the same input diverge. Not a security boundary, just a fingerprint — but synchronous
 * matters: `crypto.subtle` is async, which would force every caller of `applyMapping` (and
 * everything upstream of it) to become async for no real benefit here.
 */
function fnv1aLane(input: string, seed: number): number {
  let hash = seed;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A 64-bit fingerprint of `parts`, built from two independent 32-bit FNV-1a lanes. A single 32-bit
 * hash is NOT astronomically collision-safe at this scale: at ~2,000 payments imported for one
 * tenant, the birthday bound puts the odds of some collision around 5e-4 — worth widening, not
 * worth hand-waving away in a comment the next reader trusts. Two lanes push that to 64 bits.
 *
 * `JSON.stringify`, not a bare `|`-joined string: joining with a plain delimiter lets two different
 * rows build the identical input (payer="a|b", note="c" vs. payer="a", note="b|c"); JSON escaping
 * keeps every part's boundary unambiguous.
 */
function contentHash(parts: unknown[]): string {
  const input = JSON.stringify(parts);
  const lane1 = fnv1aLane(input, 0x811c9dc5); // FNV-1a's own standard 32-bit offset basis
  const lane2 = fnv1aLane(input, 0x9e3779b9); // 2^32/phi — a distinct seed, so the lanes diverge
  return lane1.toString(16).padStart(8, '0') + lane2.toString(16).padStart(8, '0');
}

/**
 * Turn a sitter-uploaded CSV plus their own column mapping into whole-dollar payments, exactly
 * as `parseVenmoCsv` does for Venmo's fixed format — reusing the same amount/date/sanitize rules
 * from `payment-import.ts` so the two importers can never quietly disagree about what a valid
 * amount or a safe cell is.
 *
 * THE DEDUPE KEY (spec: "derived key including duplicate-rank"), stored in the same `ExternalRef`
 * column — and the same unique index, `idx_Payments_Tenant_ExternalRef` — as a raw Venmo
 * transaction id. Every key is namespaced `csv:...` so it can never collide with one of those.
 *
 * When `reference` is mapped and the cell is non-empty, the key is `csv:<reference>` — but a
 * reference repeated within the same file is NOT re-used as a second key (see the in-file
 * duplicate-reference check below): that would silently drop every repeat past the first, and a
 * repeated reference more likely means the mapping points at the wrong column than that the same
 * payment truly happened twice, so it's reported instead of guessed at.
 *
 * Otherwise the key is `csv:<hash>:<rank>`, where `<hash>` fingerprints
 * `tenantId | date | amount | payer | note` and `<rank>` is how many identical rows preceded this
 * one in THIS file (0, 1, 2, ...):
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
  // Same rule detectCsvShape uses: a blank line carries no header. Found by content, not assumed
  // at index 0, so the two functions agree on which row is the header when a file opens with one.
  const headerIndex = allRows.findIndex((cells) => cells.some((c) => c.trim() !== ''));
  if (headerIndex === -1) return { ok: false, error: 'That file is empty.' };

  const columnCount = allRows[headerIndex].length;
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
    .slice(headerIndex + 1)
    .map((cells, i) => ({ row: headerIndex + i + 2, cells })) // 1-indexed against the sitter's file
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
  const seenReferences = new Set<string>();

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

    let reference: string | null = null;
    if (mapping.reference !== undefined) {
      const rawReference = sanitizeCell(cell(mapping.reference));
      if (rawReference !== '') reference = rawReference;
    }
    // A reference repeated within this file is refused rather than silently re-used as the same
    // key twice: the shared unique index would insert the first occurrence and refuse every
    // repeat, dropping real payments with nothing said. Reported instead — a repeated reference
    // usually means the mapping points at the wrong column.
    if (reference !== null) {
      if (seenReferences.has(reference)) {
        problems.push({
          row,
          reason: `Reference "${reference}" appears more than once in this file — check that the mapped column really holds a unique reference per payment`,
        });
        continue;
      }
      seenReferences.add(reference);
    }

    let method: PaymentMethod = defaultMethod;
    if (mapping.method !== undefined) {
      const rawMethod = cell(mapping.method).trim().toLowerCase();
      // An unrecognised mapped method falls back to the sitter's own chosen default — never
      // silently to 'other'.
      if (isPaymentMethod(rawMethod)) method = rawMethod;
    }

    const note =
      mapping.note !== undefined ? sanitizeCell(cell(mapping.note)).slice(0, MAX_NOTE_LENGTH) : '';

    let dedupeKey: string;
    if (reference !== null) {
      dedupeKey = `csv:${reference}`;
    } else {
      const hash = contentHash([tenantId, rawDate, amount.dollars, payer, note]);
      const rank = rankByHash.get(hash) ?? 0;
      rankByHash.set(hash, rank + 1);
      dedupeKey = `csv:${hash}:${rank}`;
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
