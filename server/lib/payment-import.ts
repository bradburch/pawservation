/**
 * Rules shared by every payment importer (Venmo today, a generic mapped-CSV importer next): what
 * counts as an importable amount, how a cell gets made safe to echo and store, how a payer name
 * folds onto a client, and when that fold is too ambiguous to trust. These live in one place so a
 * second importer cannot quietly drift from the first about what an amount is or when a name is
 * ambiguous — two independently-tuned copies of "is this $45.50 or is it 45.50 cents" is exactly
 * the kind of divergence this module exists to prevent.
 *
 * PURE. No D1, no env, no fetch — every function here takes plain data and returns plain data.
 */

// Built from character codes rather than a regex literal with an embedded control-character range
// (e.g. /[\x00-\x1f]/), which trips ESLint's no-control-regex rule -- see server/lib/email.ts for
// the same pattern. Matches every C0 control character plus DEL, flattened to a space (never
// dropped mid-word).
const CONTROL_CHARS = new RegExp(
  '[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']',
  'g',
);

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
 * "+ $45.50" → { sign: '+', cents: 4550 }. The unit is CENTS because that is what the ledger
 * stores (0015) and what both importers hand to `insertAccountPayment`.
 *
 * A FRACTIONAL AMOUNT IS RECORDED, NOT REFUSED. It used to be reported back to the sitter for her
 * to enter by hand, because the ledger could not hold it; the ledger can, so refusing it would be
 * this module inventing a limitation the storage no longer has. A payment is what a person
 * actually sent.
 *
 * THE FLOOR IS ONE CENT, not one dollar. Below that there is no payment to record, which is a
 * different sentence from "we cannot represent this" — `payment-csv.ts` says so for the `$0` case
 * specifically. `Payments.Amount CHECK (Amount > 0)` backstops it in the column.
 *
 * WHAT DID NOT MOVE: the sign. A negative row is a refund, which this model cannot represent at
 * all, so it comes back with `sign: '-'` for the importers to report — never coerced positive.
 * And the mapped-CSV dedupe key is unaffected: it hashes `formatCentsForKey(cents)`, which writes
 * "45" for 4500 and "45.50" for 4550, so every key an existing whole-dollar row already has is
 * byte-identical and a re-uploaded export still dedupes (`payment-csv.ts`, `applyMapping`).
 */
export function parseAmount(raw: string): { sign: '+' | '-'; cents: number } | null {
  const m = /^\s*([+-])?\s*\$?\s*([\d,]+)(?:\.(\d{1,2}))?\s*$/.exec(
    raw.replace(new RegExp(String.fromCharCode(160), 'g'), ' '),
  );
  if (!m) return null;
  // `padEnd` before `Number`, so "$45.5" is 50 cents rather than 5 — one decimal place means
  // tenths of a dollar, and a sitter's export writes it either way.
  const frac = m[3] === undefined ? 0 : Number(m[3].padEnd(2, '0'));
  const whole = Number(m[2].replace(/,/g, ''));
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents) || cents < 1) return null;
  return { sign: m[1] === '-' ? '-' : '+', cents };
}

/**
 * Fold a Venmo display name and a Venmo handle onto one key: lowercase, drop a leading '@', drop
 * every non-alphanumeric character. Deliberately lossy — it is what lets "Jess Demo" (the `From`
 * column) meet "@Jess-Demo" (the handle) with the sitter typing nothing. The cost is that two
 * clients CAN collide onto one key; the matcher refuses to guess between them (see matchVenmoTxns).
 */
export function normalizePayerName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * A client, reduced to what matching needs. `label` is what the sitter sees (name or email).
 * `accountId` is the household this client belongs to (`buildAccounts`'s account id, the
 * lexicographically-first pet of the component) — or `null` for a client who owns no live pet and
 * therefore belongs to no household at all, the one case a Venmo payment cannot be recorded against
 * without inventing a household for them.
 */
export type MatchClient = {
  endUserId: string;
  label: string;
  name: string | null;
  venmoUsername: string | null;
  accountId: string | null;
};

/**
 * Resolve a Venmo `From` name to exactly one client. Returns `null` for an empty normalized key,
 * no matching client, or MORE THAN ONE matching client — a collision is refused, never guessed
 * at. This is the ONLY place that decision is made: `matchVenmoTxns` (preview) and the confirm
 * route in `routes/admin.ts` both call this, so a name that resolves ambiguously in one can never
 * silently resolve — to a different client, via last-writer-wins or otherwise — in the other.
 */
export function resolveMatchClient(clients: MatchClient[], from: string): MatchClient | null {
  const key = normalizePayerName(from);
  if (key === '') return null;
  const hits = clients.filter((c) => normalizePayerName(c.venmoUsername ?? c.name ?? '') === key);
  return hits.length === 1 ? hits[0] : null;
}
