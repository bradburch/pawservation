import { describe, expect, it } from 'vitest';
import { matchVenmoTxns, type MatchClient, type VenmoTxn } from '../lib/venmo';

const txn = (over: Partial<VenmoTxn> = {}): VenmoTxn => ({
  txnId: 't1',
  date: '2026-07-03',
  type: 'Payment',
  status: 'Complete',
  note: 'Boarding',
  from: 'Jess Demo',
  amount: 250,
  ...over,
});

const jess: MatchClient = {
  endUserId: 'eu_1',
  label: 'Jess Demo',
  name: 'Jess Demo',
  venmoUsername: null,
  accountId: 'p_rex',
};

const run = (over: Partial<Parameters<typeof matchVenmoTxns>[0]> = {}) =>
  matchVenmoTxns({
    txns: [txn()],
    clients: [jess],
    alreadyImported: new Set<string>(),
    ...over,
  });

/**
 * Story 2.5 — VENMO IMPORT RECORDS AGAINST HOUSEHOLDS (supports FR-7a). Once a payer resolves to
 * exactly one client, resolving further to a SPECIFIC BOOKING is no longer this module's job at
 * all: the payment goes to that client's household (0011), whatever it's for. There is deliberately
 * no "ambiguous — which booking?" bucket any more, because there is nothing left to be ambiguous
 * about once the household is known — `buildAccounts` partitions owners into exactly one household
 * each, never several.
 */
describe('matchVenmoTxns', () => {
  it('matches a client by name straight to their household', () => {
    const preview = run();
    expect(preview.matched).toEqual([
      {
        txnId: 't1',
        date: '2026-07-03',
        amount: 250,
        from: 'Jess Demo',
        note: 'Boarding',
        endUserId: 'eu_1',
        clientLabel: 'Jess Demo',
        accountId: 'p_rex',
      },
    ]);
    expect(preview.unmatched).toEqual([]);
  });

  it('matches on VenmoUsername when the handle is nothing like the name', () => {
    const preview = run({
      txns: [txn({ from: '@sunny-jess-99' })],
      clients: [{ ...jess, venmoUsername: 'sunny-jess-99' }],
    });
    expect(preview.matched).toHaveLength(1);
  });

  it('prefers VenmoUsername over Name once it is set', () => {
    const preview = run({
      txns: [txn({ from: 'Jess Demo' })],
      clients: [{ ...jess, venmoUsername: 'someone-else' }],
    });
    expect(preview.matched).toEqual([]);
    expect(preview.unmatched[0].reason).toMatch(/No client/);
  });

  it('surfaces a client who has no pets on file, rather than guessing which household', () => {
    // A client with no pets belongs to no household at all — buildAccounts derives nothing to
    // attach the payment to, and this module refuses to invent one.
    const preview = run({ clients: [{ ...jess, accountId: null }] });
    expect(preview.matched).toEqual([]);
    expect(preview.unmatched).toHaveLength(1);
    expect(preview.unmatched[0].reason).toMatch(/no pets on file/);
  });

  it('refuses to guess between two clients sharing one Venmo name', () => {
    const preview = run({
      clients: [jess, { ...jess, endUserId: 'eu_2', label: 'jess@other.example' }],
    });
    expect(preview.matched).toEqual([]);
    expect(preview.unmatched[0].reason).toMatch(/More than one client/);
  });

  it('reports a sender nobody is set up for, and a row with no sender at all', () => {
    const preview = run({ txns: [txn({ from: 'Tina Alvarez' }), txn({ txnId: 't2', from: '' })] });
    expect(preview.unmatched.map((u) => u.txnId)).toEqual(['t1', 't2']);
    expect(preview.unmatched[1].reason).toMatch(/no sender/i);
  });

  it('puts an already-imported transaction in its own bucket and proposes nothing', () => {
    const preview = run({ alreadyImported: new Set(['t1']) });
    expect(preview.matched).toEqual([]);
    expect(preview.alreadyImported.map((r) => r.txnId)).toEqual(['t1']);
  });

  it('ignores a client with neither a name nor a handle to match on', () => {
    const preview = run({
      txns: [txn({ from: '' })],
      clients: [
        {
          endUserId: 'eu_3',
          label: 'x@y.example',
          name: null,
          venmoUsername: null,
          accountId: null,
        },
      ],
    });
    expect(preview.matched).toEqual([]);
    expect(preview.unmatched).toHaveLength(1);
  });

  it('never proposes over-paying anything — a household payment carries no balance to exceed', () => {
    // A prepayment far larger than anything owed is still legitimate (Story 2.3): the amount is
    // never checked against a balance here at all.
    const preview = run({ txns: [txn({ amount: 100000 })] });
    expect(preview.matched).toEqual([{ ...preview.matched[0], amount: 100000 }]);
  });
});
