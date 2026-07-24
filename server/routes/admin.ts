import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  addEndUserPet,
  clearProviderConnection,
  countBookingPetRefs,
  countBookingsForService,
  countBookingsForUser,
  countPetTypeReferences,
  createPetType,
  createService,
  deletePetTypeAndScrub,
  getAnalytics,
  getBookingSyncData,
  getBookingWithCustomer,
  getEndUserById,
  getEndUserByEmail,
  deleteBlockedRange,
  deleteCustomer,
  deletePayment,
  deleteService,
  getProviderConnection,
  insertBookingRequest,
  insertInvitedCustomer,
  insertPayment,
  listAllEndUserPetsByTenant,
  listBlockedRanges,
  listBookingsForTenant,
  listCustomers,
  listPaymentsForBooking,
  listPetNamesForBooking,
  listPetTypes,
  listProviderConnections,
  listServiceOptions,
  listServices,
  removeEndUserPet,
  renamePetType,
  replaceServiceOptions,
  setProviderCalendarId,
  setServiceConfig,
  updateBookingStatus,
  updateTenantSettings,
} from '../db/repo';
import { isEmailConfigured, sendBookingStatusEmail, sendInvite } from '../lib/email';
import { parseCsvRows } from '../lib/csv';
import { serializeAnalytics } from '../lib/analytics';
import {
  deleteBookingCalendarEvent,
  reconcileIfStale,
  syncBookingToCalendar,
  updateBookingCalendarEvent,
} from '../lib/calendar-sync';
import type { SyncInput } from '../lib/calendar-sync';
import { buildAuthUrl, revokeToken } from '../lib/google-calendar';
import { adminAuth } from '../lib/middleware';
import { signState } from '../lib/oauth-state';
import { calendarView } from '../lib/providers';
import { embedSnippets } from '../lib/snippet';
import {
  isTemplateId,
  MAX_SERVICES,
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
  isPaymentMethod,
  isRealDate,
  isValidDuration,
  isValidRate,
  isValidTimeString,
  minutesBetweenTimes,
} from '../lib/validation';
import type { AppEnv } from '../types';
import type { CancellationTier, ServiceQuestion } from '../../src/shared/index.js';
import {
  cancellationFee,
  getPacificDateStr,
  validateCancellationTiers,
  DEFAULT_TIMEZONE,
} from '../../src/shared/index.js';

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

type OptionBody = {
  optionKey?: string;
  label?: string;
  durationMinutes?: number | null;
  rate?: number;
  startTime?: string | null;
  endTime?: string | null;
  capacity?: number | null;
  weekdaysOnly?: boolean;
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
  weekdaysOnly: boolean;
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
  meta: { hasDuration: boolean },
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
    if (o.weekdaysOnly !== undefined && typeof o.weekdaysOnly !== 'boolean')
      return { error: `${serviceLabel}: weekdays-only must be true or false.` };

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
      weekdaysOnly: o.weekdaysOnly === true,
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
  acceptedPetTypes?: string[] | null;
  maxConcurrentPets?: number | null;
  maxPerDay?: number | null;
  cancellationTiers?: CancellationTier[] | null;
};
type SettingsBody = {
  displayName?: string;
  accentColor?: string;
  timezone?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  services?: ServiceBody[];
};

/**
 * PATCH semantics for a nullable config field: present in the body ⇒ take it (an explicit `null`
 * clears the limit to "unlimited"); absent ⇒ keep the tenant's current value. The lone cast covers
 * the dynamic-key access — call sites stay type-safe via the `T` they pin.
 */
function patchNullable<T extends number | string>(
  body: SettingsBody,
  key: 'timezone' | 'contactEmail' | 'contactPhone',
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
      disabled: tenant.DisabledAt != null,
      displayName: tenant.DisplayName,
      accentColor: tenant.AccentColor,
      timezone: tenant.Timezone,
      contactEmail: tenant.ContactEmail,
      contactPhone: tenant.ContactPhone,
      petTypes: petTypes.map((p) => ({ petType: p.PetType, label: p.Label })),
      services: services.map((svc) => ({
        type: svc.ServiceType,
        label: svc.Label,
        icon: svc.Icon,
        hasDuration: Boolean(svc.HasDuration),
        rateUnit: svc.RateUnit,
        shape: svc.Shape,
        custom: !isTemplateId(svc.ServiceType),
        enabled: Boolean(svc.Enabled),
        questions: svc.Questions,
        minNights: svc.MinNights,
        maxNights: svc.MaxNights,
        minPetCount: svc.MinPetCount,
        maxPetCount: svc.MaxPetCount,
        acceptedPetTypes: svc.AcceptedPetTypes,
        cancellationTiers: svc.CancellationTiers,
        capacityKind: svc.CapacityKind,
        maxConcurrentPets: svc.MaxConcurrentPets,
        options: options
          .filter((o) => o.ServiceType === svc.ServiceType)
          .map((o) => ({
            optionKey: o.OptionKey,
            label: o.Label,
            durationMinutes: o.DurationMinutes,
            rate: o.Rate,
            startTime: o.StartTime,
            endTime: o.EndTime,
            capacity: o.Capacity,
            weekdaysOnly: Boolean(o.WeekdaysOnly),
          })), // optionKey round-trips back on save so resolveServiceOptions can preserve identity
      })),
      // "Add service" picker: template id + display label of each built-in behavior archetype.
      templates: TEMPLATE_IDS.map((id) => ({ id, label: SERVICE_TEMPLATES[id].label })),
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
    const timezone = patchNullable<string>(body, 'timezone', tenant.Timezone);
    // Whitespace-only contact fields mean "cleared" — store NULL, not ''.
    const rawContactEmail = patchNullable<string>(body, 'contactEmail', tenant.ContactEmail);
    const contactEmail = rawContactEmail?.trim() || null;
    const rawContactPhone = patchNullable<string>(body, 'contactPhone', tenant.ContactPhone);
    const contactPhone = rawContactPhone?.trim() || null;
    const services = body.services ?? [];
    // Per-service PATCH semantics for questions/constraints (mirrors patchNullable above): a field
    // included in a service's body ⇒ take it; absent ⇒ keep that service's current value. Without
    // this, a caller that PUTs `{type, enabled}` alone (omitting questions/constraints) would
    // silently wipe them back to empty/unlimited.
    const currentServices =
      services.length > 0 ? await listServices(c.env.PAWBOOK_DB, tenant.Id) : [];
    const currentOptions =
      services.length > 0 ? await listServiceOptions(c.env.PAWBOOK_DB, tenant.Id) : [];
    const tenantPetTypes = await listPetTypes(c.env.PAWBOOK_DB, tenant.Id);
    const knownPetSlugs = new Set(tenantPetTypes.map((p) => p.PetType));
    const existingKeysByType = new Map<string, Set<string>>();
    for (const o of currentOptions) {
      const keys = existingKeysByType.get(o.ServiceType) ?? new Set<string>();
      keys.add(o.OptionKey);
      existingKeysByType.set(o.ServiceType, keys);
    }

    if (!displayName) return c.json({ error: 'Display name required.' }, 400);
    if (!COLOR_RE.test(accentColor)) return c.json({ error: 'Accent color must be #rrggbb.' }, 400);
    if (!isValidTimezone(timezone)) return c.json({ error: 'Unknown timezone.' }, 400);
    if (contactEmail !== null && !EMAIL_RE.test(contactEmail))
      return c.json({ error: 'Contact email must be a valid email address.' }, 400);
    if (contactPhone !== null && contactPhone.length > 40)
      return c.json({ error: 'Contact phone is too long.' }, 400);
    const resolvedOptionsByType = new Map<string, ResolvedOption[]>();
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
      const resolvedOptions = resolveServiceOptions(
        { hasDuration },
        meta.Label,
        opts,
        existingKeysByType.get(svc.type as string) ?? new Set(),
      );
      if ('error' in resolvedOptions) return c.json({ error: resolvedOptions.error }, 400);
      resolvedOptionsByType.set(svc.type as string, resolvedOptions.resolved);
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
      // Per-service cap (0015; pets everywhere as of 0017): same PATCH idiom, same 1..1000 sanity
      // rail. MaxConcurrentPets is the pets-per-day cap for BOTH pool kinds.
      if (!isNullableLimit(svc.maxConcurrentPets ?? null, DEFENSIVE_MAX_PET_COUNT))
        return c.json(
          { error: `${meta.Label}: capacity must be a positive number, or blank for no limit.` },
          400,
        );
      if (
        svc.maxConcurrentPets != null &&
        meta.CapacityKind !== 'boarding' &&
        meta.CapacityKind !== 'housesit'
      )
        return c.json(
          { error: `${meta.Label}: that capacity doesn't apply to this service.` },
          400,
        );
      // MaxPerDay is retired (0017): the house-sit cap now lives on MaxConcurrentPets. A client that
      // still sends the old field is rejected — rather than silently dropping the intended cap.
      if (svc.maxPerDay != null)
        return c.json(
          { error: `${meta.Label}: that capacity doesn't apply to this service.` },
          400,
        );
      if (svc.cancellationTiers != null && !validateCancellationTiers(svc.cancellationTiers))
        return c.json(
          {
            error: `${meta.Label}: cancellation tiers must be 1-5 rows of increasing days with a 1-100 percent.`,
          },
          400,
        );
      // Per-service acceptance list: PATCH semantics (absent = keep current). An explicit list
      // must be a subset of the tenant's slugs; the EFFECTIVE list (incoming or kept) may not be
      // empty on an enabled service — "accepts nothing" is expressed by disabling the service.
      if ('acceptedPetTypes' in svc && svc.acceptedPetTypes != null) {
        if (
          !Array.isArray(svc.acceptedPetTypes) ||
          !svc.acceptedPetTypes.every((t) => typeof t === 'string' && knownPetSlugs.has(t))
        )
          return c.json({ error: `${meta.Label}: unknown pet type in the accepted list.` }, 400);
      }
      const effectiveAccepted =
        'acceptedPetTypes' in svc ? (svc.acceptedPetTypes ?? null) : meta.AcceptedPetTypes;
      if (svc.enabled && effectiveAccepted !== null && effectiveAccepted.length === 0)
        return c.json(
          {
            error: `${meta.Label} must accept at least one pet type — disable the service instead.`,
          },
          400,
        );
    }

    await updateTenantSettings(c.env.PAWBOOK_DB, tenant.Id, {
      displayName,
      accentColor,
      timezone,
      contactEmail,
      contactPhone,
    });
    for (const svc of services) {
      const svcType = svc.type as string;
      // Validation above guarantees a matching row exists.
      const current = currentServices.find((s) => s.ServiceType === svcType)!;
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
      const updated = await setServiceConfig(c.env.PAWBOOK_DB, tenant.Id, svcType, {
        enabled: svc.enabled ?? false,
        questions,
        minNights: 'minNights' in svc ? (svc.minNights ?? null) : current.MinNights,
        maxNights: 'maxNights' in svc ? (svc.maxNights ?? null) : current.MaxNights,
        minPetCount: 'minPetCount' in svc ? (svc.minPetCount ?? null) : current.MinPetCount,
        maxPetCount: 'maxPetCount' in svc ? (svc.maxPetCount ?? null) : current.MaxPetCount,
        acceptedPetTypes:
          'acceptedPetTypes' in svc ? (svc.acceptedPetTypes ?? null) : current.AcceptedPetTypes,
        maxConcurrentPets:
          'maxConcurrentPets' in svc ? (svc.maxConcurrentPets ?? null) : current.MaxConcurrentPets,
        cancellationTiers:
          'cancellationTiers' in svc ? (svc.cancellationTiers ?? null) : current.CancellationTiers,
      });
      // The service existed when validated above but was deleted by a concurrent request since —
      // stop before writing options for a slug that no longer exists.
      if (!updated)
        return c.json({ error: `${current.Label} was deleted. Refresh and retry.` }, 409);
      await replaceServiceOptions(
        c.env.PAWBOOK_DB,
        tenant.Id,
        svcType,
        (resolvedOptionsByType.get(svcType) ?? []).map((o) => ({
          optionKey: o.optionKey,
          label: o.label,
          durationMinutes: o.durationMinutes,
          rate: o.rate,
          rateUnit: current.RateUnit,
          startTime: o.startTime,
          endTime: o.endTime,
          capacity: o.capacity,
          weekdaysOnly: o.weekdaysOnly,
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
    // Owner directive: cap TOTAL service rows (enabled or disabled) per tenant — creation is the
    // only place a new row appears, so this is the sole gate. Seeded demo tenants may already sit
    // at the cap; that's fine, they can still edit/enable what they have.
    if (existing.length >= MAX_SERVICES)
      return c.json(
        {
          error: `You've reached the limit of ${MAX_SERVICES} services. Delete one you no longer offer to add another.`,
        },
        400,
      );
    if (existing.some((s) => s.ServiceType === slug))
      return c.json({ error: 'A service with that name already exists.' }, 400);

    const tpl = SERVICE_TEMPLATES[body.template];
    try {
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
    } catch (err) {
      // The listServices check above can't see a concurrent insert of the same slug — fall back
      // to the DB's UNIQUE(TenantId, ServiceType) constraint as the source of truth.
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed'))
        return c.json({ error: 'A service with that name already exists.' }, 400);
      throw err;
    }
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
    if (isTemplateId(type))
      return c.json({ error: 'Built-in services can be disabled, not deleted.' }, 400);
    if ((await countBookingsForService(c.env.PAWBOOK_DB, tenant.Id, type)) > 0)
      return c.json({ error: 'That service has bookings — disable it instead.' }, 409);
    await deleteService(c.env.PAWBOOK_DB, tenant.Id, type);
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.body(null, 204);
  })

  // Pet-type registry CRUD: add/rename/delete are immediate (the services split). Slugs are
  // immutable — rename changes the display Label only, so history keeps resolving. On/off lives
  // on each service's AcceptedPetTypes.
  .post('/:slug/admin/pet-types', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req.json<{ label?: unknown }>().catch(() => ({}) as { label?: unknown });
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label) return c.json({ error: 'Pet type name required.' }, 400);
    const petType = slugifyServiceLabel(label);
    if (!petType) return c.json({ error: 'Pick a different pet type name.' }, 400);
    try {
      await createPetType(c.env.PAWBOOK_DB, tenant.Id, petType, label);
    } catch (err) {
      // UNIQUE(TenantId, PetType) is the source of truth for duplicates (concurrent adds included).
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed'))
        return c.json({ error: 'A pet type with that name already exists.' }, 409);
      throw err;
    }
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.json({ petType, label }, 201);
  })

  .put('/:slug/admin/pet-types/:petType', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req.json<{ label?: unknown }>().catch(() => ({}) as { label?: unknown });
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label) return c.json({ error: 'Pet type name required.' }, 400);
    const petType = c.req.param('petType');
    const renamed = await renamePetType(c.env.PAWBOOK_DB, tenant.Id, petType, label);
    if (!renamed) return c.json({ error: 'Unknown pet type.' }, 404);
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.json({ petType, label });
  })

  // Blocked with 409 while ANY customer pet or booking (any status — history included, the
  // deleteService precedent) references the slug; an unreferenced delete also scrubs the slug
  // from every service's acceptance list (config, not history — safe to clean). A list emptied
  // by the scrub becomes '[]' (accepts nothing), never NULL (accepts all) — and an enabled
  // service that just emptied out gets disabled in the same batch (migration 0015 step 6's
  // rule; see deletePetTypeAndScrub). `disabledServices` tells the caller which ones, so the
  // sitter finds out here instead of noticing a dead service later.
  .delete('/:slug/admin/pet-types/:petType', async (c) => {
    const tenant = c.get('tenant');
    const petType = c.req.param('petType');
    const rows = await listPetTypes(c.env.PAWBOOK_DB, tenant.Id);
    if (!rows.some((p) => p.PetType === petType))
      return c.json({ error: 'Unknown pet type.' }, 404);
    const refs = await countPetTypeReferences(c.env.PAWBOOK_DB, tenant.Id, petType);
    if (refs > 0)
      return c.json(
        {
          error: `That pet type is on ${refs} ${refs === 1 ? 'pet or booking' : 'pets or bookings'} and can't be deleted. Uncheck it under each service's Accepted pets instead.`,
        },
        409,
      );
    const { disabledServices } = await deletePetTypeAndScrub(c.env.PAWBOOK_DB, tenant.Id, petType);
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.json({ disabledServices }, 200);
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
    // Disabled tenants are read-only — connecting a calendar is a settings write via the callback.
    if (tenant.DisabledAt) return c.json({ error: 'account_disabled' }, 403);
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
    const petType = typeof body.petType === 'string' ? body.petType : '';
    const rawNotes = typeof body.notes === 'string' ? body.notes.trim() : '';
    const notes = rawNotes || null;
    if (!name) return c.json({ error: 'Enter a pet name.' }, 400);
    if (!petType) return c.json({ error: 'Unknown pet type.' }, 400);
    if (notes !== null && notes.length > 2000) return c.json({ error: 'Notes are too long.' }, 400);
    // The customer id comes from the URL; confirm it belongs to this tenant before writing a pet
    // under it (production D1 has foreign keys OFF, so nothing else stops a cross-tenant orphan).
    if (!(await getEndUserById(c.env.PAWBOOK_DB, tenant.Id, endUserId)))
      return c.json({ error: 'Not found.' }, 404);
    // Registry membership only (0015): a sitter may record a pet of a type no service currently
    // accepts — it just can't be booked until some service's Accepted pets list includes it.
    const known = (await listPetTypes(c.env.PAWBOOK_DB, tenant.Id)).find(
      (pt) => pt.PetType === petType,
    );
    if (!known) return c.json({ error: 'That pet type is not accepted.' }, 400);
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
    const knownPetTypes = new Set(
      (await listPetTypes(c.env.PAWBOOK_DB, tenant.Id)).map((pt) => pt.PetType),
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
        if (!knownPetTypes.has(petType)) {
          skippedRows.push({ row, reason: `'${rawPetType.trim()}' is not one of your pet types` });
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
    // A disabled tenant is read-only: don't run the calendar self-heal (a write) on this GET.
    if (!tenant.DisabledAt) await reconcileIfStale(c.env, tenant);
    const rows = await listBookingsForTenant(c.env.PAWBOOK_DB, tenant.Id);
    // Cancellation policy per service, so each confirmed row can preview the fee it would owe if
    // cancelled today (one query, keyed by ServiceType; NULL/missing = no policy).
    const tiersByType = new Map<string, CancellationTier[] | null>(
      (await listServices(c.env.PAWBOOK_DB, tenant.Id)).map((s) => [
        s.ServiceType,
        s.CancellationTiers,
      ]),
    );
    const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
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
        paidTotal: r.PaidTotal ?? 0,
        status: r.Declined ? 'declined' : r.Status,
        cancellationFee: r.CancellationFee,
        feeIfCancelledToday:
          r.Status === 'confirmed' && r.EstCost != null && tiersByType.get(r.ServiceType)
            ? cancellationFee(tiersByType.get(r.ServiceType)!, r.EstCost, r.StartDate, today)
            : null,
        createdAt: r.CreatedAt,
      })),
    });
  })

  .post('/:slug/admin/bookings/:id/status', async (c) => {
    const tenant = c.get('tenant');
    const id = c.req.param('id');
    const body = await c.req
      .json<{ status?: unknown; chargeFee?: unknown }>()
      .catch(() => ({}) as { status?: unknown; chargeFee?: unknown });
    const status = body.status;
    if (status !== 'confirmed' && status !== 'cancelled' && status !== 'declined')
      return c.json({ error: "Status must be 'confirmed', 'declined', or 'cancelled'." }, 400);

    // Cancellation-fee assessment. The amount is ALWAYS computed server-side from the tenant's
    // policy — the request only supplies the `chargeFee` boolean, never a dollar figure. A $0
    // computed fee stores NULL (no fee assessed).
    let fee: number | undefined;
    if (body.chargeFee === true) {
      if (status !== 'cancelled')
        return c.json({ error: 'A cancellation fee applies only when cancelling.' }, 400);
      const bk = await getBookingWithCustomer(c.env.PAWBOOK_DB, tenant.Id, id);
      if (!bk) return c.json({ error: 'Not found.' }, 404);
      if (bk.Status !== 'confirmed' || bk.EstCost == null)
        return c.json({ error: 'A fee needs a confirmed booking with an estimated cost.' }, 400);
      const svc = (await listServices(c.env.PAWBOOK_DB, tenant.Id)).find(
        (s) => s.ServiceType === bk.ServiceType,
      );
      if (!svc?.CancellationTiers)
        return c.json({ error: 'This service has no cancellation policy.' }, 400);
      const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
      const computed = cancellationFee(svc.CancellationTiers, bk.EstCost, bk.StartDate, today);
      if (computed > 0) fee = computed; // $0 stores NULL per spec
    }

    const updated = await updateBookingStatus(c.env.PAWBOOK_DB, tenant.Id, id, status, fee);
    if (!updated) return c.json({ error: 'Not found.' }, 404);

    // One unconditional fetch serves both the calendar hooks and the customer
    // notification below (cancel/decline are soft — the row still exists).
    const booking = await getBookingWithCustomer(c.env.PAWBOOK_DB, tenant.Id, id);

    // Calendar hooks are best-effort and never block the response (waitUntil in production; awaited
    // in tests, which have no ExecutionContext — see routes/bookings.ts).
    let calendarTask: Promise<void> | null = null;
    if (status === 'confirmed') {
      // Confirm: retitle the existing event (drop the [REQUEST] marker), or — if the booking has
      // NO event yet (booked before the calendar was connected, or a Google outage swallowed the
      // request-time create) — create it now as a catch-up, already in the confirmed state.
      const syncData = await getBookingSyncData(c.env.PAWBOOK_DB, tenant.Id, id);
      if (syncData) {
        const petNames = await listPetNamesForBooking(c.env.PAWBOOK_DB, tenant.Id, id);
        const input: SyncInput = {
          bookingId: id,
          endUserId: syncData.EndUserId,
          serviceType: syncData.ServiceType,
          serviceLabel: syncData.ServiceLabel,
          startDate: syncData.StartDate,
          endDate: syncData.EndDate,
          startTime: syncData.StartTime,
          durationMinutes: syncData.DurationMinutes,
          petCount: syncData.PetCount,
          petNames,
          estCost: syncData.EstCost,
          status: 'confirmed',
        };
        calendarTask = booking?.GCalEventId
          ? updateBookingCalendarEvent(c.env, tenant, booking.GCalEventId, input)
          : syncBookingToCalendar(c.env, tenant, input);
      }
    } else if (booking?.GCalEventId) {
      // Cancel/decline: delete the synced Google event. The booking keeps its GCalEventId as a
      // historical record; reconciliation ignores cancelled rows.
      calendarTask = deleteBookingCalendarEvent(c.env, tenant, booking.GCalEventId);
    }

    if (calendarTask) {
      const task = calendarTask.catch((err) => {
        console.error('calendar status sync failed', err);
      });
      try {
        c.executionCtx.waitUntil(task);
      } catch {
        await task;
      }
    }

    // Best-effort customer notification; `notified` lets the dashboard tell the sitter honestly
    // whether the client heard about it (false when email isn't configured or the send failed).
    let notified = false;
    if (isEmailConfigured(c.env) && booking?.Email) {
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
    return c.json({ status, notified, cancellationFee: fee ?? null });
  })

  .post('/:slug/admin/bookings/:id/payments', async (c) => {
    const tenant = c.get('tenant');
    const bookingId = c.req.param('id');
    const body = await c.req
      .json<{ amount?: unknown; method?: unknown; paidDate?: unknown; note?: unknown }>()
      .catch(() => ({}) as Record<string, never>);
    if (!isValidRate(body.amount))
      return c.json({ error: 'Amount must be whole dollars ≥ 1.' }, 400);
    if (!isPaymentMethod(body.method)) return c.json({ error: 'Unknown payment method.' }, 400);
    if (typeof body.paidDate !== 'string' || !isRealDate(body.paidDate))
      return c.json({ error: 'Invalid payment date.' }, 400);
    const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim() : null;
    const paymentId = await insertPayment(c.env.PAWBOOK_DB, tenant.Id, {
      bookingRequestId: bookingId,
      amount: body.amount,
      method: body.method,
      paidDate: body.paidDate,
      note,
    });
    // Guard refused: foreign, blocked, or cancelled booking (pending is deliberately allowed).
    if (!paymentId) return c.json({ error: 'Not found.' }, 404);
    const payments = await listPaymentsForBooking(c.env.PAWBOOK_DB, tenant.Id, bookingId);
    const created = payments.find((p) => p.Id === paymentId);
    if (!created) return c.json({ error: 'Not found.' }, 404);
    return c.json(
      {
        payment: {
          id: created.Id,
          amount: created.Amount,
          method: created.Method,
          paidDate: created.PaidDate,
          note: created.Note,
        },
        paidTotal: payments.reduce((sum, p) => sum + p.Amount, 0),
      },
      201,
    );
  })

  .get('/:slug/admin/bookings/:id/payments', async (c) => {
    const tenant = c.get('tenant');
    const bookingId = c.req.param('id');
    // Same existence guard as POST/DELETE: foreign booking or the 'blocked' sentinel 404s. Unlike
    // POST, a cancelled booking is still viewable here — DELETE is the correction mechanism for it.
    const booking = await getBookingWithCustomer(c.env.PAWBOOK_DB, tenant.Id, bookingId);
    if (!booking || booking.ServiceType === 'blocked') return c.json({ error: 'Not found.' }, 404);
    const rows = await listPaymentsForBooking(c.env.PAWBOOK_DB, tenant.Id, bookingId);
    return c.json({
      payments: rows.map((p) => ({
        id: p.Id,
        amount: p.Amount,
        method: p.Method,
        paidDate: p.PaidDate,
        note: p.Note,
      })),
    });
  })

  .delete('/:slug/admin/bookings/:id/payments/:paymentId', async (c) => {
    const tenant = c.get('tenant');
    const deleted = await deletePayment(
      c.env.PAWBOOK_DB,
      tenant.Id,
      c.req.param('id'),
      c.req.param('paymentId'),
    );
    if (!deleted) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  })

  // Earnings dashboard payload. All aggregation is SQL (getAnalytics); the tiles are derived
  // here in JS from the aggregates — no extra queries, no KV caching (prototype-scale D1).
  .get('/:slug/admin/analytics', async (c) => {
    const tenant = c.get('tenant');
    // A disabled tenant is read-only: don't run the calendar self-heal (a write) on this GET.
    if (!tenant.DisabledAt) await reconcileIfStale(c.env, tenant);
    const today = getPacificDateStr(undefined, tenant.Timezone ?? undefined);
    const data = await getAnalytics(c.env.PAWBOOK_DB, tenant.Id, today);
    return c.json(serializeAnalytics(data));
  });
