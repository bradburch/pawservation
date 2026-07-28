import { describe, expect, it } from 'vitest';
import {
  MAX_VENMO_ROWS,
  normalizeVenmoName,
  parseAmount,
  parseVenmoCsv,
  sanitizeCell,
} from '../lib/venmo';

/**
 * A realistic Venmo statement export. Shape verified against a real one:
 *  - two preamble rows before the header, every row led by an EMPTY column;
 *  - a beginning-balance row and an ending-balance/disclaimer row with a BLANK Datetime;
 *  - amounts as "+ $250.00" / "- $250.00";
 *  - "Venmo balance" landing under Destination rather than Funding Source (Venmo's own drift —
 *    the parser must look columns up by header name, never by position).
 */
const HEADER =
  ',ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (fee),' +
  'Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,' +
  'Terminal Location,Year to Date Venmo Fees,Disclaimer';

const VENMO_CSV = [
  'Account Statement - (@Sunny-Paws) - July 1st to August 1st 2026 ,,,,,,,,,,,,,,,,,,',
  'Account Activity,,,,,,,,,,,,,,,,,,',
  HEADER,
  ',,,,,,,,,,,,,$0.00,,,,,',
  // Jess Demo owes $250 on seed_sp_board1 and paid exactly that.
  ',4139874112233445566,2026-07-03T14:22:11,Payment,Complete,Boarding for Bella,Jess Demo,Sunny Paws,+ $250.00,,,,Venmo balance,,,,Venmo,,',
  // A client the sitter has never added.
  ',4139874112233445567,2026-07-05T09:01:44,Charge,Complete,walks,Tina Alvarez,Sunny Paws,+ $40.00,,,,Venmo balance,,,,Venmo,,',
  // Money OUT — a bank transfer, not a client payment.
  ',4139874112233445568,2026-07-06T18:30:02,Standard Transfer,Issued,,,,- $250.00,,,,ALLY BANK *9391,,,,Venmo,,',
  // Not settled yet.
  ',4139874112233445569,2026-07-07T11:15:00,Payment,Pending,deposit,Rob Nguyen,Sunny Paws,+ $60.00,,,,Venmo balance,,,,Venmo,,',
  ',,,,,,,,,,,,,,$40.00,$0.00,,$0.00,',
  ',,,,,,,,,,,,,,,,,,"In case of errors or questions about your electronic transfers, telephone us at 1-855-812-4430."',
  '',
].join('\n');

describe('parseVenmoCsv', () => {
  it('reads only completed incoming client payments out of a real export', () => {
    const result = parseVenmoCsv(VENMO_CSV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incoming).toEqual([
      {
        txnId: '4139874112233445566',
        date: '2026-07-03',
        type: 'Payment',
        status: 'Complete',
        note: 'Boarding for Bella',
        from: 'Jess Demo',
        amount: 250,
      },
      {
        txnId: '4139874112233445567',
        date: '2026-07-05',
        type: 'Charge',
        status: 'Complete',
        note: 'walks',
        from: 'Tina Alvarez',
        amount: 40,
      },
    ]);
    // The outgoing transfer and the pending payment are counted, never guessed at; the balance
    // and disclaimer rows (blank Datetime) are not transactions at all.
    expect(result.ignored).toBe(2);
    expect(result.problems).toEqual([]);
  });

  it('finds the header by its cells, so an extra preamble line is harmless', () => {
    const withExtra = VENMO_CSV.replace('Account Activity', 'Something New\nAccount Activity');
    const result = parseVenmoCsv(withExtra);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.incoming).toHaveLength(2);
  });

  it('rejects a file that is not a Venmo export at all', () => {
    const result = parseVenmoCsv('Client Email,Client Name,Pet Name,Pet Type\na@b.com,A,Rex,dog\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Venmo/);
  });

  it('rejects an empty file', () => {
    expect(parseVenmoCsv('').ok).toBe(false);
    expect(parseVenmoCsv('   \n').ok).toBe(false);
  });

  it('reports a cents amount instead of rounding it', () => {
    const csv = VENMO_CSV.replace('+ $250.00', '+ $250.50');
    const result = parseVenmoCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.incoming.map((t) => t.txnId)).toEqual(['4139874112233445567']);
    expect(result.problems).toEqual([
      {
        row: 5,
        reason: 'Couldn’t read the amount "+ $250.50" — Pawservation records whole dollars',
      },
    ]);
  });

  it('caps the number of transactions instead of running an unbounded import', () => {
    const row = (i: number) =>
      `,41398741122334${String(100000 + i)},2026-07-03T14:22:11,Payment,Complete,n,Jess Demo,Sunny Paws,+ $10.00,,,,Venmo balance,,,,Venmo,,`;
    const many = ['x,,', 'Account Activity,,', HEADER]
      .concat(Array.from({ length: MAX_VENMO_ROWS + 1 }, (_, i) => row(i)))
      .join('\n');
    const result = parseVenmoCsv(many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_VENMO_ROWS));
  });

  it('drops a duplicated transaction id inside one file', () => {
    const dupe = VENMO_CSV.replace('4139874112233445567', '4139874112233445566');
    const result = parseVenmoCsv(dupe);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.incoming).toHaveLength(1);
  });
});

describe('sanitizeCell', () => {
  it('defuses a spreadsheet formula and flattens control characters', () => {
    expect(sanitizeCell('=HYPERLINK("http://evil","click")')).toBe(
      '\'=HYPERLINK("http://evil","click")',
    );
    expect(sanitizeCell('  @sum(1)  ')).toBe("'@sum(1)");
    expect(sanitizeCell('-2+3')).toBe("'-2+3");
    expect(sanitizeCell('walks' + String.fromCharCode(7) + ' for\nBella')).toBe('walks for Bella');
  });

  it('is applied to display text only — an amount cell is parsed raw', () => {
    // "+ $45.00" starts with '+', so sanitizing BEFORE parsing would break every incoming row.
    expect(sanitizeCell('+ $45.00')).toBe("'+ $45.00");
    expect(parseAmount('+ $45.00')).toEqual({ sign: '+', dollars: 45 });
  });
});

describe('parseAmount', () => {
  it('reads whole dollars with either sign and refuses everything else', () => {
    expect(parseAmount('- $885.00')).toEqual({ sign: '-', dollars: 885 });
    expect(parseAmount('$1,250.00')).toEqual({ sign: '+', dollars: 1250 });
    expect(parseAmount('+ $250.50')).toBeNull();
    expect(parseAmount('$0.00')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('lots')).toBeNull();
  });
});

describe('normalizeVenmoName', () => {
  it('collapses handle punctuation so a name and a handle can meet', () => {
    expect(normalizeVenmoName('@Jess-Demo')).toBe('jessdemo');
    expect(normalizeVenmoName('Jess Demo')).toBe('jessdemo');
    expect(normalizeVenmoName('  jess_demo ')).toBe('jessdemo');
    expect(normalizeVenmoName('@@')).toBe('');
  });
});
