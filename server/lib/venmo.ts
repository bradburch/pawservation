/**
 * Venmo CSV import: turning the file a sitter downloads from Venmo into whole-dollar payments that
 * can be proposed against the households they came from (Story 2.5, 0011).
 *
 * PURE. No D1, no env, no fetch — every function here takes plain data and returns plain data, so
 * `server/db/repo.ts` remains the only module that touches the database.
 *
 * SERVER-ONLY BY PLACEMENT. This lives in `server/lib/`, not `src/shared/`: the widget and the
 * dashboard must never derive money from a file. The admin bundle uploads text and renders what
 * comes back.
 *
 * The format (verified against a real export):
 *  - two preamble rows, then a header row, and a LEADING EMPTY COLUMN on every row;
 *  - balance and disclaimer rows top and tail the transactions, marked by a blank `Datetime`;
 *  - `Amount (total)` looks like "+ $45.00" / "- $885.00";
 *  - Venmo's own column alignment drifts (a real file puts "Venmo balance" under `Destination`
 *    rather than `Funding Source`), so every column is looked up BY HEADER NAME, never by index;
 *  - `From` is the payer's DISPLAY NAME, not their @handle — hence `EndUsers.VenmoUsername` is
 *    only needed when the two differ.
 */
import { parseCsvRows } from './csv';
import {
  normalizePayerName,
  parseAmount,
  resolveMatchClient,
  sanitizeCell,
  type MatchClient,
} from './payment-import';
import { isRealDate } from './validation';

export {
  sanitizeCell,
  parseAmount,
  resolveMatchClient,
  normalizePayerName as normalizeVenmoName,
  type MatchClient,
} from './payment-import';

/**
 * Each confirmed row costs a D1 write, and the preview holds the whole file in memory. Cap the
 * transaction count so an oversized file fails fast with an actionable message instead of hitting
 * the Workers CPU/subrequest ceiling mid-loop — the same reasoning as MAX_IMPORT_ROWS on the
 * client CSV import, with its own constant because the two files have nothing else in common.
 */
export const MAX_VENMO_ROWS = 500;

/** A Venmo note is free text a client typed; cap what we store and echo. */
const MAX_VENMO_NOTE = 200;

/** Venmo's own preamble is 2 rows. Allow slack for a future title line without ever guessing. */
const MAX_PREAMBLE_ROWS = 10;

/** The header cells this importer needs. Their presence IS the "is this a Venmo file?" test. */
const REQUIRED_HEADERS = [
  'ID',
  'Datetime',
  'Type',
  'Status',
  'Note',
  'From',
  'Amount (total)',
] as const;

/**
 * Money a client sent the sitter. A 'Standard Transfer' is the sitter moving their own money to a
 * bank; 'Merchant Transaction' and 'Credit Card Reward' are not client payments either.
 */
const INCOMING_TYPES = new Set(['Payment', 'Charge']);

/** Venmo transaction ids are long digit strings. Accept a conservative token superset and nothing
 * else: this value becomes a stored dedupe key and a LIKE-free equality lookup, not free text. */
const TXN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type VenmoTxn = {
  txnId: string;
  date: string; // 'YYYY-MM-DD', taken from Datetime
  type: string;
  status: string;
  note: string;
  from: string; // the payer's Venmo display name, sanitized
  amount: number; // whole dollars, always positive (incoming only)
};

export type VenmoProblem = { row: number; reason: string };

export type VenmoParseResult =
  | { ok: true; incoming: VenmoTxn[]; ignored: number; problems: VenmoProblem[] }
  | { ok: false; error: string };

/** '2021-08-07T04:11:17' → '2021-08-07'. Null when there is no real date to be had. */
export function parseVenmoDate(datetime: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(datetime.trim());
  return m && isRealDate(m[1]) ? m[1] : null;
}

export function isVenmoTxnId(value: unknown): value is string {
  return typeof value === 'string' && TXN_ID_RE.test(value);
}

export function parseVenmoCsv(text: string): VenmoParseResult {
  if (typeof text !== 'string' || text.trim() === '')
    return { ok: false, error: 'That file is empty.' };
  const rows = parseCsvRows(text);

  // Find the header by its CELLS, not at a fixed offset: Venmo opens with a title line and an
  // "Account Activity" line today, and a file that gains a third preamble line must still import.
  const headerIndex = rows.findIndex(
    (cells, i) =>
      i < MAX_PREAMBLE_ROWS &&
      REQUIRED_HEADERS.every((h) => cells.some((cell) => cell.trim() === h)),
  );
  if (headerIndex === -1)
    return {
      ok: false,
      error:
        "That doesn't look like a Venmo CSV. Download the CSV from Venmo and upload it unchanged — " +
        'Pawservation reads the file exactly as Venmo writes it.',
    };

  const header = rows[headerIndex].map((cell) => cell.trim());
  const at = (name: string) => header.indexOf(name);
  const idx = {
    id: at('ID'),
    datetime: at('Datetime'),
    type: at('Type'),
    status: at('Status'),
    note: at('Note'),
    from: at('From'),
    amount: at('Amount (total)'),
  };

  // Balance and disclaimer rows carry no Datetime, and a trailing newline parses as one empty cell:
  // both fall out here, so nothing downstream has to know they exist.
  const dataRows = rows
    .slice(headerIndex + 1)
    .map((cells, i) => ({ row: headerIndex + i + 2, cells })) // 1-indexed against the sitter's file
    .filter(({ cells }) => (cells[idx.datetime] ?? '').trim() !== '');

  if (dataRows.length > MAX_VENMO_ROWS)
    return {
      ok: false,
      error:
        `This file has ${dataRows.length} transactions. Download a shorter date range from Venmo ` +
        `and import ${MAX_VENMO_ROWS} or fewer at a time.`,
    };

  const incoming: VenmoTxn[] = [];
  const problems: VenmoProblem[] = [];
  let ignored = 0;

  for (const { row, cells } of dataRows) {
    const cell = (i: number) => (i >= 0 ? (cells[i] ?? '') : '');
    const type = sanitizeCell(cell(idx.type));
    const status = sanitizeCell(cell(idx.status));
    // Not money that arrived from a client: a transfer out, a reward, a pending or failed row.
    // Counted so the sitter's totals add up, never guessed at.
    if (status !== 'Complete' || !INCOMING_TYPES.has(type)) {
      ignored++;
      continue;
    }
    const amount = parseAmount(cell(idx.amount));
    if (!amount) {
      // Shown raw, not via sanitizeCell: an amount cell like "+ $250.50" would otherwise pick up
      // sanitizeCell's formula-injection apostrophe and misquote the very value being reported.
      problems.push({
        row,
        reason: `Couldn’t read the amount "${cell(idx.amount).trim()}" — Pawservation records whole dollars`,
      });
      continue;
    }
    if (amount.sign === '-') {
      ignored++; // a refund the sitter sent back out
      continue;
    }
    const txnId = cell(idx.id).trim();
    const date = parseVenmoDate(cell(idx.datetime));
    if (!isVenmoTxnId(txnId) || !date) {
      problems.push({ row, reason: 'This row has no usable transaction id or date' });
      continue;
    }
    incoming.push({
      txnId,
      date,
      type,
      status,
      note: sanitizeCell(cell(idx.note)).slice(0, MAX_VENMO_NOTE),
      from: sanitizeCell(cell(idx.from)),
      amount: amount.dollars,
    });
  }

  // One upload must never propose the same payment twice, whatever the file says.
  const seen = new Set<string>();
  const deduped = incoming.filter((t) => (seen.has(t.txnId) ? false : (seen.add(t.txnId), true)));
  return { ok: true, incoming: deduped, ignored, problems };
}

export type PreviewRow = {
  txnId: string;
  date: string;
  amount: number;
  from: string;
  note: string;
};
/**
 * A transaction resolved to exactly one household. Story 2.5 records it there and nowhere more
 * specific: which booking(s) it covers is not this module's question — 0011 exists precisely so
 * that question never has to be answered by hand.
 */
export type MatchedRow = PreviewRow & {
  endUserId: string;
  clientLabel: string;
  accountId: string;
};
export type UnmatchedRow = PreviewRow & { reason: string };

export type VenmoPreview = {
  matched: MatchedRow[];
  unmatched: UnmatchedRow[];
  alreadyImported: PreviewRow[];
};

/**
 * Sort every parsed transaction into one of three buckets. Writes nothing and knows nothing about
 * D1 — the routes hand it a client list and a set, and the same function runs again on confirm so
 * the server never has to trust a client's idea of what was matched.
 *
 * STORY 2.5 — VENMO IMPORT RECORDS AGAINST HOUSEHOLDS (supports FR-7a). Earlier versions of this
 * function ranked a payer's OUTSTANDING BOOKINGS and asked the sitter to pick one — bookkeeping this
 * module was doing FOR her, the same shape of problem 0011 solved for hand-recorded payments. Once a
 * payer resolves to one client, `buildAccounts` names their household unambiguously (it partitions
 * every owner into exactly one component), so there is nothing left to rank or disambiguate: the
 * payment goes to the household, whatever it turns out to cover.
 */
export function matchVenmoTxns(input: {
  txns: VenmoTxn[];
  clients: MatchClient[];
  alreadyImported: Set<string>;
}): VenmoPreview {
  const { txns, clients, alreadyImported } = input;

  const preview: VenmoPreview = { matched: [], unmatched: [], alreadyImported: [] };

  for (const txn of txns) {
    const row: PreviewRow = {
      txnId: txn.txnId,
      date: txn.date,
      amount: txn.amount,
      from: txn.from,
      note: txn.note,
    };
    if (alreadyImported.has(txn.txnId)) {
      preview.alreadyImported.push(row);
      continue;
    }
    const key = normalizePayerName(txn.from);
    if (key === '') {
      preview.unmatched.push({ ...row, reason: 'This transaction has no sender name to match on' });
      continue;
    }
    const client = resolveMatchClient(clients, txn.from);
    if (!client) {
      // resolveMatchClient collapses "no hit" and "collision" into one null — recover which one
      // this was purely to phrase the sitter-facing reason; the pass/fail decision above is
      // already final and comes from the one shared resolver.
      const hits = clients.filter(
        (c) => normalizePayerName(c.venmoUsername ?? c.name ?? '') === key,
      );
      preview.unmatched.push({
        ...row,
        reason:
          hits.length === 0
            ? `No client matches the Venmo name “${txn.from}”. Add it to their row in Clients and check the file again.`
            : `More than one client is set up under the Venmo name “${txn.from}” (${hits
                .map((h) => h.label)
                .join(', ')}). Give them different Venmo usernames in Clients.`,
      });
      continue;
    }
    // A client with no live pet holds no edge in the owner<->pet graph at all, so `buildAccounts`
    // places them in no household. Surfaced for the sitter to sort out — never guessed at, which
    // is exactly the money-inference this project forbids everywhere else.
    if (client.accountId === null) {
      preview.unmatched.push({
        ...row,
        reason: `${client.label} has no pets on file, so there is no household to record this payment against.`,
      });
      continue;
    }
    preview.matched.push({
      ...row,
      endUserId: client.endUserId,
      clientLabel: client.label,
      accountId: client.accountId,
    });
  }
  return preview;
}
