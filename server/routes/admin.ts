import { Hono } from 'hono';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  addEndUserPet,
  addPetOwner,
  clearProviderConnection,
  countBookingPetRefs,
  countBookingsForService,
  countBookingsForUser,
  countPetTypeReferences,
  createPetType,
  createService,
  deleteAllExternalEvents,
  deletePetTypeAndScrub,
  getAnalytics,
  getBookingSyncData,
  getBookingWithCustomer,
  getEndUserById,
  getEndUserByEmail,
  deleteBlockedRange,
  deleteBookingCharge,
  deleteCustomer,
  deletePayment,
  deletePetGroupRateById,
  deleteService,
  getProviderConnection,
  getTenantUserEmailById,
  insertBookingCharge,
  insertBookingRequest,
  insertInvitedCustomerWithPet,
  insertPayment,
  listAllEndUserPetsByTenant,
  listAllPetGroupPricing,
  listBlockedRanges,
  listBookingsForTenant,
  listChargesForBooking,
  listChargesForTenant,
  listCustomers,
  listEndUserPets,
  listOutstandingBookings,
  listPaymentExternalRefs,
  listPaymentsForBooking,
  listPetNamesForBooking,
  listPetTypes,
  listProviderConnections,
  listServiceOptions,
  listServicePetRates,
  listServices,
  removeEndUserPet,
  removePetOwner,
  renamePetType,
  replaceServiceOptions,
  replaceServicePetRates,
  setProviderCalendarId,
  setServiceConfig,
  setPetDeceased,
  setEndUserVenmoUsername,
  updateBookingStatus,
  updateTenantSettings,
  upsertPetGroupRate,
} from '../db/repo';
import { isEmailConfigured, sendBookingStatusEmail, sendInvite } from '../lib/email';
import { parseCsvRows } from '../lib/csv';
import { isUniqueViolation } from '../lib/db-errors';
import { serializeAnalytics } from '../lib/analytics';
import {
  backfillCalendarEvents,
  deleteBookingCalendarEvent,
  getCalendarAccessToken,
  reconcileIfStale,
  repointCalendarTarget,
  syncBookingToCalendar,
  updateBookingCalendarEvent,
} from '../lib/calendar-sync';
import type { SyncInput } from '../lib/calendar-sync';
import {
  buildAuthUrl,
  CalendarAuthError,
  createCalendar,
  PET_CALENDAR_SUMMARY,
  revokeToken,
} from '../lib/google-calendar';
import { DEMO_EMAIL } from '../lib/demo';
import { adminAuth } from '../lib/middleware';
import { signState } from '../lib/oauth-state';
import { calendarView } from '../lib/providers';
import { embedSnippets } from '../lib/snippet';
import {
  isTemplateId,
  MAX_QUESTIONS_PER_SERVICE,
  MAX_SERVICES,
  RESERVED_SERVICE_SLUGS,
  SERVICE_TEMPLATES,
  slugifyServiceLabel,
  TEMPLATE_IDS,
} from '../lib/services';
import { decryptToken } from '../lib/token-crypto';
import { invalidateTenantCache } from '../lib/tenant-resolve';
import {
  isVenmoTxnId,
  MAX_VENMO_ROWS,
  matchVenmoTxns,
  parseVenmoCsv,
  rankCandidates,
  resolveMatchClient,
  type MatchClient,
  type OutstandingBooking,
} from '../lib/venmo';
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
  MAX_PET_COUNT_CAP,
  minutesBetweenTimes,
} from '../lib/validation';
import type { AppEnv, Tenant } from '../types';
import type { CancellationTier, ServiceQuestion } from '../../src/shared/index.js';
import {
  buildGroupKey,
  buildMixKey,
  cancellationFee,
  getPacificDateStr,
  isDedicatedCalendarId,
  parseMixKey,
  petCountOf,
  validateCancellationTiers,
  DEFAULT_TIMEZONE,
} from '../../src/shared/index.js';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Re-create future bookings' events in the currently-targeted calendar. Best-effort and never blocks
 * the response (waitUntil in production; awaited in tests, which have no ExecutionContext — same
 * dance as routes/bookings.ts and the OAuth callback).
 */
async function backfillInBackground(c: Context<AppEnv>, tenant: Tenant): Promise<void> {
  const task = backfillCalendarEvents(c.env, tenant).catch((err) => {
    console.error('calendar backfill failed', err);
  });
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    await task;
  }
}

/**
 * The three tenant-scoped reads the Venmo importer matches against, plus the service labels the
 * preview prints. Loaded identically by the preview and the confirm step: the confirm re-derives
 * the whole candidate set rather than trusting what the preview told the browser.
 */
async function loadVenmoMatchInputs(
  env: AppEnv['Bindings'],
  tenantId: string,
): Promise<{
  clients: MatchClient[];
  outstanding: OutstandingBooking[];
  alreadyImported: Set<string>;
}> {
  const [customers, bookings, refs, services] = await Promise.all([
    listCustomers(env.PAWBOOK_DB, tenantId),
    listOutstandingBookings(env.PAWBOOK_DB, tenantId),
    listPaymentExternalRefs(env.PAWBOOK_DB, tenantId),
    listServices(env.PAWBOOK_DB, tenantId),
  ]);
  const labelByType = new Map(services.map((s) => [s.ServiceType, s.Label]));
  return {
    clients: customers.map((u) => ({
      endUserId: u.Id,
      label: u.Name || u.Email,
      name: u.Name,
      venmoUsername: u.VenmoUsername,
    })),
    outstanding: bookings
      // A booking whose client was removed has nobody to match it to.
      .filter((b): b is typeof b & { EndUserId: string } => b.EndUserId !== null)
      .map((b) => ({
        bookingId: b.BookingId,
        endUserId: b.EndUserId,
        label: `${labelByType.get(b.ServiceType) ?? b.ServiceType} starting ${b.StartDate}`,
        startDate: b.StartDate,
        balance: b.Expected - b.PaidTotal,
      })),
    alreadyImported: new Set(refs),
  };
}

/**
 * Each pet-bearing row triggers several sequential D1 calls; an unbounded import can exceed
 * Workers' subrequest/CPU ceiling mid-loop, which aborts outside the per-row try/catch and
 * returns a bare 500 with no partial-import report. Cap row count so oversized files fail fast
 * with an actionable error instead of a platform crash.
 */
const MAX_IMPORT_ROWS = 500;

/**
 * A service's Description is a SHORT blurb under the service name in the widget's picker, not a
 * body of copy — cap it so one service can't push the whole picker off the page.
 */
const MAX_SERVICE_DESCRIPTION = 200;

/** Charge names are a short line item ("Vet visit"), not a note — the ledger row must stay
 *  readable inside a booking row on a phone. */
const MAX_CHARGE_LABEL = 60;

/** Venmo's own handle limit. Capped here so a hostile PATCH can't park a novel on a client row. */
const MAX_VENMO_USERNAME = 30;

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
  /** Species-count rates for this option. Absent = keep stored rows; present = replace them. */
  petRates?: { mixKey?: unknown; rate?: unknown }[];
};

type QuestionBody = {
  id?: string;
  label?: string;
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  options?: string[];
};

const QUESTION_TYPES = ['text', 'yesno', 'number', 'select'] as const;

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
    // Names the service AND the option, like every sibling error here: a new service/option now
    // starts with an EMPTY price (no default), so a missing rate is the COMMON way to land here
    // and "which price?" has to be answerable from the message alone.
    if (!isValidRate(o.rate))
      return { error: `${serviceLabel}: “${label}” needs a price — whole dollars ≥ 1.` };

    const hasStart = o.startTime !== undefined && o.startTime !== null;
    const hasEnd = o.endTime !== undefined && o.endTime !== null;
    if (hasStart !== hasEnd)
      return { error: `${serviceLabel}: a time window needs both a start and an end time.` };
    if (hasStart && !meta.hasDuration)
      // Gated on hasDuration (walks bill per walk, check-ins per visit — both qualify), so the
      // message names the shape rather than one unit's noun.
      return { error: `${serviceLabel}: only services with timed options can have a time window.` };
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

/** Validates a question's DEFINITION (not an answer) — shape/type/options sanity. */
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
  return null;
}

/**
 * Validates one option's species-count rates. Keys must be CANONICAL (`buildMixKey ∘ parseMixKey`
 * is the identity exactly on canonical keys) — the client builds them with the same shared
 * `buildMixKey`, so a non-canonical key is a client bug, not sitter input. Every species must be
 * in the service's EFFECTIVE accepted list: a rate for a pet type the service refuses could never
 * match a legal booking and would only mislead the sitter into thinking it's priced.
 */
function validateOptionPetRates(
  serviceLabel: string,
  optionLabel: string,
  petRates: unknown,
  allowedSpecies: Set<string>,
): { error: string } | { rates: { mixKey: string; rate: number }[] } {
  if (!Array.isArray(petRates))
    return { error: `${serviceLabel}: “${optionLabel}” pet-mix rates must be a list.` };
  const rates: { mixKey: string; rate: number }[] = [];
  const seen = new Set<string>();
  for (const r of petRates) {
    const mixKey =
      typeof (r as { mixKey?: unknown })?.mixKey === 'string'
        ? (r as { mixKey: string }).mixKey
        : '';
    const mix = parseMixKey(mixKey);
    if (mixKey === '' || buildMixKey(mix) !== mixKey)
      return {
        error: `${serviceLabel}: “${optionLabel}” has a pet-mix rate with no pets — pick at least one pet for each rate.`,
      };
    if (petCountOf(mix) > DEFENSIVE_MAX_PET_COUNT)
      return { error: `${serviceLabel}: “${optionLabel}” has a pet-mix rate with too many pets.` };
    for (const slug of Object.keys(mix))
      if (!allowedSpecies.has(slug))
        return {
          error: `${serviceLabel}: “${optionLabel}” has a rate for a pet type this service doesn't accept.`,
        };
    const rate = (r as { rate?: unknown }).rate;
    if (!isValidRate(rate))
      return {
        error: `${serviceLabel}: “${optionLabel}” pet-mix rates need a price — whole dollars ≥ 1.`,
      };
    if (seen.has(mixKey))
      return { error: `${serviceLabel}: “${optionLabel}” has two rates for the same pet mix.` };
    seen.add(mixKey);
    rates.push({ mixKey, rate });
  }
  return { rates };
}

type ServiceBody = {
  type?: string;
  enabled?: boolean;
  description?: string | null;
  options?: OptionBody[];
  questions?: QuestionBody[];
  /** Removed — declared only so a client that still sends it is REJECTED, not silently ignored. */
  minNights?: number | null;
  maxNights?: number | null;
  /** Retired — declared only so a client that still sends it is REJECTED, not silently ignored. */
  minPetCount?: number | null;
  maxPetCount?: number | null;
  acceptedPetTypes?: string[] | null;
  maxConcurrentPets?: number | null;
  maxPerDay?: number | null;
  cancellationTiers?: CancellationTier[] | null;
  /** Explicit whole-dollar holiday rate; null clears it. PATCH: absent = keep current. */
  holidayRate?: number | null;
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

/**
 * A `description`, if the client sent one at all, must be text or an explicit `null` (= clear it).
 * Anything else — a number, an object, `true` — is a client bug, and coercing it would silently
 * WIPE a stored blurb on a request that never meant to touch it. Reject instead.
 */
function isValidDescriptionBody(svc: ServiceBody): boolean {
  if (!('description' in svc)) return true;
  return svc.description === null || typeof svc.description === 'string';
}

/**
 * A service's widget-facing blurb, on the same PATCH terms as `patchNullable`: present in the
 * service body ⇒ take it (trimmed; `''`/whitespace-only means "cleared" ⇒ NULL), absent ⇒ keep
 * the service's current value. One function so the length check and the write can never disagree
 * about what would be stored. `isValidDescriptionBody` has already rejected every shape but a
 * string and an explicit null, so the non-string branch here is only ever the explicit null.
 */
function resolveServiceDescription(svc: ServiceBody, current: string | null): string | null {
  if (!('description' in svc)) return current;
  return typeof svc.description === 'string' ? svc.description.trim() || null : null;
}

export const adminRoutes = new Hono<AppEnv>()
  .use('/:slug/admin/*', adminAuth)

  .get('/:slug/admin/settings', async (c) => {
    const tenant = c.get('tenant');
    const [services, options, petTypes, blocked, connections, adminEmail, mixRates, groupRates] =
      await Promise.all([
        listServices(c.env.PAWBOOK_DB, tenant.Id),
        listServiceOptions(c.env.PAWBOOK_DB, tenant.Id),
        listPetTypes(c.env.PAWBOOK_DB, tenant.Id),
        listBlockedRanges(c.env.PAWBOOK_DB, tenant.Id),
        listProviderConnections(c.env.PAWBOOK_DB, tenant.Id),
        getTenantUserEmailById(c.env.PAWBOOK_DB, tenant.Id, c.get('adminUserId')),
        listServicePetRates(c.env.PAWBOOK_DB, tenant.Id),
        listAllPetGroupPricing(c.env.PAWBOOK_DB, tenant.Id),
      ]);
    return c.json({
      disabled: tenant.DisabledAt != null,
      displayName: tenant.DisplayName,
      accentColor: tenant.AccentColor,
      timezone: tenant.Timezone,
      contactEmail: tenant.ContactEmail,
      contactPhone: tenant.ContactPhone,
      // The signed-in sitter's own login email — never a client-settable field; the setup wizard
      // prefills a NULL contactEmail with it (tenants created before signup stamped ContactEmail).
      adminEmail,
      petTypes: petTypes.map((p) => ({ petType: p.PetType, label: p.Label })),
      services: services.map((svc) => ({
        type: svc.ServiceType,
        label: svc.Label,
        icon: svc.Icon,
        description: svc.Description,
        hasDuration: Boolean(svc.HasDuration),
        rateUnit: svc.RateUnit,
        shape: svc.Shape,
        custom: !isTemplateId(svc.ServiceType),
        enabled: Boolean(svc.Enabled),
        questions: svc.Questions,
        maxNights: svc.MaxNights,
        maxPetCount: svc.MaxPetCount,
        acceptedPetTypes: svc.AcceptedPetTypes,
        cancellationTiers: svc.CancellationTiers,
        capacityKind: svc.CapacityKind,
        maxConcurrentPets: svc.MaxConcurrentPets,
        holidayRate: svc.HolidayRate,
        // How many SPECIFIC-pet rates cover 2+ pets — feeds the client's coarse "multi-pet but
        // unpriced" warning (spec §6). A comma in GroupKey means 2+ pet ids by construction.
        multiPetGroupRateCount: groupRates.filter(
          (g) => g.ServiceType === svc.ServiceType && g.GroupKey.includes(','),
        ).length,
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
            // Species-count rates for THIS option ("2 dogs $60"), editable in ServiceEditor.
            petRates: mixRates
              .filter((r) => r.ServiceType === svc.ServiceType && r.OptionKey === o.OptionKey)
              .map((r) => ({ mixKey: r.MixKey, rate: r.Rate })),
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
    // svcType -> resolved optionKey -> validated rates; applied after replaceServiceOptions.
    const petRatesByType = new Map<string, Map<string, { mixKey: string; rate: number }[]>>();
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
      if ((svc.questions?.length ?? 0) > MAX_QUESTIONS_PER_SERVICE)
        return c.json(
          {
            error: `${meta.Label}: a service can have at most ${MAX_QUESTIONS_PER_SERVICE} questions — shorter forms get answered.`,
          },
          400,
        );
      for (const q of svc.questions ?? []) {
        const qError = validateQuestionBody(q);
        if (qError) return c.json({ error: qError }, 400);
      }
      if (!isValidDescriptionBody(svc))
        return c.json({ error: `${meta.Label}: description must be text.` }, 400);
      const description = resolveServiceDescription(svc, meta.Description);
      if (description !== null && description.length > MAX_SERVICE_DESCRIPTION)
        return c.json(
          {
            error: `${meta.Label}: description must be ${MAX_SERVICE_DESCRIPTION} characters or fewer.`,
          },
          400,
        );
      if (!isNullableLimit(svc.maxNights ?? null, DEFENSIVE_MAX_NIGHTS))
        return c.json({ error: `${meta.Label}: nights must be a positive number, or blank.` }, 400);
      // MinNights is removed: the minimum stay is structurally 1 night. Same treatment as
      // minPetCount below — a client that still sends one is rejected, not silently dropped.
      if (svc.minNights != null)
        return c.json(
          {
            error: `${meta.Label}: services no longer have a minimum stay — the minimum is 1 night.`,
          },
          400,
        );
      if (!isNullableLimit(svc.maxPetCount ?? null, MAX_PET_COUNT_CAP))
        return c.json(
          {
            error: `${meta.Label}: pet count must be between 1 and ${MAX_PET_COUNT_CAP}, or blank.`,
          },
          400,
        );
      // MinPetCount is retired: services have only a MAX. Same treatment as maxPerDay below — a
      // client that still sends one is rejected rather than silently dropped, so a sitter can never
      // be left believing a minimum they submitted is in force.
      if (svc.minPetCount != null)
        return c.json(
          { error: `${meta.Label}: services no longer have a minimum pet count.` },
          400,
        );
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
      // A daily pool smaller than one booking's own max is a foot-gun: the widget would offer a
      // pet count the calendar can never seat. Compare the EFFECTIVE values (incoming or stored,
      // same PATCH semantics as the writes below).
      const effMaxPetCount = 'maxPetCount' in svc ? (svc.maxPetCount ?? null) : meta.MaxPetCount;
      const effMaxConcurrent =
        'maxConcurrentPets' in svc ? (svc.maxConcurrentPets ?? null) : meta.MaxConcurrentPets;
      if (effMaxPetCount != null && effMaxConcurrent != null && effMaxConcurrent < effMaxPetCount)
        return c.json(
          {
            error: `${meta.Label}: pets in care per day (${effMaxConcurrent}) can't be lower than the pets allowed on one booking (${effMaxPetCount}).`,
          },
          400,
        );
      if (svc.cancellationTiers != null && !validateCancellationTiers(svc.cancellationTiers))
        return c.json(
          {
            error: `${meta.Label}: cancellation tiers must be 1-5 rows of increasing days with a 1-100 percent.`,
          },
          400,
        );
      // A holiday rate is an EXPLICIT stored rate, in the service's own unit. It is deliberately
      // NOT constrained relative to the base rate: charging LESS on a holiday is a real choice
      // (a sitter running a slow-season promo), and inventing a "must be higher" rule would be
      // the kind of inferred pricing this codebase refuses.
      if (svc.holidayRate != null && !isValidRate(svc.holidayRate))
        return c.json(
          { error: `${meta.Label}: Holiday rate must be whole dollars, $1 or more (or blank).` },
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

      // Species-count rates ride the same PATCH idiom as every other per-service field. The
      // allowed species set is the EFFECTIVE acceptance (incoming or kept; null = every tenant
      // slug), so a PUT that narrows acceptance and rates a now-refused species in one request
      // is rejected as a unit. Index-aligned with `opts`: resolveServiceOptions pushes exactly
      // one resolved row per input option, in order.
      const allowedSpecies = new Set(effectiveAccepted ?? [...knownPetSlugs]);
      const byOption = new Map<string, { mixKey: string; rate: number }[]>();
      for (let i = 0; i < opts.length; i++) {
        const o = opts[i];
        if (!('petRates' in o) || o.petRates === undefined) continue;
        const outcome = validateOptionPetRates(
          meta.Label,
          resolvedOptions.resolved[i].label,
          o.petRates,
          allowedSpecies,
        );
        if ('error' in outcome) return c.json({ error: outcome.error }, 400);
        byOption.set(resolvedOptions.resolved[i].optionKey, outcome.rates);
      }
      if (byOption.size > 0) petRatesByType.set(svc.type as string, byOption);
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
              ...(q.type === 'select' ? { options: q.options } : {}),
            }))
          : current.Questions;
      const updated = await setServiceConfig(c.env.PAWBOOK_DB, tenant.Id, svcType, {
        enabled: svc.enabled ?? false,
        description: resolveServiceDescription(svc, current.Description),
        questions,
        maxNights: 'maxNights' in svc ? (svc.maxNights ?? null) : current.MaxNights,
        maxPetCount: 'maxPetCount' in svc ? (svc.maxPetCount ?? null) : current.MaxPetCount,
        acceptedPetTypes:
          'acceptedPetTypes' in svc ? (svc.acceptedPetTypes ?? null) : current.AcceptedPetTypes,
        maxConcurrentPets:
          'maxConcurrentPets' in svc ? (svc.maxConcurrentPets ?? null) : current.MaxConcurrentPets,
        cancellationTiers:
          'cancellationTiers' in svc ? (svc.cancellationTiers ?? null) : current.CancellationTiers,
        holidayRate: 'holidayRate' in svc ? (svc.holidayRate ?? null) : current.HolidayRate,
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
          startTime: o.startTime,
          endTime: o.endTime,
          capacity: o.capacity,
          weekdaysOnly: o.weekdaysOnly,
        })),
      );
      // After replaceServiceOptions so its dropped-key scrub runs first; each present option's
      // set is then replaced wholesale (small per-option sets — the spec's replace pattern for
      // MIX rates; GROUP rates are the ones that must never be whole-set replaced).
      const optionRates = petRatesByType.get(svcType);
      if (optionRates)
        for (const [optionKey, rates] of optionRates)
          await replaceServicePetRates(c.env.PAWBOOK_DB, tenant.Id, svcType, optionKey, rates);
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
      // to the DB's UNIQUE(TenantId, ServiceType) constraint as the source of truth. Must go
      // through isUniqueViolation: real D1 nests the driver message under `err.cause`, so a bare
      // `err.message.includes(...)` never fires in production and this whole fallback dies.
      if (isUniqueViolation(err))
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

  // ── Pet-group rates: explicit prices for specific animals (PetGroupPricing) ──────────────
  // Upsert/delete-ONE, deliberately not whole-set replace: group rows scale with the client
  // base, so a replace-writer would round-trip every client's rows per save and let two tabs
  // clobber each other. Nothing reads these rows for pricing yet (PR 3); these routes only let
  // sitters stage rates ahead of enforcement, so no tenant-cache invalidation is needed (the
  // KV-cached public config carries no rates).
  .get('/:slug/admin/pet-group-rates', async (c) => {
    const tenant = c.get('tenant');
    const rows = await listAllPetGroupPricing(c.env.PAWBOOK_DB, tenant.Id);
    return c.json({
      rates: rows.map((r) => ({
        id: r.Id,
        serviceType: r.ServiceType,
        optionKey: r.OptionKey,
        // GroupKey IS the sorted pet-id list; UUID ids are comma-free, so the split is exact.
        petIds: r.GroupKey.split(','),
        rate: r.Rate,
        updatedAt: r.UpdatedAt,
      })),
    });
  })

  .put('/:slug/admin/pet-group-rates', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ serviceType?: unknown; optionKey?: unknown; petIds?: unknown; rate?: unknown }>()
      .catch(() => ({}) as Record<string, never>);
    const serviceType = typeof body.serviceType === 'string' ? body.serviceType : '';
    const optionKey = typeof body.optionKey === 'string' ? body.optionKey : '';
    const service = (await listServices(c.env.PAWBOOK_DB, tenant.Id)).find(
      (s) => s.ServiceType === serviceType,
    );
    if (!service) return c.json({ error: 'Unknown service type.' }, 400);
    const options = await listServiceOptions(c.env.PAWBOOK_DB, tenant.Id);
    if (!options.some((o) => o.ServiceType === serviceType && o.OptionKey === optionKey))
      return c.json({ error: `${service.Label}: unknown option.` }, 400);
    if (
      !Array.isArray(body.petIds) ||
      body.petIds.length === 0 ||
      body.petIds.length > DEFENSIVE_MAX_PET_COUNT ||
      !body.petIds.every((p): p is string => typeof p === 'string' && p !== '')
    )
      return c.json({ error: 'Pick at least one pet.' }, 400);
    // A rate may only name this tenant's LIVE pets: a deceased pet is never bookable, so a new
    // rate naming one is a mistake, not a grandfathering case.
    const pets = await listAllEndUserPetsByTenant(c.env.PAWBOOK_DB, tenant.Id);
    const livePetIds = new Set(pets.filter((p) => p.DeceasedAt === null).map((p) => p.Id));
    for (const petId of body.petIds)
      if (!livePetIds.has(petId)) return c.json({ error: 'Unknown pet in the list.' }, 400);
    if (!isValidRate(body.rate))
      return c.json({ error: 'Rates are whole dollars, at least $1.' }, 400);
    const { id } = await upsertPetGroupRate(c.env.PAWBOOK_DB, tenant.Id, {
      serviceType,
      optionKey,
      // buildGroupKey dedups + sorts, so selection order can never mint a second row.
      groupKey: buildGroupKey(body.petIds),
      rate: body.rate,
    });
    return c.json({ id, groupKey: buildGroupKey(body.petIds) });
  })

  .delete('/:slug/admin/pet-group-rates/:id', async (c) => {
    const tenant = c.get('tenant');
    const deleted = await deletePetGroupRateById(c.env.PAWBOOK_DB, tenant.Id, c.req.param('id'));
    if (!deleted) return c.json({ error: 'Not found.' }, 404);
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
      // UNIQUE(TenantId, PetType) is the source of truth for duplicates (concurrent adds
      // included). isUniqueViolation, not a bare message check — D1 nests it under `err.cause`.
      if (isUniqueViolation(err))
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
    // Materialized Google rows have no living source once disconnected — and no UI to remove
    // read-only rows — so they must not survive to block capacity forever.
    await deleteAllExternalEvents(c.env.PAWBOOK_DB, tenant.Id);
    return c.json({ status: 'disconnected' });
  })

  /**
   * Create a dedicated "Pawservation — Pet bookings" calendar inside the sitter's own Google account
   * and make it the sync target, so pet work never lands in her personal calendar. Guards, in order:
   * disabled tenant (read-only), unconfigured server, no live connection, and — so a second press
   * can't litter the account with duplicate calendars — a connection that already points at a
   * DEDICATED calendar (`isDedicatedCalendarId`; a target of NULL, `primary`, or the account's own
   * email address is personal and still gets the button).
   */
  .post('/:slug/admin/providers/calendar/create-calendar', async (c) => {
    const tenant = c.get('tenant');
    if (tenant.DisabledAt) return c.json({ error: 'account_disabled' }, 403);
    // A token refresh mid-call needs the client credentials, so the same 503 as oauth/start applies.
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET || !c.env.GOOGLE_OAUTH_REDIRECT_URI)
      return c.json({ error: 'Google Calendar is not configured on this server.' }, 503);

    const conn = await getProviderConnection(c.env.PAWBOOK_DB, tenant.Id, 'calendar');
    if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken)
      return c.json({ error: 'Connect Google Calendar first, then create the pet calendar.' }, 409);
    // Don't litter the account with duplicate calendars — but only refuse when the target is
    // already a DEDICATED calendar. NULL, 'primary', and the account's own email address all name
    // the sitter's PERSONAL calendar, and she is exactly who this button is for; the old
    // `!== 'primary'` string test locked the last of those three out of the remedy.
    if (isDedicatedCalendarId(conn.CalendarId))
      return c.json(
        {
          error: `Bookings already sync to a separate calendar ("${conn.CalendarId}"). Clear the calendar ID field first if you want a new pet calendar.`,
          calendarId: conn.CalendarId,
        },
        409,
      );

    let calendarId: string;
    try {
      const accessToken = await getCalendarAccessToken(c.env, tenant, conn);
      const created = await createCalendar(
        accessToken,
        PET_CALENDAR_SUMMARY,
        tenant.Timezone ?? DEFAULT_TIMEZONE,
      );
      calendarId = created.id;
    } catch (err) {
      // A connection authorized before calendar.app.created was requested cannot create calendars.
      // Say so, instead of letting an insufficient-scope refusal surface as a bare 500.
      if (err instanceof CalendarAuthError)
        return c.json(
          {
            error:
              'Google has not given Pawservation permission to create a calendar. Disconnect Google Calendar, connect it again to approve the new permission, then try again.',
          },
          400,
        );
      throw err;
    }

    // Repoint before responding (clears the old calendar's event ids — see repointCalendarTarget),
    // then re-create future bookings in the new calendar in the background.
    await repointCalendarTarget(c.env, tenant, calendarId);
    await backfillInBackground(c, tenant);
    return c.json({ calendarId, summary: PET_CALENDAR_SUMMARY });
  })

  .post('/:slug/admin/providers/calendar/calendar-id', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ calendarId?: unknown }>()
      .catch(() => ({}) as { calendarId?: unknown });
    const raw = typeof body.calendarId === 'string' ? body.calendarId.trim() : '';
    const next = raw === '' ? null : raw;
    const conn = await getProviderConnection(c.env.PAWBOOK_DB, tenant.Id, 'calendar');
    // NULL and the literal 'primary' name the same calendar, so compare through that default: a
    // save that doesn't actually move the target must not churn every booking's event.
    if ((conn?.CalendarId ?? 'primary') === (next ?? 'primary')) {
      await setProviderCalendarId(c.env.PAWBOOK_DB, tenant.Id, 'calendar', next);
      return c.body(null, 204);
    }
    // Real switch: clear the stored event ids with the new target (repointCalendarTarget — without
    // this, reconciliation would cancel every booking whose event lives in the old calendar), then
    // re-create future bookings in the new calendar.
    await repointCalendarTarget(c.env, tenant, next);
    await backfillInBackground(c, tenant);
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
      {
        id: string;
        name: string;
        petType: string;
        notes: string | null;
        deceasedAt: string | null;
      }[]
    >();
    // listAllEndUserPetsByTenant returns ONE ROW PER OWNER LINK (0019), so a co-owned pet lands in
    // both owners' buckets with no change to this grouping.
    for (const p of allPets) {
      const list = byUser.get(p.EndUserId) ?? [];
      list.push({
        id: p.Id,
        name: p.Name,
        petType: p.PetType,
        notes: p.Notes,
        deceasedAt: p.DeceasedAt,
      });
      byUser.set(p.EndUserId, list);
    }
    const withPets = customers.map((u) => ({
      id: u.Id,
      email: u.Email,
      name: u.Name,
      phone: u.Phone,
      venmoUsername: u.VenmoUsername,
      status: u.Status,
      invitedAt: u.InvitedAt,
      pets: byUser.get(u.Id) ?? [],
    }));
    return c.json({ customers: withPets });
  })

  // A client is a client-AND-pet relationship: name and at least one pet are required, so a
  // brand-new customer can never be committed pet-less ("no owners without pets" — the creation
  // half; removePetOwner's 'last-owner' refusal is the other half).
  .post('/:slug/admin/customers', async (c) => {
    const tenant = c.get('tenant');
    type Body = {
      email?: unknown;
      name?: unknown;
      phone?: unknown;
      petName?: unknown;
      petType?: unknown;
    };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const phone = rawPhone || null;
    const petName = typeof body.petName === 'string' ? body.petName.trim() : '';
    const petType = typeof body.petType === 'string' ? body.petType.trim() : '';
    if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);
    if (email === DEMO_EMAIL)
      return c.json({ error: 'That email is reserved for the Pawservation demo.' }, 400);
    if (!name) return c.json({ error: "Enter the client's name." }, 400);
    if (phone !== null && phone.length > 40) return c.json({ error: 'Phone is too long.' }, 400);
    if (!petName)
      return c.json({ error: 'Enter a pet name — every client needs at least one pet.' }, 400);
    // Registry membership only (0015), same rule as the add-pet route: recordable even if no
    // service currently accepts the type.
    const known = (await listPetTypes(c.env.PAWBOOK_DB, tenant.Id)).find(
      (pt) => pt.PetType === petType,
    );
    if (!known) return c.json({ error: 'That pet type is not accepted.' }, 400);

    const existing = await getEndUserByEmail(c.env.PAWBOOK_DB, tenant.Id, email);
    let customer;
    if (existing) {
      // Idempotent re-POST: never downgrade an active customer to invited, never touch their
      // stored name/phone. Add the pet only if it's new for them; a repeat of an existing pet is
      // a no-op, not an error. `listEndUserPets` is LIVE pets only, so a deceased pet's name may
      // be used again — the CSV import applies that same live-only rule (it filters DeceasedAt out
      // of the map it dedups against), and the two must not drift.
      customer = existing;
      const pets = await listEndUserPets(c.env.PAWBOOK_DB, tenant.Id, existing.Id);
      if (!pets.some((p) => p.Name.toLowerCase() === petName.toLowerCase()))
        await addEndUserPet(c.env.PAWBOOK_DB, tenant.Id, existing.Id, petName, petType);
    } else {
      // One atomic batch — if the pet insert fails, no customer row is left standing.
      customer = await insertInvitedCustomerWithPet(
        c.env.PAWBOOK_DB,
        tenant.Id,
        email,
        name,
        phone,
        petName,
        petType,
      );
    }

    // Deliberately NO email here (WS-C owner decision): creating a client is a data entry, not an
    // introduction. The welcome mail is the explicit POST /:slug/admin/customers/:id/welcome
    // below, so the sitter chooses when (and whether) a client first hears from Pawservation.
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

  // The explicit welcome mail (WS-C): re-sendable on demand, tenant-scoped via getEndUserById so a
  // foreign id is indistinguishable from a missing one. Idempotent in the safe-to-repeat sense —
  // each call sends one fresh copy; there is no "already sent" state to corrupt.
  .post('/:slug/admin/customers/:id/welcome', async (c) => {
    const tenant = c.get('tenant');
    const customer = await getEndUserById(c.env.PAWBOOK_DB, tenant.Id, c.req.param('id'));
    if (!customer) return c.json({ error: 'Not found.' }, 404);
    if (!isEmailConfigured(c.env)) {
      return c.json(
        {
          error:
            "Email isn't set up on this Pawservation instance yet, so welcome emails can't be sent.",
        },
        503,
      );
    }
    const widgetUrl = new URL(`/embed/${tenant.Slug}`, c.req.url).toString();
    try {
      await sendInvite(c.env, customer.Email, tenant.DisplayName, widgetUrl);
    } catch {
      return c.json({ error: 'The welcome email could not be sent. Try again shortly.' }, 502);
    }
    return c.json({ ok: true });
  })

  .delete('/:slug/admin/customers/:id', async (c) => {
    const tenant = c.get('tenant');
    const id = c.req.param('id');
    if ((await countBookingsForUser(c.env.PAWBOOK_DB, tenant.Id, id)) > 0)
      return c.json({ error: 'Customer has bookings; cannot remove.' }, 409);
    // deleteCustomer reports WHICH precondition refused, so a refusal never masquerades as a 404
    // for a customer who plainly exists. 'has-bookings' is only reachable when a booking lands
    // between the count above and the delete itself; the co-ownership refusal below has no such
    // pre-check and is the common one.
    //
    // Exhaustive switch, not an if-chain ending in the 204: success must be reached by a POSITIVE
    // 'deleted' test. A fifth outcome added to deleteCustomer later would otherwise fall through to
    // "204 No Content" — a refusal reported as success, which is the exact failure this whole guard
    // exists to prevent. Here it fails to compile (`never`) and, if it somehow ships, fails closed.
    const outcome = await deleteCustomer(c.env.PAWBOOK_DB, tenant.Id, id);
    switch (outcome) {
      case 'deleted':
        return c.body(null, 204);
      case 'not-found':
        return c.json({ error: 'Not found.' }, 404);
      case 'has-bookings':
        return c.json({ error: 'Customer has bookings; cannot remove.' }, 409);
      case 'pet-on-booking':
        return c.json(
          {
            // Adding a second owner is the remedy that works: the pet is then handed to that owner
            // instead of being cascaded. Cancelling the booking would NOT help — cancel/decline are
            // soft, so the BookingRequestPets row survives.
            error:
              'A pet this client owns is on a booking; cannot remove. Add a second owner first.',
          },
          409,
        );
      default: {
        const unhandled: never = outcome;
        return c.json({ error: `Cannot remove this client (${String(unhandled)}).` }, 409);
      }
    }
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
    // under it — EndUserPets.EndUserId FKs to EndUsers(Id) without a TenantId, so D1's foreign-key
    // enforcement wouldn't catch a cross-tenant id on its own; this check is what prevents it.
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
  // Co-ownership (0019). Keyed on the pet, not on a customer, because a co-owned pet has no single
  // owning customer to nest under. Covered by this app's one `.use('/:slug/admin/*', adminAuth)`
  // declaration, and by tenantMiddleware's non-GET rejection for a disabled tenant.
  .post('/:slug/admin/pets/:petId/owners', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ endUserId?: unknown }>()
      .catch(() => ({}) as { endUserId?: unknown });
    const endUserId = typeof body.endUserId === 'string' ? body.endUserId : '';
    if (!endUserId) return c.json({ error: 'Choose a client.' }, 400);
    const added = await addPetOwner(c.env.PAWBOOK_DB, tenant.Id, c.req.param('petId'), endUserId);
    // A pet or customer from another tenant is reported exactly like a nonexistent one.
    if (!added) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  })
  .delete('/:slug/admin/pets/:petId/owners/:endUserId', async (c) => {
    const tenant = c.get('tenant');
    const outcome = await removePetOwner(
      c.env.PAWBOOK_DB,
      tenant.Id,
      c.req.param('petId'),
      c.req.param('endUserId'),
    );
    if (outcome === 'not-found') return c.json({ error: 'Not found.' }, 404);
    if (outcome === 'last-owner')
      return c.json({ error: 'A pet must keep at least one owner — remove the pet instead.' }, 409);
    return c.body(null, 204);
  })
  .patch('/:slug/admin/pets/:petId', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ deceased?: unknown }>()
      .catch(() => ({}) as { deceased?: unknown });
    if (typeof body.deceased !== 'boolean')
      return c.json({ error: 'deceased must be true or false.' }, 400);
    const updated = await setPetDeceased(
      c.env.PAWBOOK_DB,
      tenant.Id,
      c.req.param('petId'),
      body.deceased,
    );
    if (!updated) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  })
  /**
   * The client's Venmo handle, and nothing else — a deliberately single-field PATCH rather than a
   * general customer editor, so this branch adds one write and one validation surface. Stored
   * '@'-less and trimmed; blank clears it (a sitter who filled it in by mistake must be able to
   * empty the field, and NULL is the meaningful "match on their name" default).
   */
  .patch('/:slug/admin/customers/:id', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ venmoUsername?: unknown }>()
      .catch(() => ({}) as { venmoUsername?: unknown });
    if (!('venmoUsername' in body)) return c.json({ error: 'Nothing to update.' }, 400);
    const raw = body.venmoUsername;
    if (raw !== null && typeof raw !== 'string')
      return c.json({ error: 'Venmo username must be text.' }, 400);
    const handle = raw === null ? '' : raw.trim().replace(/^@+/, '');
    if (handle.length > MAX_VENMO_USERNAME)
      return c.json(
        { error: `A Venmo username is at most ${MAX_VENMO_USERNAME} characters.` },
        400,
      );
    if (handle !== '' && !/^[A-Za-z0-9_-]+$/.test(handle))
      return c.json(
        { error: 'A Venmo username can only contain letters, numbers, dashes and underscores.' },
        400,
      );
    const updated = await setEndUserVenmoUsername(
      c.env.PAWBOOK_DB,
      tenant.Id,
      c.req.param('id'),
      handle === '' ? null : handle,
    );
    if (!updated) return c.json({ error: 'Not found.' }, 404);
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
    // LIVE pets only, keyed by owner id — deceased names are deliberately absent, so this map
    // answers both of the questions the loop asks of it the same way the manual-add route does
    // (which reads listEndUserPets, itself live-only): "does this client already own a pet by this
    // name" and "does this client have a pet at all". A deceased pet is neither bookable nor a
    // reason to refuse the name again.
    const livePetNames = new Map<string, Set<string>>();
    for (const pet of await listAllEndUserPetsByTenant(c.env.PAWBOOK_DB, tenant.Id)) {
      if (pet.DeceasedAt) continue;
      const set = livePetNames.get(pet.EndUserId) ?? new Set<string>();
      set.add(pet.Name.toLowerCase());
      livePetNames.set(pet.EndUserId, set);
    }

    let importedCustomers = 0;
    let importedPets = 0;
    let invitesSent = 0;
    let invitesFailed = 0;
    const skippedRows: { row: number; reason: string }[] = [];
    const freshCustomers: string[] = [];
    // Owner id per email, so the deferred pass below can look a client up whether they existed
    // before the import or were created part-way through it.
    const idByEmail = new Map<string, string>();
    // Pet-less rows are NOT judged as they are read: a later row in the same file may still supply
    // this client's pet (one row per pet, the blank ones being repeats of the client). Complaining
    // immediately would report a client as pet-less who ends the import owning pets. Resolved once,
    // after the whole file — see below.
    const petLessRows: { row: number; email: string }[] = [];
    // The name a client was given by ANY earlier row of this file, so the sitter only has to type
    // it once: in a name-on-the-first-row file the create happens on a LATER row (the first one
    // carrying a pet), and it takes the name from here rather than from its own blank cell.
    const nameByEmail = new Map<string, string>();
    const livePetCount = (email: string) => {
      const id = idByEmail.get(email);
      return id ? (livePetNames.get(id)?.size ?? 0) : 0;
    };

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
      if (email === DEMO_EMAIL) {
        skippedRows.push({ row, reason: 'That email is reserved for the Pawservation demo' });
        continue;
      }
      const name = rawName.trim();
      if (name) nameByEmail.set(email, name);

      try {
        // A customer created by an earlier row of THIS file is found here too, so one-row-per-pet
        // files work: the first row creates customer + pet atomically, later rows just add pets.
        const existing = await getEndUserByEmail(c.env.PAWBOOK_DB, tenant.Id, email);
        if (existing) idByEmail.set(email, existing.Id);
        const petSet = existing
          ? (livePetNames.get(existing.Id) ?? new Set<string>())
          : new Set<string>();

        const petName = rawPetName.trim();
        const petType = rawPetType.trim().toLowerCase();
        if (!petName && !petType) {
          petLessRows.push({ row, email });
          continue;
        }
        // Name is required to CREATE a client, and only then: a pet-only row for a client who
        // already exists must not have to restate the name they already have — that is the normal
        // shape of a one-row-per-pet file where the sitter filled the name in once. For a client
        // this file is about to create, a name typed on any earlier row of the file counts.
        const createName = nameByEmail.get(email) ?? '';
        if (!existing && !createName) {
          skippedRows.push({ row, reason: 'Missing name' });
          continue;
        }
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
        if (petSet.has(petName.toLowerCase())) {
          skippedRows.push({ row, reason: 'Pet already exists for this client' });
          continue;
        }
        if (existing) {
          await addEndUserPet(c.env.PAWBOOK_DB, tenant.Id, existing.Id, petName, petType);
          petSet.add(petName.toLowerCase());
          livePetNames.set(existing.Id, petSet);
        } else {
          // Customer + first pet in one atomic batch — a failed pet insert leaves no customer.
          const customer = await insertInvitedCustomerWithPet(
            c.env.PAWBOOK_DB,
            tenant.Id,
            email,
            createName,
            null,
            petName,
            petType,
          );
          livePetNames.set(customer.Id, new Set([petName.toLowerCase()]));
          idByEmail.set(email, customer.Id);
          importedCustomers++;
          freshCustomers.push(email);
        }
        importedPets++;
      } catch {
        skippedRows.push({ row, reason: 'Could not import this row' });
      }
    }

    // The deferred verdict on pet-less rows: only complain about the ones whose client really did
    // end the import with no live pet. A blank pet on a row for a client who owns pets is just the
    // canonical repeat-the-email shape and is silently fine.
    for (const { row, email } of petLessRows) {
      if (livePetCount(email) === 0)
        skippedRows.push({ row, reason: 'Every client needs at least one pet' });
    }
    // …which means skips are no longer discovered in file order. Sort so the sitter reads them
    // against their spreadsheet top to bottom (at most one skip per row, so this is total).
    skippedRows.sort((a, b) => a.row - b.row);

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
    // ONE read for the whole list, grouped in JS — a charge is an additive line item, so it can
    // never change EstCost; total due is EstCost + chargesTotal, derived by every reader.
    const chargeRows = await listChargesForTenant(c.env.PAWBOOK_DB, tenant.Id);
    const chargesByBooking = new Map<string, typeof chargeRows>();
    for (const ch of chargeRows) {
      const list = chargesByBooking.get(ch.BookingRequestId) ?? [];
      list.push(ch);
      chargesByBooking.set(ch.BookingRequestId, list);
    }
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
        external: r.ServiceType === 'external',
        externalSummary: r.ExternalSummary,
        answers: r.Answers,
        estCost: r.EstCost,
        paidTotal: r.PaidTotal ?? 0,
        charges: (chargesByBooking.get(r.Id) ?? []).map((ch) => ({
          id: ch.Id,
          label: ch.Label,
          amount: ch.Amount,
        })),
        chargesTotal: (chargesByBooking.get(r.Id) ?? []).reduce((sum, ch) => sum + ch.Amount, 0),
        status: r.Status,
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
      // Same existence guard as the payments route: the 'blocked'/'external' sentinels 404 rather
      // than falling through to the 400 below, which would otherwise let an external row's id be
      // distinguished from a genuinely unknown id (an existence oracle).
      if (!bk || bk.ServiceType === 'blocked' || bk.ServiceType === 'external')
        return c.json({ error: 'Not found.' }, 404);
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
      // historical record; reconciliation ignores cancelled and declined rows.
      calendarTask = deleteBookingCalendarEvent(c.env, tenant, booking.GCalEventId, id);
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
      externalRef: null,
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
    // Same existence guard as POST/DELETE: foreign booking or the 'blocked'/'external' sentinels
    // 404. Unlike POST, a cancelled booking is still viewable here — DELETE is the correction
    // mechanism for it.
    const booking = await getBookingWithCustomer(c.env.PAWBOOK_DB, tenant.Id, bookingId);
    if (!booking || booking.ServiceType === 'blocked' || booking.ServiceType === 'external')
      return c.json({ error: 'Not found.' }, 404);
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

  .post('/:slug/admin/bookings/:id/charges', async (c) => {
    const tenant = c.get('tenant');
    const bookingId = c.req.param('id');
    const body = await c.req
      .json<{ label?: unknown; amount?: unknown }>()
      .catch(() => ({}) as Record<string, never>);
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label) return c.json({ error: 'Give the charge a name.' }, 400);
    if (label.length > MAX_CHARGE_LABEL)
      return c.json({ error: `Name must be ${MAX_CHARGE_LABEL} characters or fewer.` }, 400);
    // Same predicate as a payment amount and a rate: whole dollars >= 1.
    if (!isValidRate(body.amount))
      return c.json({ error: 'Amount must be whole dollars ≥ 1.' }, 400);
    const chargeId = await insertBookingCharge(c.env.PAWBOOK_DB, tenant.Id, {
      bookingRequestId: bookingId,
      label,
      amount: body.amount,
    });
    // Guard refused: foreign booking or the 'blocked' sentinel.
    if (!chargeId) return c.json({ error: 'Not found.' }, 404);
    const charges = await listChargesForBooking(c.env.PAWBOOK_DB, tenant.Id, bookingId);
    const created = charges.find((ch) => ch.Id === chargeId);
    if (!created) return c.json({ error: 'Not found.' }, 404);
    return c.json(
      {
        charge: { id: created.Id, label: created.Label, amount: created.Amount },
        chargesTotal: charges.reduce((sum, ch) => sum + ch.Amount, 0),
      },
      201,
    );
  })

  .get('/:slug/admin/bookings/:id/charges', async (c) => {
    const tenant = c.get('tenant');
    const bookingId = c.req.param('id');
    // Same existence guard the payments GET uses: a foreign booking or the sentinel 404s.
    const booking = await getBookingWithCustomer(c.env.PAWBOOK_DB, tenant.Id, bookingId);
    if (!booking || booking.ServiceType === 'blocked') return c.json({ error: 'Not found.' }, 404);
    const rows = await listChargesForBooking(c.env.PAWBOOK_DB, tenant.Id, bookingId);
    return c.json({
      charges: rows.map((ch) => ({ id: ch.Id, label: ch.Label, amount: ch.Amount })),
    });
  })

  .delete('/:slug/admin/bookings/:id/charges/:chargeId', async (c) => {
    const tenant = c.get('tenant');
    const deleted = await deleteBookingCharge(
      c.env.PAWBOOK_DB,
      tenant.Id,
      c.req.param('id'),
      c.req.param('chargeId'),
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
  })

  /**
   * Read the sitter's Venmo CSV and say what Pawservation THINKS it found. Writes nothing at all —
   * the file is parsed in memory, matched against this tenant's clients and receivables, and
   * thrown away with the request. Nothing about the file is stored anywhere.
   */
  .post('/:slug/admin/payments/venmo/preview', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req.json<{ csv?: unknown }>().catch(() => ({}) as { csv?: unknown });
    const parsed = parseVenmoCsv(typeof body.csv === 'string' ? body.csv : '');
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const inputs = await loadVenmoMatchInputs(c.env, tenant.Id);
    const preview = matchVenmoTxns({ txns: parsed.incoming, ...inputs });
    return c.json({ ...preview, ignored: parsed.ignored, problems: parsed.problems });
  })

  /**
   * Record the rows the sitter approved. The CSV comes back with the request and is parsed and
   * matched AGAIN from scratch: the body supplies only which transaction goes on which booking, so
   * every dollar figure, date and note is the server's own reading of the file. A bookingId is
   * honoured only when it is one of the candidates this request just ranked — the preview is not a
   * token of trust. The file itself is still never stored.
   */
  .post('/:slug/admin/payments/venmo/import', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ csv?: unknown; choices?: unknown }>()
      .catch(() => ({}) as { csv?: unknown; choices?: unknown });
    if (!Array.isArray(body.choices) || body.choices.length === 0)
      return c.json({ error: 'Choose at least one payment to record.' }, 400);
    if (body.choices.length > MAX_VENMO_ROWS)
      return c.json({ error: `Record ${MAX_VENMO_ROWS} payments or fewer at a time.` }, 400);
    const choices: { txnId: string; bookingId: string }[] = [];
    for (const raw of body.choices) {
      const choice = raw as { txnId?: unknown; bookingId?: unknown };
      if (
        !isVenmoTxnId(choice.txnId) ||
        typeof choice.bookingId !== 'string' ||
        choice.bookingId === ''
      )
        return c.json({ error: 'That list of payments is malformed.' }, 400);
      choices.push({ txnId: choice.txnId, bookingId: choice.bookingId });
    }

    const parsed = parseVenmoCsv(typeof body.csv === 'string' ? body.csv : '');
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const inputs = await loadVenmoMatchInputs(c.env, tenant.Id);
    const txnById = new Map(parsed.incoming.map((t) => [t.txnId, t]));

    const skipped: { txnId: string; reason: string }[] = [];
    let imported = 0;
    let totalAmount = 0;

    for (const { txnId, bookingId } of choices) {
      const txn = txnById.get(txnId);
      if (!txn) {
        skipped.push({ txnId, reason: 'That transaction is not in this file' });
        continue;
      }
      if (inputs.alreadyImported.has(txnId)) {
        skipped.push({ txnId, reason: 'Already imported' });
        continue;
      }
      // Re-rank from THIS request's data; the browser's idea of the candidates is never trusted.
      // resolveMatchClient is the SAME function the preview uses — a name that's ambiguous there
      // is refused here too, never silently resolved by whichever client happened to sort last.
      const client = resolveMatchClient(inputs.clients, txn.from);
      const candidates = client
        ? rankCandidates(
            txn,
            inputs.outstanding.filter((b) => b.endUserId === client.endUserId),
          )
        : [];
      if (!candidates.some((candidate) => candidate.bookingId === bookingId)) {
        skipped.push({ txnId, reason: 'That booking is no longer a match for this payment' });
        continue;
      }
      const note = `Venmo import — ${txn.from}${txn.note ? `: ${txn.note}` : ''} (txn ${txn.txnId})`;
      try {
        const paymentId = await insertPayment(c.env.PAWBOOK_DB, tenant.Id, {
          bookingRequestId: bookingId,
          amount: txn.amount,
          method: 'venmo',
          paidDate: txn.date,
          note: note.slice(0, 300),
          externalRef: txn.txnId,
        });
        if (!paymentId) {
          skipped.push({ txnId, reason: 'That booking can no longer take a payment' });
          continue;
        }
        imported++;
        totalAmount += txn.amount;
      } catch (err) {
        // The partial unique index caught a replay that slipped past the pre-read (a concurrent
        // import of the same file). Idempotency is the index's job, and it did it.
        if (isUniqueViolation(err)) skipped.push({ txnId, reason: 'Already imported' });
        else throw err;
      }
    }
    return c.json({ imported, totalAmount, skipped });
  });
