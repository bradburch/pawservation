import { listConnectedCalendarTenants } from '../db/repo';
import {
  CALENDAR_SYNC_TTL_SECONDS,
  calendarSyncKey,
  reconcileBookingsWithCalendar,
  redriveCalendarOutbox,
} from './calendar-sync';

/**
 * The 15-minute sweep behind `scheduled()`: for every connected, enabled tenant — flush the
 * outbox (pushes Google is missing), then pull (deletes + external materialization). Per-tenant
 * best-effort: one tenant's failure is logged and the sweep moves on. After a successful pass the
 * per-tenant KV throttle marker is written, so a dashboard GET moments later doesn't repeat the
 * Google round-trips reconcileIfStale would otherwise fire.
 */
export async function runCalendarSweep(env: Env): Promise<void> {
  const tenants = await listConnectedCalendarTenants(env.PAWBOOK_DB);
  for (const tenant of tenants) {
    try {
      await redriveCalendarOutbox(env, tenant);
      await reconcileBookingsWithCalendar(env, tenant);
      await env.PAWBOOK_CACHE.put(calendarSyncKey(tenant.Id), '1', {
        expirationTtl: CALENDAR_SYNC_TTL_SECONDS,
      }).catch(() => {});
    } catch (err) {
      console.error('calendar sweep failed for tenant', tenant.Id, err);
    }
  }
}
