import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { adminHeaders, createTestEnv, TENANT_A, TEST_SECRET } from './helpers';

// Copied from calendar-reconcile.test.ts (:32, :50) — Google is stubbed at fetch, there is no
// injection seam for listCalendarEvents.
async function connectCalendar(env: Env) {
  await setProviderTokens(env.PAWSERVATION_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt: '2030-01-01T00:00:00Z', // far future — no refresh-token fetch needed
    calendarId: 'primary',
  });
}

type FakeEvent = {
  id?: string;
  summary?: string;
  status?: string;
  bookingId?: string; // present → a Pawservation event
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
};

function calendarResponse(events: FakeEvent[]) {
  return new Response(
    JSON.stringify({
      items: events.map((e) => ({
        id: e.id ?? 'evt_anon',
        summary: e.summary ?? 'Boarding',
        status: e.status ?? 'confirmed',
        updated: '2026-07-27T00:00:00Z',
        start: e.start ?? { date: '2026-06-10' },
        end: e.end ?? { date: '2026-06-13' },
        ...(e.bookingId
          ? {
              extendedProperties: {
                private: { pawservation: 'true', category: 'boarding', bookingId: e.bookingId },
              },
            }
          : {}),
      })),
    }),
    { status: 200 },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('POST /:slug/admin/calendar/backfill/preview', () => {
  it('refuses a range with more events than the cap, naming the count', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    // 201 events, one over MAX_BACKFILL_EVENTS.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      calendarResponse(
        Array.from({ length: 201 }, (_, i) => ({ id: `ev${i}`, summary: 'Sadie Walk' })),
      ),
    );

    const res = await app.request(
      '/api/sunny-paws/admin/calendar/backfill/preview',
      {
        method: 'POST',
        headers: await adminHeaders(TENANT_A),
        body: JSON.stringify({ from: '2026-01-01', to: '2026-12-31' }),
      },
      env,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('201');
  });

  it('refuses a malformed range', async () => {
    const { env } = await createTestEnv();
    await connectCalendar(env);
    const res = await app.request(
      '/api/sunny-paws/admin/calendar/backfill/preview',
      {
        method: 'POST',
        headers: await adminHeaders(TENANT_A),
        body: JSON.stringify({ from: '2026-12-31', to: '2026-01-01' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });
});
