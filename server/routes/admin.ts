import { Hono } from 'hono';
import type { Context } from 'hono';
import { setCookie } from 'hono/cookie';
import {
  addBookingPets,
  addCoOwnerToPets,
  addEndUserPet,
  addPetOwner,
  applyAttribution,
  clearProviderConnection,
  countBookingsForService,
  countBookingsForUser,
  countPetTypeReferences,
  createPetType,
  createService,
  deleteAllExternalEvents,
  deleteBookingRequest,
  deletePetTypeAndScrub,
  getAnalytics,
  getBookingSyncData,
  getBookingWithCustomer,
  getEndUserById,
  getEndUserByEmail,
  getHouseholdDetail,
  getHouseholdsWithUnappliedCredits,
  cancelBlockedRange,
  deleteBookingCharge,
  deleteCustomer,
  deletePayment,
  deletePetGroupRateById,
  deleteService,
  getProviderConnection,
  getTenantUserEmailById,
  insertBackfilledBooking,
  insertBookingCharge,
  keepBookingCredit,
  insertBookingRequest,
  insertInvitedCustomerAsCoOwner,
  insertInvitedCustomerWithPet,
  insertAccountPayment,
  insertPayment,
  getAccountIdsByOwner,
  listAdoptedEventIds,
  listAllEndUserPetsByTenant,
  listAllPetGroupPricing,
  listBlockedRanges,
  listBookingsForTenant,
  listChargesForBooking,
  listChargesForTenant,
  listCustomers,
  listEndUserPets,
  listOwnerPetLinks,
  listPaymentExternalRefs,
  listPaymentsForAccount,
  listPaymentsForBooking,
  listPetNamesForBooking,
  listPetNamesForTenantBookings,
  listPetsByIds,
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
  updateBackfilledBookingCost,
  updateBookingStatus,
  updateTenantSettings,
  upsertPetGroupRate,
} from '../db/repo';
import { isEmailConfigured, sendBookingStatusEmail, sendInvite } from '../lib/email';
import { parseCsvRows } from '../lib/csv';
import { isUniqueViolation } from '../lib/db-errors';
import {
  candidateDistance,
  expandImportedRefs,
  nearestCandidateDistance,
  proposeAttribution,
} from '../lib/payment-attribution';
import { serializeAnalytics } from '../lib/analytics';
import { confirmOverbookWarning, estimateCost } from '../lib/availability';
import {
  backfillCalendarEvents,
  deleteBookingCalendarEvent,
  getCalendarAccessToken,
  keepsCalendarEventOnCancel,
  reconcileIfStale,
  repointCalendarTarget,
  syncBookingToCalendar,
  updateBookingCalendarEvent,
} from '../lib/calendar-sync';
import type { SyncInput } from '../lib/calendar-sync';
import {
  buildAuthUrl,
  callbackUriFor,
  CalendarAuthError,
  createCalendar,
  listCalendarEvents,
  PET_CALENDAR_SUMMARY,
  revokeToken,
} from '../lib/google-calendar';
import type { CalendarEvent } from '../lib/google-calendar';
import {
  classifyEvent,
  type BackfillContext,
  type BackfillPet,
  type BackfillService,
  type Classified,
  type PetOwnerLink,
} from '../lib/calendar-backfill';
import { DEMO_EMAIL } from '../lib/demo';
import { adminAuth } from '../lib/middleware';
import { signState } from '../lib/oauth-state';
import { calendarView } from '../lib/providers';
import { embedSnippets } from '../lib/snippet';
import {
  isTemplateId,
  MAX_OPTIONS_PER_SERVICE,
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
  resolveMatchClient,
  type MatchClient,
} from '../lib/venmo';
import {
  applyMapping,
  detectCsvShape,
  MAX_CSV_ROWS,
  matchCsvPayments,
  parseCsvColumnMapping,
} from '../lib/payment-csv';
import { NONCE_KEY } from './oauth';
import {
  DEFENSIVE_MAX_NIGHTS,
  DEFENSIVE_MAX_PET_COUNT,
  EMAIL_RE,
  isNullableLimit,
  isPaymentMethod,
  isPetRateMode,
  isRealDate,
  isValidDuration,
  isValidRate,
  isValidTimeString,
  MAX_ADVANCE_MONTHS_CAP,
  MAX_OVERLAP_DAYS_CAP,
  isValidOverlapDays,
  MAX_LEAD_DAYS_CAP,
  MAX_PET_COUNT_CAP,
  minutesBetweenTimes,
} from '../lib/validation';
import type { AppEnv, Tenant, TenantService, TenantServiceOption } from '../types';
import type {
  CancellationTier,
  GroupRate,
  MixRate,
  ServiceQuestion,
} from '../../src/shared/index.js';
import {
  buildGroupKey,
  buildMixKey,
  cancellationFee,
  getPacificDateStr,
  isDedicatedCalendarId,
  MAX_ATTRIBUTIONS_PER_REQUEST,
  MAX_BACKFILL_EVENTS,
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
 * The tenant-scoped reads BOTH payment importers (Venmo, and the generic mapped-CSV importer)
 * match against. Loaded identically by every preview and every confirm step: a confirm re-derives
 * the whole match set rather than trusting what the preview told the browser.
 *
 * `accountId` (Story 2.5) is looked up via `getAccountIdsByOwner`, NOT `getHouseholdBalances` — the
 * latter only returns households with existing bookings or payments, and a client's first-ever
 * payment must still resolve to their household with none of either on record yet.
 *
 * `households` is every household of this tenant a payment may be filed against — the list the CSV
 * panel offers for a row the matcher couldn't place, and the SAME list the CSV import route
 * validates the sitter's choice against, so what the panel offers and what the server accepts can
 * never be two different sets. Built from `clients`, so a client the sitter cannot see (the
 * reserved demo identity, which `listCustomers` filters out) is not somewhere money can be filed.
 */
async function loadPaymentMatchInputs(
  env: AppEnv['Bindings'],
  tenantId: string,
): Promise<{
  clients: MatchClient[];
  alreadyImported: Set<string>;
  households: { accountId: string; label: string }[];
}> {
  const [customers, accountsByOwner, refs] = await Promise.all([
    listCustomers(env.PAWSERVATION_DB, tenantId),
    getAccountIdsByOwner(env.PAWSERVATION_DB, tenantId),
    listPaymentExternalRefs(env.PAWSERVATION_DB, tenantId),
  ]);
  const clients: MatchClient[] = customers.map((u) => ({
    endUserId: u.Id,
    label: u.Name || u.Email,
    name: u.Name,
    venmoUsername: u.VenmoUsername,
    accountId: accountsByOwner.get(u.Id) ?? null,
  }));
  // Two clients who share a pet share one household, and it is listed ONCE, under both their
  // names — exactly as they share one balance and one invoice number.
  const labelsByAccount = new Map<string, string[]>();
  for (const client of clients) {
    if (client.accountId === null) continue;
    const labels = labelsByAccount.get(client.accountId);
    if (labels) labels.push(client.label);
    else labelsByAccount.set(client.accountId, [client.label]);
  }
  return {
    clients,
    // NOT `new Set(refs)`: attribution rewrites an imported payment's `ExternalRef` and deletes
    // the row that carried the original, so the live column alone no longer answers "has this
    // tenant already recorded this transaction". `expandImportedRefs` adds back the original
    // behind every derived ref, which is what stops a re-upload of an already-attributed export
    // recording the whole file a second time. Both importers read this one set.
    alreadyImported: expandImportedRefs(refs),
    households: [...labelsByAccount]
      .map(([accountId, labels]) => ({ accountId, label: labels.join(' & ') }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

// MAX_BACKFILL_EVENTS itself now lives in src/shared/util/calendar-target.ts (imported above),
// so CalendarBackfillPanel.tsx can chunk its bulk Adopt calls at the exact same number this route
// enforces, instead of carrying a second literal that could drift from it. Re-exported here so
// this route's own tests keep importing it from this module.
export { MAX_BACKFILL_EVENTS };

/** Same sanity ceiling as every other explicit-bounds field in this file (advance months, lead
 *  days, overlap days, pet count) — a sitter-typed historical price is real money, but a figure
 *  with 15 digits behind it is a typo, not a stay anyone actually charged. */
export const MAX_BACKFILL_EST_COST = 1_000_000;

/**
 * Everything the pure classifier (`classifyEvent`, `server/lib/calendar-backfill.ts`) needs,
 * loaded once per pass. Lives here, not in `server/lib/`, because it touches D1 — the same split
 * `loadPaymentMatchInputs` above uses.
 */
async function loadBackfillContext(
  c: Context<AppEnv>,
  tenant: Tenant,
): Promise<{
  pets: BackfillPet[];
  links: PetOwnerLink[];
  backfillServices: BackfillService[];
  serviceByType: Map<string, TenantService>;
  optionByType: Map<string, TenantServiceOption>;
  rates: { groupRates: GroupRate[]; mixRates: MixRate[] };
}> {
  const [petRows, links, services, options, groupRows, mixRows] = await Promise.all([
    listAllEndUserPetsByTenant(c.env.PAWSERVATION_DB, tenant.Id),
    listOwnerPetLinks(c.env.PAWSERVATION_DB, tenant.Id),
    listServices(c.env.PAWSERVATION_DB, tenant.Id),
    listServiceOptions(c.env.PAWSERVATION_DB, tenant.Id),
    // Both pet-set rate tables, ONE read each, tenant-wide — not routed through `loadPetSetRates`
    // (which is per-service by design, for the booking flow's single-service callers) and not
    // called once per enabled service here. `resolvePetSetRate` (inside `estimateCost`) filters
    // every candidate row by `serviceType`+`optionKey` on each lookup regardless of what superset
    // of rows it's handed, so passing the full tenant-wide set to every service below is exactly
    // equivalent to a per-service-scoped read — with none of the redundant D1 cost. This route
    // classifies every event against every enabled service (up to MAX_SERVICES) in one pass, which
    // makes it the one caller that actually wants the whole tenant's rate tables at once; a
    // per-service loop here would reread `TenantServicePetRates` in full, byte-identically, up to
    // MAX_SERVICES times, which is what blew the Workers Free plan's subrequest budget this cap
    // exists to protect. `listAllPetGroupPricing` is the same tenant-wide read already used by the
    // pet-pricing GET route below (:703) and the settings-warning route.
    listAllPetGroupPricing(c.env.PAWSERVATION_DB, tenant.Id),
    listServicePetRates(c.env.PAWSERVATION_DB, tenant.Id),
  ]);

  const pets: BackfillPet[] = petRows.map((p) => ({ id: p.Id, name: p.Name, petType: p.PetType }));

  // classifyEvent wants one option per service; take each enabled service's first option, which
  // is what a title like "Sadie Walk" can name. A service with no option cannot price and is
  // simply absent, so such an event flags `unknown-service` rather than failing. "First" is
  // `listServiceOptions`'s own `ORDER BY ServiceType, DurationMinutes` (repo.ts) — i.e. the
  // SHORTEST-duration option on a multi-option service — not an arbitrary array-order tiebreak;
  // reordering that query would silently reprice every multi-option service's adopted stays.
  const serviceByType = new Map<string, TenantService>();
  const optionByType = new Map<string, TenantServiceOption>();
  const backfillServices: BackfillService[] = [];
  for (const s of services) {
    if (!s.Enabled) continue;
    const option = options.find((o) => o.ServiceType === s.ServiceType);
    if (!option) continue;
    serviceByType.set(s.ServiceType, s);
    optionByType.set(s.ServiceType, option);
    backfillServices.push({
      serviceType: s.ServiceType,
      label: s.Label,
      optionKey: option.OptionKey,
      // TenantServices.Shape, carried through verbatim. classifyEvent uses it to decide whether a
      // booking keeps its exclusive end date. NEVER inferred from the slug: slugs are per-tenant
      // text derived from a renameable label, so the built-in "House sitting" template becomes
      // 'house-sitting' and any hardcoded slug list silently drops the end date off every
      // multi-night stay.
      shape: s.Shape,
    });
  }

  // Same field mapping `loadPetSetRates` (availability.ts) applies to these two row shapes; kept
  // in sync by hand since that mapping is a stable 1:1 column rename, not logic.
  const rates = {
    groupRates: groupRows.map((r) => ({
      groupKey: r.GroupKey,
      rate: r.Rate,
      serviceType: r.ServiceType,
      optionKey: r.OptionKey,
    })),
    mixRates: mixRows.map((r) => ({
      mixKey: r.MixKey,
      rate: r.Rate,
      serviceType: r.ServiceType,
      optionKey: r.OptionKey,
    })),
  };

  return { pets, links, backfillServices, serviceByType, optionByType, rates };
}

/**
 * Classify every Google Calendar event against this tenant's live pets/households/services/rates.
 * Reused verbatim by the import route (Task 7) so the preview and the actual import classify by
 * exactly the same code path. Also returns the pet list `loadBackfillContext` resolved, so a
 * caller that wants display-only pet names (the preview route) doesn't re-read it.
 */
async function classifyAll(
  c: Context<AppEnv>,
  tenant: Tenant,
  events: CalendarEvent[],
): Promise<{ classified: Classified[]; pets: BackfillPet[] }> {
  const [{ pets, links, backfillServices, serviceByType, optionByType, rates }, adoptedEventIds] =
    await Promise.all([
      loadBackfillContext(c, tenant),
      listAdoptedEventIds(c.env.PAWSERVATION_DB, tenant.Id),
    ]);

  const priceFor: BackfillContext['priceFor'] = (
    service,
    pricedPets,
    startDate,
    endDateExclusive,
  ) => {
    const tenantService = serviceByType.get(service.serviceType)!;
    const option = optionByType.get(service.serviceType)!;
    return estimateCost(tenantService, option, startDate, endDateExclusive, pricedPets, rates);
  };

  const ctx: BackfillContext = {
    pets,
    links,
    services: backfillServices,
    adoptedEventIds,
    priceFor,
  };
  return { classified: events.map((event) => classifyEvent(event, ctx)), pets };
}

/**
 * Each pet-bearing row triggers several sequential D1 calls; an unbounded import can exceed
 * Workers' subrequest/CPU ceiling mid-loop, which aborts outside the per-row try/catch and
 * returns a bare 500 with no partial-import report. Cap row count so oversized files fail fast
 * with an actionable error instead of a platform crash.
 */
const MAX_IMPORT_ROWS = 500;

/**
 * How many pets one co-owner add may link in a single call. A household's pet set is small; this
 * only bounds the batch a hostile body could ask for (every link is a statement in one db.batch).
 */
const MAX_ACCOUNT_PET_LINKS = 25;

/**
 * How many co-owners one CSV row may name. A household has a handful of humans; the cap is what
 * stops MAX_IMPORT_ROWS × an unbounded cell from becoming an unbounded pile of writes inside one
 * request. Exceeding it links NONE of that row's co-owners — a partial application of a list the
 * sitter clearly mistyped is worse than a clear refusal — while the row's PET still imports.
 */
const MAX_CO_OWNERS_PER_ROW = 5;

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
  // Server-side bound on the "Add an option" / "Add another slot" buttons. Checked before any
  // per-row work so an oversized payload is one clear message, not the first row's complaint.
  //
  // The cap blocks GROWTH, not existence. "Add an option" was unbounded before this cap landed,
  // so a live sitter may already hold more rows than the limit — and a flat `> MAX` check would
  // lock her out of saving ANYTHING in Settings (a name, a question, a holiday rate) until she
  // deleted options she still uses. A rule introduced today must never retroactively invalidate
  // a configuration that was legal when it was made. So the effective ceiling is the higher of
  // the cap and what this service ALREADY has: an over-cap service stays fully editable and
  // saveable, it simply cannot get bigger, and every deletion ratchets it down toward the cap.
  const ceiling = Math.max(MAX_OPTIONS_PER_SERVICE, existingKeys.size);
  if (opts.length > ceiling)
    return {
      error:
        existingKeys.size > MAX_OPTIONS_PER_SERVICE
          ? `${serviceLabel}: this service already has ${existingKeys.size} options, more than the limit of ${MAX_OPTIONS_PER_SERVICE}. You can keep and edit the ones you have, but you'll need to remove one before adding another.`
          : `${serviceLabel}: a service can have at most ${MAX_OPTIONS_PER_SERVICE} options. Remove one to add another.`,
    };
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
  /** Minimum notice in days for the start date (0004); 0/null = same-day OK. PATCH: absent = keep. */
  minLeadDays?: number | null;
  acceptedPetTypes?: string[] | null;
  maxConcurrentPets?: number | null;
  maxPerDay?: number | null;
  cancellationTiers?: CancellationTier[] | null;
  /** Explicit whole-dollar holiday rate; null clears it. PATCH: absent = keep current. */
  holidayRate?: number | null;
  /** How an otherwise-unpriced pet set is priced (0005): 'exact' refuses it, 'linear' charges the
   *  option rate x the pet count. PATCH: absent = keep current — never coerced to a default here,
   *  because coercing it would silently re-mode a service on any partial save. */
  petRateMode?: unknown;
  /** Extra-time surcharge (0009): the hours a stay normally starts and ends, plus a FLAT
   *  whole-dollar fee for each side. All four PATCH: absent = keep current, null = clear. Each side
   *  needs BOTH its time and its fee to charge anything. */
  standardArrivalTime?: string | null;
  standardDepartureTime?: string | null;
  earlyArrivalFee?: number | null;
  lateDepartureFee?: number | null;
};
type SettingsBody = {
  displayName?: string;
  accentColor?: string;
  timezone?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  /** Booking horizon in months, profile-level (0004); null = no limit. PATCH: absent = keep. */
  maxAdvanceMonths?: number | null;
  /** House-sit/boarding tail-end overlap allowance in days (0006); null = no limit. Same PATCH
   *  semantics — and 0 is a MEANINGFUL value here ("never overlap"), which is why `patchNullable`
   *  keys off `in`, not falsiness. */
  housesitBoardingOverlapDays?: number | null;
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
    | 'timezone'
    | 'contactEmail'
    | 'contactPhone'
    | 'maxAdvanceMonths'
    | 'housesitBoardingOverlapDays',
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
        listServices(c.env.PAWSERVATION_DB, tenant.Id),
        listServiceOptions(c.env.PAWSERVATION_DB, tenant.Id),
        listPetTypes(c.env.PAWSERVATION_DB, tenant.Id),
        listBlockedRanges(c.env.PAWSERVATION_DB, tenant.Id),
        listProviderConnections(c.env.PAWSERVATION_DB, tenant.Id),
        getTenantUserEmailById(c.env.PAWSERVATION_DB, tenant.Id, c.get('adminUserId')),
        listServicePetRates(c.env.PAWSERVATION_DB, tenant.Id),
        listAllPetGroupPricing(c.env.PAWSERVATION_DB, tenant.Id),
      ]);
    return c.json({
      disabled: tenant.DisabledAt != null,
      displayName: tenant.DisplayName,
      accentColor: tenant.AccentColor,
      timezone: tenant.Timezone,
      contactEmail: tenant.ContactEmail,
      contactPhone: tenant.ContactPhone,
      maxAdvanceMonths: tenant.MaxAdvanceMonths,
      housesitBoardingOverlapDays: tenant.HousesitBoardingOverlapDays,
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
        minLeadDays: svc.MinLeadDays,
        maxPetCount: svc.MaxPetCount,
        acceptedPetTypes: svc.AcceptedPetTypes,
        cancellationTiers: svc.CancellationTiers,
        capacityKind: svc.CapacityKind,
        maxConcurrentPets: svc.MaxConcurrentPets,
        holidayRate: svc.HolidayRate,
        petRateMode: svc.PetRateMode,
        // Extra-time surcharge config (0009), round-tripped by the service editor. Null = that side
        // is off; the FEE the customer is shown is still only ever computed server-side.
        standardArrivalTime: svc.StandardArrivalTime,
        standardDepartureTime: svc.StandardDepartureTime,
        earlyArrivalFee: svc.EarlyArrivalFee,
        lateDepartureFee: svc.LateDepartureFee,
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
    const maxAdvanceMonths = patchNullable<number>(
      body,
      'maxAdvanceMonths',
      tenant.MaxAdvanceMonths,
    );
    if (
      maxAdvanceMonths !== null &&
      (!Number.isInteger(maxAdvanceMonths) ||
        maxAdvanceMonths < 1 ||
        maxAdvanceMonths > MAX_ADVANCE_MONTHS_CAP)
    )
      return c.json(
        {
          error: `Booking horizon must be between 1 and ${MAX_ADVANCE_MONTHS_CAP} months, or blank for no limit.`,
        },
        400,
      );
    const housesitBoardingOverlapDays = patchNullable<number>(
      body,
      'housesitBoardingOverlapDays',
      tenant.HousesitBoardingOverlapDays,
    );
    if (!isValidOverlapDays(housesitBoardingOverlapDays))
      return c.json(
        {
          error: `House sitting and boarding may overlap by 0 to ${MAX_OVERLAP_DAYS_CAP} days, or leave it blank for no limit.`,
        },
        400,
      );
    const services = body.services ?? [];
    // Per-service PATCH semantics for questions/constraints (mirrors patchNullable above): a field
    // included in a service's body ⇒ take it; absent ⇒ keep that service's current value. Without
    // this, a caller that PUTs `{type, enabled}` alone (omitting questions/constraints) would
    // silently wipe them back to empty/unlimited.
    const currentServices =
      services.length > 0 ? await listServices(c.env.PAWSERVATION_DB, tenant.Id) : [];
    const currentOptions =
      services.length > 0 ? await listServiceOptions(c.env.PAWSERVATION_DB, tenant.Id) : [];
    const tenantPetTypes = await listPetTypes(c.env.PAWSERVATION_DB, tenant.Id);
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
      if (
        svc.minLeadDays != null &&
        (!Number.isInteger(svc.minLeadDays) ||
          svc.minLeadDays < 0 ||
          svc.minLeadDays > MAX_LEAD_DAYS_CAP)
      )
        return c.json(
          {
            error: `${meta.Label}: days of notice must be between 0 and ${MAX_LEAD_DAYS_CAP}, or blank.`,
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
      // The pet-rate mode is a STORED CHOICE, so an unrecognised value is rejected rather than
      // coerced: coercing to 'exact' would silently discard a sitter's opt-in, and coercing to
      // 'linear' would multiply money nobody asked to multiply.
      if ('petRateMode' in svc && !isPetRateMode(svc.petRateMode))
        return c.json({ error: `${meta.Label}: unknown multi-pet pricing mode.` }, 400);
      // Extra-time surcharge (0009). Gated the way the capacity check gates itself — to the shape
      // this config can actually act on. Standard HOURS only mean something where the OWNER sets the
      // booking's times, i.e. a service whose options are not duration-priced (`HasDuration = 0`:
      // boarding, house sitting, daycare). On a walk or a check-in the option's slot IS the clock, so
      // a "standard arrival" there could never fire — and config a sitter typed that silently never
      // applies is the same defect as the retired minPetCount, so it is REJECTED, not dropped.
      const extraTimeFields = [
        'standardArrivalTime',
        'standardDepartureTime',
        'earlyArrivalFee',
        'lateDepartureFee',
      ] as const;
      const sendsExtraTime = extraTimeFields.some((f) => f in svc && svc[f] != null);
      if (sendsExtraTime && meta.HasDuration)
        return c.json(
          {
            error: `${meta.Label}: the option you booked sets the times on this service, so standard hours don't apply.`,
          },
          400,
        );
      for (const field of ['standardArrivalTime', 'standardDepartureTime'] as const) {
        if (svc[field] != null && !isValidTimeString(svc[field]))
          return c.json({ error: `${meta.Label}: standard hours must be in HH:MM format.` }, 400);
      }
      // Whole dollars >= 1, the same `isValidRate` every other stored money field uses. Deliberately
      // NOT bounded relative to the base rate, and deliberately not a percentage: a rate the sitter
      // did not type is a price they did not agree to.
      for (const field of ['earlyArrivalFee', 'lateDepartureFee'] as const) {
        if (svc[field] != null && !isValidRate(svc[field]))
          return c.json(
            {
              error: `${meta.Label}: extra-time fees must be whole dollars, $1 or more (or blank).`,
            },
            400,
          );
      }
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

    await updateTenantSettings(c.env.PAWSERVATION_DB, tenant.Id, {
      displayName,
      accentColor,
      timezone,
      contactEmail,
      contactPhone,
      maxAdvanceMonths,
      housesitBoardingOverlapDays,
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
      const updated = await setServiceConfig(c.env.PAWSERVATION_DB, tenant.Id, svcType, {
        enabled: svc.enabled ?? false,
        description: resolveServiceDescription(svc, current.Description),
        questions,
        maxNights: 'maxNights' in svc ? (svc.maxNights ?? null) : current.MaxNights,
        maxPetCount: 'maxPetCount' in svc ? (svc.maxPetCount ?? null) : current.MaxPetCount,
        minLeadDays: 'minLeadDays' in svc ? (svc.minLeadDays ?? null) : current.MinLeadDays,
        acceptedPetTypes:
          'acceptedPetTypes' in svc ? (svc.acceptedPetTypes ?? null) : current.AcceptedPetTypes,
        maxConcurrentPets:
          'maxConcurrentPets' in svc ? (svc.maxConcurrentPets ?? null) : current.MaxConcurrentPets,
        cancellationTiers:
          'cancellationTiers' in svc ? (svc.cancellationTiers ?? null) : current.CancellationTiers,
        holidayRate: 'holidayRate' in svc ? (svc.holidayRate ?? null) : current.HolidayRate,
        petRateMode: isPetRateMode(svc.petRateMode) ? svc.petRateMode : current.PetRateMode,
        // Same PATCH idiom as every field above: absent keeps the stored value, an explicit null
        // clears that side back to "no surcharge".
        standardArrivalTime:
          'standardArrivalTime' in svc
            ? (svc.standardArrivalTime ?? null)
            : current.StandardArrivalTime,
        standardDepartureTime:
          'standardDepartureTime' in svc
            ? (svc.standardDepartureTime ?? null)
            : current.StandardDepartureTime,
        earlyArrivalFee:
          'earlyArrivalFee' in svc ? (svc.earlyArrivalFee ?? null) : current.EarlyArrivalFee,
        lateDepartureFee:
          'lateDepartureFee' in svc ? (svc.lateDepartureFee ?? null) : current.LateDepartureFee,
      });
      // The service existed when validated above but was deleted by a concurrent request since —
      // stop before writing options for a slug that no longer exists.
      if (!updated)
        return c.json({ error: `${current.Label} was deleted. Refresh and retry.` }, 409);
      await replaceServiceOptions(
        c.env.PAWSERVATION_DB,
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
          await replaceServicePetRates(c.env.PAWSERVATION_DB, tenant.Id, svcType, optionKey, rates);
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

    const existing = await listServices(c.env.PAWSERVATION_DB, tenant.Id);
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
    // The template's species guess, INTERSECTED with this tenant's actual registry. A tenant that
    // deleted 'cat' would otherwise get a check-in service whose accepted list is empty — an
    // enabled service accepting nothing, which the settings PUT rejects on every subsequent save.
    // An empty intersection falls back to NULL (= every registry type), never to `[]`.
    const registry = new Set(
      (await listPetTypes(c.env.PAWSERVATION_DB, tenant.Id)).map((p) => p.PetType),
    );
    const wanted = tpl.defaultAcceptedPetTypes?.filter((t) => registry.has(t)) ?? null;
    const acceptedPetTypes = wanted && wanted.length > 0 ? [...wanted] : null;
    try {
      await createService(c.env.PAWSERVATION_DB, tenant.Id, {
        serviceType: slug,
        label,
        icon: tpl.icon,
        shape: tpl.shape,
        rateUnit: tpl.rateUnit,
        hasDuration: tpl.hasDuration,
        capacityKind: tpl.capacityKind,
        sortOrder: Math.max(0, ...existing.map((s) => s.SortOrder)) + 1,
        acceptedPetTypes,
        // Owner directive (2026-07-28): a service created from here on starts with per-pet
        // multiplication ON, so a two-dog household can book the moment the sitter types one
        // price. This is the ONE place that default is chosen, and it applies to NEW rows only —
        // the column's own default is 'exact', so every service that already exists keeps
        // refusing unpriced sets exactly as before. The service editor states the mode in plain
        // English right above the price, so it is a disclosed default, not a silent one.
        petRateMode: 'linear',
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
    const existing = await listServices(c.env.PAWSERVATION_DB, tenant.Id);
    const service = existing.find((s) => s.ServiceType === type);
    if (!service) return c.json({ error: 'Unknown service type.' }, 404);
    if (isTemplateId(type))
      return c.json({ error: 'Built-in services can be disabled, not deleted.' }, 400);
    if ((await countBookingsForService(c.env.PAWSERVATION_DB, tenant.Id, type)) > 0)
      return c.json({ error: 'That service has bookings — disable it instead.' }, 409);
    await deleteService(c.env.PAWSERVATION_DB, tenant.Id, type);
    await invalidateTenantCache(tenant.Slug, c.env);
    return c.body(null, 204);
  })

  // ── Pet-group rates: explicit prices for specific animals (PetGroupPricing) ──────────────
  // Upsert/delete-ONE, deliberately not whole-set replace: group rows scale with the client
  // base, so a replace-writer would round-trip every client's rows per save and let two tabs
  // clobber each other. Pricing reads these rows on every quote (loadPetSetRates →
  // resolvePetSetRate, where a group rate beats a mix rate), straight from D1 — so no
  // tenant-cache invalidation is needed (the KV-cached public config carries none of these rows).
  .get('/:slug/admin/pet-group-rates', async (c) => {
    const tenant = c.get('tenant');
    const rows = await listAllPetGroupPricing(c.env.PAWSERVATION_DB, tenant.Id);
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
    const service = (await listServices(c.env.PAWSERVATION_DB, tenant.Id)).find(
      (s) => s.ServiceType === serviceType,
    );
    if (!service) return c.json({ error: 'Unknown service type.' }, 400);
    const options = await listServiceOptions(c.env.PAWSERVATION_DB, tenant.Id);
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
    const pets = await listAllEndUserPetsByTenant(c.env.PAWSERVATION_DB, tenant.Id);
    const livePetIds = new Set(pets.filter((p) => p.DeceasedAt === null).map((p) => p.Id));
    for (const petId of body.petIds)
      if (!livePetIds.has(petId)) return c.json({ error: 'Unknown pet in the list.' }, 400);
    if (!isValidRate(body.rate))
      return c.json({ error: 'Rates are whole dollars, at least $1.' }, 400);
    const { id } = await upsertPetGroupRate(c.env.PAWSERVATION_DB, tenant.Id, {
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
    const deleted = await deletePetGroupRateById(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      c.req.param('id'),
    );
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
      await createPetType(c.env.PAWSERVATION_DB, tenant.Id, petType, label);
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
    const renamed = await renamePetType(c.env.PAWSERVATION_DB, tenant.Id, petType, label);
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
    const rows = await listPetTypes(c.env.PAWSERVATION_DB, tenant.Id);
    if (!rows.some((p) => p.PetType === petType))
      return c.json({ error: 'Unknown pet type.' }, 404);
    const refs = await countPetTypeReferences(c.env.PAWSERVATION_DB, tenant.Id, petType);
    if (refs > 0)
      return c.json(
        {
          error: `That pet type is on ${refs} ${refs === 1 ? 'pet or booking' : 'pets or bookings'} and can't be deleted. Uncheck it under each service's Accepted pets instead.`,
        },
        409,
      );
    const { disabledServices } = await deletePetTypeAndScrub(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      petType,
    );
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
    const id = await insertBookingRequest(c.env.PAWSERVATION_DB, tenant.Id, {
      endUserId: null,
      serviceType: 'blocked',
      startDate: start,
      endDate: end,
      optionKey: null,
      petCount: 1,
      estCost: null,
      status: 'confirmed',
    });

    // Best-effort push of an all-day "UNAVAILABLE" event, mirroring every other calendar hook in
    // this file (waitUntil in production; awaited in tests, which have no ExecutionContext — see
    // routes/bookings.ts). syncBookingToCalendar short-circuits to buildUnavailableEventResource
    // for ServiceType 'blocked' before touching any of the customer/pet fields below, which exist
    // only to satisfy SyncInput's shape.
    const input: SyncInput = {
      bookingId: id,
      endUserId: null,
      serviceType: 'blocked',
      serviceLabel: 'Time off',
      startDate: start,
      endDate: end,
      startTime: null,
      departureTime: null,
      durationMinutes: null,
      petCount: 1,
      petNames: [],
      estCost: null,
      status: 'confirmed',
    };
    const task = syncBookingToCalendar(c.env, tenant, input).catch((err) => {
      console.error('calendar blocked sync failed', err);
    });
    try {
      c.executionCtx.waitUntil(task);
    } catch {
      await task;
    }

    return c.json({ id }, 201);
  })

  .delete('/:slug/admin/blocked/:id', async (c) => {
    const tenant = c.get('tenant');
    // cancelBlockedRange is a soft delete (Status -> 'cancelled', SyncPending re-armed) and returns
    // a three-way result: `undefined` when no row matched (404, matching the old hard-DELETE's
    // repeat-call behavior); `null` when the row was found and cancelled but was never synced to
    // Google (every blocked row is born SyncPending regardless of connection state, so an
    // unconnected sitter's block has GCalEventId = null too — that must NOT 404); a `string` when
    // the row was found, cancelled, and HAD a live Google event, which is deleted best-effort below.
    const gcalEventId = await cancelBlockedRange(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      c.req.param('id'),
    );
    if (gcalEventId === undefined) return c.json({ error: 'Not found.' }, 404);
    if (gcalEventId) {
      // Best-effort delete of the mirrored Google event, same dance as every other calendar hook.
      const task = deleteBookingCalendarEvent(c.env, tenant, gcalEventId, c.req.param('id')).catch(
        (err) => {
          console.error('calendar blocked delete failed', err);
        },
      );
      try {
        c.executionCtx.waitUntil(task);
      } catch {
        await task;
      }
    }
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
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET)
      return c.json({ error: 'Google Calendar is not configured on this server.' }, 503);

    const nonce = crypto.randomUUID();
    await c.env.PAWSERVATION_CACHE.put(NONCE_KEY(nonce), '1', { expirationTtl: 600 });
    const state = await signState(c.env.TOKEN_SECRET, {
      tenantId: tenant.Id,
      nonce,
      exp: Date.now() + 600_000,
    });
    // Bind the callback to THIS admin's browser: the nonce travels back as a cookie that an
    // attacker cannot plant in a victim's browser, defeating OAuth login-CSRF. Path-scoped to the
    // callback only, and set on whichever host she opened her dashboard on — the same host
    // `callbackUriFor` sends Google back to, which is what makes the cookie readable there.
    // `secure` is read off the REQUEST's own scheme rather than ENVIRONMENT: that
    // var is unset in `.dev.vars`, so plain `npm run dev` was marking the cookie Secure over
    // http://localhost — which Chrome tolerates on localhost and Safari does not, breaking the
    // local connect in one browser only. The scheme is right in every environment with nothing to
    // configure, and is still `https:` in production.
    setCookie(c, 'pawservation_gcal_nonce', nonce, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax', // sent on Google's top-level redirect back to the callback
      path: '/oauth/google/callback',
      maxAge: 600,
    });
    return c.json({ url: buildAuthUrl(c.env, state, callbackUriFor(c.req.url)) });
  })

  .post('/:slug/admin/providers/calendar/disconnect', async (c) => {
    const tenant = c.get('tenant');
    const conn = await getProviderConnection(c.env.PAWSERVATION_DB, tenant.Id, 'calendar');
    if (conn?.RefreshToken) {
      try {
        await revokeToken(await decryptToken(c.env.TOKEN_SECRET, conn.RefreshToken));
      } catch {
        /* best-effort revoke; clear locally regardless */
      }
    }
    await clearProviderConnection(c.env.PAWSERVATION_DB, tenant.Id, 'calendar');
    // Materialized Google rows have no living source once disconnected — and no UI to remove
    // read-only rows — so they must not survive to block capacity forever.
    await deleteAllExternalEvents(c.env.PAWSERVATION_DB, tenant.Id);
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
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET)
      return c.json({ error: 'Google Calendar is not configured on this server.' }, 503);

    const conn = await getProviderConnection(c.env.PAWSERVATION_DB, tenant.Id, 'calendar');
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
    const conn = await getProviderConnection(c.env.PAWSERVATION_DB, tenant.Id, 'calendar');
    // NULL and the literal 'primary' name the same calendar, so compare through that default: a
    // save that doesn't actually move the target must not churn every booking's event.
    if ((conn?.CalendarId ?? 'primary') === (next ?? 'primary')) {
      await setProviderCalendarId(c.env.PAWSERVATION_DB, tenant.Id, 'calendar', next);
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
      listCustomers(c.env.PAWSERVATION_DB, tenant.Id),
      listAllEndUserPetsByTenant(c.env.PAWSERVATION_DB, tenant.Id),
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
    const known = (await listPetTypes(c.env.PAWSERVATION_DB, tenant.Id)).find(
      (pt) => pt.PetType === petType,
    );
    if (!known) return c.json({ error: 'That pet type is not accepted.' }, 400);

    const existing = await getEndUserByEmail(c.env.PAWSERVATION_DB, tenant.Id, email);
    let customer;
    if (existing) {
      // Idempotent re-POST: never downgrade an active customer to invited, never touch their
      // stored name/phone. Add the pet only if it's new for them; a repeat of an existing pet is
      // a no-op, not an error. `listEndUserPets` is LIVE pets only, so a deceased pet's name may
      // be used again — the CSV import applies that same live-only rule (it filters DeceasedAt out
      // of the map it dedups against), and the two must not drift.
      customer = existing;
      const pets = await listEndUserPets(c.env.PAWSERVATION_DB, tenant.Id, existing.Id);
      if (!pets.some((p) => p.Name.toLowerCase() === petName.toLowerCase()))
        await addEndUserPet(c.env.PAWSERVATION_DB, tenant.Id, existing.Id, petName, petType);
    } else {
      // One atomic batch — if the pet insert fails, no customer row is left standing.
      customer = await insertInvitedCustomerWithPet(
        c.env.PAWSERVATION_DB,
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
    // `created` tells the dashboard whether this made a new client or appended a pet to an
    // existing one — the two must not read as the same outcome (a typed name/phone is discarded
    // on the append path, and the sitter deserves to know that).
    return c.json(
      {
        id: customer.Id,
        email: customer.Email,
        name: customer.Name,
        phone: customer.Phone,
        status: customer.Status,
        created: !existing,
      },
      201,
    );
  })

  /**
   * A second HUMAN on an existing account — "Rob, Tina's husband" — who brings no new animal.
   *
   * The many-to-many model was already here (PetOwners edges + union-find billing accounts); the one
   * thing missing was a way to CREATE such a person, since POST /admin/customers hard-requires a new
   * pet. Without it the sitter had to invent a throwaway duplicate pet, merge, then delete it.
   *
   * "No owners without pets" is preserved rather than punched through: the client row and every
   * ownership link are ONE `db.batch` (`insertInvitedCustomerAsCoOwner`), so a pet id that cannot be
   * linked leaves no client standing at all — not even for an instant. The bare pet-less
   * `insertInvitedCustomer` is deliberately not reachable from here.
   *
   * Keyed on PET IDS, not on an account id, for the reason the other co-ownership routes are
   * (`POST /admin/pets/:petId/owners`): an account is derived client-side by union-find and has no
   * server-side identity to nest under. LIVE pets only — a deceased pet is not a pet for this rule,
   * the same live-only count the manual add and the CSV import apply — so a memorial account (no
   * live pets) legitimately has nothing to share and is refused; the sitter adds a pet first, which
   * revives the account, and can then add the person.
   *
   * An email that already belongs to a client is LINKED rather than rejected: that is the
   * account-merge case, and it is what the sitter meant. Their stored name and phone are kept
   * untouched (the manual-add route's rule), and `created: false` says so. No email is ever sent from
   * here — the welcome mail stays the explicit POST /admin/customers/:id/welcome.
   */
  .post('/:slug/admin/customers/co-owner', async (c) => {
    const tenant = c.get('tenant');
    type Body = { email?: unknown; name?: unknown; phone?: unknown; petIds?: unknown };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const rawPhone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const phone = rawPhone || null;
    // De-duplicated here rather than trusted: a repeated id would trip PetOwners' PRIMARY KEY and
    // abort the batch, turning a harmless double-send into a 500.
    const petIds = Array.isArray(body.petIds)
      ? [...new Set(body.petIds.filter((v): v is string => typeof v === 'string' && v !== ''))]
      : [];
    if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);
    if (email === DEMO_EMAIL)
      return c.json({ error: 'That email is reserved for the Pawservation demo.' }, 400);
    if (!name) return c.json({ error: "Enter this person's name." }, 400);
    if (phone !== null && phone.length > 40) return c.json({ error: 'Phone is too long.' }, 400);
    if (petIds.length === 0)
      return c.json(
        { error: 'Choose at least one pet — a client can never be added without pets.' },
        400,
      );
    if (petIds.length > MAX_ACCOUNT_PET_LINKS)
      return c.json({ error: `An account can share at most ${MAX_ACCOUNT_PET_LINKS} pets.` }, 400);

    // One read, purely so the refusal can say WHICH problem it is. The write is guarded again in SQL
    // (coOwnerLinkStmt), so nothing here is load-bearing for correctness.
    const found = await listPetsByIds(c.env.PAWSERVATION_DB, tenant.Id, petIds);
    if (found.length !== petIds.length) return c.json({ error: 'Not found.' }, 404);
    if (found.some((p) => p.DeceasedAt !== null))
      return c.json(
        {
          error:
            "A pet that has passed away can't be shared. Add a live pet to this account first, then add the person.",
        },
        400,
      );

    const existing = await getEndUserByEmail(c.env.PAWSERVATION_DB, tenant.Id, email);
    let customer;
    if (existing) {
      // The merge case. Never downgrade an active customer to invited, never rewrite the name or
      // phone already on file — exactly the manual-add route's append semantics.
      await addCoOwnerToPets(c.env.PAWSERVATION_DB, tenant.Id, existing.Id, petIds);
      customer = existing;
    } else {
      customer = await insertInvitedCustomerAsCoOwner(
        c.env.PAWSERVATION_DB,
        tenant.Id,
        email,
        name,
        phone,
        petIds,
      );
    }
    return c.json(
      {
        id: customer.Id,
        email: customer.Email,
        name: customer.Name,
        phone: customer.Phone,
        status: customer.Status,
        created: !existing,
        linkedPets: petIds.length,
      },
      201,
    );
  })

  // The explicit welcome mail (WS-C): re-sendable on demand, tenant-scoped via getEndUserById so a
  // foreign id is indistinguishable from a missing one. Idempotent in the safe-to-repeat sense —
  // each call sends one fresh copy; there is no "already sent" state to corrupt.
  .post('/:slug/admin/customers/:id/welcome', async (c) => {
    const tenant = c.get('tenant');
    const customer = await getEndUserById(c.env.PAWSERVATION_DB, tenant.Id, c.req.param('id'));
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
    if ((await countBookingsForUser(c.env.PAWSERVATION_DB, tenant.Id, id)) > 0)
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
    const outcome = await deleteCustomer(c.env.PAWSERVATION_DB, tenant.Id, id);
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
    if (!(await getEndUserById(c.env.PAWSERVATION_DB, tenant.Id, endUserId)))
      return c.json({ error: 'Not found.' }, 404);
    // Registry membership only (0015): a sitter may record a pet of a type no service currently
    // accepts — it just can't be booked until some service's Accepted pets list includes it.
    const known = (await listPetTypes(c.env.PAWSERVATION_DB, tenant.Id)).find(
      (pt) => pt.PetType === petType,
    );
    if (!known) return c.json({ error: 'That pet type is not accepted.' }, 400);
    const pet = await addEndUserPet(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      endUserId,
      name,
      petType,
      notes,
    );
    return c.json({ id: pet.Id, name: pet.Name, petType: pet.PetType, notes: pet.Notes }, 201);
  })
  .delete('/:slug/admin/customers/:id/pets/:petId', async (c) => {
    const tenant = c.get('tenant');
    // The "is it on a booking" refusal lives in removeEndUserPet's own SQL, not in a pre-check
    // here: BookingRequestPets has no ON DELETE CASCADE, so a check-then-delete could still lose
    // the race to a booking POST and surface a raw FK error as a 500. Exhaustive switch for
    // deleteCustomer's reason — success must be reached by a POSITIVE test, so a fourth outcome
    // added later fails to compile instead of falling through to "204 No Content".
    const outcome = await removeEndUserPet(c.env.PAWSERVATION_DB, tenant.Id, c.req.param('petId'));
    switch (outcome) {
      case 'removed':
        return c.body(null, 204);
      case 'not-found':
        return c.json({ error: 'Not found.' }, 404);
      case 'has-bookings':
        // Names the remedy that keeps the record intact: a pet on a booking is part of what that
        // booking was for, and marking it deceased is the product's answer for a pet that has died.
        return c.json(
          { error: 'Pet has bookings; cannot remove. Mark them as passed away instead.' },
          409,
        );
      default: {
        const unhandled: never = outcome;
        return c.json({ error: `Cannot remove this pet (${String(unhandled)}).` }, 409);
      }
    }
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
    const added = await addPetOwner(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      c.req.param('petId'),
      endUserId,
    );
    // A pet or customer from another tenant is reported exactly like a nonexistent one.
    if (!added) return c.json({ error: 'Not found.' }, 404);
    return c.body(null, 204);
  })
  .delete('/:slug/admin/pets/:petId/owners/:endUserId', async (c) => {
    const tenant = c.get('tenant');
    const outcome = await removePetOwner(
      c.env.PAWSERVATION_DB,
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
      c.env.PAWSERVATION_DB,
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
      c.env.PAWSERVATION_DB,
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
      (await listPetTypes(c.env.PAWSERVATION_DB, tenant.Id)).map((pt) => pt.PetType),
    );
    // LIVE pets only, keyed by owner id — deceased names are deliberately absent, so this map
    // answers both of the questions the loop asks of it the same way the manual-add route does
    // (which reads listEndUserPets, itself live-only): "does this client already own a pet by this
    // name" and "does this client have a pet at all". A deceased pet is neither bookable nor a
    // reason to refuse the name again.
    //
    // Name → pet ID rather than a bare set of names, because the co-owner pass needs the ID of a pet
    // the row merely REFERRED to (one that already existed, or was created earlier in this file) in
    // order to link a second owner to it. `.size` / `.has` answer the two dedup questions exactly as
    // the old Set did.
    const livePetNames = new Map<string, Map<string, string>>();
    for (const pet of await listAllEndUserPetsByTenant(c.env.PAWSERVATION_DB, tenant.Id)) {
      if (pet.DeceasedAt) continue;
      const byName = livePetNames.get(pet.EndUserId) ?? new Map<string, string>();
      byName.set(pet.Name.toLowerCase(), pet.Id);
      livePetNames.set(pet.EndUserId, byName);
    }

    let importedCustomers = 0;
    let importedPets = 0;
    let coOwnerLinks = 0;
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
    /**
     * One "also owned by" reference from the fifth column, resolved in a DEFERRED pass for the same
     * reason the pet-less verdict is: the co-owner may be a client this file has not created yet (the
     * canonical shape puts their own name-bearing row anywhere in the file), and a single-pass import
     * with immediate writes could only ever look backwards.
     */
    const coOwnerRefs: { row: number; email: string; petId: string; petName: string }[] = [];
    /**
     * Parse one co-owner cell. Anything wrong with an individual email is reported and dropped — the
     * PET on that row is still perfectly importable, so a bad co-owner never costs the sitter the
     * animal. Naming the row's own client is a no-op rather than an error (a sitter listing both
     * owners on both rows is being thorough, not wrong).
     */
    const noteCoOwners = (
      row: number,
      ownerEmail: string,
      pet: { id: string; name: string },
      cell: string,
    ) => {
      // Semicolons are the documented separator (a comma inside a CSV cell has to be quoted, which
      // is exactly what a sitter editing in Excel will forget), but commas and spaces are accepted
      // too: no email contains any of them, so being lenient here cannot misread anything.
      const raws = cell
        .split(/[;,\s]+/)
        .map((v) => v.trim())
        .filter((v) => v !== '');
      if (raws.length === 0) return;
      if (raws.length > MAX_CO_OWNERS_PER_ROW) {
        skippedRows.push({
          row,
          reason: `At most ${MAX_CO_OWNERS_PER_ROW} co-owner emails per row — none on this row were linked`,
        });
        return;
      }
      for (const raw of raws) {
        const email = raw.toLowerCase();
        if (email === ownerEmail) continue;
        if (!EMAIL_RE.test(email)) {
          skippedRows.push({ row, reason: `'${raw}' is not a valid co-owner email` });
          continue;
        }
        if (email === DEMO_EMAIL) {
          skippedRows.push({ row, reason: `'${raw}' is reserved for the Pawservation demo` });
          continue;
        }
        coOwnerRefs.push({ row, email, petId: pet.id, petName: pet.name });
      }
    };

    for (const [i, cells] of rows.entries()) {
      const row = i + 2; // 1-indexed against the sitter's file; +1 since the header was sliced off
      if (cells.length === 1 && cells[0] === '') continue; // blank line — not a real row
      if (cells.length < 4) {
        skippedRows.push({ row, reason: 'Could not parse this row' });
        continue;
      }
      const [rawEmail, rawName, rawPetName, rawPetType] = cells;
      // Fifth column, added later and therefore OPTIONAL: a four-column file (every file exported
      // before this existed) reads it as blank and behaves exactly as it always did.
      const rawCoOwners = cells[4] ?? '';
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
        const existing = await getEndUserByEmail(c.env.PAWSERVATION_DB, tenant.Id, email);
        if (existing) idByEmail.set(email, existing.Id);
        const petSet = existing
          ? (livePetNames.get(existing.Id) ?? new Map<string, string>())
          : new Map<string, string>();

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
        const already = petSet.get(petName.toLowerCase());
        if (already !== undefined) {
          // The pet is a duplicate, but the SHARING on this row may still be new — a re-run of a
          // file whose first pass failed part-way must converge, so the co-owner reference is
          // recorded before the row is reported as a duplicate.
          noteCoOwners(row, email, { id: already, name: petName }, rawCoOwners);
          skippedRows.push({ row, reason: 'Pet already exists for this client' });
          continue;
        }
        if (existing) {
          const pet = await addEndUserPet(
            c.env.PAWSERVATION_DB,
            tenant.Id,
            existing.Id,
            petName,
            petType,
          );
          petSet.set(petName.toLowerCase(), pet.Id);
          livePetNames.set(existing.Id, petSet);
          noteCoOwners(row, email, { id: pet.Id, name: petName }, rawCoOwners);
        } else {
          // Customer + first pet in one atomic batch — a failed pet insert leaves no customer.
          const customer = await insertInvitedCustomerWithPet(
            c.env.PAWSERVATION_DB,
            tenant.Id,
            email,
            createName,
            null,
            petName,
            petType,
          );
          livePetNames.set(customer.Id, new Map([[petName.toLowerCase(), customer.PetId]]));
          idByEmail.set(email, customer.Id);
          importedCustomers++;
          freshCustomers.push(email);
          noteCoOwners(row, email, { id: customer.PetId, name: petName }, rawCoOwners);
        }
        importedPets++;
      } catch {
        skippedRows.push({ row, reason: 'Could not import this row' });
      }
    }

    // ── The deferred co-ownership pass ────────────────────────────────────────────────────────────
    // Grouped by PERSON, not by row, so each co-owner is resolved once and linked to all of their
    // pets in ONE write. This must run BEFORE the pet-less verdict below: a co-owner-only human is
    // legitimately pet-less in their own rows (their row exists only to give them a name) and ends
    // the import owning pets, so judging them first would report them as skipped.
    const coOwnerPets = new Map<string, { pets: Map<string, string>; rows: number[] }>();
    for (const ref of coOwnerRefs) {
      const entry = coOwnerPets.get(ref.email) ?? { pets: new Map<string, string>(), rows: [] };
      entry.pets.set(ref.petId, ref.petName);
      if (!entry.rows.includes(ref.row)) entry.rows.push(ref.row);
      coOwnerPets.set(ref.email, entry);
    }
    for (const [email, { pets, rows }] of coOwnerPets) {
      const petIds = [...pets.keys()];
      try {
        let ownerId = idByEmail.get(email);
        if (!ownerId) {
          // Tenant-scoped, like every other lookup here: the same email in another tenant is a
          // different person and must never be linked.
          const found = await getEndUserByEmail(c.env.PAWSERVATION_DB, tenant.Id, email);
          if (found) {
            ownerId = found.Id;
            idByEmail.set(email, found.Id);
          }
        }
        if (ownerId) {
          // An existing client keeps their stored name and phone; they simply gain the pets, which
          // is what merges the two billing accounts into one.
          await addCoOwnerToPets(c.env.PAWSERVATION_DB, tenant.Id, ownerId, petIds);
        } else {
          const createName = nameByEmail.get(email);
          if (!createName) {
            // There is no name to create them with — the pet is already imported, so say what the
            // sitter has to add rather than failing anything.
            for (const row of rows)
              skippedRows.push({
                row,
                reason: `Co-owner ${email} needs a row of their own with their name`,
              });
            continue;
          }
          // Human + every ownership link in ONE batch (the same repo function the co-owner route
          // uses), so this path can never commit a pet-less client either.
          const customer = await insertInvitedCustomerAsCoOwner(
            c.env.PAWSERVATION_DB,
            tenant.Id,
            email,
            createName,
            null,
            petIds,
          );
          ownerId = customer.Id;
          idByEmail.set(email, ownerId);
          importedCustomers++;
          freshCustomers.push(email);
        }
        // Record the pets they now own so the pet-less verdict counts them, and so a later row
        // naming the same pet for them reads as the duplicate it is.
        const byName = livePetNames.get(ownerId) ?? new Map<string, string>();
        for (const [petId, petName] of pets) byName.set(petName.toLowerCase(), petId);
        livePetNames.set(ownerId, byName);
        coOwnerLinks += petIds.length;
      } catch {
        for (const row of rows)
          skippedRows.push({ row, reason: `Could not link co-owner ${email}` });
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
    // against their spreadsheet top to bottom. A row can now carry more than one note (a duplicate
    // pet AND an unresolvable co-owner), so this leans on Array#sort being stable to keep those in
    // the order they were found rather than pretending the key is unique.
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

    return c.json({
      importedCustomers,
      importedPets,
      coOwnerLinks,
      invitesSent,
      invitesFailed,
      skippedRows,
    });
  })

  .get('/:slug/admin/bookings', async (c) => {
    const tenant = c.get('tenant');
    // A disabled tenant is read-only: don't run the calendar self-heal (a write) on this GET.
    if (!tenant.DisabledAt) await reconcileIfStale(c.env, tenant);
    const rows = await listBookingsForTenant(c.env.PAWSERVATION_DB, tenant.Id);
    // Cancellation policy per service, so each confirmed row can preview the fee it would owe if
    // cancelled today (one query, keyed by ServiceType; NULL/missing = no policy).
    const tiersByType = new Map<string, CancellationTier[] | null>(
      (await listServices(c.env.PAWSERVATION_DB, tenant.Id)).map((s) => [
        s.ServiceType,
        s.CancellationTiers,
      ]),
    );
    const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
    // ONE read for the whole list, grouped in JS — a charge is an additive line item, so it can
    // never change EstCost; total due is EstCost + chargesTotal, derived by every reader.
    const chargeRows = await listChargesForTenant(c.env.PAWSERVATION_DB, tenant.Id);
    const chargesByBooking = new Map<string, typeof chargeRows>();
    for (const ch of chargeRows) {
      const list = chargesByBooking.get(ch.BookingRequestId) ?? [];
      list.push(ch);
      chargesByBooking.set(ch.BookingRequestId, list);
    }
    // Same one-read-grouped-in-JS shape as chargesByBooking above — pet names are what the
    // sitter actually cares about identifying a row by (CLAUDE.md: "everything should be
    // categorized by the pets"), so the admin list must carry them, not just a bare count.
    const petNameRows = await listPetNamesForTenantBookings(c.env.PAWSERVATION_DB, tenant.Id);
    const petNamesByBooking = new Map<string, string[]>();
    for (const pr of petNameRows) {
      const list = petNamesByBooking.get(pr.BookingRequestId) ?? [];
      list.push(pr.Name);
      petNamesByBooking.set(pr.BookingRequestId, list);
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
        departureTime: r.DepartureTime,
        optionKey: r.OptionKey,
        petCount: r.PetCount,
        petNames: petNamesByBooking.get(r.Id) ?? [],
        external: r.ServiceType === 'external',
        externalSummary: r.ExternalSummary,
        // What the design doc names as the flag the UI reads to label a cost as an estimate
        // rather than a client-agreed price (docs/superpowers/specs/2026-08-09-calendar-backfill-
        // design.md) — the same restriction the PATCH .../cost route enforces server-side.
        isBackfilled: r.Source === 'calendar-backfill',
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
      .json<{ status?: unknown; chargeFee?: unknown; overrideCapacity?: unknown }>()
      .catch(() => ({}) as { status?: unknown; chargeFee?: unknown; overrideCapacity?: unknown });
    const status = body.status;
    if (status !== 'confirmed' && status !== 'cancelled' && status !== 'declined')
      return c.json({ error: "Status must be 'confirmed', 'declined', or 'cancelled'." }, 400);

    // CONFIRM RE-CHECKS THE COMMITTED CALENDAR. A pending request occupies capacity, but nothing
    // re-validated when the sitter said yes — so two pending requests for one scarce day could both
    // be confirmed, and a confirm could break a rule that did not exist when the request was made (a
    // day blocked off since, the 0006 handover rule, a cap she has since lowered).
    //
    // It WARNS; it does not refuse. It is her calendar, and hard-refusing an overbooking she wants on
    // purpose would be worse than the hole — so the answer is a 409 naming what will collide plus
    // `requiresOverride`, and the same POST with `overrideCapacity: true` goes through. What she can
    // no longer do is end up over capacity without having been told.
    //
    // Only the pending -> confirmed direction: decline and cancel free capacity rather than take it,
    // and a row that is ALREADY confirmed is not changing, so there is nothing to warn about (and
    // re-confirming must not start refusing). Terminal rows still fall through to
    // updateBookingStatus's SQL guard and its 404, which is why this reads the row first and only
    // acts on 'pending' — a warning must never displace an existence answer.
    if (status === 'confirmed' && body.overrideCapacity !== true) {
      const bk = await getBookingWithCustomer(c.env.PAWSERVATION_DB, tenant.Id, id);
      if (bk && bk.Status === 'pending' && bk.ServiceType !== 'external') {
        const warning = await confirmOverbookWarning(c.env, tenant, bk);
        // Advisory, so inherently racy — a confirm landing in the same second still can't be caught
        // here. That is acceptable precisely because the answer is a warning she may override
        // anyway; the WRITE stays guarded by updateBookingStatus's own SQL.
        if (warning !== null)
          return c.json({ error: warning, code: 'capacity_conflict', requiresOverride: true }, 409);
      }
    }

    // Cancellation-fee assessment. The amount is ALWAYS computed server-side from the tenant's
    // policy — the request only supplies the `chargeFee` boolean, never a dollar figure. A $0
    // computed fee stores NULL (no fee assessed).
    let fee: number | undefined;
    if (body.chargeFee === true) {
      if (status !== 'cancelled')
        return c.json({ error: 'A cancellation fee applies only when cancelling.' }, 400);
      const bk = await getBookingWithCustomer(c.env.PAWSERVATION_DB, tenant.Id, id);
      // Same existence guard as the payments route: the 'blocked'/'external' sentinels 404 rather
      // than falling through to the 400 below, which would otherwise let an external row's id be
      // distinguished from a genuinely unknown id (an existence oracle).
      if (!bk || bk.ServiceType === 'blocked' || bk.ServiceType === 'external')
        return c.json({ error: 'Not found.' }, 404);
      if (bk.Status !== 'confirmed' || bk.EstCost == null)
        return c.json({ error: 'A fee needs a confirmed booking with an estimated cost.' }, 400);
      const svc = (await listServices(c.env.PAWSERVATION_DB, tenant.Id)).find(
        (s) => s.ServiceType === bk.ServiceType,
      );
      if (!svc?.CancellationTiers)
        return c.json({ error: 'This service has no cancellation policy.' }, 400);
      const today = getPacificDateStr(new Date(), tenant.Timezone ?? DEFAULT_TIMEZONE);
      const computed = cancellationFee(svc.CancellationTiers, bk.EstCost, bk.StartDate, today);
      if (computed > 0) fee = computed; // $0 stores NULL per spec
    }

    const updated = await updateBookingStatus(c.env.PAWSERVATION_DB, tenant.Id, id, status, fee);
    if (!updated) return c.json({ error: 'Not found.' }, 404);

    // One unconditional fetch serves both the calendar hooks and the customer
    // notification below (cancel/decline are soft — the row still exists).
    const booking = await getBookingWithCustomer(c.env.PAWSERVATION_DB, tenant.Id, id);

    // Calendar hooks are best-effort and never block the response (waitUntil in production; awaited
    // in tests, which have no ExecutionContext — see routes/bookings.ts).
    let calendarTask: Promise<void> | null = null;
    const retitle = keepsCalendarEventOnCancel('cancelled', fee ?? null) && status === 'cancelled';
    if (status === 'confirmed' || retitle) {
      // Confirm: retitle the existing event (drop the [REQUEST] marker), or — if the booking has
      // NO event yet (booked before the calendar was connected, or a Google outage swallowed the
      // request-time create) — create it now as a catch-up, already in the confirmed state.
      //
      // Cancel-WITH-A-FEE lands here too, retitling to [CANCELLED] rather than deleting: the stay
      // isn't happening but the receivable is, and this must agree with the outbox's own
      // delete-vs-retitle derivation or a failed push here would be resolved the other way by the
      // next sweep. It differs from confirm in one respect — a fee-cancelled booking with no
      // event is NOT created now, since putting a [CANCELLED] event on a calendar that never had
      // the booking helps nobody.
      const syncData = await getBookingSyncData(c.env.PAWSERVATION_DB, tenant.Id, id);
      if (syncData && !(retitle && !booking?.GCalEventId)) {
        const petNames = await listPetNamesForBooking(c.env.PAWSERVATION_DB, tenant.Id, id);
        const input: SyncInput = {
          bookingId: id,
          endUserId: syncData.EndUserId,
          serviceType: syncData.ServiceType,
          serviceLabel: syncData.ServiceLabel,
          startDate: syncData.StartDate,
          endDate: syncData.EndDate,
          startTime: syncData.StartTime,
          departureTime: syncData.DepartureTime,
          durationMinutes: syncData.DurationMinutes,
          petCount: syncData.PetCount,
          petNames,
          estCost: syncData.EstCost,
          status: retitle ? 'cancelled' : 'confirmed',
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
    const paymentId = await insertPayment(c.env.PAWSERVATION_DB, tenant.Id, {
      bookingRequestId: bookingId,
      amount: body.amount,
      method: body.method,
      paidDate: body.paidDate,
      note,
      externalRef: null,
    });
    // Guard refused: foreign, blocked/external, declined, or a cancelled booking that owes
    // nothing — no fee and no live charges (pending is deliberately allowed).
    if (!paymentId) return c.json({ error: 'Not found.' }, 404);
    const payments = await listPaymentsForBooking(c.env.PAWSERVATION_DB, tenant.Id, bookingId);
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

  /**
   * Close an over-payment the client agreed the sitter KEEPS, by logging it as a charge. The amount
   * is computed server-side from the same expressions the Earnings page displays the credit with —
   * the request carries no figure at all (same doctrine as the cancellation fee) — so the charge can
   * never differ from what she was shown. The other resolution, "the money went back", is the
   * payments ledger: DELETE the payment and re-record what was actually kept.
   */
  .post('/:slug/admin/bookings/:id/credit/keep', async (c) => {
    const tenant = c.get('tenant');
    const result = await keepBookingCredit(c.env.PAWSERVATION_DB, tenant.Id, c.req.param('id'));
    switch (result.outcome) {
      case 'kept':
        return c.json({ kept: result.amount });
      case 'not-found':
        return c.json({ error: 'Not found.' }, 404);
      case 'declined':
        return c.json(
          {
            error:
              'A declined request may keep nothing — refund the client and delete the payment instead.',
          },
          409,
        );
      case 'no-credit':
        return c.json({ error: 'That booking is not in credit.' }, 409);
      default: {
        const unhandled: never = result;
        return c.json({ error: `Cannot close this credit (${String(unhandled)}).` }, 409);
      }
    }
  })

  .get('/:slug/admin/bookings/:id/payments', async (c) => {
    const tenant = c.get('tenant');
    const bookingId = c.req.param('id');
    // Same existence guard as POST/DELETE: foreign booking or the 'blocked'/'external' sentinels
    // 404. Unlike POST, a cancelled booking is still viewable here — DELETE is the correction
    // mechanism for it.
    const booking = await getBookingWithCustomer(c.env.PAWSERVATION_DB, tenant.Id, bookingId);
    if (!booking || booking.ServiceType === 'blocked' || booking.ServiceType === 'external')
      return c.json({ error: 'Not found.' }, 404);
    const rows = await listPaymentsForBooking(c.env.PAWSERVATION_DB, tenant.Id, bookingId);
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
      c.env.PAWSERVATION_DB,
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
    const chargeId = await insertBookingCharge(c.env.PAWSERVATION_DB, tenant.Id, {
      bookingRequestId: bookingId,
      label,
      amount: body.amount,
    });
    // Guard refused: foreign booking or the 'blocked' sentinel.
    if (!chargeId) return c.json({ error: 'Not found.' }, 404);
    const charges = await listChargesForBooking(c.env.PAWSERVATION_DB, tenant.Id, bookingId);
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
    const booking = await getBookingWithCustomer(c.env.PAWSERVATION_DB, tenant.Id, bookingId);
    if (!booking || booking.ServiceType === 'blocked') return c.json({ error: 'Not found.' }, 404);
    const rows = await listChargesForBooking(c.env.PAWSERVATION_DB, tenant.Id, bookingId);
    return c.json({
      charges: rows.map((ch) => ({ id: ch.Id, label: ch.Label, amount: ch.Amount })),
    });
  })

  .delete('/:slug/admin/bookings/:id/charges/:chargeId', async (c) => {
    const tenant = c.get('tenant');
    const deleted = await deleteBookingCharge(
      c.env.PAWSERVATION_DB,
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
    const data = await getAnalytics(c.env.PAWSERVATION_DB, tenant.Id, today);
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
    const inputs = await loadPaymentMatchInputs(c.env, tenant.Id);
    const preview = matchVenmoTxns({ txns: parsed.incoming, ...inputs });
    return c.json({ ...preview, ignored: parsed.ignored, problems: parsed.problems });
  })

  /**
   * Record the rows the sitter approved AGAINST THEIR HOUSEHOLDS (Story 2.5, 0011). The CSV comes
   * back with the request and is parsed and matched AGAIN from scratch: the body supplies only
   * which transaction goes on which household, so every dollar figure, date and note is the
   * server's own reading of the file. An accountId is honoured only when it is EXACTLY the
   * household this request independently resolves the transaction's sender to — the preview is not
   * a token of trust, and there is no ranking step left to fool: a client resolves to at most one
   * household. The file itself is still never stored.
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
    const choices: { txnId: string; accountId: string }[] = [];
    for (const raw of body.choices) {
      const choice = raw as { txnId?: unknown; accountId?: unknown };
      if (
        !isVenmoTxnId(choice.txnId) ||
        typeof choice.accountId !== 'string' ||
        choice.accountId === ''
      )
        return c.json({ error: 'That list of payments is malformed.' }, 400);
      choices.push({ txnId: choice.txnId, accountId: choice.accountId });
    }

    const parsed = parseVenmoCsv(typeof body.csv === 'string' ? body.csv : '');
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const inputs = await loadPaymentMatchInputs(c.env, tenant.Id);
    const txnById = new Map(parsed.incoming.map((t) => [t.txnId, t]));

    const skipped: { txnId: string; reason: string }[] = [];
    let imported = 0;
    let totalAmount = 0;

    for (const { txnId, accountId } of choices) {
      const txn = txnById.get(txnId);
      if (!txn) {
        skipped.push({ txnId, reason: 'That transaction is not in this file' });
        continue;
      }
      if (inputs.alreadyImported.has(txnId)) {
        skipped.push({ txnId, reason: 'Already imported' });
        continue;
      }
      // Re-resolve from THIS request's data; the browser's idea of the match is never trusted.
      // resolveMatchClient is the SAME function the preview uses — a name that's ambiguous there
      // is refused here too, never silently resolved by whichever client happened to sort last.
      const client = resolveMatchClient(inputs.clients, txn.from);
      if (!client || client.accountId === null || client.accountId !== accountId) {
        skipped.push({ txnId, reason: 'That household is no longer a match for this payment' });
        continue;
      }
      const note = `Venmo import — ${txn.from}${txn.note ? `: ${txn.note}` : ''} (txn ${txn.txnId})`;
      try {
        const paymentId = await insertAccountPayment(c.env.PAWSERVATION_DB, tenant.Id, {
          accountId,
          amount: txn.amount,
          method: 'venmo',
          paidDate: txn.date,
          note: note.slice(0, 300),
          externalRef: txn.txnId,
        });
        if (!paymentId) {
          skipped.push({ txnId, reason: 'That household can no longer take a payment' });
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
  })

  /**
   * Read the shape of a sitter-uploaded, arbitrarily-columned payment CSV — its headers and a
   * sample of real rows — so the mapping panel can ask "which column is the date" against actual
   * values, never header names alone (the free-form counterpart to the Venmo importer, which knows
   * its own fixed headers). Writes nothing.
   */
  .post('/:slug/admin/payments/csv/columns', async (c) => {
    const body = await c.req.json<{ csv?: unknown }>().catch(() => ({}) as { csv?: unknown });
    const shape = detectCsvShape(typeof body.csv === 'string' ? body.csv : '');
    if (!shape.ok) return c.json({ error: shape.error }, 400);
    return c.json({
      headers: shape.headers,
      sample: shape.sample,
      dataRowCount: shape.dataRowCount,
    });
  })

  /**
   * Read the sitter's mapped CSV and say what Pawservation THINKS it found — the mapped-CSV sibling
   * of the Venmo preview above. Writes nothing: the file is re-parsed in memory against the
   * sitter's own column mapping, matched against this tenant's clients and receivables, and thrown
   * away with the request.
   */
  .post('/:slug/admin/payments/csv/preview', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ csv?: unknown; mapping?: unknown; defaultMethod?: unknown }>()
      .catch(() => ({}) as { csv?: unknown; mapping?: unknown; defaultMethod?: unknown });
    if (!isPaymentMethod(body.defaultMethod))
      return c.json({ error: 'Choose a valid default payment method.' }, 400);
    const mapping = parseCsvColumnMapping(body.mapping);
    if (!mapping) return c.json({ error: 'That column mapping is malformed.' }, 400);
    const parsed = applyMapping(
      typeof body.csv === 'string' ? body.csv : '',
      mapping,
      body.defaultMethod,
      tenant.Id,
    );
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const inputs = await loadPaymentMatchInputs(c.env, tenant.Id);
    const preview = matchCsvPayments({
      payments: parsed.payments,
      clients: inputs.clients,
      alreadyImported: inputs.alreadyImported,
    });
    // `households` rides along so the panel can offer a client for a row the matcher couldn't
    // place — the sitter assigning it is the design's own answer to an unmatched row.
    return c.json({ ...preview, households: inputs.households, problems: parsed.problems });
  })

  /**
   * Record the rows the sitter approved AGAINST THEIR HOUSEHOLDS — the mapped-CSV sibling of
   * `payments/venmo/import`, near-identical security shape. The body supplies the file, the
   * mapping, and only WHICH row goes on which household (`choices`): `applyMapping` runs again from
   * scratch, so every amount, date, method and note is the server's own re-reading of the file,
   * never the browser's. The file itself is still never stored.
   *
   * WHERE THIS DELIBERATELY DIFFERS FROM THE VENMO ROUTE. There, an `accountId` is honoured only
   * when the server independently resolves the sender to exactly that household. Here it need only
   * name a real household OF THIS TENANT, because matching is by payer name and a bank export's
   * payer strings often equal no client's stored name at all — so the design's answer to an
   * unmatched row is that THE SITTER ASSIGNS IT. That is safe because of what each side states: a
   * mapping is instructions ("column 3 is the amount"), never a claim about a value, so every
   * figure that becomes money is still read out of the file by the server. Which household a
   * payment belongs to is a judgement the authenticated sitter is the rightful authority on for
   * their own business. Their choice is still checked against this tenant's own households, and
   * `insertAccountPayment` scopes its insert by TenantId underneath — a cross-tenant write is
   * refused twice. Nothing here guesses: a payer matching two clients is still not resolved for
   * them, it is simply theirs to place.
   */
  .post('/:slug/admin/payments/csv/import', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ csv?: unknown; mapping?: unknown; defaultMethod?: unknown; choices?: unknown }>()
      .catch(
        () =>
          ({}) as { csv?: unknown; mapping?: unknown; defaultMethod?: unknown; choices?: unknown },
      );
    if (!isPaymentMethod(body.defaultMethod))
      return c.json({ error: 'Choose a valid default payment method.' }, 400);
    const mapping = parseCsvColumnMapping(body.mapping);
    if (!mapping) return c.json({ error: 'That column mapping is malformed.' }, 400);
    if (!Array.isArray(body.choices) || body.choices.length === 0)
      return c.json({ error: 'Choose at least one payment to record.' }, 400);
    if (body.choices.length > MAX_CSV_ROWS)
      return c.json({ error: `Record ${MAX_CSV_ROWS} payments or fewer at a time.` }, 400);
    const choices: { dedupeKey: string; accountId: string }[] = [];
    for (const raw of body.choices) {
      const choice = raw as { dedupeKey?: unknown; accountId?: unknown };
      if (
        typeof choice.dedupeKey !== 'string' ||
        choice.dedupeKey === '' ||
        typeof choice.accountId !== 'string' ||
        choice.accountId === ''
      )
        return c.json({ error: 'That list of payments is malformed.' }, 400);
      choices.push({ dedupeKey: choice.dedupeKey, accountId: choice.accountId });
    }

    const parsed = applyMapping(
      typeof body.csv === 'string' ? body.csv : '',
      mapping,
      body.defaultMethod,
      tenant.Id,
    );
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const inputs = await loadPaymentMatchInputs(c.env, tenant.Id);
    const paymentByKey = new Map(parsed.payments.map((p) => [p.dedupeKey, p]));
    const householdIds = new Set(inputs.households.map((h) => h.accountId));

    const skipped: { dedupeKey: string; reason: string }[] = [];
    let imported = 0;
    let totalAmount = 0;

    for (const { dedupeKey, accountId } of choices) {
      const payment = paymentByKey.get(dedupeKey);
      if (!payment) {
        skipped.push({ dedupeKey, reason: 'That payment is not in this file' });
        continue;
      }
      if (inputs.alreadyImported.has(dedupeKey)) {
        skipped.push({ dedupeKey, reason: 'Already imported' });
        continue;
      }
      // The sitter may file this payment against any household of their OWN business — and only
      // theirs. Checked against the freshly-loaded household set, never against anything the
      // preview told the browser.
      if (!householdIds.has(accountId)) {
        skipped.push({ dedupeKey, reason: 'That household is not one of your clients' });
        continue;
      }
      const note = `CSV import — ${payment.payer}${payment.note ? `: ${payment.note}` : ''}`;
      try {
        const paymentId = await insertAccountPayment(c.env.PAWSERVATION_DB, tenant.Id, {
          accountId,
          amount: payment.amount,
          method: payment.method,
          paidDate: payment.date,
          note: note.slice(0, 300),
          externalRef: dedupeKey,
        });
        if (!paymentId) {
          skipped.push({ dedupeKey, reason: 'That household can no longer take a payment' });
          continue;
        }
        imported++;
        totalAmount += payment.amount;
      } catch (err) {
        // The partial unique index caught a replay that slipped past the pre-read (a concurrent
        // import of the same file). Idempotency is the index's job, and it did it.
        if (isUniqueViolation(err)) skipped.push({ dedupeKey, reason: 'Already imported' });
        else throw err;
      }
    }
    return c.json({ imported, totalAmount, skipped });
  })

  /**
   * PREVIEW HOW A SITTER'S IMPORTED HOUSEHOLD CREDITS WOULD SETTLE (Task 3 of payment
   * attribution) — for each unapplied account-level credit of one household, or of every
   * household when `accountId` is omitted, asks the PURE `proposeAttribution`
   * (server/lib/payment-attribution.ts) how it would split against that household's unpaid
   * bookings. Read-only: it never calls `applyAttribution`, so nothing here ever moves money —
   * only the sitter's own explicit "apply" action (a later task) does that.
   *
   * "Unapplied account-level credit" needs no extra query of its own: `Payments.AccountId` and
   * `Payments.BookingRequestId` are mutually exclusive by `CHECK`, so every row
   * `listPaymentsForAccount` returns for a household IS an unapplied credit — one already
   * attributed to a booking would carry `BookingRequestId` instead and simply not be in that list.
   *
   * CANDIDATE BOOKINGS ARE RESTRICTED TO `outstanding > 0`, computed here from
   * `getHouseholdDetail`'s own `expected`/`paidTotal` (the same figures the household balance is
   * built from) rather than trusted from anywhere else. This is the fix a prior review asked for:
   * `getHouseholdDetail` also lists `declined` bookings, whose `expected` is zeroed by
   * `CREDITABLE_AMOUNT_SQL` but which can still carry a payment recorded before they were
   * declined (`insertPayment` allows it while a booking is still pending) — leaving a NEGATIVE
   * outstanding. Handing that straight to `proposeAttribution` would trip its own
   * unreadable-amount guard and refuse the household's ENTIRE credit, not just skip the one
   * booking nobody will ever bill (`insertPayment`'s payability predicate already refuses a
   * declined booking, so a split onto one would settle a stay that can never be collected on).
   * Filtering to `outstanding > 0` before the pure module ever sees the list is what keeps a
   * stray declined-with-payment booking from poisoning an otherwise ordinary proposal.
   *
   * A HOUSEHOLD'S CREDITS ARE PROPOSED IN SEQUENCE (each against what earlier ones left), which is
   * what stops three $40 credits from each claiming the same $40 booking. WHICH credit goes next is
   * closest-pair, not oldest-paid: the credit whose nearest still-available stay is nearest goes
   * first, with oldest `PaidDate` (then payment id) surviving only as the tie-break — see the loop
   * itself for why the older ordering mis-attributed a whole client. Ranking alone only settles who
   * gets the FIRST stay, so before a credit is proposed its candidate list also DROPS any stay a
   * different, not-yet-proposed credit of the same household is strictly closer to — otherwise the
   * round's winner spills onto a stay another credit was paid on the day of. The side effect is
   * unchanged:
   * a credit that comes second to a stay comes back
   * `no-unpaid-bookings` — and left there, that is automatic-with-no-override, the guess
   * `docs/superpowers/specs/2026-08-10-payment-attribution-design.md` explicitly rejects. So the
   * `unresolved[].bookings` list is the override: a credit the sequencing skipped still NAMES the
   * household's live-outstanding stays, so the sitter can untick the proposed one and place this
   * one instead. A credit whose household has no unpaid stay at all names nothing, and that
   * emptiness is the only signal the panel needs to tell an actionable refusal (offer an editor)
   * from an inert one (772 of 821 on the live tenant — summarised, never interactive).
   *
   * The server still decides everything: this route proposes nothing extra and writes nothing.
   * Whatever the sitter picks goes through the ordinary apply route, which re-derives the source
   * payment and re-reads live outstanding, and refuses an over-claim with its reason.
   *
   * `accountId` is resolved the way every other household read resolves it — by asking
   * `getHouseholdDetail` for the CURRENT id, never by equality on whatever the caller happened to
   * send — because a household's account id is its lexicographically-first pet and a newly added
   * pet renames it (see `householdPetIds`). An id `getHouseholdDetail` cannot resolve for this
   * tenant — another tenant's, or no household at all — is the same 404 every sibling household
   * route gives.
   *
   * THE OMITTED-`accountId` PATH USES `getHouseholdsWithUnappliedCredits`, NOT A LOOP OF
   * `getHouseholdDetail` PLUS `listPaymentsForAccount`, AND THIS IS A HARD CONSTRAINT RATHER THAN A
   * PREFERENCE: the panel ALWAYS previews tenant-wide (`AttributionPanel.tsx` never sends an
   * `accountId`), Cloudflare counts every D1 query against a per-invocation subrequest ceiling of
   * 50 on the Workers Free plan, and any per-household read multiplies by the tenant's household
   * count. A real 53-household account issued 216 of them and the feature simply did not run. The
   * tenant-wide reader is a CONSTANT six queries for any tenant, whatever its size — see its own
   * doc comment in `server/db/repo.ts`, and the prepare-counting test in
   * `server/__tests__/payment-attribution-routes.test.ts` that fails if a per-household read ever
   * comes back.
   */
  .post('/:slug/admin/payments/attribute/preview', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ accountId?: unknown }>()
      .catch(() => ({}) as { accountId?: unknown });
    const requestedAccountId =
      typeof body.accountId === 'string' && body.accountId !== '' ? body.accountId : undefined;

    const targets: {
      accountId: string;
      detail: NonNullable<Awaited<ReturnType<typeof getHouseholdDetail>>>;
      credits: Awaited<ReturnType<typeof listPaymentsForAccount>>;
    }[] = [];
    if (requestedAccountId !== undefined) {
      const detail = await getHouseholdDetail(c.env.PAWSERVATION_DB, tenant.Id, requestedAccountId);
      if (!detail) return c.json({ error: 'Not found.' }, 404);
      const credits = await listPaymentsForAccount(
        c.env.PAWSERVATION_DB,
        tenant.Id,
        detail.accountId,
      );
      if (credits.length > 0) targets.push({ accountId: detail.accountId, detail, credits });
    } else {
      const candidates = await getHouseholdsWithUnappliedCredits(c.env.PAWSERVATION_DB, tenant.Id);
      for (const { accountId, detail, credits } of candidates)
        targets.push({ accountId, detail, credits });
    }

    const proposals: {
      accountId: string;
      paymentId: string;
      amount: number;
      paidDate: string;
      splits: {
        bookingId: string;
        amount: number;
        serviceType: string;
        startDate: string;
        status: string;
        // Declared, not merely emitted: the panel's over-split guard reads this, so dropping it
        // must be a type error rather than a silent `undefined` that quietly disables the guard.
        outstanding: number;
      }[];
      remainder: number;
    }[] = [];
    const unresolved: {
      accountId: string;
      paymentId: string;
      amount: number;
      paidDate: string;
      reason: string;
      detail: string;
      bookings: {
        bookingId: string;
        serviceType: string;
        startDate: string;
        status: string;
        outstanding: number;
      }[];
    }[] = [];

    for (const { accountId, detail, credits } of targets) {
      // outstanding > 0 only — see the doc comment above for why this must happen before
      // proposeAttribution ever sees the list.
      const candidates = detail.bookings.filter((b) => b.expected - b.paidTotal > 0);
      const staticById = new Map(
        candidates.map((b) => [
          b.bookingId,
          {
            bookingId: b.bookingId,
            serviceType: b.serviceType,
            startDate: b.startDate,
            status: b.status,
          },
        ]),
      );
      // MUTABLE, and carried forward across this household's credits — a household's credits are
      // NOT independent proposals against the same fixed list. Each one is proposed against
      // whatever is still outstanding after every earlier credit's splits are subtracted, so a
      // $40 booking with three $40 credits gets ONE proposal, not three each claiming the full
      // $40. A booking that reaches 0 here simply stops appearing with positive outstanding, and
      // `proposeAttribution` already treats "no candidate with outstanding > 0" as
      // `no-unpaid-bookings` — the true answer for a later credit with nothing left to attach to.
      const outstandingById = new Map(
        candidates.map((b) => [b.bookingId, b.expected - b.paidTotal]),
      );
      // The booking's genuinely LIVE outstanding — never decremented as this loop works through
      // the household's credits, unlike `outstandingById` above. `outstandingById` still has to
      // drive `proposeAttribution` itself (it genuinely needs to know what an earlier credit in
      // THIS batch already claimed, or it would double-propose the same dollar to two credits).
      // But the figure sent to the CLIENT for display/capping must not be that sequenced number:
      // it is true only if the sitter applies this exact batch, unedited, in this exact order,
      // and presenting it as "outstanding" false-blocks a sitter who edits or reorders — e.g.
      // excludes an earlier credit and raises a later one to settle the booking outright, which
      // the server would accept (see task-5-report.md, round 2). So every `outstanding` field
      // returned below — on a resolved split AND on an ambiguous credit's candidate bookings —
      // reads this map instead, and so does the membership test deciding WHICH candidate
      // bookings an ambiguous credit is offered.
      //
      // Accepted consequence: two credits proposed within the SAME household preview can each
      // report the booking's full live outstanding, so a sitter could compose a batch that
      // over-attributes across them (e.g. approve both credits above at full value). That's
      // already caught server-side — `applyAttribution`'s loop is sequential and each call
      // re-reads live state, so the second attribution in such a batch is refused with a reason
      // this panel already surfaces (`AttributionPanel.tsx`'s skipped-reason rendering). Blocking
      // it here too would be a nice-to-have; blocking a legal single settlement, which is what
      // this fixes, is not acceptable.
      const liveOutstandingById = new Map(
        candidates.map((b) => [b.bookingId, b.expected - b.paidTotal]),
      );

      // The pool this household's credits are drawn from, in the order that decides every TIE:
      // oldest PAID date first, then payment id, so a run over the same data always produces the
      // same allocation. It is no longer the order they are PROPOSED in — see the loop below.
      const remainingCredits = [...credits].sort((a, b) => {
        if (a.PaidDate !== b.PaidDate) return a.PaidDate < b.PaidDate ? -1 : 1;
        return a.Id < b.Id ? -1 : a.Id > b.Id ? 1 : 0;
      });

      while (remainingCredits.length > 0) {
        // `endDate` comes along free: `getHouseholdDetail` / the bulk read already select it on
        // the same statement they select the start date on, so the route's constant prepare count
        // is untouched. It is what lets `proposeAttribution` and `nearestCandidateDistance`
        // measure to the whole stay — a payment made mid-house-sit is 0 days from it, not 20.
        const unpaidBookings = candidates.map((b) => ({
          bookingId: b.bookingId,
          startDate: b.startDate,
          endDate: b.endDate,
          outstanding: outstandingById.get(b.bookingId)!,
        }));

        // CLOSEST PAIR FIRST, NOT OLDEST CREDIT FIRST — the ordering fix. Each round proposes the
        // credit whose nearest still-available stay is nearest, rather than the credit that
        // happened to be paid earliest.
        //
        // Oldest-first was a per-credit optimum with a queue: the first credit took its own
        // nearest stay and consumed it, and nothing ever compared one credit's "0 days" against
        // another's "28 days". On a client who pays on the day, that is every stay attributed to
        // the wrong payment — a June credit 28 days out claimed the mid-July walk, and the credit
        // paid ON that walk fell out as `no-recent-booking`. The comparison the sitter makes
        // instantly (this payment is the same day as that walk) is exactly the one only a
        // cross-credit ranking can make.
        //
        // O(credits²) over data ALREADY IN MEMORY. `nearestCandidateDistance` reads the same
        // `unpaidBookings` array `proposeAttribution` is about to be handed, decremented in place
        // by earlier rounds — no query, no per-credit read, so the route's constant prepare count
        // is untouched. A household holds ~100 credits at the top end; the loop is arithmetic.
        //
        // `null` (nothing left this credit could claim) never wins a round, so those credits fall
        // out at the end in pool order — oldest paid first — and get their refusal from
        // `proposeAttribution` exactly as before. Strict `<` keeps the pool's own order as the
        // tie-break, which is what makes equal distances resolve oldest-paid-first, stably.
        let pickedIndex = 0;
        let bestDistance: number | null = null;
        for (let i = 0; i < remainingCredits.length; i++) {
          const distance = nearestCandidateDistance(remainingCredits[i].PaidDate, unpaidBookings);
          if (distance === null) continue;
          if (bestDistance === null || distance < bestDistance) {
            bestDistance = distance;
            pickedIndex = i;
          }
        }
        const row = remainingCredits.splice(pickedIndex, 1)[0];

        // A STAY SOME OTHER CREDIT IS SITTING CLOSER TO IS NOT OFFERED TO THIS ONE — the half of
        // closest-pair the ranking above cannot reach, and an in-memory filter over the arrays this
        // loop already holds (no query, so the route's constant prepare count is untouched).
        //
        // The ranking decides which credit gets the FIRST stay. `proposeAttribution` is pure and
        // per-credit by design, so once a credit wins a round it spills greedily onto every further
        // stay inside `MAX_SPILL_DAYS` it can settle in full — and nothing inside it can ask whether
        // a credit not yet proposed matches those stays more closely, because by construction it
        // never sees them. Live shape: a boarding ending 07-20 and a walk on 07-29, with $280 paid
        // 07-20 and $50 paid 07-29. The $280 ranked first at distance 0, took the boarding, then
        // spilled nine days forward onto the walk — and the $50 paid ON that walk came back
        // `no-unpaid-bookings`.
        //
        // STRICTLY closer, never equal: on a tie the credit being proposed keeps the stay, so the
        // ranking (and its oldest-paid-first tie-break) still decides and nothing here becomes
        // order-dependent.
        //
        // APPLIED TO EVERY CANDIDATE, NOT ONLY SPILL TARGETS, deliberately — a uniform rule is
        // easier to reason about and cannot change the primary match anyway: this credit won its
        // round because its own nearest eligible stay is nearest of all, so no remaining credit can
        // be strictly closer to that stay than it is. It is therefore never excluded, and a credit
        // with anything to claim is never filtered down to nothing.
        //
        // NOT A RESERVATION AND NOT A BACKTRACK. A withheld stay is simply absent from THIS call;
        // the closer credit meets it in a later round of the same loop, and if that credit turns out
        // not to fund it the stay stays unpaid and is offered to whoever comes next — the sitter
        // still sees it in `unresolved[].bookings` either way, which is why the list below is built
        // from the unfiltered `unpaidBookings`.
        //
        // `candidateDistance` is `null` for a stay this credit could not be placed on at all
        // (unreadable dates, outside the directional windows). Those are KEPT: dropping them would
        // silently swallow the very refusals — `invalid-date`, `no-recent-booking` — that
        // `proposeAttribution` alone is allowed to make.
        const offered = unpaidBookings.filter((b) => {
          const mine = candidateDistance(b, row.PaidDate);
          if (mine === null) return true;
          return !remainingCredits.some((other) => {
            const theirs = candidateDistance(b, other.PaidDate);
            return theirs !== null && theirs < mine;
          });
        });

        const proposal = proposeAttribution(
          { paymentId: row.Id, amount: row.Amount, paidDate: row.PaidDate },
          offered,
        );
        if (proposal.ok) {
          proposals.push({
            accountId,
            paymentId: proposal.paymentId,
            amount: row.Amount,
            paidDate: row.PaidDate,
            splits: proposal.splits.map((s) => ({
              amount: s.amount,
              ...staticById.get(s.bookingId)!,
              outstanding: liveOutstandingById.get(s.bookingId)!,
            })),
            remainder: proposal.remainder,
          });
          // Carry the decrement forward for the next credit in this household.
          for (const s of proposal.splits)
            outstandingById.set(s.bookingId, outstandingById.get(s.bookingId)! - s.amount);
        } else {
          // `bookings` MEANS ONE THING, ON EVERY REASON THAT CARRIES IT: the candidates this
          // credit could still be placed on, each with its LIVE outstanding — i.e. exactly what
          // a sitter may choose from. Three reasons can have any: `ambiguous` (a tie the proposer
          // refused to break), `no-unpaid-bookings` (the sequencing below claimed everything for
          // an earlier credit of the same household), and `no-recent-booking` (no stay falls
          // inside the payment's proximity windows — `MAX_LATE_PAYMENT_DAYS` behind it,
          // `MAX_PREPAYMENT_DAYS` ahead — so proximity has nothing to say). The last
          // one is placeable for precisely the reason it exists: the floor takes away the
          // automatic GUESS, never the sitter's ability to attribute — she may well know which
          // stay an old payment settled, and refusing to name candidates would turn a refusal to
          // guess into a refusal to record. The remaining reasons —
          // `invalid-date`, `invalid-amount`, `duplicate-booking-id` — are faults in the credit's
          // or the household's own data: the household may well still have unpaid stays, but
          // this credit cannot be placed on any of them until the underlying record is fixed, so
          // naming candidates beside it would offer a choice that has nowhere to go. They carry
          // an empty list, which is what `AttributionUnresolved`'s type comment
          // (app/shared-ui/api.ts) states and what the panel's actionable/inert split reads.
          const placeable =
            proposal.reason === 'ambiguous' ||
            proposal.reason === 'no-unpaid-bookings' ||
            proposal.reason === 'no-recent-booking';
          // Membership is decided by the LIVE figure, not the sequenced one, for the same
          // reason the reported figure is: a booking an earlier credit in this preview drove
          // to zero is still a booking the sitter may legitimately choose here, once they
          // untick that earlier credit. Filtering on the sequenced value removed the option
          // altogether — the same false-block as the cap, one level up.
          const bookings = placeable
            ? unpaidBookings
                .filter((b) => liveOutstandingById.get(b.bookingId)! > 0)
                .map((b) => ({
                  ...staticById.get(b.bookingId)!,
                  outstanding: liveOutstandingById.get(b.bookingId)!,
                }))
            : [];
          unresolved.push({
            accountId,
            paymentId: proposal.paymentId,
            amount: row.Amount,
            paidDate: row.PaidDate,
            reason: proposal.reason,
            // THE PURE PROPOSER'S SENTENCE IS REPLACED, NOT DECORATED, FOR THE ONE CASE IT CANNOT
            // SEE. `proposeAttribution` is handed the SEQUENCED outstanding, so when an earlier
            // credit of this household has already claimed every stay it truthfully reports "no
            // unpaid bookings to attribute this against" — a sentence a non-empty `bookings`
            // flatly contradicts, and one that reads as "this household is settled" when in fact
            // the sitter is being invited to pick. The sequencing is a fact only this loop holds,
            // so only this loop can say it. Every other reason keeps the proposer's own wording
            // verbatim.
            detail:
              proposal.reason === 'no-unpaid-bookings' && bookings.length > 0
                ? `Earlier credits from this household were proposed for every unpaid stay first, so nothing is left for payment ${proposal.paymentId} in this batch. If this is the credit that actually paid one of them, choose the booking yourself — and untick the earlier proposal, or it will be refused as an overpayment.`
                : proposal.detail,
            bookings,
          });
        }
      }
    }

    return c.json({ proposals, unresolved });
  })

  /**
   * APPLY THE ATTRIBUTIONS A SITTER APPROVED (Task 4 of payment attribution) — the only route in
   * this feature that moves money. The browser supplies only WHICH payment goes on which bookings
   * and in what amounts; everything else is re-derived from live state, because the browser's copy
   * is a snapshot from whenever the preview ran and money moves in between.
   *
   * `applyAttribution` (server/db/repo.ts) does the re-derivation: it re-reads the source payment
   * (its `Amount` is the only authority, never the caller's), re-checks conservation
   * (`sum(splits) + remainder === Amount` exactly, whole dollars), re-reads EVERY TARGET BOOKING'S
   * OWN LIVE OUTSTANDING (`getHouseholdDetail`'s `expected - paidTotal`) and refuses any split that
   * would exceed it, resolves the household by pet-id MEMBERSHIP rather than `AccountId` equality
   * (an account id is the household's lexicographically-first pet and moves when a pet is added —
   * see its own doc comment), and writes the whole thing as one `db.batch` so a partially-applied
   * attribution can never happen. This route does not re-implement any of that; it is a thin
   * per-item loop around it.
   *
   * THE LOOP BELOW IS SEQUENTIAL — `await`ed one attribution at a time, deliberately not
   * `Promise.all`'d — which is what makes the per-booking outstanding re-check above effective
   * ACROSS a batch, not just within one attribution: two attributions in the same request that both
   * land on the same booking (a hand-crafted body, or a stale preview reused after the sitter
   * settled that booking some other way) commit one after the other, so the second one's re-read
   * sees the first one's write already applied and refuses the overpay, rather than both reading a
   * stale pre-batch snapshot and both succeeding.
   *
   * EACH ATTRIBUTION IS ITS OWN try/catch, so one failure — a booking since paid, a payment since
   * attributed by an earlier request in this same array, a genuine fault — cannot abort the rest of
   * a batch the sitter approved together. A payment `applyAttribution` can no longer find as a
   * household-level payment of the given account (because an earlier call already attributed or
   * deleted it) comes back as an ordinary refusal, not a throw — which is what makes a double-submit
   * of the exact same body apply once: the second call's `applyAttribution` re-reads the row, finds
   * it gone, and skips with a reason instead of duplicating the money.
   *
   * AN ATTRIBUTION MAY CARRY A `tip` — `{ bookingId, amount }`, naming one of its own splits'
   * bookings. That is the one part of a payment that is not settlement: `applyAttribution` records
   * it as a `BookingCharges` row on the stay instead of leaving it as an account-level credit that
   * would tell the sitter she owes her client money she was thanked with. THE SPLIT IS SENT
   * EXCLUSIVE OF IT and the server adds it, so conservation is `sum(splits) + tip + remainder ===
   * the payment` — see `applyAttribution`'s own doc comment for why that framing rather than an
   * inclusive split. Only the SHAPE is checked below; every rule about the figure and the booking
   * is re-decided server-side against live state.
   *
   * BODY SHAPE IS VALIDATED IN FULL BEFORE ANYTHING IS APPLIED — a structurally malformed
   * attribution (wrong types, missing fields) is a 400 for the WHOLE request with nothing written,
   * the same posture the CSV-import route above takes toward a malformed `choices` list. That is a
   * different failure than a well-formed attribution `applyAttribution` refuses on the merits (bad
   * conservation, foreign booking, vanished payment, wrong tenant) — those are reported per-item in
   * `skipped`, never as a 400, so one bad row in an otherwise-good batch doesn't block the rest.
   */
  .post('/:slug/admin/payments/attribute/apply', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ attributions?: unknown }>()
      .catch(() => ({}) as { attributions?: unknown });
    if (!Array.isArray(body.attributions) || body.attributions.length === 0)
      return c.json({ error: 'Choose at least one attribution to apply.' }, 400);
    // THE SERVER CAPS THE ARRAY TOO — a client is not trusted to chunk. `AttributionPanel.tsx`
    // sends approved credits in chunks of exactly this size and continues by itself (the sitter
    // clicks Apply once), but the ceiling this protects is the platform's, not the panel's: see
    // MAX_ATTRIBUTIONS_PER_REQUEST's own doc comment for the subrequest arithmetic behind the
    // number. Refused WHOLE rather than truncated to what fits — a partial apply nobody asked for
    // is worse than a refusal, and the same posture the malformed-body checks below take.
    if (body.attributions.length > MAX_ATTRIBUTIONS_PER_REQUEST)
      return c.json(
        {
          error: `Apply at most ${MAX_ATTRIBUTIONS_PER_REQUEST} attributions in one request; nothing was written.`,
        },
        400,
      );

    const attributions: {
      paymentId: string;
      accountId: string;
      splits: { bookingId: string; amount: number }[];
      remainder: number;
      tip?: { bookingId: string; amount: number };
    }[] = [];
    for (const raw of body.attributions) {
      // `typeof null === 'object'`, so a `null` element must be turned away before the property
      // reads below ever run on it — otherwise a malformed `[null]` body 500s instead of 400ing.
      if (typeof raw !== 'object' || raw === null)
        return c.json({ error: 'That list of attributions is malformed.' }, 400);
      const a = raw as {
        paymentId?: unknown;
        accountId?: unknown;
        splits?: unknown;
        remainder?: unknown;
        tip?: unknown;
      };
      if (
        typeof a.paymentId !== 'string' ||
        a.paymentId === '' ||
        typeof a.accountId !== 'string' ||
        a.accountId === '' ||
        !Array.isArray(a.splits) ||
        typeof a.remainder !== 'number'
      )
        return c.json({ error: 'That list of attributions is malformed.' }, 400);

      const splits: { bookingId: string; amount: number }[] = [];
      for (const rawSplit of a.splits) {
        if (typeof rawSplit !== 'object' || rawSplit === null)
          return c.json({ error: 'That list of attributions is malformed.' }, 400);
        const s = rawSplit as { bookingId?: unknown; amount?: unknown };
        if (typeof s.bookingId !== 'string' || s.bookingId === '' || typeof s.amount !== 'number')
          return c.json({ error: 'That list of attributions is malformed.' }, 400);
        splits.push({ bookingId: s.bookingId, amount: s.amount });
      }

      // THE OPTIONAL TIP — part of this payment the client meant as thanks, which
      // `applyAttribution` records as a `BookingCharges` row on one of the bookings above rather
      // than as an account-level credit that would read as a debt. SHAPE ONLY is checked here: that
      // the amount is a whole positive dollar figure, that the booking is one of this attribution's
      // own splits, and that it belongs to this payment's household are all decided by
      // `applyAttribution` against LIVE state, and are refusals on the merits (per-item `skipped`)
      // rather than malformed bodies. Absent is the ordinary case and stays `undefined`, so the
      // repo function's own `tip === undefined` branch is what every existing caller keeps hitting.
      let tip: { bookingId: string; amount: number } | undefined;
      if (a.tip !== undefined) {
        // `typeof null === 'object'`, so a null tip must be turned away before the property reads.
        if (typeof a.tip !== 'object' || a.tip === null)
          return c.json({ error: 'That list of attributions is malformed.' }, 400);
        const t = a.tip as { bookingId?: unknown; amount?: unknown };
        if (typeof t.bookingId !== 'string' || t.bookingId === '' || typeof t.amount !== 'number')
          return c.json({ error: 'That list of attributions is malformed.' }, 400);
        tip = { bookingId: t.bookingId, amount: t.amount };
      }

      attributions.push({
        paymentId: a.paymentId,
        accountId: a.accountId,
        splits,
        remainder: a.remainder,
        tip,
      });
    }

    let applied = 0;
    const skipped: { paymentId: string; reason: string }[] = [];
    for (const attribution of attributions) {
      try {
        const result = await applyAttribution(c.env.PAWSERVATION_DB, tenant.Id, attribution);
        if (result.ok) applied++;
        else skipped.push({ paymentId: attribution.paymentId, reason: result.reason });
      } catch (err) {
        // Genuine fault (not a refusal `applyAttribution` already turned into `{ ok: false }`) —
        // skipped rather than allowed to abort the rest of a batch the sitter approved together,
        // but logged so it's distinguishable from an ordinary refusal in the logs rather than
        // collapsing into the same generic skip a sitter sees.
        console.error('payment attribution apply failed', attribution.paymentId, err);
        skipped.push({
          paymentId: attribution.paymentId,
          reason: `Payment ${attribution.paymentId} could not be applied due to an unexpected error; nothing was written for it.`,
        });
      }
    }

    return c.json({ applied, skipped });
  })

  /**
   * Preview which calendar events would be adopted as bookings. Writes nothing — every event is
   * read from Google and classified fresh (`classifyAll`), same as the Venmo preview above.
   */
  .post('/:slug/admin/calendar/backfill/preview', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ from?: unknown; to?: unknown }>()
      .catch(() => ({}) as { from?: unknown; to?: unknown });
    const from = typeof body.from === 'string' ? body.from : '';
    const to = typeof body.to === 'string' ? body.to : '';
    if (!isRealDate(from) || !isRealDate(to) || to <= from)
      return c.json({ error: 'Choose a start date and a later end date.' }, 400);

    const conn = await getProviderConnection(c.env.PAWSERVATION_DB, tenant.Id, 'calendar');
    if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken)
      return c.json({ error: 'Connect your Google Calendar first.' }, 400);
    const accessToken = await getCalendarAccessToken(c.env, tenant, conn);

    const events = (
      await listCalendarEvents(
        accessToken,
        conn.CalendarId ?? 'primary',
        `${from}T00:00:00Z`,
        `${to}T00:00:00Z`,
      )
    ).filter((e) => e.status !== 'cancelled');

    // Classify at most MAX_BACKFILL_EVENTS per pass, oldest first, rather than refusing a range
    // that holds more than that — the platform's subrequest/CPU budget is real (same reasoning as
    // MAX_BACKFILL_EVENTS's own doc comment), but staying inside it is this route's job, not
    // something to push back onto the sitter as "pick a shorter range". Sorted defensively —
    // Google's own `orderBy: startTime` already returns events in this order, but nothing here
    // should depend on that holding forever.
    const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
    const capped = sorted.length > MAX_BACKFILL_EVENTS;
    const slice = capped ? sorted.slice(0, MAX_BACKFILL_EVENTS) : sorted;
    // Resume from the LAST CLASSIFIED EVENT'S OWN START DATE — never "the day after it". Two
    // events can share a start date, and a sibling of the cut-off event can sort AFTER it within
    // that same day; resuming from the day after would silently skip that sibling, and skipping
    // is unrecoverable (the caller has no way to notice a gap it was never told about).
    // Resuming from the same date instead means the next pass may RECLASSIFY a few events from
    // that date — harmless, since this route writes nothing and the import route's own adoption
    // is idempotent on GCalEventId — but it can never skip one. The one failure mode this leaves
    // is more than MAX_BACKFILL_EVENTS events sharing a single start date, which would make
    // nextFrom stop advancing; the caller is expected to give up after a bounded number of passes
    // rather than loop forever chasing it.
    const nextFrom = capped ? slice[slice.length - 1].start : null;
    const remaining = sorted.length - slice.length;

    const { classified, pets } = await classifyAll(c, tenant, slice);
    // Display-only: the classifier's Classified type stays pure (petIds only). Names are resolved
    // here, against the same pet list classifyAll already fetched, so the panel can offer a pet
    // filter without guessing from the event title. Ordered as `petIds` is ordered so the two
    // stay aligned.
    const nameById = new Map(pets.map((p) => [p.id, p.name] as const));
    const withPetNames = <T extends { petIds: string[] }>(r: T): T & { petNames: string[] } => ({
      ...r,
      // Every petId here was resolved by classifyAll's own classifyEvent against this SAME `pets`
      // array (resolvePetsByName only ever returns ids it found in it), so a miss is a real bug,
      // not a data gap — throw rather than emit '', which the panel's filter reads as "All pets".
      petNames: r.petIds.map((id) => {
        const name = nameById.get(id);
        if (name === undefined) throw new Error(`Backfill preview: unresolved pet id ${id}`);
        return name;
      }),
    });
    return c.json({
      adopt: classified
        .filter((r): r is Extract<Classified, { kind: 'adopt' }> => r.kind === 'adopt')
        .map(withPetNames),
      needsPrice: classified
        .filter((r): r is Extract<Classified, { kind: 'needs-price' }> => r.kind === 'needs-price')
        .map(withPetNames),
      flags: classified.filter((r) => r.kind === 'flag'),
      // An array, not a count — unlike a count, a skip row carries its own eventId, so a caller
      // resuming across passes can de-duplicate the boundary date's events by id exactly like
      // adopt/needsPrice/flags, instead of a naive per-pass sum double-counting whatever landed
      // on the shared resume date.
      skipped: classified.filter(
        (r): r is Extract<Classified, { kind: 'skip' }> => r.kind === 'skip',
      ),
      nextFrom,
      remaining,
    });
  })

  /**
   * Adopt chosen calendar events as bookings. The security shape is copied from the Venmo
   * importer, with one deliberate exception: every date, pet, household and service is
   * RE-DERIVED server-side by `classifyAll` — the browser names event ids and, optionally,
   * prices, and nothing else. An event the fresh classification no longer adopts is skipped
   * with a reason, never adopted on the browser's say-so.
   *
   * The amount is the exception, because pricing a historical stay is the sitter's own decision,
   * not a claim about their calendar (see the module doc on `insertBackfilledBooking` and the
   * design doc). `estCost`, when supplied, must be a whole-dollar integer >= 1 or the WHOLE
   * request is refused with 400 — never a silent coercion, and never a partial import.
   */
  .post('/:slug/admin/calendar/backfill/import', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ from?: unknown; to?: unknown; events?: unknown }>()
      .catch(() => ({}) as { from?: unknown; to?: unknown; events?: unknown });
    const from = typeof body.from === 'string' ? body.from : '';
    const to = typeof body.to === 'string' ? body.to : '';
    if (!isRealDate(from) || !isRealDate(to) || to <= from)
      return c.json({ error: 'Choose a start date and a later end date.' }, 400);
    if (!Array.isArray(body.events) || body.events.length === 0)
      return c.json({ error: 'Choose at least one event to import.' }, 400);
    if (body.events.length > MAX_BACKFILL_EVENTS)
      return c.json({ error: `Import ${MAX_BACKFILL_EVENTS} events or fewer at a time.` }, 400);

    // eventId -> the sitter's own price for it, when given. Whole dollars only, like every other
    // amount in this codebase; a bad one fails the WHOLE request rather than being coerced or
    // silently dropping just its own row.
    const wanted = new Map<string, number | null>();
    for (const raw of body.events) {
      if (typeof raw !== 'object' || raw === null)
        return c.json({ error: 'That list of events is malformed.' }, 400);
      const entry = raw as { eventId?: unknown; estCost?: unknown };
      if (typeof entry.eventId !== 'string' || entry.eventId === '')
        return c.json({ error: 'That list of events is malformed.' }, 400);
      if (entry.estCost !== undefined) {
        if (
          !Number.isInteger(entry.estCost) ||
          (entry.estCost as number) < 1 ||
          (entry.estCost as number) > MAX_BACKFILL_EST_COST
        )
          return c.json(
            { error: `Enter a whole-dollar amount between $1 and $${MAX_BACKFILL_EST_COST}.` },
            400,
          );
      }
      wanted.set(entry.eventId, entry.estCost === undefined ? null : (entry.estCost as number));
    }

    const conn = await getProviderConnection(c.env.PAWSERVATION_DB, tenant.Id, 'calendar');
    if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken)
      return c.json({ error: 'Connect your Google Calendar first.' }, 400);
    const accessToken = await getCalendarAccessToken(c.env, tenant, conn);

    const events = (
      await listCalendarEvents(
        accessToken,
        conn.CalendarId ?? 'primary',
        `${from}T00:00:00Z`,
        `${to}T00:00:00Z`,
      )
    ).filter((e) => e.status !== 'cancelled');

    // RE-DERIVED from scratch — same classifier the preview used, so the two can never disagree.
    // The browser named event ids and, optionally, prices; nothing else survives this call.
    const { classified } = await classifyAll(c, tenant, events);
    // Every classified row, by id — used only to tell an already-imported id apart from every
    // other reason it might not be adoptable, below.
    const classifiedById = new Map(classified.map((r) => [r.eventId, r] as const));
    // Both kinds are adoptable: 'adopt' carries a rate-card price, 'needs-price' carries
    // everything BUT the price and is adoptable only when the sitter supplies one.
    const resolvable = new Map(
      classified
        .filter(
          (r): r is Extract<Classified, { kind: 'adopt' | 'needs-price' }> =>
            r.kind === 'adopt' || r.kind === 'needs-price',
        )
        .map((r) => [r.eventId, r] as const),
    );

    const skipped: { eventId: string; reason: string }[] = [];
    let imported = 0;
    for (const [eventId, suppliedCost] of wanted) {
      const row = resolvable.get(eventId);
      if (!row) {
        // 'already-adopted' gets its own message — a sitter re-running an import over an
        // overlapping range must read that as "already imported", not as data loss. Every other
        // reason a fresh classification might refuse the id (absent from the calendar entirely,
        // or classified as a flag) keeps the generic message.
        const already = classifiedById.get(eventId);
        const reason =
          already?.kind === 'skip' && already.why === 'already-adopted'
            ? 'Already imported'
            : 'That event is no longer adoptable';
        skipped.push({ eventId, reason });
        continue;
      }
      // The sitter's figure wins when given; otherwise the rate card's, which only an 'adopt' row
      // has. A 'needs-price' row with no supplied amount is never adopted at zero and never at a
      // number this server invented.
      const estCost = suppliedCost ?? (row.kind === 'adopt' ? row.estCost : null);
      if (estCost === null) {
        skipped.push({ eventId, reason: 'That event still needs a price' });
        continue;
      }
      // Each row's write is isolated: one event's failure must never take down the response for
      // every other event in the same request, turn a partial success into a bare 500, or — worse
      // — go unreported and then be silently un-retryable because GCalEventId now looks adopted.
      let bookingId: string | null = null; // hoisted above the try so the catch can clean it up
      try {
        bookingId = await insertBackfilledBooking(c.env.PAWSERVATION_DB, tenant.Id, {
          endUserId: row.endUserId,
          serviceType: row.serviceType,
          startDate: row.startDate,
          endDate: row.endDate,
          optionKey: row.optionKey,
          petCount: row.petIds.length,
          estCost,
          status: row.cancelled ? 'cancelled' : 'confirmed',
          gcalEventId: row.eventId,
        });
        await addBookingPets(c.env.PAWSERVATION_DB, tenant.Id, bookingId, row.petIds);
        imported++;
      } catch (err) {
        console.error('calendar backfill import failed for event', eventId, err);
        // Remove the orphan, or the GCalEventId stamp makes this event permanently
        // un-retryable: every later run would report "Already imported" for a booking that has
        // no pets. Same pattern as booking-ops.ts's own optimistic-row cleanup — best-effort,
        // and never lets a failed cleanup mask the real failure being reported below.
        if (bookingId) {
          await deleteBookingRequest(c.env.PAWSERVATION_DB, tenant.Id, bookingId).catch(() => {});
        }
        skipped.push({ eventId, reason: 'Could not import that event' });
      }
    }
    return c.json({ imported, skipped });
  })

  /**
   * Correct the price on a booking ADOPTED from the calendar. Restricted to
   * `Source = 'calendar-backfill'` rows by `updateBackfilledBookingCost`'s own SQL, not by this
   * route — their cost was invented from today's rate card for a stay that may predate it, and no
   * client ever saw or agreed to that figure. A booking that came through pawservation carries a
   * figure a client DID see; it is out of reach here by construction, and refuses with the same
   * 404 as the 'blocked'/'external' sentinels and a foreign tenant's id, so the response never
   * tells the caller which of those four reasons applied.
   *
   * The route itself never decides EstCost vs. CancellationFee — `updateBackfilledBookingCost`
   * writes into whichever column the row's own Status says the balance reads, so a cancelled
   * adoption's correction lands where `BASE_AMOUNT_SQL` actually looks for it.
   */
  .patch('/:slug/admin/bookings/:id/cost', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ estCost?: unknown }>()
      .catch(() => ({}) as { estCost?: unknown });
    const estCost = body.estCost;
    // Whole dollars only — cents are unrepresentable codebase-wide. Same ceiling as the sitter's
    // price on the same field at import time (Task 7); two bounds on one field would drift.
    if (
      typeof estCost !== 'number' ||
      !Number.isInteger(estCost) ||
      estCost < 1 ||
      estCost > MAX_BACKFILL_EST_COST
    )
      return c.json(
        { error: `Enter a whole-dollar amount between $1 and $${MAX_BACKFILL_EST_COST}.` },
        400,
      );

    const ok = await updateBackfilledBookingCost(
      c.env.PAWSERVATION_DB,
      tenant.Id,
      c.req.param('id'),
      estCost,
    );
    // One 404 for: another tenant's booking, an unknown id, a sentinel, and a booking a client
    // agreed to. Same non-oracle posture as the other booking routes.
    if (!ok) return c.json({ error: 'Not found.' }, 404);
    return c.json({ estCost });
  });
