/**
 * Minimal RFC4180-ish CSV row parser: splits on commas outside quotes, un-escapes `""` to `"`
 * inside a quoted field. Not a general CSV library — this codebase's only CSV use is the fixed
 * 4-column client/pet import format (see
 * docs/superpowers/specs/2026-07-10-csv-client-import-design.md), so a small hand-rolled parser
 * avoids a dependency for a narrow, well-defined need.
 */
export function parseCsvRows(text: string): string[][] {
  if (text === '') return [];
  const rows: string[][] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (const line of lines) {
    const cells: string[] = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
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
      } else {
        cell += ch;
      }
    }
    cells.push(cell);
    rows.push(cells);
  }
  return rows;
}
