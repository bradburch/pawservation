import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { setProviderTokens } from '../db/repo';
import { syncBookingToCalendar } from '../lib/calendar-sync';
import { encryptToken } from '../lib/token-crypto';
import { adminHeaders, createTestEnv, endUserToken, TENANT_B, TEST_SECRET } from './helpers';
import { DEFAULT_TIMEZONE } from '../../src/shared/index.js';
import type { Tenant } from '../types';

/**
 * Persona scenarios: Dana runs Happy Tails (TENANT_B, slug 'happy-tails') — walks + drop-ins with
 * timed visit windows. She has NEVER connected Google Calendar (seed.sql seeds her
 * ProviderConnections row with Status='disconnected'), and connects it only partway through this
 * suite's timeline. These tests probe what "absent or late calendar sync" actually does to the
 * booking lifecycle, using the real request pipeline where the scenario is about the lifecycle
 * (booking creation, admin confirm) and the pure `syncBookingToCalendar` unit (as in
 * calendar-sync.test.ts) where the scenario is about exact event shape.
 */

function bearerBody(init: RequestInit) {
  return JSON.parse((init.body as string) ?? '{}');
}

/** Mirrors calendar-sync.test.ts's connectCalendar helper, parametrized by tenant. */
async function connectCalendar(env: Env, tenantId: string, expiresAt: string) {
  await setProviderTokens(env.PAWBOOK_DB, tenantId, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt,
    calendarId: 'primary',
  });
}

function seedBooking(
  raw: { exec: (s: string) => void },
  id: string,
  fields: {
    serviceType: string;
    startDate: string;
    endDate: string | null;
    startTime?: string | null;
  },
) {
  const endDate = fields.endDate ? `'${fields.endDate}'` : 'NULL';
  const startTime = fields.startTime ? `'${fields.startTime}'` : 'NULL';
  raw.exec(`INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, StartTime, PetCount, EstCost, Status)
            VALUES ('${id}', '${TENANT_B}', '${fields.serviceType}', '${fields.startDate}', ${endDate}, ${startTime}, 1, 35, 'pending')`);
}

describe('Persona: Dana (Happy Tails) — calendar sync absent/late', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('1. no connection — no Google traffic on booking', () => {
    it('customer books a timed walk; booking succeeds (201, pending, in DB) and zero fetches occur', async () => {
      const { env, raw } = createTestEnv();

      // Sanity: Happy Tails is seeded with calendar Status='disconnected' — Dana never connected.
      const conn = raw
        .prepare(
          `SELECT Status FROM ProviderConnections WHERE TenantId='tnt_happytails' AND Capability='calendar'`,
        )
        .get() as { Status: string } | undefined;
      expect(conn?.Status).toBe('disconnected');

      const token = await endUserToken(env, 'happy-tails', 'jess@example.com');
      const spy = vi.spyOn(globalThis, 'fetch');

      const res = await app.request(
        '/api/happy-tails/bookings',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'walk',
            optionKey: 'group-8-9', // timed option: StartTime 08:00, DurationMinutes 60
            startDate: '2028-11-06',
            petIds: ['pet_ht_otis'],
          }),
        },
        env,
      );

      expect(res.status).toBe(201);
      const booked = (await res.json()) as { id: string; status: string };
      expect(booked.status).toBe('pending');

      const row = raw
        .prepare(`SELECT Status, GCalEventId FROM BookingRequests WHERE Id = ?`)
        .get(booked.id) as { Status: string; GCalEventId: string | null };
      expect(row.Status).toBe('pending');
      expect(row.GCalEventId).toBeNull();

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('2. connect later — confirm catches up', () => {
    it('confirming an OLD pending booking after connecting creates its event via catch-up', async () => {
      const { env, raw } = createTestEnv();

      // seed_ht_pend1: a pending walk booked by jess on 2026-08-12, back when Dana's calendar
      // was still disconnected — so it has no GCalEventId.
      const before = raw
        .prepare(`SELECT Status, GCalEventId FROM BookingRequests WHERE Id='seed_ht_pend1'`)
        .get() as { Status: string; GCalEventId: string | null };
      expect(before.Status).toBe('pending');
      expect(before.GCalEventId).toBeNull();

      // Dana connects her calendar now (mid-stream), with a token that isn't expired.
      await connectCalendar(env, TENANT_B, '2031-01-01T00:00:00Z');

      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_ht_catchup' }), { status: 200 }));

      const res = await app.request(
        `/api/happy-tails/admin/bookings/seed_ht_pend1/status`,
        {
          method: 'POST',
          headers: { ...(await adminHeaders(TENANT_B)), 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'confirmed' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const after = raw
        .prepare(`SELECT Status, GCalEventId FROM BookingRequests WHERE Id='seed_ht_pend1'`)
        .get() as { Status: string; GCalEventId: string | null };
      expect(after.Status).toBe('confirmed');
      // A booking with no event is now created as a catch-up on confirm — the request-lifecycle
      // fix for a sitter who connected mid-stream. The event id Google returned is persisted.
      expect(after.GCalEventId).toBe('evt_ht_catchup');

      expect(spy).toHaveBeenCalledOnce();
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('POST'); // a create, not a PATCH (there was no prior event)
      expect(String(url)).toContain('/calendars/primary/events');
      const body = bearerBody(init) as { summary: string };
      expect(body.summary).toBe('Walks — 1 pet'); // confirmed, so no [REQUEST] prefix
    });
  });

  describe('3. timed event shape', () => {
    it('creates a dateTime event (not all-day) whose end = start + duration, timeZone = tenant timezone', async () => {
      const { env, raw } = createTestEnv();
      await connectCalendar(env, TENANT_B, '2031-01-01T00:00:00Z');
      raw.exec(`UPDATE Tenants SET Timezone='America/New_York' WHERE Id='${TENANT_B}'`);
      seedBooking(raw, 'w1', {
        serviceType: 'walk',
        startDate: '2028-11-06',
        endDate: null,
        startTime: '08:00',
      });
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_w1' }), { status: 200 }));

      const tenant = { Id: TENANT_B, Slug: 'happy-tails', Timezone: 'America/New_York' } as Tenant;
      await syncBookingToCalendar(env, tenant, {
        bookingId: 'w1',
        endUserId: null,
        serviceType: 'walk',
        serviceLabel: 'Walks',
        startDate: '2028-11-06',
        endDate: null,
        startTime: '08:00',
        durationMinutes: 60,
        petCount: 1,
        petNames: [],
        estCost: 18,
        status: 'pending',
      });

      expect(spy).toHaveBeenCalledOnce();
      const [url, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(String(url)).toContain('googleapis.com');
      const body = bearerBody(init);
      expect(body.start).toEqual({ dateTime: '2028-11-06T08:00:00', timeZone: 'America/New_York' });
      expect(body.end).toEqual({ dateTime: '2028-11-06T09:00:00', timeZone: 'America/New_York' });

      const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='w1'`).get() as {
        GCalEventId: string;
      };
      expect(row.GCalEventId).toBe('evt_w1');
    });

    it('falls back to DEFAULT_TIMEZONE when tenant.Timezone is NULL', async () => {
      const { env, raw } = createTestEnv();
      await connectCalendar(env, TENANT_B, '2031-01-01T00:00:00Z');

      // Happy Tails is seeded with Timezone NULL — confirm the fixture assumption still holds.
      const tenantRow = raw
        .prepare(`SELECT Timezone FROM Tenants WHERE Id='${TENANT_B}'`)
        .get() as {
        Timezone: string | null;
      };
      expect(tenantRow.Timezone).toBeNull();

      seedBooking(raw, 'w2', {
        serviceType: 'walk',
        startDate: '2028-11-06',
        endDate: null,
        startTime: '08:00',
      });
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_w2' }), { status: 200 }));

      const tenant = { Id: TENANT_B, Slug: 'happy-tails', Timezone: null } as Tenant;
      await syncBookingToCalendar(env, tenant, {
        bookingId: 'w2',
        endUserId: null,
        serviceType: 'walk',
        serviceLabel: 'Walks',
        startDate: '2028-11-06',
        endDate: null,
        startTime: '08:00',
        durationMinutes: 60,
        petCount: 1,
        petNames: [],
        estCost: 18,
        status: 'pending',
      });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = bearerBody(init);
      expect(body.start).toEqual({ dateTime: '2028-11-06T08:00:00', timeZone: DEFAULT_TIMEZONE });
      expect(body.end).toEqual({ dateTime: '2028-11-06T09:00:00', timeZone: DEFAULT_TIMEZONE });
    });
  });

  describe('4. multi-day (boarding) event shape', () => {
    it('produces an all-day event using the given endDate (exclusive, as-is)', async () => {
      const { env, raw } = createTestEnv();
      await connectCalendar(env, TENANT_B, '2031-01-01T00:00:00Z');
      seedBooking(raw, 'b_board1', {
        serviceType: 'boarding',
        startDate: '2028-11-10',
        endDate: '2028-11-13',
      });
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_board1' }), { status: 200 }));

      const tenant = { Id: TENANT_B, Slug: 'happy-tails', Timezone: null } as Tenant;
      await syncBookingToCalendar(env, tenant, {
        bookingId: 'b_board1',
        endUserId: null,
        serviceType: 'boarding',
        serviceLabel: 'Boarding',
        startDate: '2028-11-10',
        endDate: '2028-11-13',
        startTime: null,
        durationMinutes: null,
        petCount: 1,
        petNames: [],
        estCost: 120,
        status: 'pending',
      });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = bearerBody(init);
      expect(body.start).toEqual({ date: '2028-11-10' });
      expect(body.end).toEqual({ date: '2028-11-13' }); // exclusive end date, passed through as-is
    });

    it('falls back to start+1 when endDate is null', async () => {
      const { env, raw } = createTestEnv();
      await connectCalendar(env, TENANT_B, '2031-01-01T00:00:00Z');
      seedBooking(raw, 'b_day1', {
        serviceType: 'daycare',
        startDate: '2028-11-20',
        endDate: null,
      });
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ id: 'evt_day1' }), { status: 200 }));

      const tenant = { Id: TENANT_B, Slug: 'happy-tails', Timezone: null } as Tenant;
      await syncBookingToCalendar(env, tenant, {
        bookingId: 'b_day1',
        endUserId: null,
        serviceType: 'daycare',
        serviceLabel: 'Day care',
        startDate: '2028-11-20',
        endDate: null,
        startTime: null,
        durationMinutes: null,
        petCount: 1,
        petNames: [],
        estCost: 35,
        status: 'pending',
      });

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      const body = bearerBody(init);
      expect(body.start).toEqual({ date: '2028-11-20' });
      expect(body.end).toEqual({ date: '2028-11-21' }); // start + 1 day, exclusive-end convention
    });
  });
});
