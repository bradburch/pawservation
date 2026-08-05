import { describe, expect, it } from 'vitest';
import app from '../index';
import {
  addBookingPets,
  insertAccountPayment,
  insertBookingRequest,
  insertInvitedCustomer,
} from '../db/repo';
import { createTestEnv, endUserToken, seedPets } from './helpers';

const TENANT_C = 'tnt_pawsandrelax'; // seeded clean slate: customers, no bookings
const SLUG_C = 'paws-and-relax';

/**
 * `GET /:slug/account` IS A CUSTOMER-FACING, POLLABLE ROUTE. `llms.txt` tells an agent to hold a
 * long-lived personal access token and call it, so its cost is no longer admin-frequency work: it
 * is whatever a client's automation decides to do, times every client.
 *
 * It used to answer one household's question with several TENANT-WIDE reads — every booking with
 * its payment and charge aggregates, every booking<->pet edge, every customer — and union-find over
 * all of it. One customer's poll therefore did work proportional to the sitter's ENTIRE book, and
 * every other household's bookings were read to produce a number that cannot depend on them.
 *
 * The measurement below is the property, not a benchmark: rows read while serving one caller must
 * not move when OTHER households book more. It is asserted by counting rows through a wrapper
 * around the D1 binding, so it stays honest as the SQL changes.
 */
type Counts = { queries: number; rows: number };

function countingDb(db: D1Database): { db: D1Database; counts: Counts } {
  const counts: Counts = { queries: 0, rows: 0 };
  type Stmt = {
    bind: (...args: unknown[]) => Stmt;
    all: () => Promise<{ results: unknown[] }>;
    first: () => Promise<unknown>;
    run: () => Promise<unknown>;
  };
  const wrap = (stmt: Stmt): Stmt => ({
    bind: (...args: unknown[]) => wrap(stmt.bind(...args)),
    all: async () => {
      counts.queries++;
      const res = await stmt.all();
      counts.rows += res.results.length;
      return res;
    },
    first: async () => {
      counts.queries++;
      const row = await stmt.first();
      if (row !== null && row !== undefined) counts.rows += 1;
      return row;
    },
    run: async () => {
      counts.queries++;
      return stmt.run();
    },
  });
  const inner = db as unknown as { prepare: (sql: string) => Stmt; batch: unknown };
  return {
    counts,
    db: {
      prepare: (sql: string) => wrap(inner.prepare(sql)),
      batch: inner.batch,
    } as unknown as D1Database,
  };
}

async function book(env: Env, endUserId: string, petIds: string[], estCost: number) {
  const id = await insertBookingRequest(env.PAWBOOK_DB, TENANT_C, {
    endUserId,
    serviceType: 'boarding',
    startDate: '2030-01-01',
    endDate: '2030-01-03',
    optionKey: 'standard',
    petCount: 1,
    estCost,
    status: 'confirmed',
  });
  await addBookingPets(env.PAWBOOK_DB, TENANT_C, id, petIds);
  return id;
}

/**
 * One caller with one booking and one household payment, plus `others` OTHER households holding
 * `bookingsEach` bookings apiece. Only the second number varies between the two measurements, so
 * any difference in rows read is other households' BOOKINGS being read to serve this caller.
 */
async function measureAccountRead(bookingsEach: number): Promise<Counts & { body: unknown }> {
  const { env, raw } = createTestEnv();
  const me = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_C, 'me@example.com', 'Me');
  seedPets(raw, TENANT_C, me.Id, [{ id: 'p_mine', petType: 'dog' }]);
  await book(env, me.Id, ['p_mine'], 100);
  await insertAccountPayment(env.PAWBOOK_DB, TENANT_C, {
    accountId: 'p_mine',
    amount: 40,
    method: 'venmo',
    paidDate: '2026-07-01',
    note: null,
    externalRef: null,
  });

  for (let i = 0; i < 12; i++) {
    const other = await insertInvitedCustomer(
      env.PAWBOOK_DB,
      TENANT_C,
      `other${i}@example.com`,
      `Other ${i}`,
    );
    seedPets(raw, TENANT_C, other.Id, [{ id: `p_other${i}`, petType: 'dog' }]);
    for (let b = 0; b < bookingsEach; b++) await book(env, other.Id, [`p_other${i}`], 200);
  }

  // Token minted BEFORE the counter is attached: the login flow is not what is being measured.
  const token = await endUserToken(env, SLUG_C, 'me@example.com');
  const { db, counts } = countingDb(env.PAWBOOK_DB);
  const res = await app.request(
    `/api/${SLUG_C}/account`,
    { headers: { Authorization: `Bearer ${token}` } },
    { ...env, PAWBOOK_DB: db } as Env,
  );
  expect(res.status).toBe(200);
  return { ...counts, body: await res.json() };
}

describe('GET /:slug/account reads one household, not the whole tenant', () => {
  it('reads the same number of rows however much OTHER households book', async () => {
    const quiet = await measureAccountRead(1);
    const busy = await measureAccountRead(10);

    // The answer itself is unchanged — this is the same balance either way. (Payment ids are
    // random per fixture, so the money is compared, not the row identities.)
    const money = { expectedTotal: 100, paidTotal: 40, balance: 60 };
    expect(quiet.body).toMatchObject(money);
    expect(busy.body).toMatchObject(money);

    // …and producing it cost the same. 12 other households booking ten times each rather than
    // once is 108 extra bookings this caller's balance cannot depend on.
    expect(busy.rows).toBe(quiet.rows);
    expect(busy.queries).toBe(quiet.queries);
  });

  it('serves a poll in a bounded number of reads', async () => {
    // A ceiling, not a target: it exists so a future change that reintroduces a tenant-wide scan
    // fails here rather than silently doubling every polling client's cost.
    const busy = await measureAccountRead(10);
    expect(busy.rows).toBeLessThan(40);
    expect(busy.queries).toBeLessThan(15);
  });
});
