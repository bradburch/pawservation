/**
 * Rules shared by every payment importer (Venmo today, a generic mapped-CSV importer next): what
 * counts as a whole-dollar amount, how a cell gets made safe to echo and store, how a payer name
 * folds onto a client, and when that fold is too ambiguous to trust. These live in one place so a
 * second importer cannot quietly drift from the first about what an amount is or when a name is
 * ambiguous — two independently-tuned copies of "is this $45.50 or cents" is exactly the kind of
 * divergence this module exists to prevent.
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
