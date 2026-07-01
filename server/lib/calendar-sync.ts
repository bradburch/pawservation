import { DEFAULT_TIMEZONE } from '../../src/shared/index.js';
import {
  getEndUserById,
  getProviderConnection,
  setBookingGCalEventId,
  setProviderTokens,
} from '../db/repo';
import { buildEventResource, createEvent, refreshAccessToken } from './google-calendar';
import { SERVICE_CATALOG } from './services';
import type { ServiceType } from './services';
import { decryptToken, encryptToken } from './token-crypto';
import type { Tenant, ProviderConnectionWithTokens } from '../types';

export type SyncInput = {
  bookingId: string;
  endUserId: string | null;
  serviceType: ServiceType;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  petCount: number;
  estCost: number | null;
};

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
 * Best-effort: create a Google Calendar event for a booking and persist its id. Callers run this
 * via executionCtx.waitUntil and ignore rejections — a Google failure must never affect a booking.
 */
export async function syncBookingToCalendar(env: Env, tenant: Tenant, b: SyncInput): Promise<void> {
  const conn = await getProviderConnection(env.PAWBOOK_DB, tenant.Id, 'calendar');
  if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken) return;

  const accessToken = await getCalendarAccessToken(env, tenant, conn);

  const customer = b.endUserId
    ? await getEndUserById(env.PAWBOOK_DB, tenant.Id, b.endUserId)
    : null;

  const resource = buildEventResource({
    serviceLabel: SERVICE_CATALOG[b.serviceType].label,
    category: b.serviceType,
    bookingId: b.bookingId,
    startDate: b.startDate,
    endDate: b.endDate,
    startTime: b.startTime,
    durationMinutes: b.durationMinutes,
    petCount: b.petCount,
    estCost: b.estCost,
    customerEmail: customer?.Email ?? null,
    timezone: tenant.Timezone ?? DEFAULT_TIMEZONE,
  });

  const { id } = await createEvent(accessToken, conn.CalendarId ?? 'primary', resource);
  await setBookingGCalEventId(env.PAWBOOK_DB, tenant.Id, b.bookingId, id);
}
