import { addDays, DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/index.js';
import {
  getEndUserById,
  getProviderConnection,
  listPetNamesForBooking,
  listSyncedBookingIds,
  listUnsyncedFutureBookings,
  setBookingGCalEventId,
  setProviderTokens,
  updateBookingStatus,
} from '../db/repo';
import {
  buildEventResource,
  createEvent,
  deleteEvent,
  listCalendarEvents,
  refreshAccessToken,
  updateEvent,
} from './google-calendar';
import type { ServiceType } from './services';
import { decryptToken, encryptToken } from './token-crypto';
import type { Tenant, ProviderConnectionWithTokens } from '../types';

export type SyncInput = {
  bookingId: string;
  endUserId: string | null;
  serviceType: ServiceType; // tenant service slug — stored as the event's category
  serviceLabel: string;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  petCount: number;
  petNames: string[];
  estCost: number | null;
  status: 'pending' | 'confirmed';
};

/**
 * Build the Google event resource for a booking, resolving the customer's email for the
 * description. Shared by the create / update / backfill paths so event shaping stays identical.
 */
async function resourceForBooking(env: Env, tenant: Tenant, b: SyncInput) {
  const customer = b.endUserId
    ? await getEndUserById(env.PAWBOOK_DB, tenant.Id, b.endUserId)
    : null;
  return buildEventResource({
    serviceLabel: b.serviceLabel,
    category: b.serviceType,
    bookingId: b.bookingId,
    startDate: b.startDate,
    endDate: b.endDate,
    startTime: b.startTime,
    durationMinutes: b.durationMinutes,
    petCount: b.petCount,
    petNames: b.petNames,
    estCost: b.estCost,
    customerEmail: customer?.Email ?? null,
    status: b.status,
    timezone: tenant.Timezone ?? DEFAULT_TIMEZONE,
  });
}

/**
 * Decrypt the stored access token for a provider connection, refreshing it (and persisting the new
 * tokens) if the current token is missing or expired. Returns the plaintext access token.
 */
export async function getCalendarAccessToken(
  env: Env,
  tenant: Tenant,
  conn: ProviderConnectionWithTokens,
): Promise<string> {
  if (!conn.TokenExpiresAt || conn.TokenExpiresAt <= new Date().toISOString()) {
    const refreshToken = await decryptToken(env.TOKEN_SECRET, conn.RefreshToken!);
    const refreshed = await refreshAccessToken(env, refreshToken);
    await setProviderTokens(env.PAWBOOK_DB, tenant.Id, 'calendar', conn.Provider, {
      access: await encryptToken(env.TOKEN_SECRET, refreshed.accessToken),
      refresh: conn.RefreshToken!,
      expiresAt: refreshed.expiresAt,
      calendarId: conn.CalendarId ?? 'primary',
    });
    return refreshed.accessToken;
  }
  return decryptToken(env.TOKEN_SECRET, conn.AccessToken!);
}

/**
 * Persist a freshly-created Google event id via compare-and-swap, guarding against the duplicate-
 * event race: two near-simultaneous writers can each read GCalEventId as `expectedOld` and both
 * create an event. The CAS lets only one win; if this call lost, its event is a would-be orphan, so
 * we best-effort delete it (swallowing errors). `expectedOld` is NULL for a first create, or the
 * stale id when recreating a hand-deleted event.
 */
async function persistEventIdOrCleanup(
  env: Env,
  tenant: Tenant,
  accessToken: string,
  calendarId: string,
  bookingId: string,
  eventId: string,
  expectedOld: string | null,
): Promise<void> {
  const stuck = await setBookingGCalEventId(
    env.PAWBOOK_DB,
    tenant.Id,
    bookingId,
    eventId,
    expectedOld,
  );
  if (!stuck) {
    await deleteEvent(accessToken, calendarId, eventId).catch(() => {});
  }
}

/**
 * Best-effort: create a Google Calendar event for a booking and persist its id. Callers run this
 * via executionCtx.waitUntil and ignore rejections — a Google failure must never affect a booking.
 * The id is stored with a NULL-expected compare-and-swap so a concurrent writer can't leave a
 * duplicate event orphaned (see persistEventIdOrCleanup).
 */
export async function syncBookingToCalendar(env: Env, tenant: Tenant, b: SyncInput): Promise<void> {
  const conn = await getProviderConnection(env.PAWBOOK_DB, tenant.Id, 'calendar');
  if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken) return;

  const accessToken = await getCalendarAccessToken(env, tenant, conn);
  const calendarId = conn.CalendarId ?? 'primary';
  const resource = await resourceForBooking(env, tenant, b);
  const { id } = await createEvent(accessToken, calendarId, resource);
  await persistEventIdOrCleanup(env, tenant, accessToken, calendarId, b.bookingId, id, null);
}

/**
 * Best-effort: PATCH an already-synced booking's Google event to reflect its current state — used
 * when the sitter confirms a request, so its title loses the [REQUEST] marker (status flips to
 * 'confirmed'). Same connection gating and never-blocks posture as syncBookingToCalendar; callers
 * run it via executionCtx.waitUntil and swallow rejections.
 *
 * If the event was hand-deleted in Calendar (updateEvent reports gone), recreate it and CAS the new
 * id in place of the stale one. This re-asserts the booking the sitter just confirmed, so a later
 * reconcile won't cancel it for having no live event. If the CAS loses to a concurrent writer, the
 * replacement is deleted rather than orphaned (persistEventIdOrCleanup).
 */
export async function updateBookingCalendarEvent(
  env: Env,
  tenant: Tenant,
  gcalEventId: string,
  b: SyncInput,
): Promise<void> {
  const conn = await getProviderConnection(env.PAWBOOK_DB, tenant.Id, 'calendar');
  if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken) return;

  const accessToken = await getCalendarAccessToken(env, tenant, conn);
  const calendarId = conn.CalendarId ?? 'primary';
  const resource = await resourceForBooking(env, tenant, b);
  const { gone } = await updateEvent(accessToken, calendarId, gcalEventId, resource);
  if (gone) {
    const { id } = await createEvent(accessToken, calendarId, resource);
    await persistEventIdOrCleanup(
      env,
      tenant,
      accessToken,
      calendarId,
      b.bookingId,
      id,
      gcalEventId,
    );
  }
}

/** Cap on how many bookings one backfill pass creates events for — a sane bound so a sitter with a
 * huge history doesn't spend an unbounded number of Google round-trips on a single connect. */
const BACKFILL_LIMIT = 200;

/**
 * Best-effort: after a sitter connects Google Calendar, create events for every future non-cancelled
 * booking that predates the connection (GCalEventId NULL), so nothing booked before she connected is
 * silently missing from her calendar. Sequential and per-booking best-effort — one Google failure
 * (or a token hiccup) skips that booking and moves on; the rest still sync. Run via waitUntil.
 */
export async function backfillCalendarEvents(env: Env, tenant: Tenant): Promise<void> {
  const conn = await getProviderConnection(env.PAWBOOK_DB, tenant.Id, 'calendar');
  if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken) return;

  const accessToken = await getCalendarAccessToken(env, tenant, conn);
  const calendarId = conn.CalendarId ?? 'primary';
  const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
  const rows = await listUnsyncedFutureBookings(env.PAWBOOK_DB, tenant.Id, today, BACKFILL_LIMIT);

  for (const r of rows) {
    try {
      const petNames = await listPetNamesForBooking(env.PAWBOOK_DB, tenant.Id, r.Id);
      const resource = await resourceForBooking(env, tenant, {
        bookingId: r.Id,
        endUserId: r.EndUserId,
        serviceType: r.ServiceType,
        serviceLabel: r.ServiceLabel,
        startDate: r.StartDate,
        endDate: r.EndDate,
        startTime: r.StartTime,
        durationMinutes: r.DurationMinutes,
        petCount: r.PetCount,
        petNames,
        estCost: r.EstCost,
        status: r.Status,
      });
      const { id } = await createEvent(accessToken, calendarId, resource);
      await persistEventIdOrCleanup(env, tenant, accessToken, calendarId, r.Id, id, null);
    } catch (err) {
      console.error('calendar backfill failed for booking', r.Id, err);
    }
  }
}

/**
 * Best-effort: delete the Google Calendar event for a booking that was cancelled or declined in
 * the dashboard. Callers run this via executionCtx.waitUntil and swallow rejections — mirroring
 * syncBookingToCalendar's never-blocks posture: the status change has already been committed and
 * must stand regardless of what Google does. deleteEvent treats 410 Gone (already deleted, e.g.
 * removed by hand in Calendar) as success. The booking keeps its GCalEventId as a historical
 * record; reconciliation ignores it because listSyncedBookingIds excludes cancelled bookings.
 */
export async function deleteBookingCalendarEvent(
  env: Env,
  tenant: Tenant,
  gcalEventId: string,
): Promise<void> {
  const conn = await getProviderConnection(env.PAWBOOK_DB, tenant.Id, 'calendar');
  if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken) return;
  const accessToken = await getCalendarAccessToken(env, tenant, conn);
  await deleteEvent(accessToken, conn.CalendarId ?? 'primary', gcalEventId);
}

const CALENDAR_SYNC_TTL_SECONDS = 120;
const calendarSyncKey = (tenantId: string) => `calendar-sync:${tenantId}:last`;

/**
 * Reconciles this tenant's synced bookings against Google Calendar: if a booking's event was
 * deleted directly in Calendar (not through Pawservation), the booking is marked cancelled. Read-only
 * against Google and strictly best-effort — a Calendar failure must never block the dashboard from
 * returning current DB state, same philosophy as syncBookingToCalendar above.
 */
export async function reconcileBookingsWithCalendar(env: Env, tenant: Tenant): Promise<void> {
  const conn = await getProviderConnection(env.PAWBOOK_DB, tenant.Id, 'calendar');
  if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken) return;

  const accessToken = await getCalendarAccessToken(env, tenant, conn);
  const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
  const windowStart = addDays(today, -1);
  const windowEndExclusive = addDays(today, 180);
  const events = await listCalendarEvents(
    accessToken,
    conn.CalendarId ?? 'primary',
    `${windowStart}T00:00:00Z`,
    `${windowEndExclusive}T00:00:00Z`,
  );
  const liveBookingIds = new Set(events.map((e) => e.private.bookingId).filter(Boolean));

  const candidates = await listSyncedBookingIds(
    env.PAWBOOK_DB,
    tenant.Id,
    windowStart,
    windowEndExclusive,
  );
  for (const id of candidates) {
    if (!liveBookingIds.has(id)) {
      await updateBookingStatus(env.PAWBOOK_DB, tenant.Id, id, 'cancelled');
    }
  }
}

/** Reconciles at most once per CALENDAR_SYNC_TTL_SECONDS per tenant, via PAWBOOK_CACHE. */
export async function reconcileIfStale(env: Env, tenant: Tenant): Promise<void> {
  const key = calendarSyncKey(tenant.Id);
  if (await env.PAWBOOK_CACHE.get(key).catch(() => null)) return;
  try {
    await reconcileBookingsWithCalendar(env, tenant);
  } catch {
    /* best-effort; the dashboard falls back to current DB state */
  } finally {
    await env.PAWBOOK_CACHE.put(key, '1', { expirationTtl: CALENDAR_SYNC_TTL_SECONDS }).catch(
      () => {},
    );
  }
}
