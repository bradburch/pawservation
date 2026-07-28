/**
 * Venmo CSV import: turning the file a sitter downloads from Venmo into whole-dollar payments that
 * can be proposed against their outstanding bookings.
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
import { isRealDate } from './validation';

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

// Built from character codes rather than a regex literal with an embedded control-character range
// (e.g. /[\x00-\x1f]/), which trips ESLint's no-control-regex rule -- see server/lib/email.ts for
// the same pattern. Matches every C0 control character plus DEL, flattened to a space (never
// dropped mid-word).
const CONTROL_CHARS = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
  'g',
);

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

/**
 * Make a cell safe to echo to the sitter and to store. Two jobs:
 *  - flatten control characters and runs of whitespace (a note is free text a client typed);
 *  - defuse spreadsheet formulas: a cell starting `=`, `+`, `-` or `@` executes the moment the
 *    sitter pastes our output into Excel or Sheets, so it gets a leading apostrophe.
 *
 * ORDERING CONSTRAINT this creates: a Venmo amount is literally "+ $45.00", so amounts are parsed
 * from the RAW cell by `parseAmount` and sanitized only if they are shown back as display text.
 * Sanitizing first would turn every incoming amount into "'+ $45.00" and match nothing.
 */
export function sanitizeCell(value: string): string {
  const flat = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

/**
 * "+ $45.00" → { sign: '+', dollars: 45 }. Returns null for anything that is not a whole-dollar
 * amount of at least $1 — cents are deliberately unrepresentable in this codebase, so a $45.50 row
 * is REPORTED to the sitter rather than silently rounded into a wrong ledger entry.
 */
export function parseAmount(raw: string): { sign: '+' | '-'; dollars: number } | null {
  const m = /^\s*([+-])?\s*\$?\s*([\d,]+)(?:\.(\d{1,2}))?\s*$/.exec(
    raw.replace(new RegExp(String.fromCharCode(160), 'g'), ' '),
  );
  if (!m) return null;
  if (m[3] !== undefined && Number(m[3].padEnd(2, '0')) !== 0) return null;
  const dollars = Number(m[2].replace(/,/g, ''));
  if (!Number.isSafeInteger(dollars) || dollars < 1) return null;
  return { sign: m[1] === '-' ? '-' : '+', dollars };
}

/** '2021-08-07T04:11:17' → '2021-08-07'. Null when there is no real date to be had. */
export function parseVenmoDate(datetime: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/.exec(datetime.trim());
  return m && isRealDate(m[1]) ? m[1] : null;
}

/**
 * Fold a Venmo display name and a Venmo handle onto one key: lowercase, drop a leading '@', drop
 * every non-alphanumeric character. Deliberately lossy — it is what lets "Jess Demo" (the `From`
 * column) meet "@Jess-Demo" (the handle) with the sitter typing nothing. The cost is that two
 * clients CAN collide onto one key; the matcher refuses to guess between them (see matchVenmoTxns).
 */
export function normalizeVenmoName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9]/g, '');
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

/** A client, reduced to what matching needs. `label` is what the sitter sees (name or email). */
export type MatchClient = {
  endUserId: string;
  label: string;
  name: string | null;
  venmoUsername: string | null;
};

/** An under-paid booking, reduced to what matching needs. `balance` is expected minus paid. */
export type OutstandingBooking = {
  bookingId: string;
  endUserId: string;
  label: string;
  startDate: string; // 'YYYY-MM-DD'
  balance: number; // whole dollars, > 0
};

export type PreviewRow = {
  txnId: string;
  date: string;
  amount: number;
  from: string;
  note: string;
};
export type MatchedRow = PreviewRow & {
  endUserId: string;
  clientLabel: string;
  bookingId: string;
  bookingLabel: string;
};
export type AmbiguousRow = PreviewRow & {
  endUserId: string;
  clientLabel: string;
  candidates: { bookingId: string; label: string; balance: number }[];
};
export type UnmatchedRow = PreviewRow & { reason: string };

export type VenmoPreview = {
  matched: MatchedRow[];
  ambiguous: AmbiguousRow[];
  unmatched: UnmatchedRow[];
  alreadyImported: PreviewRow[];
};

const dayDiff = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));

/**
 * Order one transaction's possible bookings: exact balance first (the overwhelmingly common real
 * case — a client pays what they owe), then the booking whose start date sits closest to the
 * payment date, then the later start date, then the id. The last key makes the order TOTAL, so the
 * same file previews identically every time it is uploaded.
 *
 * Only bookings with enough balance left are candidates: Pawservation proposes a partial payment
 * against a bigger bill happily, but never proposes over-paying a booking.
 */
export function rankCandidates(
  txn: VenmoTxn,
  bookings: OutstandingBooking[],
): OutstandingBooking[] {
  return bookings
    .filter((b) => b.balance >= txn.amount)
    .sort((a, b) => {
      const exact = Number(b.balance === txn.amount) - Number(a.balance === txn.amount);
      if (exact !== 0) return exact;
      const near = dayDiff(a.startDate, txn.date) - dayDiff(b.startDate, txn.date);
      if (near !== 0) return near;
      if (a.startDate !== b.startDate) return a.startDate < b.startDate ? 1 : -1;
      return a.bookingId < b.bookingId ? -1 : 1;
    });
}

/**
 * Sort every parsed transaction into one of four buckets. Writes nothing and knows nothing about
 * D1 — the routes hand it three lists and a set, and the same function runs again on confirm so
 * the server never has to trust a client's idea of what was matched.
 */
export function matchVenmoTxns(input: {
  txns: VenmoTxn[];
  clients: MatchClient[];
  outstanding: OutstandingBooking[];
  alreadyImported: Set<string>;
}): VenmoPreview {
  const { txns, clients, outstanding, alreadyImported } = input;

  // Clients by normalized match key. A key with two clients on it can never be resolved
  // automatically, so it is kept as a LIST and refused below rather than being silently won by
  // whichever client sorted first.
  const byKey = new Map<string, MatchClient[]>();
  for (const client of clients) {
    const key = normalizeVenmoName(client.venmoUsername ?? client.name ?? '');
    if (key === '') continue; // nothing to match on
    byKey.set(key, [...(byKey.get(key) ?? []), client]);
  }
  const bookingsByClient = new Map<string, OutstandingBooking[]>();
  for (const b of outstanding)
    bookingsByClient.set(b.endUserId, [...(bookingsByClient.get(b.endUserId) ?? []), b]);

  const preview: VenmoPreview = { matched: [], ambiguous: [], unmatched: [], alreadyImported: [] };

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
    const key = normalizeVenmoName(txn.from);
    if (key === '') {
      preview.unmatched.push({ ...row, reason: 'This transaction has no sender name to match on' });
      continue;
    }
    const hits = byKey.get(key) ?? [];
    if (hits.length === 0) {
      preview.unmatched.push({
        ...row,
        reason: `No client matches the Venmo name “${txn.from}”. Add it to their row in Clients and check the file again.`,
      });
      continue;
    }
    if (hits.length > 1) {
      preview.unmatched.push({
        ...row,
        reason: `More than one client is set up under the Venmo name “${txn.from}” (${hits
          .map((h) => h.label)
          .join(', ')}). Give them different Venmo usernames in Clients.`,
      });
      continue;
    }
    const client = hits[0];
    const candidates = rankCandidates(txn, bookingsByClient.get(client.endUserId) ?? []);
    if (candidates.length === 0) {
      preview.unmatched.push({
        ...row,
        reason: `${client.label} has no unpaid booking of $${txn.amount} or more.`,
      });
      continue;
    }
    if (candidates.length === 1) {
      preview.matched.push({
        ...row,
        endUserId: client.endUserId,
        clientLabel: client.label,
        bookingId: candidates[0].bookingId,
        bookingLabel: candidates[0].label,
      });
      continue;
    }
    preview.ambiguous.push({
      ...row,
      endUserId: client.endUserId,
      clientLabel: client.label,
      candidates: candidates.map((c) => ({
        bookingId: c.bookingId,
        label: c.label,
        balance: c.balance,
      })),
    });
  }
  return preview;
}
