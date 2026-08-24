/**
 * Minimal RFC4180-ish CSV parser tailored to this codebase's only CSV use: the fixed
 * client/pet import format (see docs/superpowers/specs/2026-07-10-csv-client-import-design.md),
 * whose free-text fields (e.g. a quoted Client Name) may contain newlines pasted from a spreadsheet.
 *
 * It runs a single-pass state machine over the whole input string (not line-by-line), so a
 * quoted field spanning multiple physical lines stays in one cell / one row:
 *  - `"` outside a quoted field opens one; inside a quoted field `""` is a literal `"` and a
 *    lone `"` closes the field.
 *  - `,` outside quotes ends a cell.
 *  - `\r\n`, lone `\r`, and lone `\n` outside quotes each end a row (a CRLF is one row break).
 *  - Any newline inside a quoted field is kept as a literal character in the cell.
 *
 * A hand-rolled parser avoids a dependency for this narrow, well-defined need.
 */
export function parseCsvRows(text: string): string[][] {
  if (text === '') return [];
  const rows: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      // Row terminator: \r\n counts as a single break.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      cell = '';
      rows.push(cells);
      cells = [];
    } else {
      cell += ch;
    }
  }

  cells.push(cell);
  rows.push(cells);
  return rows;
}

/** One cell as a caller hands it over. `null`/`undefined` are written as an empty cell. */
export type CsvValue = string | number | null | undefined;

/**
 * The characters that make a spreadsheet read a cell as a FORMULA rather than as text. A client
 * name, a care note or a payment note is text the sitter's clients typed, and it lands in Excel or
 * Sheets: a note beginning `=HYPERLINK(...)` or `+cmd|...` is executed on open, which is CSV
 * injection (OWASP). Tab and CR are here for the same reason — both are stripped by some importers
 * before the leading character is judged, so `\t=1+1` can arrive at the formula parser as `=1+1`.
 *
 * `-` costs us nothing to include: every genuinely numeric field this codebase exports (an amount,
 * a count) is handed over as a `number`, and numbers are never neutralised.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * One cell, RFC 4180: wrapped in double quotes when it contains a comma, a double quote, a CR or an
 * LF, with each embedded quote doubled.
 *
 * A cell that had to be neutralised is ALWAYS quoted, even though the apostrophe needs no escaping —
 * the guard is only worth anything if the spreadsheet sees the apostrophe as the cell's first
 * character, and quoting is what guarantees that whatever the importer does with surrounding
 * whitespace.
 */
function encodeCsvCell(value: CsvValue): string {
  if (value == null) return '';
  // A number is never a formula, so it is never neutralised — that is what keeps a negative amount
  // reading as -45 rather than as the literal text '-45.
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  const neutralised = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return neutralised !== value || /[",\r\n]/.test(neutralised)
    ? `"${neutralised.replaceAll('"', '""')}"`
    : neutralised;
}

/**
 * Rows (the first is the header, by convention of every caller) to one CSV string, CRLF-separated
 * per RFC 4180.
 *
 * Deliberately NO trailing newline: `parseCsvRows` above reads one as a final empty row, and these
 * two functions being exact inverses is what lets a test prove a comma-and-quote-bearing name
 * survives the round trip. Excel and Sheets are indifferent either way.
 *
 * ponytail: builds the whole file in memory. One sitter's book is thousands of rows at the outside,
 * so this is a few hundred KB; if a tenant ever outgrows that, the upgrade path is a streamed
 * `ReadableStream` body writing row by row — not a library.
 */
export function serializeCsvRows(rows: CsvValue[][]): string {
  return rows.map((row) => row.map(encodeCsvCell).join(',')).join('\r\n');
}
