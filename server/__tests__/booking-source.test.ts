import { describe, expect, it } from 'vitest';
import { insertBookingRequest } from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

describe('BookingRequests.Source', () => {
  it('stores the source when given and NULL when omitted', async () => {
    const { env, raw } = createTestEnv();
    const withSource = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2028-09-01',
      endDate: '2028-09-03',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 100,
      status: 'pending',
      source: 'mcp',
    });
    const withoutSource = await insertBookingRequest(env.PAWBOOK_DB, TENANT_A, {
      endUserId: null,
      serviceType: 'boarding',
      startDate: '2028-09-05',
      endDate: '2028-09-06',
      optionKey: 'standard',
      petType: 'dog',
      petCount: 1,
      estCost: 50,
      status: 'pending',
    });
    const rows = raw
      .prepare('SELECT Id, Source FROM BookingRequests WHERE Id IN (?, ?)')
      .all(withSource, withoutSource) as { Id: string; Source: string | null }[];
    expect(rows.find((r) => r.Id === withSource)?.Source).toBe('mcp');
    expect(rows.find((r) => r.Id === withoutSource)?.Source).toBeNull();
  });
});
