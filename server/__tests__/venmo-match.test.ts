import { describe, expect, it } from 'vitest';
import {
  matchVenmoTxns,
  type MatchClient,
  type OutstandingBooking,
  type VenmoTxn,
} from '../lib/venmo';

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
};

const booking = (over: Partial<OutstandingBooking> = {}): OutstandingBooking => ({
  bookingId: 'bk_1',
  endUserId: 'eu_1',
  label: 'Boarding starting 2026-07-01',
  startDate: '2026-07-01',
  balance: 250,
  ...over,
});

const run = (over: Partial<Parameters<typeof matchVenmoTxns>[0]> = {}) =>
  matchVenmoTxns({
    txns: [txn()],
    clients: [jess],
    outstanding: [booking()],
    alreadyImported: new Set<string>(),
    ...over,
  });

describe('matchVenmoTxns', () => {
  it('matches a client by name and a booking by an exact balance', () => {
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
        bookingId: 'bk_1',
        bookingLabel: 'Boarding starting 2026-07-01',
      },
    ]);
    expect(preview.ambiguous).toEqual([]);
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

  it('offers a ranked choice when several bookings could take the payment', () => {
    const preview = run({
      txns: [txn({ amount: 100, date: '2026-07-10' })],
      outstanding: [
        booking({ bookingId: 'bk_far', startDate: '2026-01-01', balance: 300 }),
        booking({ bookingId: 'bk_near', startDate: '2026-07-09', balance: 300 }),
        booking({ bookingId: 'bk_exact', startDate: '2026-03-01', balance: 100 }),
      ],
    });
    expect(preview.matched).toEqual([]);
    expect(preview.ambiguous).toHaveLength(1);
    // Exact balance first, then nearest start date, then the rest.
    expect(preview.ambiguous[0].candidates.map((c) => c.bookingId)).toEqual([
      'bk_exact',
      'bk_near',
      'bk_far',
    ]);
  });

  it('never proposes over-paying a booking', () => {
    const preview = run({ txns: [txn({ amount: 400 })] });
    expect(preview.matched).toEqual([]);
    expect(preview.unmatched[0].reason).toMatch(/no unpaid booking of \$400 or more/);
  });

  it('refuses to guess between two clients sharing one Venmo name', () => {
    const preview = run({
      clients: [jess, { ...jess, endUserId: 'eu_2', label: 'jess@other.example' }],
    });
    expect(preview.matched).toEqual([]);
    expect(preview.ambiguous).toEqual([]);
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
      clients: [{ endUserId: 'eu_3', label: 'x@y.example', name: null, venmoUsername: null }],
    });
    expect(preview.matched).toEqual([]);
    expect(preview.unmatched).toHaveLength(1);
  });
});
