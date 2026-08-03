import { listConnectedCalendarTenants } from '../db/repo';
import {
  backfillCalendarEvents,
  CALENDAR_SYNC_TTL_SECONDS,
  calendarSyncKey,
  reconcileBookingsWithCalendar,
  redriveCalendarOutbox,
} from './calendar-sync';

/**
 * The 15-minute sweep behind `scheduled()`: for every connected, enabled tenant — flush the
 * outbox (pushes Google is missing), backfill (catches up any pre-existing row this feature or a
 * past connection never synced), then pull (deletes + external materialization). Per-tenant
 * best-effort: one tenant's failure is logged and the sweep moves on. After a successful pass the
 * per-tenant KV throttle marker is written, so a dashboard GET moments later doesn't repeat the
 * Google round-trips reconcileIfStale would otherwise fire.
 *
 * Backfill runs here, not just at connect/repoint time, because a row can predate a FEATURE
 * rather than a connection: a blocked (time-off) row created before time-off started pushing to
 * Google has `SyncPending = 0` and `GCalEventId = NULL` — the old code path — so neither the
 * outbox (`SyncPending = 1` required) nor reconcile's re-assertion pass (`GCalEventId IS NOT
 * NULL` required, since there's no event to be missing) will ever pick it up. Only backfill's
 * `GCalEventId IS NULL` predicate reaches it. Running it every sweep is safe and cheap: once a
 * tenant's rows are all backfilled, `listUnsyncedFutureBookings` is one bounded, empty-result
 * query. As a deliberate, understood side effect this also catches up any pre-existing REAL
 * BOOKING that similarly never got backfilled for an already-connected tenant who never
 * repointed her calendar — not new scope, just the same gap this sweep is already closing,
 * applied to the sibling row type.
 */
export async function runCalendarSweep(env: Env): Promise<void> {
  const tenants = await listConnectedCalendarTenants(env.PAWBOOK_DB);
  for (const tenant of tenants) {
    try {
      await redriveCalendarOutbox(env, tenant);
      await backfillCalendarEvents(env, tenant);
      await reconcileBookingsWithCalendar(env, tenant);
      await env.PAWBOOK_CACHE.put(calendarSyncKey(tenant.Id), '1', {
        expirationTtl: CALENDAR_SYNC_TTL_SECONDS,
      }).catch(() => {});
    } catch (err) {
      console.error('calendar sweep failed for tenant', tenant.Id, err);
    }
  }
}
