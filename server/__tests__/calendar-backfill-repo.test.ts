import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  insertBackfilledBooking,
  listActiveAdoptedEventIds,
  listAdoptedEventIds,
} from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

const ROW = {
  endUserId: 'u1',
  serviceType: 'walk',
  startDate: '2026-07-01',
  endDate: null,
  optionKey: 'standard',
  petCount: 1,
  estCost: 25,
  status: 'confirmed' as const,
  gcalEventId: 'ev1',
};

// BookingRequests.EndUserId is FK-enforced (schema.sql), and neither the base seed nor the brief's
// ROW fixture provides a 'u1' EndUsers row — insert one directly on the raw handle so the FK is
// satisfied without touching helpers.ts or the seed data other tests depend on.
function seedEndUser(raw: DatabaseSync, tenantId: string, id: string): void {
  raw
    .prepare(`INSERT INTO EndUsers (Id, TenantId, Email) VALUES (?, ?, ?)`)
    .run(id, tenantId, `${id}@example.com`);
}

describe('insertBackfilledBooking', () => {
  it('stores the event id and leaves SyncPending OFF', async () => {
    const { env, raw } = await createTestEnv();
    seedEndUser(raw, TENANT_A, 'u1');
    const id = await insertBackfilledBooking(env.PAWSERVATION_DB, TENANT_A, ROW);

    const row = await env.PAWSERVATION_DB.prepare(
      'SELECT GCalEventId, SyncPending, Source, EstCost FROM BookingRequests WHERE Id = ?',
    )
      .bind(id)
      .first<{ GCalEventId: string; SyncPending: number; Source: string; EstCost: number }>();

    expect(row?.GCalEventId).toBe('ev1');
    // The whole point: an adopted row must never push an event back to Google.
    expect(row?.SyncPending).toBe(0);
    expect(row?.Source).toBe('calendar-backfill');
    expect(row?.EstCost).toBe(25);
  });

  it('lists adopted event ids for the tenant, and only that tenant', async () => {
    const { env, raw } = await createTestEnv();
    seedEndUser(raw, TENANT_A, 'u1');
    await insertBackfilledBooking(env.PAWSERVATION_DB, TENANT_A, ROW);

    expect(await listAdoptedEventIds(env.PAWSERVATION_DB, TENANT_A)).toEqual(new Set(['ev1']));
    expect(await listAdoptedEventIds(env.PAWSERVATION_DB, 'tnt_happytails')).toEqual(new Set());
  });

  // The two functions serve opposite roles and must disagree on a cancelled adoption:
  // listAdoptedEventIds is the IMPORT's idempotency key (a re-run must not re-adopt an event whose
  // booking was since cancelled — that would create a duplicate), while listActiveAdoptedEventIds
  // is RECONCILE's live-booking check (a cancelled adoption must fall back to being an ordinary
  // external blocker, or a live Google event blocks nothing).
  it('a cancelled adoption still counts for import idempotency, but not for reconcile’s live check', async () => {
    const { env, raw } = await createTestEnv();
    seedEndUser(raw, TENANT_A, 'u1');
    await insertBackfilledBooking(env.PAWSERVATION_DB, TENANT_A, {
      ...ROW,
      status: 'cancelled',
      gcalEventId: 'ev_cancelled',
    });

    expect(await listAdoptedEventIds(env.PAWSERVATION_DB, TENANT_A)).toEqual(
      new Set(['ev_cancelled']),
    );
    expect(await listActiveAdoptedEventIds(env.PAWSERVATION_DB, TENANT_A)).toEqual(new Set());
  });
});
