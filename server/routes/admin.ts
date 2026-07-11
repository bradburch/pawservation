import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  addEndUserPet,
  clearProviderConnection,
  countBookingPetRefs,
  countBookingsForService,
  countBookingsForUser,
  createService,
  getBookingWithCustomer,
  getEndUserById,
  getEndUserByEmail,
  deleteBlockedRange,
  deleteCustomer,
  deleteService,
  getProviderConnection,
  insertBookingRequest,
  insertInvitedCustomer,
  listAllEndUserPetsByTenant,
  listBlockedRanges,
  listBookingsForTenant,
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
  setServiceConfig,
  updateBookingStatus,
  updateTenantSettings,
} from '../db/repo';
import { isEmailConfigured, sendBookingStatusEmail, sendInvite } from '../lib/email';
import { parseCsvRows } from '../lib/csv';
import { reconcileIfStale } from '../lib/calendar-sync';
import { buildAuthUrl, revokeToken } from '../lib/google-calendar';
import { adminAuth } from '../lib/middleware';
import { signState } from '../lib/oauth-state';
import { findCapability, providerViews } from '../lib/providers';
import { embedSnippets } from '../lib/snippet';
import {
  isPetType,
  isTemplateId,
  PET_TYPES,
  RESERVED_SERVICE_SLUGS,
  SERVICE_TEMPLATES,
  slugifyServiceLabel,
  TEMPLATE_IDS,
} from '../lib/services';
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
import type { ServiceQuestion } from '../../src/shared/index.js';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Each pet-bearing row triggers several sequential D1 calls; an unbounded import can exceed
 * Workers' subrequest/CPU ceiling mid-loop, which aborts outside the per-row try/catch and
 * returns a bare 500 with no partial-import report. Cap row count so oversized files fail fast
 * with an actionable error instead of a platform crash.
 */
const MAX_IMPORT_ROWS = 500;

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

type QuestionBody = {
  id?: string;
  label?: string;
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: string;
  options?: string[];
};

const QUESTION_TYPES = ['text', 'yesno', 'number', 'select'] as const;

/**
 * Heuristic reject for classic catastrophic-backtracking shapes: a quantified group whose body
 * is itself quantified, e.g. `(a+)+` or `([a-zA-Z]+)+`. Not exhaustive — a determined admin could
 * still craft a pathological pattern this misses — but it blocks the textbook ReDoS shapes without
 * requiring a linear-time regex engine. Paired with a runtime input-length cap in
 * src/shared/booking/service-rules.ts as a second safety rail.
 */
function looksCatastrophic(pattern: string): boolean {
  return /\([^()]*[+*][^()]*\)[+*]/.test(pattern);
}

/** Validates a question's DEFINITION (not an answer) — shape/type/options/pattern sanity. */
function validateQuestionBody(q: QuestionBody): string | null {
  const label = q.label?.trim();
  if (!label) return 'Every question needs a label.';
  if (!QUESTION_TYPES.includes(q.type as (typeof QUESTION_TYPES)[number]))
    return `Unknown question type for "${label}".`;
  if (q.type === 'number') {
    if (q.min !== undefined && (typeof q.min !== 'number' || !Number.isFinite(q.min)))
      return `"${label}": min must be a number.`;
    if (q.max !== undefined && (typeof q.max !== 'number' || !Number.isFinite(q.max)))
      return `"${label}": max must be a number.`;
    if (q.min !== undefined && q.max !== undefined && q.min > q.max)
      return `"${label}": min cannot exceed max.`;
  }
  if (q.type === 'select' && (!Array.isArray(q.options) || q.options.length === 0))
    return `"${label}" needs at least one option.`;
  if (q.type === 'text' && q.pattern) {
    try {
      new RegExp(q.pattern);
    } catch {
      return `"${label}" has an invalid pattern.`;
    }
    if (looksCatastrophic(q.pattern))
      return `"${label}": that pattern could hang on certain input — try a simpler one.`;
  }
  return null;
}

type ServiceBody = {
  type?: string;
  enabled?: boolean;
  options?: OptionBody[];
  questions?: QuestionBody[];
  minNights?: number | null;
  maxNights?: number | null;
  minPetCount?: number | null;
  maxPetCount?: number | null;
};
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
      services: services.map((svc) => ({
        type: svc.ServiceType,
        label: svc.Label,
        icon: svc.Icon,
        hasDuration: Boolean(svc.HasDuration),
        rateUnit: svc.RateUnit,
        shape: svc.Shape,
        custom: !(svc.ServiceType in SERVICE_TEMPLATES),
        enabled: Boolean(svc.Enabled),
        questions: svc.Questions,
        minNights: svc.MinNights,
        maxNights: svc.MaxNights,
        minPetCount: svc.MinPetCount,
        maxPetCount: svc.MaxPetCount,
        options: options
          .filter((o) => o.ServiceType === svc.ServiceType)
          .map((o) => ({
            optionKey: o.OptionKey,
            label: o.Label,
            durationMinutes: o.DurationMinutes,
            rate: o.Rate,
          })),
      })),
      // "Add service" picker: template id + display label of each built-in behavior archetype.
      templates: TEMPLATE_IDS.map((id) => ({ id, label: SERVICE_TEMPLATES[id].label })),
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
    // Per-service PATCH semantics for questions/constraints (mirrors patchNullable above): a field
    // included in a service's body ⇒ take it; absent ⇒ keep that service's current value. Without
    // this, a caller that PUTs `{type, enabled}` alone (omitting questions/constraints) would
    // silently wipe them back to empty/unlimited.
    const currentServices =
      services.length > 0 ? await listServices(c.env.PAWBOOK_DB, tenant.Id) : [];

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
      const meta = currentServices.find((s) => s.ServiceType === svc.type);
      if (!meta) return c.json({ error: 'Unknown service type.' }, 400);
      const hasDuration = Boolean(meta.HasDuration);
      const opts = svc.options ?? [];
      if (svc.enabled && opts.length === 0)
        return c.json({ error: `${meta.Label} needs at least one price option.` }, 400);
      // Non-duration services derive every optionKey as 'standard', so more than one would collide
      // on the (TenantId, ServiceType, OptionKey) UNIQUE constraint mid-write. Reject up front.
      if (!hasDuration && opts.length > 1)
        return c.json({ error: `${meta.Label} takes a single price.` }, 400);
      for (const o of opts) {
        if (!isValidRate(o.rate)) return c.json({ error: 'Rates must be whole dollars ≥ 1.' }, 400);
        if (hasDuration && !isValidDuration(o.durationMinutes))
          return c.json({ error: 'Durations must be whole minutes ≥ 1.' }, 400);
      }
      if (hasDuration) {
        const mins = opts.map((o) => o.durationMinutes);
        if (new Set(mins).size !== mins.length)
          return c.json({ error: 'Duplicate durations for one service.' }, 400);
      }
      for (const q of svc.questions ?? []) {
        const qError = validateQuestionBody(q);
        if (qError) return c.json({ error: qError }, 400);
      }
      if (
        !isNullableLimit(svc.minNights ?? null, DEFENSIVE_MAX_NIGHTS) ||
        !isNullableLimit(svc.maxNights ?? null, DEFENSIVE_MAX_NIGHTS)
      )
        return c.json({ error: `${meta.Label}: nights must be a positive number, or blank.` }, 400);
      if (svc.minNights != null && svc.maxNights != null && svc.minNights > svc.maxNights)
        return c.json({ error: `${meta.Label}: min nights cannot exceed max nights.` }, 400);
      if (
        !isNullableLimit(svc.minPetCount ?? null, DEFENSIVE_MAX_PET_COUNT) ||
        !isNullableLimit(svc.maxPetCount ?? null, DEFENSIVE_MAX_PET_COUNT)
      )
        return c.json(
          { error: `${meta.Label}: pet count must be a positive number, or blank.` },
          400,
        );
      if (svc.minPetCount != null && svc.maxPetCount != null && svc.minPetCount > svc.maxPetCount)
        return c.json({ error: `${meta.Label}: min pets cannot exceed max pets.` }, 400);
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
      const svcType = svc.type as string;
      // Validation above guarantees a matching row exists.
      const current = currentServices.find((s) => s.ServiceType === svcType)!;
      const hasDuration = Boolean(current.HasDuration);
      const questions: ServiceQuestion[] =
        svc.questions !== undefined
          ? svc.questions.map((q) => ({
              id: q.id ?? crypto.randomUUID(),
              label: q.label!.trim(),
              type: q.type as ServiceQuestion['type'],
              required: q.required ?? false,
              ...(q.type === 'number' && q.min !== undefined ? { min: q.min } : {}),
              ...(q.type === 'number' && q.max !== undefined ? { max: q.max } : {}),
              ...(q.type === 'text' && q.pattern ? { pattern: q.pattern } : {}),
              ...(q.type === 'select' ? { options: q.options } : {}),
            }))
          : current.Questions;
      await setServiceConfig(c.env.PAWBOOK_DB, tenant.Id, svcType, {
        enabled: svc.enabled ?? false,
        questions,
        minNights: 'minNights' in svc ? (svc.minNights ?? null) : current.MinNights,
        maxNights: 'maxNights' in svc ? (svc.maxNights ?? null) : current.MaxNights,
        minPetCount: 'minPetCount' in svc ? (svc.minPetCount ?? null) : current.MinPetCount,
        maxPetCount: 'maxPetCount' in svc ? (svc.maxPetCount ?? null) : current.MaxPetCount,
      });
      await replaceServiceOptions(
        c.env.PAWBOOK_DB,
        tenant.Id,
        svcType,
        (svc.options ?? []).map((o) => ({
          optionKey: hasDuration ? `d${o.durationMinutes}` : 'standard',
          label: o.label?.trim() || (hasDuration ? `${o.durationMinutes} min` : 'Standard'),
          durationMinutes: hasDuration ? (o.durationMinutes as number) : null,
          rate: o.rate as number,
          rateUnit: current.RateUnit,
        })),
      );
    }

    // The widget reads tenant config through the KV-cached resolution seam (PRD FR19).
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.body(null, 204);
  })

  // Create a custom service from a template. The template permanently fixes behavior (shape,
  // rate unit, duration, capacity pool); the sitter picks only the name. Created disabled with
  // no options — priced and enabled through the normal settings PUT, same as any service.
  .post('/:slug/admin/services', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ template?: string; label?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!isTemplateId(body.template)) return c.json({ error: 'Unknown template.' }, 400);
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label) return c.json({ error: 'Service name required.' }, 400);
    const slug = slugifyServiceLabel(label);
    if (!slug || RESERVED_SERVICE_SLUGS.includes(slug))
      return c.json({ error: 'Pick a different service name.' }, 400);

    const existing = await listServices(c.env.PAWBOOK_DB, tenant.Id);
    if (existing.some((s) => s.ServiceType === slug))
      return c.json({ error: 'A service with that name already exists.' }, 400);

    const tpl = SERVICE_TEMPLATES[body.template];
    await createService(c.env.PAWBOOK_DB, tenant.Id, {
      serviceType: slug,
      label,
      icon: tpl.icon,
      shape: tpl.shape,
      rateUnit: tpl.rateUnit,
      hasDuration: tpl.hasDuration,
      capacityKind: tpl.capacityKind,
      sortOrder: Math.max(0, ...existing.map((s) => s.SortOrder)) + 1,
    });
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.json({ type: slug, label, template: body.template }, 201);
  })

  // Delete a CUSTOM service. Built-ins are disabled, never deleted; a slug any booking row
  // references (any status — history included) can't be removed.
  .delete('/:slug/admin/services/:type', async (c) => {
    const tenant = c.get('tenant');
    const type = c.req.param('type');
    const existing = await listServices(c.env.PAWBOOK_DB, tenant.Id);
    const service = existing.find((s) => s.ServiceType === type);
    if (!service) return c.json({ error: 'Unknown service type.' }, 404);
    if (type in SERVICE_TEMPLATES)
      return c.json({ error: 'Built-in services can be disabled, not deleted.' }, 400);
    if ((await countBookingsForService(c.env.PAWBOOK_DB, tenant.Id, type)) > 0)
      return c.json({ error: 'That service has bookings — disable it instead.' }, 409);
    await deleteService(c.env.PAWBOOK_DB, tenant.Id, type);
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
  })
  .post('/:slug/admin/customers/import', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ csv?: unknown; sendInvites?: unknown }>()
      .catch(() => ({}) as { csv?: unknown; sendInvites?: unknown });
    const csv = typeof body.csv === 'string' ? body.csv : '';
    const sendInvites = body.sendInvites === true;

    const rows = parseCsvRows(csv).slice(1); // row 1 is the header
    if (rows.length > MAX_IMPORT_ROWS) {
      return c.json(
        {
          error: `This file has ${rows.length} rows; split it into files of ${MAX_IMPORT_ROWS} or fewer and import in batches.`,
        },
        400,
      );
    }
    const petTypesEnabled = new Set(
      (await listPetTypes(c.env.PAWBOOK_DB, tenant.Id))
        .filter((pt) => pt.Enabled)
        .map((pt) => pt.PetType),
    );
    const existingPetNames = new Map<string, Set<string>>();
    for (const pet of await listAllEndUserPetsByTenant(c.env.PAWBOOK_DB, tenant.Id)) {
      const set = existingPetNames.get(pet.EndUserId) ?? new Set<string>();
      set.add(pet.Name.toLowerCase());
      existingPetNames.set(pet.EndUserId, set);
    }

    let importedCustomers = 0;
    let importedPets = 0;
    let invitesSent = 0;
    let invitesFailed = 0;
    const skippedRows: { row: number; reason: string }[] = [];
    const freshCustomers: string[] = [];

    for (const [i, cells] of rows.entries()) {
      const row = i + 2; // 1-indexed against the sitter's file; +1 since the header was sliced off
      if (cells.length === 1 && cells[0] === '') continue; // blank line — not a real row
      if (cells.length < 4) {
        skippedRows.push({ row, reason: 'Could not parse this row' });
        continue;
      }
      const [rawEmail, rawName, rawPetName, rawPetType] = cells;
      const email = rawEmail.trim().toLowerCase();
      if (!EMAIL_RE.test(email)) {
        skippedRows.push({ row, reason: 'Invalid email address' });
        continue;
      }

      try {
        const existing = await getEndUserByEmail(c.env.PAWBOOK_DB, tenant.Id, email);
        const name = rawName.trim() || null;
        const customer = await insertInvitedCustomer(c.env.PAWBOOK_DB, tenant.Id, email, name);
        if (!existing) {
          importedCustomers++;
          freshCustomers.push(email);
        }

        const petName = rawPetName.trim();
        const petType = rawPetType.trim().toLowerCase();
        if (!petName && !petType) continue; // client-only row
        if (petName && !petType) {
          skippedRows.push({ row, reason: 'Pet name given without a pet type' });
          continue;
        }
        if (!petName && petType) {
          skippedRows.push({ row, reason: 'Pet type given without a pet name' });
          continue;
        }
        if (!isPetType(petType) || !petTypesEnabled.has(petType)) {
          skippedRows.push({ row, reason: `'${rawPetType.trim()}' is not an enabled pet type` });
          continue;
        }
        const petSet = existingPetNames.get(customer.Id) ?? new Set<string>();
        if (petSet.has(petName.toLowerCase())) {
          skippedRows.push({ row, reason: 'Pet already exists for this client' });
          continue;
        }
        await addEndUserPet(c.env.PAWBOOK_DB, tenant.Id, customer.Id, petName, petType);
        petSet.add(petName.toLowerCase());
        existingPetNames.set(customer.Id, petSet);
        importedPets++;
      } catch {
        skippedRows.push({ row, reason: 'Could not import this row' });
      }
    }

    if (sendInvites && isEmailConfigured(c.env)) {
      const widgetUrl = new URL(`/embed/${tenant.Slug}`, c.req.url).toString();
      for (const email of freshCustomers) {
        try {
          await sendInvite(c.env, email, tenant.DisplayName, widgetUrl);
          invitesSent++;
        } catch {
          invitesFailed++;
        }
      }
    }

    return c.json({ importedCustomers, importedPets, invitesSent, invitesFailed, skippedRows });
  })

  .get('/:slug/admin/bookings', async (c) => {
    const tenant = c.get('tenant');
    await reconcileIfStale(c.env, tenant);
    const rows = await listBookingsForTenant(c.env.PAWBOOK_DB, tenant.Id);
    return c.json({
      bookings: rows.map((r) => ({
        id: r.Id,
        customerEmail: r.Email,
        customerName: r.Name,
        type: r.ServiceType,
        startDate: r.StartDate,
        endDate: r.EndDate,
        startTime: r.StartTime,
        optionKey: r.OptionKey,
        petCount: r.PetCount,
        estCost: r.EstCost,
        status: r.Declined ? 'declined' : r.Status,
        createdAt: r.CreatedAt,
      })),
    });
  })

  .post('/:slug/admin/bookings/:id/status', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req.json<{ status?: unknown }>().catch(() => ({}) as { status?: unknown });
    const status = body.status;
    if (status !== 'confirmed' && status !== 'cancelled' && status !== 'declined')
      return c.json({ error: "Status must be 'confirmed', 'declined', or 'cancelled'." }, 400);
    // ponytail: cancel leaves any synced GCal event in place; delete via GCalEventId if sitters complain
    const updated = await updateBookingStatus(
      c.env.PAWBOOK_DB,
      tenant.Id,
      c.req.param('id'),
      status,
    );
    if (!updated) return c.json({ error: 'Not found.' }, 404);

    // Best-effort customer notification; `notified` lets the dashboard tell the sitter honestly
    // whether the client heard about it (false when email isn't configured or the send failed).
    let notified = false;
    if (isEmailConfigured(c.env)) {
      const booking = await getBookingWithCustomer(c.env.PAWBOOK_DB, tenant.Id, c.req.param('id'));
      if (booking?.Email) {
        const whenText = booking.EndDate
          ? `${booking.StartDate} – ${booking.EndDate}`
          : booking.StartDate;
        try {
          await sendBookingStatusEmail(c.env, booking.Email, tenant.DisplayName, status, whenText);
          notified = true;
        } catch {
          /* status change stands; the dashboard reports the client was not emailed */
        }
      }
    }
    return c.json({ status, notified });
  });
