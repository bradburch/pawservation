import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  addEndUserPet,
  clearProviderConnection,
  countBookingPetRefs,
  countBookingsForUser,
  getEndUserById,
  deleteBlockedRange,
  deleteCustomer,
  getProviderConnection,
  insertBookingRequest,
  insertInvitedCustomer,
  listAllEndUserPetsByTenant,
  listBlockedRanges,
  listCustomers,
  listPetTypes,
  listProviderConnections,
  listServiceOptions,
  listServices,
  removeEndUserPet,
  replaceServiceOptions,
  setProviderCalendarId,
  setPetTypeEnabled,
  setProviderStatus,
  setServiceEnabled,
  updateTenantSettings,
} from '../db/repo';
import { isEmailConfigured, sendInvite } from '../lib/email';
import { buildAuthUrl, revokeToken } from '../lib/google-calendar';
import { adminAuth } from '../lib/middleware';
import { signState } from '../lib/oauth-state';
import { findCapability, providerViews } from '../lib/providers';
import { embedSnippets } from '../lib/snippet';
import { isPetType, isServiceType, PET_TYPES, SERVICE_CATALOG } from '../lib/services';
import { decryptToken } from '../lib/token-crypto';
import { invalidateTenantCache } from '../lib/tenant-resolve';
import { NONCE_KEY } from './oauth';
import {
  DEFENSIVE_MAX_NIGHTS,
  DEFENSIVE_MAX_PET_COUNT,
  EMAIL_RE,
  isNullableLimit,
  isRealDate,
  isValidDuration,
  isValidRate,
} from '../lib/validation';
import type { AppEnv } from '../types';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** null/undefined (use default) or a timezone Intl accepts. */
function isValidTimezone(value: unknown): value is string | null | undefined {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

type OptionBody = { label?: string; durationMinutes?: number | null; rate?: number };
type ServiceBody = { type?: string; enabled?: boolean; options?: OptionBody[] };
type SettingsBody = {
  displayName?: string;
  accentColor?: string;
  maxBoardingPets?: number | null;
  maxHouseSitsPerDay?: number | null;
  maxStayNights?: number | null;
  timezone?: string | null;
  petTypes?: string[];
  services?: ServiceBody[];
};

/**
 * PATCH semantics for a nullable config field: present in the body ⇒ take it (an explicit `null`
 * clears the limit to "unlimited"); absent ⇒ keep the tenant's current value. The lone cast covers
 * the dynamic-key access — call sites stay type-safe via the `T` they pin.
 */
function patchNullable<T extends number | string>(
  body: SettingsBody,
  key: 'maxBoardingPets' | 'maxHouseSitsPerDay' | 'maxStayNights' | 'timezone',
  current: T | null,
): T | null {
  return key in body ? ((body[key] as T | null | undefined) ?? null) : current;
}

export const adminRoutes = new Hono<AppEnv>()
  .use('/:slug/admin/*', adminAuth)

  .get('/:slug/admin/settings', async (c) => {
    const tenant = c.get('tenant');
    const [services, options, petTypes, blocked, connections] = await Promise.all([
      listServices(c.env.PAWBOOK_DB, tenant.Id),
      listServiceOptions(c.env.PAWBOOK_DB, tenant.Id),
      listPetTypes(c.env.PAWBOOK_DB, tenant.Id),
      listBlockedRanges(c.env.PAWBOOK_DB, tenant.Id),
      listProviderConnections(c.env.PAWBOOK_DB, tenant.Id),
    ]);
    const enabledByType = new Map(services.map((s) => [s.ServiceType, Boolean(s.Enabled)]));
    return c.json({
      displayName: tenant.DisplayName,
      accentColor: tenant.AccentColor,
      maxBoardingPets: tenant.MaxBoardingPets,
      maxHouseSitsPerDay: tenant.MaxHouseSitsPerDay,
      maxStayNights: tenant.MaxStayNights,
      timezone: tenant.Timezone,
      petTypes: PET_TYPES.map((pt) => ({
        petType: pt,
        enabled: petTypes.some((p) => p.PetType === pt && p.Enabled),
      })),
      services: Object.entries(SERVICE_CATALOG).map(([type, meta]) => ({
        type,
        label: meta.label,
        hasDuration: meta.hasDuration,
        rateUnit: meta.rateUnit,
        enabled: enabledByType.get(type as keyof typeof SERVICE_CATALOG) ?? false,
        options: options
          .filter((o) => o.ServiceType === type)
          .map((o) => ({
            optionKey: o.OptionKey,
            label: o.Label,
            durationMinutes: o.DurationMinutes,
            rate: o.Rate,
          })),
      })),
      blocked: blocked.map((b) => ({ id: b.Id, startDate: b.StartDate, endDate: b.EndDate })),
      providers: providerViews(connections).map(
        ({ capability, provider, label, authMode, status, connectedAt, calendarId }) => ({
          capability,
          provider,
          label,
          authMode,
          status,
          connectedAt,
          calendarId,
        }),
      ),
    });
  })

  .put('/:slug/admin/settings', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req.json<SettingsBody>().catch(() => ({}) as SettingsBody);

    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim() : tenant.DisplayName;
    const accentColor =
      typeof body.accentColor === 'string' ? body.accentColor : tenant.AccentColor;
    const maxBoardingPets = patchNullable<number>(body, 'maxBoardingPets', tenant.MaxBoardingPets);
    const maxHouseSitsPerDay = patchNullable<number>(
      body,
      'maxHouseSitsPerDay',
      tenant.MaxHouseSitsPerDay,
    );
    const maxStayNights = patchNullable<number>(body, 'maxStayNights', tenant.MaxStayNights);
    const timezone = patchNullable<string>(body, 'timezone', tenant.Timezone);
    const petTypes = body.petTypes;
    const services = body.services ?? [];

    if (!displayName) return c.json({ error: 'Display name required.' }, 400);
    if (!COLOR_RE.test(accentColor)) return c.json({ error: 'Accent color must be #rrggbb.' }, 400);
    if (!isNullableLimit(maxBoardingPets, DEFENSIVE_MAX_PET_COUNT))
      return c.json(
        { error: 'Boarding capacity must be a positive number, or blank for no limit.' },
        400,
      );
    // DEFENSIVE_MAX_PET_COUNT is reused here purely as a generic "sane capacity integer" ceiling —
    // a house-sit count isn't a pet count, but the same 1..1000 sanity bound is the right guard.
    if (!isNullableLimit(maxHouseSitsPerDay, DEFENSIVE_MAX_PET_COUNT))
      return c.json(
        { error: 'House-sit capacity must be a positive number, or blank for no limit.' },
        400,
      );
    if (!isNullableLimit(maxStayNights, DEFENSIVE_MAX_NIGHTS))
      return c.json(
        { error: 'Max stay nights must be a positive number, or blank for no limit.' },
        400,
      );
    if (!isValidTimezone(timezone)) return c.json({ error: 'Unknown timezone.' }, 400);
    if (petTypes !== undefined) {
      if (!Array.isArray(petTypes) || !petTypes.every(isPetType))
        return c.json({ error: 'Unknown pet type.' }, 400);
    }
    for (const svc of services) {
      if (!isServiceType(svc.type)) return c.json({ error: 'Unknown service type.' }, 400);
      const meta = SERVICE_CATALOG[svc.type];
      const opts = svc.options ?? [];
      if (svc.enabled && opts.length === 0)
        return c.json({ error: `${meta.label} needs at least one price option.` }, 400);
      // Non-duration services derive every optionKey as 'standard', so more than one would collide
      // on the (TenantId, ServiceType, OptionKey) UNIQUE constraint mid-write. Reject up front.
      if (!meta.hasDuration && opts.length > 1)
        return c.json({ error: `${meta.label} takes a single price.` }, 400);
      for (const o of opts) {
        if (!isValidRate(o.rate)) return c.json({ error: 'Rates must be whole dollars ≥ 1.' }, 400);
        if (meta.hasDuration && !isValidDuration(o.durationMinutes))
          return c.json({ error: 'Durations must be whole minutes ≥ 1.' }, 400);
      }
      if (meta.hasDuration) {
        const mins = opts.map((o) => o.durationMinutes);
        if (new Set(mins).size !== mins.length)
          return c.json({ error: 'Duplicate durations for one service.' }, 400);
      }
    }

    await updateTenantSettings(c.env.PAWBOOK_DB, tenant.Id, {
      displayName,
      accentColor,
      maxBoardingPets,
      maxHouseSitsPerDay,
      maxStayNights,
      timezone,
    });
    if (petTypes !== undefined) {
      for (const pt of PET_TYPES)
        await setPetTypeEnabled(c.env.PAWBOOK_DB, tenant.Id, pt, petTypes.includes(pt));
    }
    for (const svc of services) {
      const svcType = svc.type as keyof typeof SERVICE_CATALOG;
      const meta = SERVICE_CATALOG[svcType];
      await setServiceEnabled(c.env.PAWBOOK_DB, tenant.Id, svcType, svc.enabled ?? false);
      await replaceServiceOptions(
        c.env.PAWBOOK_DB,
        tenant.Id,
        svcType,
        (svc.options ?? []).map((o) => ({
          optionKey: meta.hasDuration ? `d${o.durationMinutes}` : 'standard',
          label: o.label?.trim() || (meta.hasDuration ? `${o.durationMinutes} min` : 'Standard'),
          durationMinutes: meta.hasDuration ? (o.durationMinutes as number) : null,
          rate: o.rate as number,
          rateUnit: meta.rateUnit,
        })),
      );
    }

    // The widget reads tenant config through the KV-cached resolution seam (PRD FR19).
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.body(null, 204);
  })

  .post('/:slug/admin/blocked', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ startDate?: string; endDate?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const start = typeof body.startDate === 'string' ? body.startDate : '';
    const end = typeof body.endDate === 'string' ? body.endDate : '';
    if (!isRealDate(start) || !isRealDate(end) || end <= start)
      return c.json({ error: 'Provide a valid range (end is exclusive).' }, 400);
    const id = await insertBookingRequest(c.env.PAWBOOK_DB, tenant.Id, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: start,
      endDate: end,
      optionKey: null,
      petType: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });
    return c.json({ id }, 201);
  })

  .delete('/:slug/admin/blocked/:id', async (c) => {
    const tenant = c.get('tenant');
    const deleted = await deleteBlockedRange(c.env.PAWBOOK_DB, tenant.Id, c.req.param('id'));
    if (!deleted) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  })

  .get('/:slug/admin/snippet', (c) => {
    const tenant = c.get('tenant');
    return c.json(embedSnippets(new URL(c.req.url).origin, tenant.Slug));
  })

  .post('/:slug/admin/providers/:capability/connect', async (c) => {
    const tenant = c.get('tenant');
    const descriptor = findCapability(c.req.param('capability'));
    if (!descriptor) return c.json({ error: 'Unknown capability.' }, 404);
    await setProviderStatus(
      c.env.PAWBOOK_DB,
      tenant.Id,
      descriptor.capability,
      descriptor.provider,
      'connected-stub',
    );
    return c.json({ status: 'connected-stub' });
  })

  .get('/:slug/admin/providers/calendar/oauth/start', async (c) => {
    const tenant = c.get('tenant');
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_OAUTH_REDIRECT_URI)
      return c.json({ error: 'Google Calendar is not configured on this server.' }, 503);
    const nonce = crypto.randomUUID();
    await c.env.PAWBOOK_CACHE.put(NONCE_KEY(nonce), '1', { expirationTtl: 600 });
    const state = await signState(c.env.TOKEN_SECRET, {
      tenantId: tenant.Id,
      nonce,
      exp: Date.now() + 600_000,
    });
    // Bind the callback to THIS admin's browser: the nonce travels back as a cookie that an
    // attacker cannot plant in a victim's browser, defeating OAuth login-CSRF. Secure in prod;
    // omitted on http://localhost so local dev still works. Path-scoped to the callback only.
    setCookie(c, 'pawbook_gcal_nonce', nonce, {
      httpOnly: true,
      secure: c.env.ENVIRONMENT !== 'development',
      sameSite: 'Lax', // sent on Google's top-level redirect back to the callback
      path: '/oauth/google/callback',
      maxAge: 600,
    });
    return c.json({ url: buildAuthUrl(c.env, state) });
  })

  .post('/:slug/admin/providers/calendar/disconnect', async (c) => {
    const tenant = c.get('tenant');
    const conn = await getProviderConnection(c.env.PAWBOOK_DB, tenant.Id, 'calendar');
    if (conn?.RefreshToken) {
      try {
        await revokeToken(await decryptToken(c.env.TOKEN_SECRET, conn.RefreshToken));
      } catch {
        /* best-effort revoke; clear locally regardless */
      }
    }
    await clearProviderConnection(c.env.PAWBOOK_DB, tenant.Id, 'calendar');
    return c.json({ status: 'disconnected' });
  })

  .post('/:slug/admin/providers/calendar/calendar-id', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ calendarId?: unknown }>()
      .catch(() => ({}) as { calendarId?: unknown });
    const raw = typeof body.calendarId === 'string' ? body.calendarId.trim() : '';
    await setProviderCalendarId(c.env.PAWBOOK_DB, tenant.Id, 'calendar', raw === '' ? null : raw);
    return c.body(null, 204);
  })

  .get('/:slug/admin/customers', async (c) => {
    const tenant = c.get('tenant');
    const [customers, allPets] = await Promise.all([
      listCustomers(c.env.PAWBOOK_DB, tenant.Id),
      listAllEndUserPetsByTenant(c.env.PAWBOOK_DB, tenant.Id),
    ]);
    const byUser = new Map<string, { id: string; name: string; petType: string }[]>();
    for (const p of allPets) {
      const list = byUser.get(p.EndUserId) ?? [];
      list.push({ id: p.Id, name: p.Name, petType: p.PetType });
      byUser.set(p.EndUserId, list);
    }
    const withPets = customers.map((u) => ({
      id: u.Id,
      email: u.Email,
      name: u.Name,
      status: u.Status,
      invitedAt: u.InvitedAt,
      pets: byUser.get(u.Id) ?? [],
    }));
    return c.json({ customers: withPets });
  })

  .post('/:slug/admin/customers', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ email?: unknown; name?: unknown }>()
      .catch(() => ({}) as { email?: unknown; name?: unknown });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    const name = rawName || null;
    if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);

    const customer = await insertInvitedCustomer(c.env.PAWBOOK_DB, tenant.Id, email, name);

    // Only send the invite for a freshly-invited customer — skip if the customer is already active
    // (a re-POST of an existing active customer must not send a confusing "you're invited" email).
    if (customer.Status === 'invited' && isEmailConfigured(c.env)) {
      const widgetUrl = new URL(`/embed/${tenant.Slug}`, c.req.url).toString();
      try {
        await sendInvite(c.env, email, tenant.DisplayName, widgetUrl);
      } catch {
        return c.json({ error: 'Customer saved, but the invite email could not be sent.' }, 502);
      }
    }
    return c.json(
      { id: customer.Id, email: customer.Email, name: customer.Name, status: customer.Status },
      201,
    );
  })

  .delete('/:slug/admin/customers/:id', async (c) => {
    const tenant = c.get('tenant');
    const id = c.req.param('id');
    if ((await countBookingsForUser(c.env.PAWBOOK_DB, tenant.Id, id)) > 0)
      return c.json({ error: 'Customer has bookings; cannot remove.' }, 409);
    const deleted = await deleteCustomer(c.env.PAWBOOK_DB, tenant.Id, id);
    if (!deleted) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  })
  .post('/:slug/admin/customers/:id/pets', async (c) => {
    const tenant = c.get('tenant');
    const endUserId = c.req.param('id');
    const body = await c.req
      .json<{ name?: unknown; petType?: unknown }>()
      .catch(() => ({}) as { name?: unknown; petType?: unknown });
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const petType = body.petType;
    if (!name) return c.json({ error: 'Enter a pet name.' }, 400);
    if (!isPetType(petType)) return c.json({ error: 'Unknown pet type.' }, 400);
    // The customer id comes from the URL; confirm it belongs to this tenant before writing a pet
    // under it (production D1 has foreign keys OFF, so nothing else stops a cross-tenant orphan).
    if (!(await getEndUserById(c.env.PAWBOOK_DB, tenant.Id, endUserId)))
      return c.json({ error: 'Not found.' }, 404);
    const accepted = (await listPetTypes(c.env.PAWBOOK_DB, tenant.Id)).find(
      (pt) => pt.PetType === petType && pt.Enabled,
    );
    if (!accepted) return c.json({ error: 'That pet type is not accepted.' }, 400);
    const pet = await addEndUserPet(c.env.PAWBOOK_DB, tenant.Id, endUserId, name, petType);
    return c.json({ id: pet.Id, name: pet.Name, petType: pet.PetType }, 201);
  })
  .delete('/:slug/admin/customers/:id/pets/:petId', async (c) => {
    const tenant = c.get('tenant');
    const refs = await countBookingPetRefs(c.env.PAWBOOK_DB, tenant.Id, c.req.param('petId'));
    if (refs > 0) return c.json({ error: 'Pet has bookings; cannot remove.' }, 409);
    const removed = await removeEndUserPet(c.env.PAWBOOK_DB, tenant.Id, c.req.param('petId'));
    if (!removed) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  });
