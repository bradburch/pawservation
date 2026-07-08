import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  addEndUserPet,
  clearProviderConnection,
  countBookingPetRefs,
  countBookingsForUser,
  getBookingWithCustomer,
  getEndUserById,
  deleteBlockedRange,
  deleteCustomer,
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
  setServiceConfig,
  updateBookingStatus,
  updateTenantSettings,
} from '../db/repo';
import { isEmailConfigured, sendBookingStatusEmail, sendInvite } from '../lib/email';
import { buildAuthUrl, revokeToken } from '../lib/google-calendar';
import { adminAuth } from '../lib/middleware';
import { signState } from '../lib/oauth-state';
import { calendarView } from '../lib/providers';
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
  isValidTimeString,
  minutesBetweenTimes,
} from '../lib/validation';
import type { AppEnv } from '../types';
import type { ServiceQuestion } from '../../src/shared/index.js';

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

type OptionBody = {
  optionKey?: string;
  label?: string;
  durationMinutes?: number | null;
  rate?: number;
  startTime?: string | null;
  endTime?: string | null;
  capacity?: number | null;
};

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

/** Derives a stable OptionKey from a windowed option's label: lowercase, non-alphanumeric runs
 * collapsed to '-', leading/trailing '-' trimmed. "Morning Walk!" -> "morning-walk". */
function slugifyLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

type ResolvedOption = {
  optionKey: string;
  label: string;
  durationMinutes: number | null;
  rate: number;
  startTime: string | null;
  endTime: string | null;
  capacity: number | null;
};

/**
 * Validates and derives one service's option rows in one pass: label, time window, capacity,
 * duration (overridden from the window when present — never trusted from the client, matching
 * how EstCost is never taken from the request body), and the OptionKey each option is saved
 * under. Non-windowed options keep today's `d${durationMinutes}` / `standard` scheme; windowed
 * options derive OptionKey from a slug of their label instead (their duration is no longer a
 * stable, unique-enough key — two different windows can share a length).
 *
 * `existingKeys` are this service's current OptionKeys (from the DB, before this save). An
 * option that names one of them via `optionKey` keeps that key rather than getting a freshly
 * derived one — otherwise renaming a windowed option (whose key is label-derived) would sever
 * it from bookings already made against the old key, silently letting the slot oversell past
 * its capacity. Only a genuinely new option (no matching existing key) gets a fresh one.
 *
 * Returns an error message, or the resolved rows ready to persist.
 */
function resolveServiceOptions(
  meta: (typeof SERVICE_CATALOG)[keyof typeof SERVICE_CATALOG],
  serviceLabel: string,
  opts: OptionBody[],
  existingKeys: Set<string>,
): { error: string } | { resolved: ResolvedOption[] } {
  const resolved: ResolvedOption[] = [];
  // Duplicate names are the only collision a sitter should ever have to fix by hand — keys are
  // derived plumbing and are de-duped automatically below (two same-duration options are fine).
  const seenLabels = new Set<string>();
  // Keys already claimed in this payload: preserved keys up front (order-independent), fresh
  // derivations as they're assigned.
  const usedKeys = new Set(
    opts.map((o) => o.optionKey).filter((k): k is string => k !== undefined && existingKeys.has(k)),
  );
  for (const o of opts) {
    const label = o.label?.trim();
    if (!label) return { error: `${serviceLabel}: every option needs a name.` };
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey))
      return {
        error: `${serviceLabel}: two options are both named “${label}” — give each option a different name.`,
      };
    seenLabels.add(labelKey);
    if (!isValidRate(o.rate)) return { error: 'Rates must be whole dollars ≥ 1.' };

    const hasStart = o.startTime !== undefined && o.startTime !== null;
    const hasEnd = o.endTime !== undefined && o.endTime !== null;
    if (hasStart !== hasEnd)
      return { error: `${serviceLabel}: a time window needs both a start and an end time.` };
    if (hasStart && !meta.hasDuration)
      return { error: `${serviceLabel}: only per-visit services can have a time window.` };
    if (hasStart && (!isValidTimeString(o.startTime) || !isValidTimeString(o.endTime)))
      return { error: `${serviceLabel}: times must be in HH:MM format.` };
    if (hasStart && (o.endTime as string) <= (o.startTime as string))
      return { error: `${serviceLabel}: the window's end time must be after its start time.` };
    if (!isNullableLimit(o.capacity ?? null, DEFENSIVE_MAX_PET_COUNT))
      return {
        error: `${serviceLabel}: capacity must be a positive number, or blank for no limit.`,
      };

    const windowed = hasStart;
    const durationMinutes = windowed
      ? minutesBetweenTimes(o.startTime as string, o.endTime as string)
      : meta.hasDuration
        ? (o.durationMinutes ?? null)
        : null;
    if (meta.hasDuration && !isValidDuration(durationMinutes))
      return { error: `${serviceLabel}: durations must be whole minutes ≥ 1.` };

    const derivedKey = windowed
      ? slugifyLabel(label)
      : meta.hasDuration
        ? `d${durationMinutes}`
        : 'standard';
    const preserveExisting = o.optionKey !== undefined && existingKeys.has(o.optionKey);
    // A label that's entirely punctuation/whitespace after the non-empty check above still
    // slugifies to '' (e.g. "---") — treat that the same as no usable label. Only relevant when
    // a fresh key is actually being derived; a preserved key is already known-valid.
    if (windowed && !preserveExisting && derivedKey === '')
      return { error: `${serviceLabel}: that name has no usable letters or numbers.` };
    let optionKey = preserveExisting ? (o.optionKey as string) : derivedKey;
    if (!preserveExisting) {
      // Two options may legitimately derive the same key (e.g. two 30-minute check-ins with
      // different names/rates) — suffix until unique instead of bouncing the save back.
      for (let n = 2; usedKeys.has(optionKey); n++) optionKey = `${derivedKey}-${n}`;
      usedKeys.add(optionKey);
    }

    resolved.push({
      optionKey,
      label,
      durationMinutes,
      rate: o.rate as number,
      startTime: windowed ? (o.startTime as string) : null,
      endTime: windowed ? (o.endTime as string) : null,
      capacity: o.capacity ?? null,
    });
  }
  // Backstop only: fresh keys are de-duped above, so this can fire only when two options in the
  // payload name the SAME saved optionKey (a stale/duplicated client state).
  const keys = resolved.map((o) => o.optionKey);
  if (new Set(keys).size !== keys.length)
    return {
      error: `${serviceLabel}: two options point at the same saved option — reload the page and try again.`,
    };
  return { resolved };
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
  contactEmail?: string | null;
  contactPhone?: string | null;
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
  key:
    | 'maxBoardingPets'
    | 'maxHouseSitsPerDay'
    | 'maxStayNights'
    | 'timezone'
    | 'contactEmail'
    | 'contactPhone',
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
      contactEmail: tenant.ContactEmail,
      contactPhone: tenant.ContactPhone,
      petTypes: PET_TYPES.map((pt) => ({
        petType: pt,
        enabled: petTypes.some((p) => p.PetType === pt && p.Enabled),
      })),
      services: Object.entries(SERVICE_CATALOG).map(([type, meta]) => {
        const svc = services.find((s) => s.ServiceType === type);
        return {
          type,
          label: meta.label,
          hasDuration: meta.hasDuration,
          rateUnit: meta.rateUnit,
          shape: meta.shape,
          enabled: enabledByType.get(type as keyof typeof SERVICE_CATALOG) ?? false,
          questions: svc?.Questions ?? [],
          minNights: svc?.MinNights ?? null,
          maxNights: svc?.MaxNights ?? null,
          minPetCount: svc?.MinPetCount ?? null,
          maxPetCount: svc?.MaxPetCount ?? null,
          options: options
            .filter((o) => o.ServiceType === type)
            .map((o) => ({
              optionKey: o.OptionKey,
              label: o.Label,
              durationMinutes: o.DurationMinutes,
              rate: o.Rate,
              startTime: o.StartTime,
              endTime: o.EndTime,
              capacity: o.Capacity,
            })), // optionKey round-trips back on save so resolveServiceOptions can preserve identity
        };
      }),
      blocked: blocked.map((b) => ({ id: b.Id, startDate: b.StartDate, endDate: b.EndDate })),
      calendar: calendarView(connections),
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
    // Whitespace-only contact fields mean "cleared" — store NULL, not ''.
    const rawContactEmail = patchNullable<string>(body, 'contactEmail', tenant.ContactEmail);
    const contactEmail = rawContactEmail?.trim() || null;
    const rawContactPhone = patchNullable<string>(body, 'contactPhone', tenant.ContactPhone);
    const contactPhone = rawContactPhone?.trim() || null;
    const petTypes = body.petTypes;
    const services = body.services ?? [];
    // Per-service PATCH semantics for questions/constraints (mirrors patchNullable above): a field
    // included in a service's body ⇒ take it; absent ⇒ keep that service's current value. Without
    // this, a caller that PUTs `{type, enabled}` alone (omitting questions/constraints) would
    // silently wipe them back to empty/unlimited.
    const currentServices =
      services.length > 0 ? await listServices(c.env.PAWBOOK_DB, tenant.Id) : [];
    const currentOptions =
      services.length > 0 ? await listServiceOptions(c.env.PAWBOOK_DB, tenant.Id) : [];
    const existingKeysByType = new Map<string, Set<string>>();
    for (const o of currentOptions) {
      const keys = existingKeysByType.get(o.ServiceType) ?? new Set<string>();
      keys.add(o.OptionKey);
      existingKeysByType.set(o.ServiceType, keys);
    }

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
    if (contactEmail !== null && !EMAIL_RE.test(contactEmail))
      return c.json({ error: 'Contact email must be a valid email address.' }, 400);
    if (contactPhone !== null && contactPhone.length > 40)
      return c.json({ error: 'Contact phone is too long.' }, 400);
    if (petTypes !== undefined) {
      if (!Array.isArray(petTypes) || !petTypes.every(isPetType))
        return c.json({ error: 'Unknown pet type.' }, 400);
    }
    const resolvedOptionsByType = new Map<string, ResolvedOption[]>();
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
      const resolvedOptions = resolveServiceOptions(
        meta,
        meta.label,
        opts,
        existingKeysByType.get(svc.type) ?? new Set(),
      );
      if ('error' in resolvedOptions) return c.json({ error: resolvedOptions.error }, 400);
      resolvedOptionsByType.set(svc.type, resolvedOptions.resolved);
      for (const q of svc.questions ?? []) {
        const qError = validateQuestionBody(q);
        if (qError) return c.json({ error: qError }, 400);
      }
      if (
        !isNullableLimit(svc.minNights ?? null, DEFENSIVE_MAX_NIGHTS) ||
        !isNullableLimit(svc.maxNights ?? null, DEFENSIVE_MAX_NIGHTS)
      )
        return c.json({ error: `${meta.label}: nights must be a positive number, or blank.` }, 400);
      if (svc.minNights != null && svc.maxNights != null && svc.minNights > svc.maxNights)
        return c.json({ error: `${meta.label}: min nights cannot exceed max nights.` }, 400);
      if (
        !isNullableLimit(svc.minPetCount ?? null, DEFENSIVE_MAX_PET_COUNT) ||
        !isNullableLimit(svc.maxPetCount ?? null, DEFENSIVE_MAX_PET_COUNT)
      )
        return c.json(
          { error: `${meta.label}: pet count must be a positive number, or blank.` },
          400,
        );
      if (svc.minPetCount != null && svc.maxPetCount != null && svc.minPetCount > svc.maxPetCount)
        return c.json({ error: `${meta.label}: min pets cannot exceed max pets.` }, 400);
    }

    await updateTenantSettings(c.env.PAWBOOK_DB, tenant.Id, {
      displayName,
      accentColor,
      maxBoardingPets,
      maxHouseSitsPerDay,
      maxStayNights,
      timezone,
      contactEmail,
      contactPhone,
    });
    if (petTypes !== undefined) {
      for (const pt of PET_TYPES)
        await setPetTypeEnabled(c.env.PAWBOOK_DB, tenant.Id, pt, petTypes.includes(pt));
    }
    for (const svc of services) {
      const svcType = svc.type as keyof typeof SERVICE_CATALOG;
      const meta = SERVICE_CATALOG[svcType];
      const current = currentServices.find((s) => s.ServiceType === svcType);
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
          : (current?.Questions ?? []);
      await setServiceConfig(c.env.PAWBOOK_DB, tenant.Id, svcType, {
        enabled: svc.enabled ?? false,
        questions,
        minNights: 'minNights' in svc ? (svc.minNights ?? null) : (current?.MinNights ?? null),
        maxNights: 'maxNights' in svc ? (svc.maxNights ?? null) : (current?.MaxNights ?? null),
        minPetCount:
          'minPetCount' in svc ? (svc.minPetCount ?? null) : (current?.MinPetCount ?? null),
        maxPetCount:
          'maxPetCount' in svc ? (svc.maxPetCount ?? null) : (current?.MaxPetCount ?? null),
      });
      await replaceServiceOptions(
        c.env.PAWBOOK_DB,
        tenant.Id,
        svcType,
        (resolvedOptionsByType.get(svcType) ?? []).map((o) => ({
          optionKey: o.optionKey,
          label: o.label,
          durationMinutes: o.durationMinutes,
          rate: o.rate,
          rateUnit: meta.rateUnit,
          startTime: o.startTime,
          endTime: o.endTime,
          capacity: o.capacity,
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
      return c.json({ error: 'Provide a valid date range.' }, 400);
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
    const byUser = new Map<
      string,
      { id: string; name: string; petType: string; notes: string | null }[]
    >();
    for (const p of allPets) {
      const list = byUser.get(p.EndUserId) ?? [];
      list.push({ id: p.Id, name: p.Name, petType: p.PetType, notes: p.Notes });
      byUser.set(p.EndUserId, list);
    }
    const withPets = customers.map((u) => ({
      id: u.Id,
      email: u.Email,
      name: u.Name,
      phone: u.Phone,
      status: u.Status,
      invitedAt: u.InvitedAt,
      pets: byUser.get(u.Id) ?? [],
    }));
    return c.json({ customers: withPets });
  })

  .post('/:slug/admin/customers', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ email?: unknown; name?: unknown; phone?: unknown }>()
      .catch(() => ({}) as { email?: unknown; name?: unknown; phone?: unknown });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const rawName = typeof body.name === 'string' ? body.name.trim() : '';
    const name = rawName || null;
    const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const phone = rawPhone || null;
    if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);
    if (phone !== null && phone.length > 40) return c.json({ error: 'Phone is too long.' }, 400);

    const customer = await insertInvitedCustomer(c.env.PAWBOOK_DB, tenant.Id, email, name, phone);

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
      {
        id: customer.Id,
        email: customer.Email,
        name: customer.Name,
        phone: customer.Phone,
        status: customer.Status,
      },
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
      .json<{ name?: unknown; petType?: unknown; notes?: unknown }>()
      .catch(() => ({}) as { name?: unknown; petType?: unknown; notes?: unknown });
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const petType = body.petType;
    const rawNotes = typeof body.notes === 'string' ? body.notes.trim() : '';
    const notes = rawNotes || null;
    if (!name) return c.json({ error: 'Enter a pet name.' }, 400);
    if (!isPetType(petType)) return c.json({ error: 'Unknown pet type.' }, 400);
    if (notes !== null && notes.length > 2000) return c.json({ error: 'Notes are too long.' }, 400);
    // The customer id comes from the URL; confirm it belongs to this tenant before writing a pet
    // under it (production D1 has foreign keys OFF, so nothing else stops a cross-tenant orphan).
    if (!(await getEndUserById(c.env.PAWBOOK_DB, tenant.Id, endUserId)))
      return c.json({ error: 'Not found.' }, 404);
    const accepted = (await listPetTypes(c.env.PAWBOOK_DB, tenant.Id)).find(
      (pt) => pt.PetType === petType && pt.Enabled,
    );
    if (!accepted) return c.json({ error: 'That pet type is not accepted.' }, 400);
    const pet = await addEndUserPet(c.env.PAWBOOK_DB, tenant.Id, endUserId, name, petType, notes);
    return c.json({ id: pet.Id, name: pet.Name, petType: pet.PetType, notes: pet.Notes }, 201);
  })
  .delete('/:slug/admin/customers/:id/pets/:petId', async (c) => {
    const tenant = c.get('tenant');
    const refs = await countBookingPetRefs(c.env.PAWBOOK_DB, tenant.Id, c.req.param('petId'));
    if (refs > 0) return c.json({ error: 'Pet has bookings; cannot remove.' }, 409);
    const removed = await removeEndUserPet(c.env.PAWBOOK_DB, tenant.Id, c.req.param('petId'));
    if (!removed) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  })

  .get('/:slug/admin/bookings', async (c) => {
    const tenant = c.get('tenant');
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
