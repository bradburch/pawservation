import type {
  AllowedSitterRow,
  AnalyticsData,
  BookingChargeRow,
  BookingRow,
  CancellationTier,
  EndUser,
  EndUserPet,
  ExtraTimeOrigin,
  HouseholdBalanceRow,
  HouseholdDetailRow,
  OwnerUser,
  PaymentRow,
  PetGroupPricingRow,
  PetType,
  ProviderConnection,
  ProviderConnectionWithTokens,
  Tenant,
  TenantPetTypeRow,
  TenantService,
  TenantServiceOption,
  TenantServicePetRateRow,
  TenantUser,
} from '../types';
import { EXTRA_TIME_ORIGINS } from '../types';
import type { CapacityKind, RateUnit, ServiceShape, ServiceType } from '../lib/services';
import type { PaymentMethod, PetRateMode } from '../lib/validation';
import type { Account, ServiceQuestion } from '../../src/shared/index.js';
import {
  buildAccounts,
  buildHouseholdBalances,
  buildPaymentAnchors,
  parseMixKey,
  quarterlyBreakdown,
} from '../../src/shared/index.js';
import { isUniqueViolation } from '../lib/db-errors';
import { deriveAttributedRef } from '../lib/payment-attribution';
import { constantTimeEqual } from '../lib/timing';
import { DEMO_EMAIL } from '../lib/demo';

/**
 * The ONLY module allowed to touch PAWSERVATION_DB. Every function below either resolves a
 * tenant (getTenantBySlug) / a login (getTenantUserByEmail) or takes `tenantId` as its FIRST
 * parameter and scopes its SQL with `WHERE TenantId = ?`. Importing the D1 binding elsewhere
 * is a defect.
 */

const TENANT_COLS =
  'Id, Slug, DisplayName, AccentColor, Timezone, ContactEmail, ContactPhone, MaxAdvanceMonths, HousesitBoardingOverlapDays, DisabledAt, PremiumUntil';

const BOOKING_COLS =
  'Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, StartTime, DepartureTime, OptionKey, PetCount, EstCost, CancellationFee, GCalEventId, Status, CreatedAt';

/** BOOKING_COLS, table-qualified — needed once a query joins BookingRequests against another
 * table (EndUsers) that shares column names like Id/TenantId, which would otherwise be ambiguous. */
const BOOKING_COLS_QUALIFIED = BOOKING_COLS.split(', ')
  .map((col) => `BookingRequests.${col}`)
  .join(', ');

export async function getTenantBySlug(db: D1Database, slug: string): Promise<Tenant | null> {
  return await db
    .prepare(`SELECT ${TENANT_COLS} FROM Tenants WHERE Slug = ?`)
    .bind(slug)
    .first<Tenant>();
}

export async function getTenantById(db: D1Database, tenantId: string): Promise<Tenant | null> {
  return await db
    .prepare(`SELECT ${TENANT_COLS} FROM Tenants WHERE Id = ?`)
    .bind(tenantId)
    .first<Tenant>();
}

/** Login lookup by globally-unique email — resolves WHICH tenant the sitter manages. */
export async function getTenantUserByEmail(
  db: D1Database,
  email: string,
): Promise<TenantUser | null> {
  return await db
    .prepare('SELECT Id, TenantId, Email, PasswordHash FROM TenantUsers WHERE Email = ?')
    .bind(email)
    .first<TenantUser>();
}

/** The authenticated admin's own login email, tenant-scoped like every read here — used by the
 * settings GET so the setup wizard can prefill a missing contact email. */
export async function getTenantUserEmailById(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT Email FROM TenantUsers WHERE TenantId = ? AND Id = ?')
    .bind(tenantId, userId)
    .first<{ Email: string }>();
  return row?.Email ?? null;
}

/**
 * Where to send this tenant operational mail (today: a customer cancelled something).
 *
 * `Tenants.ContactEmail` is the address the sitter chose to publish for business contact, so it
 * wins — but it is OPTIONAL and genuinely often unset, and a notification feature that silently
 * does nothing for every account that skipped an optional field is worse than no feature. So it
 * falls back to her dashboard login (`TenantUsers.Email`, NOT NULL and created at signup), which
 * is the address Pawservation already uses to reach her for password resets. Empty/whitespace
 * ContactEmail is treated as unset rather than as an address.
 *
 * Returns null only when a tenant has neither — reachable only for a half-built tenant row with
 * no user yet. Callers must treat that as "skip the send", never as an error: the operation being
 * reported on has already committed.
 *
 * ORDER BY pins which login is chosen if a tenant ever has several, so the recipient is stable
 * rather than whatever SQLite returns first.
 */
export async function getSitterNotificationEmail(
  db: D1Database,
  tenantId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT COALESCE(
         (SELECT NULLIF(TRIM(ContactEmail), '') FROM Tenants WHERE Id = ?),
         (SELECT Email FROM TenantUsers WHERE TenantId = ? ORDER BY CreatedAt, Id LIMIT 1)
       ) AS Email`,
    )
    .bind(tenantId, tenantId)
    .first<{ Email: string | null }>();
  return row?.Email ?? null;
}

/** Returns whether a row actually changed — false means the email has no sitter login. */
export async function updateTenantUserPasswordHash(
  db: D1Database,
  email: string,
  passwordHash: string,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE TenantUsers SET PasswordHash = ? WHERE Email = ?')
    .bind(passwordHash, email)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listServices(db: D1Database, tenantId: string): Promise<TenantService[]> {
  const { results } = await db
    .prepare(
      `SELECT TenantId, ServiceType, Enabled, Label, Icon, Description, Shape, RateUnit, HasDuration,
              CapacityKind, SortOrder, Questions, MaxNights, MaxPetCount, MinLeadDays,
              AcceptedPetTypes, MaxConcurrentPets, CancellationTiers, HolidayRate, PetRateMode,
              StandardArrivalTime, StandardDepartureTime, EarlyArrivalFee, LateDepartureFee
       FROM TenantServices WHERE TenantId = ? ORDER BY SortOrder, Label`,
    )
    .bind(tenantId)
    .all<
      Omit<TenantService, 'Questions' | 'AcceptedPetTypes' | 'CancellationTiers'> & {
        Questions: string;
        AcceptedPetTypes: string | null;
        CancellationTiers: string | null;
      }
    >();
  return results.map((r) => ({
    ...r,
    Questions: JSON.parse(r.Questions) as ServiceQuestion[],
    AcceptedPetTypes:
      r.AcceptedPetTypes === null ? null : (JSON.parse(r.AcceptedPetTypes) as string[]),
    CancellationTiers:
      r.CancellationTiers === null ? null : (JSON.parse(r.CancellationTiers) as CancellationTier[]),
  }));
}

/** Create a service from template-derived behavior. Callers validate slug/template beforehand. */
export async function createService(
  db: D1Database,
  tenantId: string,
  svc: {
    serviceType: string;
    label: string;
    icon: string;
    shape: ServiceShape;
    rateUnit: RateUnit;
    hasDuration: boolean;
    capacityKind: CapacityKind;
    sortOrder: number;
    /** Species this service accepts, already intersected with the tenant's registry by the
     *  caller. null = accepts every registry type (the null-is-unlimited convention). */
    acceptedPetTypes: string[] | null;
    /** Named explicitly rather than left to the column default, so "which mode does a brand-new
     *  service start in" is one visible decision at the call site instead of an implicit one
     *  buried in DDL. Existing rows are never touched by this. */
    petRateMode: PetRateMode;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO TenantServices
         (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind,
          SortOrder, AcceptedPetTypes, PetRateMode)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      tenantId,
      svc.serviceType,
      svc.label,
      svc.icon,
      svc.shape,
      svc.rateUnit,
      svc.hasDuration ? 1 : 0,
      svc.capacityKind,
      svc.sortOrder,
      svc.acceptedPetTypes === null ? null : JSON.stringify(svc.acceptedPetTypes),
      svc.petRateMode,
    )
    .run();
}

/** Delete a service and its options in one atomic batch. Callers enforce the no-bookings guard. */
export async function deleteService(
  db: D1Database,
  tenantId: string,
  serviceType: string,
): Promise<void> {
  await db.batch([
    // Rate rows key on (ServiceType, OptionKey) STRINGS, not FK ids, and a re-created service
    // re-derives the same slug — leaving rows behind would resurrect old prices on a future
    // service the sitter never priced. Scrub both rate tables with the service.
    db
      .prepare('DELETE FROM PetGroupPricing WHERE TenantId = ? AND ServiceType = ?')
      .bind(tenantId, serviceType),
    db
      .prepare('DELETE FROM TenantServicePetRates WHERE TenantId = ? AND ServiceType = ?')
      .bind(tenantId, serviceType),
    // Same argument for saved intake answers: they key on the ServiceType STRING too, so a
    // re-created service would otherwise pre-fill its form with answers to questions it never
    // asked. (The shape guard would drop most of them on read; scrubbing is the real fix.)
    db
      .prepare('DELETE FROM SavedAnswers WHERE TenantId = ? AND ServiceType = ?')
      .bind(tenantId, serviceType),
    db
      .prepare('DELETE FROM TenantServiceOptions WHERE TenantId = ? AND ServiceType = ?')
      .bind(tenantId, serviceType),
    db
      .prepare('DELETE FROM TenantServices WHERE TenantId = ? AND ServiceType = ?')
      .bind(tenantId, serviceType),
  ]);
}

/** Bookings of ANY status referencing the slug — history included, so deletion never orphans it. */
export async function countBookingsForService(
  db: D1Database,
  tenantId: string,
  serviceType: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM BookingRequests WHERE TenantId = ? AND ServiceType = ?')
    .bind(tenantId, serviceType)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listServiceOptions(
  db: D1Database,
  tenantId: string,
): Promise<TenantServiceOption[]> {
  const { results } = await db
    .prepare(
      // RateUnit is deliberately NOT selected: the per-option copy is retired (see sql/schema.sql),
      // so leaving it off the read makes "nothing reads it" a compiler-enforced fact.
      `SELECT Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, StartTime, EndTime, Capacity, WeekdaysOnly
       FROM TenantServiceOptions WHERE TenantId = ? ORDER BY ServiceType, DurationMinutes`,
    )
    .bind(tenantId)
    .all<TenantServiceOption>();
  return results;
}

export async function listPetTypes(db: D1Database, tenantId: string): Promise<TenantPetTypeRow[]> {
  // ORDER BY PetType: deterministic with no ordering column — the admin wizard's index-wise
  // draft compare (profilePutBody) depends on a stable order.
  const { results } = await db
    .prepare(
      'SELECT TenantId, PetType, Label FROM TenantPetTypes WHERE TenantId = ? ORDER BY PetType',
    )
    .bind(tenantId)
    .all<TenantPetTypeRow>();
  return results;
}

/** Create a pet-type registry row. Throws on UNIQUE(TenantId, PetType) — caller maps to 409. */
export async function createPetType(
  db: D1Database,
  tenantId: string,
  petType: string,
  label: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO TenantPetTypes (TenantId, PetType, Label) VALUES (?, ?, ?)')
    .bind(tenantId, petType, label)
    .run();
}

/** Rename the display Label only — the slug is immutable (services' identity model). */
export async function renamePetType(
  db: D1Database,
  tenantId: string,
  petType: string,
  label: string,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE TenantPetTypes SET Label = ? WHERE TenantId = ? AND PetType = ?')
    .bind(label, tenantId, petType)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

export async function deletePetType(
  db: D1Database,
  tenantId: string,
  petType: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM TenantPetTypes WHERE TenantId = ? AND PetType = ?')
    .bind(tenantId, petType)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/** Customer pets + bookings referencing the slug via their linked pets (any status — history
 * included, mirroring countBookingsForService's rule, so deletion never orphans a slug the admin
 * list and CSV export would render as a bare token). A booking references a slug through
 * BookingRequestPets → EndUserPets.PetType; BookingRequests carries no denormalized copy. The
 * demo shadow customer's pet(s) are excluded from both halves — the demo identity must never
 * block a real pet-type deletion (its booking POSTs never persist a row anyway, but the pet
 * itself does, so the exclusion still matters for the direct pet count). */
export async function countPetTypeReferences(
  db: D1Database,
  tenantId: string,
  petType: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM EndUserPets
                WHERE TenantId = ? AND PetType = ?
                  AND EndUserId NOT IN (SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = ?))
            + (SELECT COUNT(DISTINCT brp.BookingRequestId)
                 FROM BookingRequestPets brp
                 JOIN EndUserPets p ON p.Id = brp.PetId
                WHERE p.TenantId = ? AND p.PetType = ?
                  AND p.EndUserId NOT IN (SELECT Id FROM EndUsers WHERE TenantId = ? AND Email = ?)) AS n`,
    )
    .bind(tenantId, petType, tenantId, DEMO_EMAIL, tenantId, petType, tenantId, DEMO_EMAIL)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Overwrite one service's acceptance list (config, not history — safe for delete-scrubbing). */
export async function setServiceAcceptedPetTypes(
  db: D1Database,
  tenantId: string,
  serviceType: string,
  accepted: string[] | null,
): Promise<void> {
  await db
    .prepare(
      'UPDATE TenantServices SET AcceptedPetTypes = ? WHERE TenantId = ? AND ServiceType = ?',
    )
    .bind(accepted === null ? null : JSON.stringify(accepted), tenantId, serviceType)
    .run();
}

/** Delete a pet type and scrub it from every service's acceptance list in one atomic batch
 * (deleteService precedent) — a mid-write failure can no longer strand the slug in a service's
 * AcceptedPetTypes after the type row is already gone. An emptied list is stored as '[]' — NEVER
 * null/"accepts all" — per migration 0015 step 6's rule: a list with nothing in it accepts
 * nothing, not everything. An enabled service whose list empties gets disabled in the same batch
 * (also step 6) since it just went unbookable; `disabledServices` reports which services that
 * happened to, so the caller can surface it instead of the sitter discovering a silently-off
 * service later. Callers enforce the no-references guard. */
export async function deletePetTypeAndScrub(
  db: D1Database,
  tenantId: string,
  petType: string,
): Promise<{ disabledServices: string[] }> {
  const services = await listServices(db, tenantId);
  const mixRows = await listServicePetRates(db, tenantId);
  const statements = [
    db
      .prepare('DELETE FROM TenantPetTypes WHERE TenantId = ? AND PetType = ?')
      .bind(tenantId, petType),
  ];
  // Mix rates name species by SLUG, and slugs re-derive: re-creating a deleted type under the
  // same name would resurrect its old mix prices. Scrub every mix that names this species —
  // exact membership via parseMixKey (null-prototype, so 'constructor' can't fool the read;
  // never substring-match a MixKey: 'cat' must not scrub 'bobcat'). Pet-id (PetGroupPricing)
  // rows key on UUIDs that never re-derive, so they are deliberately not touched here.
  for (const row of mixRows) {
    if (parseMixKey(row.MixKey)[petType] === undefined) continue;
    statements.push(
      db
        .prepare(
          'DELETE FROM TenantServicePetRates WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ? AND MixKey = ?',
        )
        .bind(tenantId, row.ServiceType, row.OptionKey, row.MixKey),
    );
  }
  const disabledServices: string[] = [];
  for (const svc of services) {
    if (!svc.AcceptedPetTypes?.includes(petType)) continue;
    const next = svc.AcceptedPetTypes.filter((t) => t !== petType);
    const emptied = next.length === 0;
    const disabling = emptied && svc.Enabled === 1;
    if (disabling) disabledServices.push(svc.ServiceType);
    statements.push(
      db
        .prepare(
          disabling
            ? 'UPDATE TenantServices SET AcceptedPetTypes = ?, Enabled = 0 WHERE TenantId = ? AND ServiceType = ?'
            : 'UPDATE TenantServices SET AcceptedPetTypes = ? WHERE TenantId = ? AND ServiceType = ?',
        )
        .bind(emptied ? '[]' : JSON.stringify(next), tenantId, svc.ServiceType),
    );
  }
  await db.batch(statements);
  return { disabledServices };
}

export async function createLoginCode(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  code: string,
  expiresAtIso: string,
  nowIso: string = new Date().toISOString(),
): Promise<string> {
  const id = crypto.randomUUID();
  // ponytail: opportunistic prune on each new code — a cron is overkill at this scale
  await db.batch([
    db
      .prepare('DELETE FROM LoginCodes WHERE TenantId = ? AND ExpiresAt < ?')
      .bind(tenantId, nowIso),
    db
      .prepare(
        'INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(id, tenantId, endUserId, code, expiresAtIso),
  ]);
  return id;
}

/** Max verify attempts before a login code is locked — caps brute-forcing a 6-digit code. */
export const MAX_CODE_ATTEMPTS = 5;

/**
 * Consume a valid, unexpired, unused code, returning the end user id or null.
 *
 * Brute-force resistant: every call atomically claims one attempt against a still-live code
 * (`Attempts < MAX`), so wrong guesses count against the cap and a code locks after MAX tries
 * even if never guessed correctly. The code itself is compared in constant time in app code
 * rather than via SQL `Code = ?` (which is not constant-time and can't enforce the cap).
 */
export async function consumeLoginCode(
  db: D1Database,
  tenantId: string,
  codeId: string,
  code: string,
  nowIso: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE LoginCodes SET Attempts = Attempts + 1
       WHERE Id = ? AND TenantId = ? AND UsedAt IS NULL AND ExpiresAt > ? AND Attempts < ?
       RETURNING Code, EndUserId`,
    )
    .bind(codeId, tenantId, nowIso, MAX_CODE_ATTEMPTS)
    .first<{ Code: string; EndUserId: string }>();
  if (!row) return null; // unknown / expired / used / too many attempts
  if (!constantTimeEqual(row.Code, code)) return null; // wrong code — the attempt is already counted
  // Correct code: consume it so it can't be replayed.
  await db
    .prepare('UPDATE LoginCodes SET UsedAt = ? WHERE Id = ? AND TenantId = ? AND UsedAt IS NULL')
    .bind(nowIso, codeId, tenantId)
    .run();
  return row.EndUserId;
}

/** A booking row joined with its service's capacity pool (null for 'blocked' sentinel rows). */
export type CapacityRow = BookingRow & { CapacityKind: Exclude<CapacityKind, 'none'> | null };

/**
 * WHICH existing rows a capacity read counts.
 *
 * - `'all-live'` — pending AND confirmed, the customer-facing rule: a pending request holds the
 *   slot, so nobody else can take it while the sitter decides.
 * - `'committed-only'` — confirmed rows (plus blocked/external rows, which are always stored
 *   `'confirmed'`), i.e. what the sitter has actually COMMITTED to. Used by the admin confirm
 *   re-check, where counting other pending requests would warn her about the very requests she is
 *   adjudicating: the first of two competing requests is the one she SHOULD confirm, and a warning
 *   there would train her to click through the one that matters (the second).
 */
export type OccupancyScope = 'all-live' | 'committed-only';

const statusFilterSql = (scope: OccupancyScope): string =>
  scope === 'committed-only' ? `Status = 'confirmed'` : `Status IN ('pending', 'confirmed')`;

/**
 * A stored EndDate that is present but is not a `YYYY-MM-DD` date. The window predicate below
 * compares dates as STRINGS, so a corrupt end date can sort BELOW the window's start (`''` is the
 * easy example) and drop the row from the read entirely — and a row the query never returns is a
 * row the capacity engine never gets to fail safe on, however carefully it treats what it is given
 * (`isWellFormedCapacityEvent`). So the window fails toward INCLUSION: anything starting before the
 * window's end whose end date is unusable comes back, and `buildCapacity` turns it into a blocked
 * day. A corrupt row from outside the window can only add a blocked day outside the window, which
 * costs nothing. GLOB (not LIKE) because it is case-sensitive and has real character classes.
 */
const CORRUPT_END_DATE_SQL = `(b.EndDate IS NOT NULL
       AND b.EndDate NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')`;

/**
 * Rows that feed the capacity map: bookings whose service draws from a capacity pool
 * (CapacityKind boarding/housesit — custom services included) + blocked ranges, overlapping
 * [from, to). `excludeId` omits one row — used by the post-insert race check so a just-created
 * booking re-asks "do I still fit, ignoring myself?" against everyone else. `scope` chooses which
 * rows count (see `OccupancyScope`); the default is the customer-facing "pending holds the slot".
 */
export async function listCapacityRows(
  db: D1Database,
  tenantId: string,
  fromDate: string,
  toDateExclusive: string,
  excludeId?: string,
  scope: OccupancyScope = 'all-live',
): Promise<CapacityRow[]> {
  const cols = BOOKING_COLS.split(', ')
    .map((c) => `b.${c}`)
    .join(', ');
  const { results } = await db
    .prepare(
      `SELECT ${cols}, s.CapacityKind
       FROM BookingRequests b
       LEFT JOIN TenantServices s ON s.TenantId = b.TenantId AND s.ServiceType = b.ServiceType
       WHERE b.TenantId = ? AND b.${statusFilterSql(scope)}
         AND (b.ServiceType IN ('blocked', 'external') OR s.CapacityKind IN ('boarding', 'housesit'))
         AND b.StartDate < ?
         AND (COALESCE(b.EndDate, b.StartDate) >= ? OR ${CORRUPT_END_DATE_SQL})
         AND (? IS NULL OR b.Id != ?)`,
    )
    .bind(tenantId, toDateExclusive, fromDate, excludeId ?? null, excludeId ?? null)
    .all<CapacityRow>();
  return results;
}

/**
 * One end user's own pending/confirmed booking date ranges overlapping [from, to) — across
 * EVERY service type (unlike listCapacityRows, which is boarding/house-sit/blocked only).
 * Feeds the month grid's "mine" flag, so a walk/daycare/check-in booking still highlights.
 */
export async function listUserBookingDatesInRange(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  fromDate: string,
  toDateExclusive: string,
): Promise<{ StartDate: string; EndDate: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT StartDate, EndDate FROM BookingRequests
       WHERE TenantId = ? AND EndUserId = ? AND Status IN ('pending', 'confirmed')
         AND StartDate < ? AND COALESCE(EndDate, StartDate) >= ?`,
    )
    .bind(tenantId, endUserId, toDateExclusive, fromDate)
    .all<{ StartDate: string; EndDate: string | null }>();
  return results;
}

/**
 * Sum the pets across non-cancelled bookings against one option on one date — enforces a windowed option's
 * Capacity. `excludeId` lets the post-insert race check ask "do I still fit, ignoring myself?",
 * matching the pattern `listCapacityRows` already uses for boarding/house-sit — as does `scope`
 * (see `OccupancyScope`), so the sitter's confirm re-check counts slot commitments the same way it
 * counts pool ones.
 */
export async function countSlotBookings(
  db: D1Database,
  tenantId: string,
  serviceType: ServiceType,
  optionKey: string,
  date: string,
  excludeId?: string,
  scope: OccupancyScope = 'all-live',
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(PetCount), 0) AS n FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ? AND StartDate = ?
         AND ${statusFilterSql(scope)} AND (? IS NULL OR Id != ?)`,
    )
    .bind(tenantId, serviceType, optionKey, date, excludeId ?? null, excludeId ?? null)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Per-date pet counts against one option over [fromDate, toDateExclusive) — ONE query for
 * a whole month grid, so `monthAvailability` never issues one DB round-trip per day (the
 * "build the map once" pattern `buildCapacity` already uses for boarding/house-sit).
 *
 * `excludeId` mirrors `countSlotBookings`': a customer repainting the grid while EDITING a
 * booking must not see their own row occupying the slot they already hold, or a stay they are
 * merely re-timing reads as full.
 */
export async function listSlotBookingCounts(
  db: D1Database,
  tenantId: string,
  serviceType: ServiceType,
  optionKey: string,
  fromDate: string,
  toDateExclusive: string,
  excludeId?: string,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT StartDate, COALESCE(SUM(PetCount), 0) AS n FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ?
         AND StartDate >= ? AND StartDate < ? AND Status IN ('pending', 'confirmed')
         AND (? IS NULL OR Id != ?)
       GROUP BY StartDate`,
    )
    .bind(
      tenantId,
      serviceType,
      optionKey,
      fromDate,
      toDateExclusive,
      excludeId ?? null,
      excludeId ?? null,
    )
    .all<{ StartDate: string; n: number }>();
  return new Map(results.map((r) => [r.StartDate, r.n]));
}

/** Every row — including 'blocked' time off — is born sync-pending; the outbox clears on push
 * success. 'blocked' rows sync as an all-day UNAVAILABLE event the same way a real booking syncs
 * as its own event; only 'external' (Google-owned, materialized by reconcile) is never written
 * here at all. */
export async function insertBookingRequest(
  db: D1Database,
  tenantId: string,
  row: {
    endUserId: string | null;
    serviceType: ServiceType | 'blocked';
    startDate: string;
    endDate: string | null;
    optionKey: string | null;
    petCount: number;
    startTime?: string | null;
    /** Owner-set departure time (0008); undefined/null = none given. */
    departureTime?: string | null;
    estCost: number | null;
    status: 'pending' | 'confirmed';
    answers?: Record<string, string>;
    source?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO BookingRequests
         (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, DepartureTime, EstCost, Answers, Status, Source, IdempotencyKey, SyncPending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      row.endUserId,
      row.serviceType,
      row.startDate,
      row.endDate,
      row.optionKey,
      row.petCount,
      row.startTime ?? null,
      row.departureTime ?? null,
      row.estCost,
      JSON.stringify(row.answers ?? {}),
      row.status,
      row.source ?? null,
      row.idempotencyKey ?? null,
      1,
    )
    .run();
  return id;
}

/**
 * Insert a booking ADOPTED from an existing Google Calendar event.
 *
 * Deliberately NOT `insertBookingRequest`, which hard-codes `SyncPending = 1`. An adopted row is a
 * record of an event Google already has: arming the outbox would push a SECOND event for the same
 * stay and break the read-only guarantee the backfill is built on. `GCalEventId` is stamped here
 * instead, so reconcile stops materializing the event as an `'external'` row and treats it as a
 * known booking.
 */
export async function insertBackfilledBooking(
  db: D1Database,
  tenantId: string,
  row: {
    endUserId: string;
    serviceType: string;
    startDate: string;
    endDate: string | null;
    optionKey: string;
    petCount: number;
    estCost: number;
    status: 'confirmed' | 'cancelled';
    gcalEventId: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  // A cancelled adoption's price is also stamped into CancellationFee, not EstCost alone:
  // BASE_AMOUNT_SQL reads CancellationFee (not EstCost) for a cancelled row, and the convention
  // this feature adopts from (`keepsCalendarEventOnCancel`) keeps a cancelled event on the
  // calendar only when a fee is owed — every adopted [CANCELLED] event is a receivable by that
  // convention, so it must land in the column the balance actually sums. EstCost keeps the same
  // number too, as the stay's own figure independent of what happened to it afterward.
  const cancellationFee = row.status === 'cancelled' ? row.estCost : null;
  await db
    .prepare(
      `INSERT INTO BookingRequests
         (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount,
          EstCost, CancellationFee, Answers, Status, Source, GCalEventId, SyncPending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 'calendar-backfill', ?, 0)`,
    )
    .bind(
      id,
      tenantId,
      row.endUserId,
      row.serviceType,
      row.startDate,
      row.endDate,
      row.optionKey,
      row.petCount,
      row.estCost,
      cancellationFee,
      row.status,
      row.gcalEventId,
    )
    .run();
  return id;
}

/**
 * Was this booking ADOPTED from the sitter's own calendar (`Source = 'calendar-backfill'`)?
 *
 * The read behind the write-side half of the backfill's read-only guarantee. `GCalEventId` on an
 * adopted row names an event the SITTER created and pawservation only ever read, so no push may
 * ever touch it — but the row is an otherwise ordinary booking, so every lifecycle path
 * (dashboard cancel, customer cancel, customer edit) reaches the same inline calendar push an
 * ordinary booking does. `listSyncPendingBookings` keeps such a row out of the OUTBOX; this is
 * what keeps it out of those INLINE pushes, which never consult the outbox query at all.
 *
 * Unknown id → false: a push for a booking that no longer exists is already a no-op against
 * Google's own 404/410 handling, and this must never be the thing that decides existence.
 */
export async function isAdoptedBooking(
  db: D1Database,
  tenantId: string,
  bookingId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS Hit FROM BookingRequests
       WHERE TenantId = ? AND Id = ? AND Source = 'calendar-backfill'`,
    )
    .bind(tenantId, bookingId)
    .first<{ Hit: number }>();
  return row != null;
}

/** Event ids this tenant has EVER adopted — the import's idempotency key, so re-running the
 *  backfill over an overlapping range adopts nothing twice.
 *
 *  Deliberately ignores `Status`: a cancelled adoption is still an adoption. Without this, a
 *  sitter who adopts an event, cancels the resulting booking, then re-runs a backfill over that
 *  range would get the same Google event adopted a SECOND time, creating a duplicate booking. */
export async function listAdoptedEventIds(db: D1Database, tenantId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT GCalEventId FROM BookingRequests
       WHERE TenantId = ? AND Source = 'calendar-backfill' AND GCalEventId IS NOT NULL`,
    )
    .bind(tenantId)
    .all<{ GCalEventId: string }>();
  return new Set(results.map((r) => r.GCalEventId));
}

/** Event ids this tenant has adopted and NOT since cancelled — reconcile's live candidate set for
 *  deciding an event is already represented by a real booking and must not be re-materialized as
 *  an ordinary `external` blocker.
 *
 *  Excludes cancelled/declined rows: a sitter who cancels an adopted booking while its Google
 *  event still exists must get that event back as an ordinary `external` blocker on the next
 *  reconcile, not have it silently suppressed forever — the row being cancelled is not the event
 *  disappearing from Google. Do NOT use this for the import route's idempotency check; use
 *  `listAdoptedEventIds` there instead, which must ignore status to avoid re-adopting an event
 *  whose booking was cancelled. */
export async function listActiveAdoptedEventIds(
  db: D1Database,
  tenantId: string,
): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT GCalEventId FROM BookingRequests
       WHERE TenantId = ? AND Source = 'calendar-backfill' AND GCalEventId IS NOT NULL
         AND Status NOT IN ('cancelled', 'declined')`,
    )
    .bind(tenantId)
    .all<{ GCalEventId: string }>();
  return new Set(results.map((r) => r.GCalEventId));
}

/**
 * Re-price a booking ADOPTED from the calendar. Scoped to `Source = 'calendar-backfill'` in the
 * SQL itself, not in the route: an adopted row's cost was computed from today's rate card for a
 * stay that may predate it, so correcting it takes nothing from anyone. A booking a client
 * actually agreed to is out of reach here by construction — the WHERE clause, not the caller, is
 * what makes that true.
 *
 * Writes BOTH columns for a cancelled row, exactly as `insertBackfilledBooking` does — the two
 * must agree about the same invariant or a correction half-lands:
 *
 *  - `CancellationFee` is what `BASE_AMOUNT_SQL` reads once cancelled, so the balance only follows
 *    a correction that reaches it. Guarded by the SAME `CASE WHEN Status = 'cancelled'` test
 *    `BASE_AMOUNT_SQL` uses, so a confirmed row's fee column is never invented.
 *  - `EstCost` is set UNCONDITIONALLY, because it is the figure the sitter actually SEES:
 *    `listBookingsForTenant` renders it raw in the admin list and the inline Edit affordance
 *    prefills from it. Leaving it behind on a cancelled row meant a stay corrected from $25 to
 *    $60 moved the balance while still reading "$25 (estimate)", and re-opening Edit offered the
 *    stale number back.
 *
 * One statement, not a read-then-write: Status is read and acted on atomically, with no race
 * between checking it and writing the price.
 */
export async function updateBackfilledBookingCost(
  db: D1Database,
  tenantId: string,
  bookingId: string,
  estCost: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE BookingRequests
       SET EstCost = ?,
           CancellationFee = CASE WHEN Status = 'cancelled' THEN ? ELSE CancellationFee END
       WHERE TenantId = ? AND Id = ? AND Source = 'calendar-backfill'`,
    )
    .bind(estCost, estCost, tenantId, bookingId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/** Booking previously created with this Idempotency-Key by this customer, or null. */
export async function findBookingByIdempotencyKey(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  key: string,
): Promise<{ Id: string; EstCost: number | null; Status: string } | null> {
  const row = await db
    .prepare(
      `SELECT Id, EstCost, Status FROM BookingRequests
        WHERE TenantId = ? AND EndUserId = ? AND IdempotencyKey = ?`,
    )
    .bind(tenantId, endUserId, key)
    .first<{ Id: string; EstCost: number | null; Status: string }>();
  return row ?? null;
}

/** Delete a single booking by id (tenant-scoped). Used to roll back a lost overbooking race. */
export async function deleteBookingRequest(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<void> {
  await db
    .prepare('DELETE FROM BookingRequests WHERE TenantId = ? AND Id = ?')
    .bind(tenantId, id)
    .run();
}

/**
 * This customer's own bookings. `Answers` rides along (it is not in `BOOKING_COLS`, which every
 * other booking read shares) because the widget's edit form has to open showing what was actually
 * answered — re-fetching it per row, or re-deriving it from `SavedAnswers`, would show a customer
 * the pre-fill instead of what they submitted on THIS booking.
 */
export async function listBookingsForUser(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<(BookingRow & { Answers: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_COLS}, Answers
       FROM BookingRequests
       WHERE TenantId = ? AND EndUserId = ?
       ORDER BY StartDate DESC`,
    )
    .bind(tenantId, endUserId)
    .all<BookingRow & { Answers: string }>();
  return results;
}

/**
 * All non-blocked bookings for the sitter's admin list, newest-first, with the customer's
 * Email/Name joined in (NULL for a booking whose customer was later removed — EndUserId only
 * ever points at a row in the SAME tenant, enforced by how bookings are created), plus the
 * total paid so far (0 for bookings with no payments).
 */
export async function listBookingsForTenant(
  db: D1Database,
  tenantId: string,
): Promise<
  (BookingRow & {
    Email: string | null;
    Name: string | null;
    PaidTotal: number;
    /** Parsed intake answers; {} for none or unparseable — the admin list renders them. */
    Answers: Record<string, string>;
    /** Materialized-external-row title from Google (e.g. "Neighbor stay — Rex"); null for a real
     * booking. Task 8 surfaces it. */
    ExternalSummary: string | null;
  })[]
> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_COLS_QUALIFIED}, BookingRequests.Answers AS Answers,
              BookingRequests.ExternalSummary AS ExternalSummary,
              BookingRequests.Source AS Source,
              EndUsers.Email AS Email, EndUsers.Name AS Name,
              COALESCE(paid.Total, 0) AS PaidTotal
       FROM BookingRequests
       LEFT JOIN EndUsers ON EndUsers.Id = BookingRequests.EndUserId
         AND EndUsers.TenantId = BookingRequests.TenantId
       LEFT JOIN (
         SELECT BookingRequestId, SUM(Amount) AS Total
         FROM Payments WHERE TenantId = ? GROUP BY BookingRequestId
       ) paid ON paid.BookingRequestId = BookingRequests.Id
       WHERE BookingRequests.TenantId = ? AND BookingRequests.ServiceType != 'blocked'
       ORDER BY BookingRequests.StartDate DESC, BookingRequests.CreatedAt DESC`,
    )
    .bind(tenantId, tenantId)
    .all<
      BookingRow & {
        Email: string | null;
        Name: string | null;
        PaidTotal: number;
        Answers: string;
        ExternalSummary: string | null;
      }
    >();
  return results.map((r) => {
    let answers: Record<string, string> = {};
    try {
      const parsed = JSON.parse(r.Answers) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        answers = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
      }
    } catch {
      /* stored garbage renders as "no answers", never a 500 */
    }
    return { ...r, Answers: answers };
  });
}

/**
 * Sitter-driven lifecycle transition. The guard is entirely in SQL so it's atomic with the write:
 * 'blocked' rows aren't real bookings (never surfaced or manageable here), and 'cancelled' and
 * 'declined' are both terminal — once set, no further transition matches. Confirming an
 * already-confirmed row still matches (harmless no-op). Returns whether a row actually changed.
 *
 * 'declined' is a sitter's "no" to a still-pending request — a first-class Status value — and is
 * only valid from 'pending': a confirmed booking is cancelled, never declined.
 *
 * Every transition re-enters the calendar outbox; the push that mirrors it clears the flag.
 */
export async function updateBookingStatus(
  db: D1Database,
  tenantId: string,
  id: string,
  status: 'confirmed' | 'cancelled' | 'declined',
  cancellationFee?: number,
): Promise<boolean> {
  // Assessed cancellation: record the fee and cancel atomically. The `Status = 'confirmed'` guard
  // lives in the SQL so a raced double-cancel can't charge the fee twice.
  if (status === 'cancelled' && cancellationFee != null) {
    const result = await db
      .prepare(
        `UPDATE BookingRequests SET Status = 'cancelled', CancellationFee = ?, SyncPending = 1
         WHERE TenantId = ? AND Id = ? AND ServiceType NOT IN ('blocked', 'external') AND Status = 'confirmed'`,
      )
      .bind(cancellationFee, tenantId, id)
      .run();
    return (result.meta as { changes?: number }).changes !== 0;
  }
  const result =
    status === 'declined'
      ? await db
          .prepare(
            `UPDATE BookingRequests SET Status = 'declined', SyncPending = 1
             WHERE TenantId = ? AND Id = ? AND ServiceType NOT IN ('blocked', 'external') AND Status = 'pending'`,
          )
          .bind(tenantId, id)
          .run()
      : await db
          .prepare(
            `UPDATE BookingRequests SET Status = ?, SyncPending = 1
             WHERE TenantId = ? AND Id = ? AND ServiceType NOT IN ('blocked', 'external')
               AND Status NOT IN ('cancelled', 'declined')`,
          )
          .bind(status, tenantId, id)
          .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * One of THIS customer's own bookings. Deliberately a separate function from
 * `getBookingWithCustomer` rather than a widened parameter on it: the customer cancel path must
 * never be able to name a booking it does not own, and the way to guarantee that is for the only
 * read it has access to to carry `EndUserId = ?` in its own SQL. The 'blocked'/'external'
 * sentinels are excluded here too, so they read as "no such booking" (a 404) rather than as an
 * existence oracle for rows the customer has no business knowing about.
 *
 * Carries `Answers` (raw JSON) beyond `BOOKING_COLS` so the edit path can snapshot the whole
 * mutable state of the row in ONE read — a rollback that restored the dates but not the answers
 * would be a rollback that half-happened.
 */
export async function getBookingForUser(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  id: string,
): Promise<(BookingRow & { Answers: string }) | null> {
  return await db
    .prepare(
      `SELECT ${BOOKING_COLS}, Answers FROM BookingRequests
       WHERE TenantId = ? AND EndUserId = ? AND Id = ?
         AND ServiceType NOT IN ('blocked', 'external')`,
    )
    .bind(tenantId, endUserId, id)
    .first<BookingRow & { Answers: string }>();
}

/**
 * Customer-initiated cancellation. Scoped by `EndUserId` as well as tenant — the ownership
 * constraint lives in this statement, not in a caller's pre-check, so it cannot be forgotten.
 *
 * The whole guard is in SQL and therefore atomic with the write, exactly like
 * `updateBookingStatus`'s assessed-cancellation arm. It matches `expectedStatus` — the status the
 * caller PRICED — rather than `Status IN ('pending','confirmed')`, which does two jobs at once: a
 * raced double-cancel changes one row and stamps the fee once, AND a sitter confirming in the gap
 * between the fee calculation and this write loses the race instead of landing a request-priced
 * (free) cancellation on a now-confirmed booking. Either loser sees `false` and its route 409s.
 *
 * `cancellationFee` is ALWAYS written, 0 included — a customer cancellation that owes nothing
 * stores a real 0 rather than NULL, so "the customer cancelled and owes nothing" is a recorded
 * fact rather than the absence of one. (NULL keeps meaning "no fee was ever assessed", which is
 * what a sitter-side waive still writes.) Every money read already treats 0 correctly: the
 * earnings base amount resolves to 0, and the payment guard requires a fee > 0.
 */
export async function cancelBookingForUser(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  id: string,
  cancellationFee: number,
  expectedStatus: 'pending' | 'confirmed',
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE BookingRequests SET Status = 'cancelled', CancellationFee = ?, SyncPending = 1
       WHERE TenantId = ? AND EndUserId = ? AND Id = ?
         AND ServiceType NOT IN ('blocked', 'external')
         AND Status = ?`,
    )
    .bind(cancellationFee, tenantId, endUserId, id, expectedStatus)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Customer-initiated EDIT of an existing booking — dates, arrival time, pet count, the re-quoted
 * estimate and the intake answers. Scoped by `EndUserId` as well as tenant for exactly the reason
 * `cancelBookingForUser` is: the ownership constraint lives in this statement, not in a caller's
 * pre-check, so it cannot be forgotten.
 *
 * Three things this statement does deliberately:
 *
 *  - `Status = 'pending'`. An edited booking always goes back to the sitter. She agreed to
 *    specific dates for specific pets, not to whatever they become.
 *  - `SyncPending = 1`, so the outbox moves and retitles the Google event even if the inline push
 *    fails — the same write-ahead flag every other state change sets.
 *  - `CancellationFee` is untouched (it is NULL on any editable row anyway): rescheduling is not a
 *    cancellation and must never assess one.
 *
 * `expectedStatus` is the status the caller READ and priced from, matching `cancelBookingForUser`'s
 * guard: a sitter who confirms or declines in the gap between the read and this write wins the
 * race, and the edit is refused rather than landing on a row whose state it no longer describes.
 */
export async function updateBookingForEdit(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  id: string,
  next: {
    startDate: string;
    endDate: string | null;
    startTime: string | null;
    departureTime: string | null;
    petCount: number;
    estCost: number;
    answers: Record<string, string>;
    expectedStatus: 'pending' | 'confirmed';
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE BookingRequests
          SET StartDate = ?, EndDate = ?, StartTime = ?, DepartureTime = ?, PetCount = ?,
              EstCost = ?, Answers = ?, Status = 'pending', SyncPending = 1
        WHERE TenantId = ? AND EndUserId = ? AND Id = ?
          AND ServiceType NOT IN ('blocked', 'external')
          AND Status = ?`,
    )
    .bind(
      next.startDate,
      next.endDate,
      next.startTime,
      next.departureTime,
      next.petCount,
      next.estCost,
      JSON.stringify(next.answers),
      tenantId,
      endUserId,
      id,
      next.expectedStatus,
    )
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Put a booking back exactly as it was after an edit was applied optimistically and then refused
 * (a capacity conflict, or a throw part-way through). Deliberately NOT status-guarded: the row's
 * status is whatever `updateBookingForEdit` just made it, and a guard that missed would strand the
 * customer's booking describing dates nobody asked for — the one outcome worse than a lost race.
 * Tenant + id scoped, and only ever called with values this same request just read off the row.
 */
export async function restoreBookingAfterEdit(
  db: D1Database,
  tenantId: string,
  id: string,
  previous: {
    startDate: string;
    endDate: string | null;
    startTime: string | null;
    departureTime: string | null;
    petCount: number;
    estCost: number | null;
    answers: string;
    status: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE BookingRequests
          SET StartDate = ?, EndDate = ?, StartTime = ?, DepartureTime = ?, PetCount = ?,
              EstCost = ?, Answers = ?, Status = ?
        WHERE TenantId = ? AND Id = ?`,
    )
    .bind(
      previous.startDate,
      previous.endDate,
      previous.startTime,
      previous.departureTime,
      previous.petCount,
      previous.estCost,
      previous.answers,
      previous.status,
      tenantId,
      id,
    )
    .run();
}

/** One booking joined with its customer's contact details — for status-change notifications. */
export async function getBookingWithCustomer(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<(BookingRow & { Email: string | null; Name: string | null }) | null> {
  return await db
    .prepare(
      `SELECT ${BOOKING_COLS_QUALIFIED}, EndUsers.Email AS Email, EndUsers.Name AS Name
       FROM BookingRequests
       LEFT JOIN EndUsers ON EndUsers.Id = BookingRequests.EndUserId
         AND EndUsers.TenantId = BookingRequests.TenantId
       WHERE BookingRequests.TenantId = ? AND BookingRequests.Id = ?`,
    )
    .bind(tenantId, id)
    .first<BookingRow & { Email: string | null; Name: string | null }>();
}

/**
 * Record a payment iff the booking exists for THIS tenant, is not a 'blocked'/'external' sentinel,
 * and still OWES something — the guard lives in the SQL (INSERT ... SELECT ... WHERE) so it is
 * atomic with the write, like updateBookingStatus's guarded UPDATE. 'pending' is deliberately
 * allowed: deposits are commonly collected before a booking is confirmed. Returns the new payment
 * id, or null when the guard refused (route 404s on null, the existing idiom).
 *
 * A terminal row normally refuses payment, with exactly the two exceptions that make it a live
 * receivable — and they are the same two `OUTSTANDING_WHERE_SQL` bills a cancelled row for, which
 * is the point: the sitter must never be shown an outstanding balance whose *Record payment*
 * button 404s.
 *   1. A NON-ZERO assessed CancellationFee. The test is `> 0`, not `IS NOT NULL`: a customer
 *      self-cancel writes a real 0 for "cancelled, nothing owed" (see cancelBookingForUser), and
 *      nothing owed must still refuse. For every sitter-assessed fee the two spellings agree —
 *      the admin route only ever stores a fee it computed as greater than zero.
 *   2. A live BookingCharges total. Extra charges survive a cancellation by design (a charge is
 *      owed on a stay that happened whether or not it was later cancelled) and EstCost is never
 *      mutated to absorb them, so a fee-FREE cancel carrying $45 of extras is genuinely owed $45.
 * 'declined' gets neither exception, matching the earnings predicate: a declined row is never
 * billed, so it is never payable.
 *
 * `externalRef` carries the Venmo transaction id for imported payments (NULL for hand-recorded
 * ones). A replay violates the partial unique index and THROWS rather than returning null — the
 * importer catches it with isUniqueViolation and reports the row as already imported; the null
 * return still means only "the booking guard refused".
 */
export async function insertPayment(
  db: D1Database,
  tenantId: string,
  payment: {
    bookingRequestId: string;
    amount: number;
    method: PaymentMethod;
    paidDate: string;
    note: string | null;
    externalRef: string | null;
  },
): Promise<string | null> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate, Note, ExternalRef)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       FROM BookingRequests
       WHERE TenantId = ? AND Id = ? AND ServiceType NOT IN ('blocked', 'external')
         AND (Status NOT IN ('cancelled', 'declined')
              OR COALESCE(CancellationFee, 0) > 0
              OR (Status = 'cancelled' AND COALESCE((
                    SELECT SUM(c.Amount) FROM BookingCharges c
                    WHERE c.TenantId = BookingRequests.TenantId
                      AND c.BookingRequestId = BookingRequests.Id
                  ), 0) > 0))`,
    )
    .bind(
      id,
      tenantId,
      payment.bookingRequestId,
      payment.amount,
      payment.method,
      payment.paidDate,
      payment.note,
      payment.externalRef,
      tenantId,
      payment.bookingRequestId,
    )
    .run();
  return (result.meta as { changes?: number }).changes !== 0 ? id : null;
}

/**
 * Every Venmo transaction id this tenant has already imported. Read whole rather than probed per
 * row: the importer needs the set up front to render an "already imported" bucket in its preview,
 * and a tenant's payment count is prototype-scale.
 */
export async function listPaymentExternalRefs(db: D1Database, tenantId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT ExternalRef FROM Payments WHERE TenantId = ? AND ExternalRef IS NOT NULL')
    .bind(tenantId)
    .all<{ ExternalRef: string }>();
  return results.map((r) => r.ExternalRef);
}

/**
 * Delete one payment. The WHERE includes BookingRequestId so a payment id paired with the wrong
 * booking id in the URL reports false (route 404s) instead of silently deleting. Deliberately NO
 * booking-status guard — deleting the record is the only correction mechanism for refunds, so it
 * must work on cancelled bookings too (see the design's Non-goals).
 */
export async function deletePayment(
  db: D1Database,
  tenantId: string,
  bookingRequestId: string,
  paymentId: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM Payments WHERE TenantId = ? AND BookingRequestId = ? AND Id = ?')
    .bind(tenantId, bookingRequestId, paymentId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

export async function listPaymentsForBooking(
  db: D1Database,
  tenantId: string,
  bookingRequestId: string,
): Promise<PaymentRow[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, BookingRequestId, AccountId, Amount, Method, PaidDate, Note, CreatedAt
       FROM Payments WHERE TenantId = ? AND BookingRequestId = ?
       ORDER BY PaidDate DESC, CreatedAt DESC`,
    )
    .bind(tenantId, bookingRequestId)
    .all<PaymentRow>();
  return results;
}

/**
 * RECORD ONE PAYMENT AGAINST A HOUSEHOLD (0011). A client who pays weekly or monthly sends one
 * amount covering several bookings; this writes it as ONE row against the household, and the sitter
 * is never asked to split it. `BookingRequestId` stays NULL — the database's `CHECK` is what makes
 * "exactly one of the two" a fact rather than a convention, so no reader has to decide which side
 * counts a row and none of them can count it twice.
 *
 * The guard is `insertPayment`'s idiom — `INSERT … SELECT … WHERE`, atomic with the write — asked of
 * `EndUserPets` rather than of `BookingRequests`, because a household is identified by a pet id (see
 * the schema's `AccountId` note). A pet of another tenant, a deceased pet, and an id that is no pet
 * at all all insert nothing and return null, which the route reports as 404: tenancy is enforced in
 * the SQL, never by a caller-side pre-check. It deliberately does NOT also test for a `PetOwners`
 * edge: "no pets without owners" is a standing invariant of this schema, so a live pet always sits
 * in some household and that clause could never fire — the same reason `buildAccounts` refuses to
 * filter out components with no owners.
 *
 * Deliberately NO status or balance guard, unlike the booking form. There is no booking to be
 * cancelled or declined here, and a household that owes nothing yet may legitimately be paid — that
 * is prepayment, which shows up as a credit and is drawn down by the next booking through the same
 * arithmetic.
 *
 * `externalRef` carries the Venmo transaction id for an import recorded against a household (Story
 * 2.5) — NULL for a hand-recorded one, exactly `insertPayment`'s idiom. It shares that function's
 * partial unique index on `(TenantId, ExternalRef)`, so a replayed CSV row throws here too rather
 * than inserting a second time; the importer catches it with `isUniqueViolation`.
 */
export async function insertAccountPayment(
  db: D1Database,
  tenantId: string,
  payment: {
    accountId: string;
    amount: number;
    method: PaymentMethod;
    paidDate: string;
    note: string | null;
    externalRef: string | null;
  },
): Promise<string | null> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO Payments (Id, TenantId, BookingRequestId, AccountId, Amount, Method, PaidDate, Note, ExternalRef)
       SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?
       FROM EndUserPets
       WHERE TenantId = ? AND Id = ? AND DeceasedAt IS NULL`,
    )
    .bind(
      id,
      tenantId,
      payment.accountId,
      payment.amount,
      payment.method,
      payment.paidDate,
      payment.note,
      payment.externalRef,
      tenantId,
      payment.accountId,
    )
    .run();
  return (result.meta as { changes?: number }).changes !== 0 ? id : null;
}

/**
 * Every client's household account id, keyed by owner (EndUser) id — the same connected-component
 * graph `buildAccounts` derives for invoice numbering and `getHouseholdBalances` derives for money,
 * built here with NO activity filter. `getHouseholdBalances` deliberately drops a household with no
 * bookings and no payments (a statement for a client who has never booked or paid is noise on the
 * Earnings page) — but the Venmo importer (Story 2.5) needs to resolve a client's FIRST-EVER payment
 * to their household, before any activity exists to filter on. An owner with no live pet holds no
 * edge in the graph at all and is simply absent from the returned map — they belong to no household,
 * and the importer surfaces that rather than guessing one.
 */
export async function getAccountIdsByOwner(
  db: D1Database,
  tenantId: string,
): Promise<Map<string, string>> {
  const links = await listOwnerPetLinks(db, tenantId);
  const accounts = buildAccounts(links.map((l) => ({ ownerId: l.EndUserId, petId: l.PetId })));
  const map = new Map<string, string>();
  for (const account of accounts)
    for (const ownerId of account.ownerIds) map.set(ownerId, account.id);
  return map;
}

/**
 * Every pet id a payment of this household may be FILED UNDER, or null when the account id names
 * no household of this tenant.
 *
 * Membership, not equality: the account id is the lexicographically-first pet of its component, so
 * a new pet sorting earlier RENAMES the household — and a payment filed under the old name must
 * still be found. Every household-payment read goes through this, so what the panel lists and what
 * the balance counts can never be two different sets.
 *
 * The set is the component's live pets PLUS its payment anchors — pets that have DIED since a
 * payment was filed against them (`buildPaymentAnchors`). Without the anchors, marking the
 * account-id pet deceased dropped its payments out of this list and out of `getHouseholdBalances`
 * together, silently, while `Payments` kept counting them as revenue. Both lists are consulted for
 * the same reason they are kept apart: a dead pet is a legitimate place for money to have been
 * filed, and not a member of the household.
 */
async function householdPetIds(
  db: D1Database,
  tenantId: string,
  accountId: string,
): Promise<string[] | null> {
  const graph = await loadAccountGraph(db, tenantId);
  return resolveHousehold(graph, { accountId })?.paymentPetIds ?? null;
}

/** Every payment recorded against a household, newest paid-date first (listPaymentsForBooking's order). */
export async function listPaymentsForAccount(
  db: D1Database,
  tenantId: string,
  accountId: string,
): Promise<PaymentRow[]> {
  const petIds = await householdPetIds(db, tenantId, accountId);
  if (!petIds) return [];
  const placeholders = petIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, BookingRequestId, AccountId, Amount, Method, PaidDate, Note, CreatedAt
       FROM Payments
       WHERE TenantId = ? AND AccountId IN (${placeholders})
       ORDER BY PaidDate DESC, CreatedAt DESC`,
    )
    .bind(tenantId, ...petIds)
    .all<PaymentRow>();
  return results;
}

/**
 * Delete one household payment. Carries the account id for the same reason `deletePayment` carries
 * the booking id: a payment id paired with the wrong household in the URL must report false (the
 * route 404s) rather than silently deleting someone else's money. Deleting is the only correction
 * mechanism this ledger has, here as there.
 *
 * AN ORPHAN IS DELETABLE UNDER THE ID IT IS FILED AGAINST. When `accountId` resolves to no
 * household — the pet it names was deleted with its owner edges — the payment is matched by exact
 * `AccountId` equality instead of by household membership. Without this the sitter could SEE an
 * orphan (`getOrphanedAccountPayments` puts it on the Earnings page) and have no way to clear it,
 * which would leave the one correction this ledger has unavailable precisely where it is needed.
 * Equality is not a loophole: an id that resolves to a household never reaches this branch, so it
 * reaches exactly the payments nothing else can, and tenancy is enforced in the SQL either way.
 */
export async function deleteAccountPayment(
  db: D1Database,
  tenantId: string,
  accountId: string,
  paymentId: string,
): Promise<boolean> {
  // No household ⇒ the id is an orphan's own account id, and only its own payments answer to it.
  const petIds = (await householdPetIds(db, tenantId, accountId)) ?? [accountId];
  const placeholders = petIds.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `DELETE FROM Payments WHERE TenantId = ? AND Id = ? AND AccountId IN (${placeholders})`,
    )
    .bind(tenantId, paymentId, ...petIds)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * APPLY ONE ATTRIBUTION — turn a household-level credit into the booking-level payments it
 * actually settled, in ONE transaction. The riskiest write in this file: it is the only one that
 * destroys money and re-creates it.
 *
 * A sitter who imported payment history has money recorded against a HOUSEHOLD and against no
 * particular stay, so every booking still reads unpaid while the client reads "in credit".
 * `proposeAttribution` (server/lib/payment-attribution.ts) DECIDES the split, purely; this applies
 * it. The two are kept apart so the decision can be reviewed before any money moves.
 *
 * NOT AN UPDATE — A DELETE PLUS INSERTS. `Payments` carries
 * `CHECK ((BookingRequestId IS NULL) <> (AccountId IS NULL))`: a row settles a booking OR a
 * household, never both. The account-level row therefore cannot be re-pointed at a booking; it
 * must be deleted and the booking-level rows created. Which is why EVERY statement goes in ONE
 * `db.batch` — D1 runs a batch as a single transaction (the test shim wraps it in a real
 * BEGIN/COMMIT too, see helpers.ts). A partially-applied attribution either duplicates the money
 * or loses it, and best-effort cleanup afterwards is not good enough for a ledger.
 *
 * THE STATEMENTS ARE BUILT HERE rather than by calling `insertPayment`, `insertAccountPayment` and
 * `deleteAccountPayment`: those three each `.run()` their own statement, so composing them would
 * be three separate transactions, which is precisely the failure mode above. The column lists
 * below are IDENTICAL to theirs, deliberately, so the two spellings cannot drift.
 *
 * They are plain `INSERT ... VALUES`, NOT `insertPayment`'s guarded `INSERT ... SELECT ... WHERE`.
 * A guard that refuses inside a batch writes zero rows WITHOUT raising, and by the time
 * `meta.changes` could be inspected the batch has committed — source row deleted, its money gone.
 * So every guard runs BEFORE the batch, and every statement inside it writes exactly one row or
 * throws.
 *
 * AND THE SOURCE ROW MUST STILL BE THERE WHEN THE BATCH RUNS. A zero-row DELETE does not raise, so
 * two overlapping applies of the same payment would both pass every guard and the second would
 * delete nothing and insert a second complete set of booking rows — money from nowhere. One
 * in-batch statement therefore DEPENDS on the source row (see `guardedFirstSplit` below), so its
 * absence aborts the transaction instead of quietly duplicating. This is enforced here rather than
 * by serialising at the route: the ledger's integrity cannot rest on every future caller
 * remembering to.
 *
 * THE SOURCE PAYMENT IS RE-READ HERE and its `Amount` is the only authority on how much money is
 * in play; a caller-supplied figure is never trusted. `sum(splits) + remainder` must equal it
 * EXACTLY — whole dollars, integer arithmetic, no rounding anywhere. That equation is
 * CONSERVATION, and it is the reason attribution can never create or destroy money. Both figures
 * are named in the refusal, because "the split doesn't add up" is unactionable without them.
 *
 * `ExternalRef` is MARKED, not dropped: `attr:1:<ref>`, `attr:2:<ref>`, … and `attr:r:<ref>` for
 * the remainder (`deriveAttributedRef`, server/lib/payment-attribution.ts). The derived rows share
 * `idx_Payments_Tenant_ExternalRef` (partial unique) with the source, so they cannot inherit it
 * unchanged. The marker LEADS and the original is carried verbatim as the tail precisely so that
 * recovery is unambiguous — a suffix cannot be undone against a key like `csv:<hash>:<rank>` that
 * already ends in `:` plus digits. A source with no `ExternalRef` yields rows with none.
 *
 * THAT REWRITE IS ONLY HALF THE SCHEME, AND THE OTHER HALF IS NOT HERE. Deleting the source row
 * removes the key both payment importers dedupe against, so on its own this would let the next
 * upload of the same file record the payment a SECOND time — creating money, on the CSV
 * importer's own documented expected case of overlapping monthly exports. What prevents that is
 * `expandImportedRefs`, applied where the importers build their dedupe set (server/routes/admin.ts,
 * `loadPaymentMatchInputs`): it adds the recovered original behind every derived ref, so an
 * attributed key still reads as already-imported. Do not remove that call as redundant defence —
 * it is the protection, not a belt on top of one. Pinned by
 * server/__tests__/payment-attribution-reimport.test.ts, which drives both importers end to end.
 *
 * EVERY TARGET BOOKING'S OWN LIVE OUTSTANDING IS RE-READ TOO, from the same `getHouseholdDetail`
 * that computes the balance this attribution must leave unchanged — a caller-supplied split is
 * conservation-checked against the SOURCE payment above, but conservation alone cannot catch a
 * split that is internally consistent yet lands more money on a booking than it still owes. That
 * happens two ways: a stale client (a preview rendered before the booking was paid some other way,
 * or before an earlier attribution in the SAME request already settled it — this function is
 * called once per attribution, sequentially, by its one caller in `admin.ts`, so a second call in
 * one batch sees the first one's write already committed) or a hand-crafted request. `expected` is
 * `CREDITABLE_AMOUNT_SQL`, already 0 for a `declined` booking and `CancellationFee` (default 0) for
 * a fee-free `cancelled` one, so a split against either is refused here as ordinary overpayment —
 * no separate status check is needed, matching the preview's own `outstanding > 0` candidate
 * filter rather than inventing a second rule for the same fact.
 *
 * A THIRD WAY TO OVER-FUND ONE BOOKING, caught before either of the above even runs a query: the
 * SAME booking id named twice within one attribution's OWN splits. Checked in isolation against
 * live outstanding, two splits on one booking can each individually be fine while summing past
 * what it owes — so a duplicate booking id is refused outright rather than aggregated, on the same
 * "refuse rather than guess" doctrine `proposeAttribution` already applies to a duplicate candidate.
 */
export async function applyAttribution(
  db: D1Database,
  tenantId: string,
  input: {
    paymentId: string;
    accountId: string;
    splits: { bookingId: string; amount: number }[];
    remainder: number;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { paymentId, accountId, splits, remainder } = input;

  if (splits.length === 0) {
    return {
      ok: false,
      reason: `Attribution of payment ${paymentId} names no bookings; there is nothing to attribute it to.`,
    };
  }
  const badSplit = splits.find((s) => !Number.isInteger(s.amount) || s.amount <= 0);
  if (badSplit) {
    return {
      ok: false,
      reason: `Split for booking ${badSplit.bookingId} is ${badSplit.amount}; every split must be a whole number of dollars greater than zero.`,
    };
  }
  if (!Number.isInteger(remainder) || remainder < 0) {
    return {
      ok: false,
      reason: `Remainder ${remainder} is not a whole, non-negative number of dollars.`,
    };
  }

  // REFUSED OUTRIGHT, NOT AGGREGATED — the same booking id named twice in one attribution's
  // splits (`[{B,100},{B,50}]`) would otherwise pass conservation (each split is individually
  // positive and, checked in isolation below, individually within outstanding) while together
  // over-funding B. Aggregating the two into one $150 comparison would also FIX that, but this
  // refuses instead: two different figures for the same booking is not a shape `proposeAttribution`
  // ever emits, so a caller sending it is either malformed or means something ambiguous (which of
  // the two did the sitter actually intend?) — the same "refuse rather than guess" doctrine
  // `proposeAttribution` itself applies to a duplicate candidate id
  // (server/lib/payment-attribution.ts, `duplicate-booking-id`). Checked before any DB read: it
  // needs nothing but the splits array itself.
  const bookingIdCounts = new Map<string, number>();
  for (const s of splits)
    bookingIdCounts.set(s.bookingId, (bookingIdCounts.get(s.bookingId) ?? 0) + 1);
  const duplicateBookingId = [...bookingIdCounts.entries()].find(([, count]) => count > 1)?.[0];
  if (duplicateBookingId !== undefined) {
    return {
      ok: false,
      reason: `Booking ${duplicateBookingId} appears more than once among this attribution's splits; refusing rather than risk applying part of the credit to it twice.`,
    };
  }

  // MEMBERSHIP, NOT EQUALITY — `AccountId IN (householdPetIds)`, exactly as
  // `listPaymentsForAccount` and `deleteAccountPayment` do it. The account id is the household's
  // lexicographically-first pet and a pet added later RENAMES it, so a payment filed under the old
  // name is still this household's money. Matching on equality here would leave a payment the
  // sitter can see and can delete under the current account id impossible to ATTRIBUTE under it —
  // fail-closed, but it strands precisely the households the anchor machinery exists for. The
  // orphan fallback is `deleteAccountPayment`'s too: with no household, the id answers only for
  // payments filed under itself (any split is then refused below, since an orphan has no bookings).
  const petIds = (await householdPetIds(db, tenantId, accountId)) ?? [accountId];
  const petPlaceholders = petIds.map(() => '?').join(', ');

  // The row in the database is the authority — on the amount, and on this being a household-level
  // payment of this tenant at all. `AccountId` comes back too: the remainder is re-filed under the
  // id the source was filed under, not under the caller's, so leftover money never moves.
  const source = await db
    .prepare(
      `SELECT Amount, AccountId, Method, PaidDate, Note, ExternalRef FROM Payments
       WHERE TenantId = ? AND Id = ? AND AccountId IN (${petPlaceholders})
         AND BookingRequestId IS NULL`,
    )
    .bind(tenantId, paymentId, ...petIds)
    .first<{
      Amount: number;
      AccountId: string;
      Method: PaymentMethod;
      PaidDate: string;
      Note: string | null;
      ExternalRef: string | null;
    }>();
  if (!source) {
    return {
      ok: false,
      reason: `Payment ${paymentId} is not a household-level payment of account ${accountId} in this tenant.`,
    };
  }

  const attributed = splits.reduce((sum, s) => sum + s.amount, 0) + remainder;
  if (attributed !== source.Amount) {
    return {
      ok: false,
      reason: `Attribution of payment ${paymentId} accounts for $${attributed} (splits plus remainder) but the payment is $${source.Amount}; refusing rather than create or destroy money.`,
    };
  }

  // "Is this booking in this household, and what does it still owe RIGHT NOW" is asked of
  // `getHouseholdDetail` — the same tenant-scoped rollup that computes the balance this attribution
  // must leave unchanged — rather than a fresh predicate written here, so the two can never come to
  // mean different things. A `null` detail (the account id names no household) leaves the map empty
  // and every split is refused.
  const detail = await getHouseholdDetail(db, tenantId, accountId);
  const outstandingByBooking = new Map(
    (detail?.bookings ?? []).map((b) => [b.bookingId, b.expected - b.paidTotal]),
  );
  const foreign = splits.find((s) => !outstandingByBooking.has(s.bookingId));
  if (foreign) {
    return {
      ok: false,
      reason: `Booking ${foreign.bookingId} is not a booking of account ${accountId} in this tenant.`,
    };
  }

  // LIVE OUTSTANDING, RE-READ HERE, NOT TRUSTED FROM THE CALLER — the fix for the defect a review
  // caught at the REQUEST level, the same shape as the sequential-allocation bug `proposeAttribution`
  // was already fixed against: nothing before this point ever compares a split to what its booking
  // actually still owes, so two attributions in one batch (or a stale preview reused after the
  // booking was settled some other way) could each land their full split on the SAME booking and
  // overpay it. `getHouseholdDetail` is re-read fresh on every call, so the second of two
  // applications in a batch — this function is called once per attribution, sequentially, awaited —
  // sees the first one's write already committed and refuses rather than doubling it.
  //
  // `expected` is `CREDITABLE_AMOUNT_SQL`, which is already 0 for a `declined` booking and
  // `CancellationFee` (defaulting to 0) for a `cancelled` one — so a split against a declined, or a
  // fee-free-cancelled, booking is refused here with no separate status check: its outstanding is
  // already <= 0, and every split is a positive whole dollar amount (checked above), so it can never
  // clear this bar. A cancelled booking that DOES carry an assessed fee or a live charge is a genuine
  // receivable and is allowed exactly as far as that fee/charge still goes, matching the preview's
  // own `outstanding > 0` candidate filter.
  const overpaid = splits.find((s) => s.amount > outstandingByBooking.get(s.bookingId)!);
  if (overpaid) {
    // Reported EXACTLY as computed, never clamped to 0 — a booking already sitting in credit
    // (outstanding negative, because it was overpaid some other way) is a fact worth showing the
    // sitter as-is; rounding it to "owes $0" would read as merely settled rather than already
    // over-paid, which is a different, more actionable, situation.
    const owed = outstandingByBooking.get(overpaid.bookingId)!;
    // Negative outstanding is stated as over-paid rather than rendered `$-50`, which reads as a
    // typo in a sitter-facing message; the figure itself is still reported exactly.
    const standing = owed < 0 ? `is $${-owed} over-paid` : `owes $${owed}`;
    return {
      ok: false,
      reason: `Booking ${overpaid.bookingId} ${standing} but this split names $${overpaid.amount}; refusing rather than overpay it.`,
    };
  }

  // `attr:<segment>:<the source's own ref>` — see `deriveAttributedRef`
  // (server/lib/payment-attribution.ts) for why the original is carried VERBATIM as the tail
  // rather than suffixed. In short: this DELETE removes the last row holding the importers'
  // idempotency key, so unless that key can be read back out of what attribution leaves behind,
  // a re-upload of the same export records every attributed payment all over again.
  const derivedRef = (segment: string) => deriveAttributedRef(source.ExternalRef, segment);

  // THE FIRST SPLIT'S AMOUNT IS MULTIPLIED BY A LOOKUP OF THE SOURCE ROW, and that is load-bearing
  // rather than decorative. Between the re-read above and this batch, another request applying the
  // SAME payment can commit: its DELETE takes the source, and ours would then match zero rows —
  // WITHOUT raising, because a zero-row DELETE is a perfectly ordinary result — leaving this batch
  // to insert a second, complete set of booking rows. The household would gain `source.Amount` out
  // of nothing. The unique index on `ExternalRef` catches that for IMPORTED payments only: it is
  // PARTIAL (`WHERE ExternalRef IS NOT NULL`, sql/schema.sql), so every hand-recorded household
  // payment — the common case — has no protection from it at all, and a double-clicked Apply
  // button is the whole trigger.
  //
  // A vanished source makes the scalar subquery NULL and `amount * NULL` NULL, and the abort rests
  // SPECIFICALLY on `Payments.Amount` being `INTEGER NOT NULL` (sql/schema.sql). Not on its
  // `CHECK (Amount > 0)`: SQLite treats a CHECK that evaluates to NULL as SATISFIED, so the CHECK
  // would let a NULL amount straight through. If that column is ever relaxed to nullable, this
  // guard stops aborting SILENTLY and the duplicate-money race returns with no test failing —
  // re-guard it here before touching the column. Absence RAISES instead of quietly writing, the
  // same property the plain `INSERT ... VALUES` above protects. `splits` is non-empty here, so
  // exactly one statement carries the guard, and one is enough: it takes the whole transaction
  // down with it.
  //
  // ORDER MATTERS: the DELETE goes LAST. Ahead of the guard it would remove the very row the
  // subquery looks for, and every attribution would abort.
  const guardedFirstSplit = `? * (SELECT 1 FROM Payments
      WHERE TenantId = ? AND Id = ? AND BookingRequestId IS NULL)`;

  const statements = [
    // Column list identical to insertPayment's.
    ...splits.map((s, i) =>
      db
        .prepare(
          `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate, Note, ExternalRef)
           VALUES (?, ?, ?, ${i === 0 ? guardedFirstSplit : '?'}, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          tenantId,
          s.bookingId,
          ...(i === 0 ? [s.amount, tenantId, paymentId] : [s.amount]),
          source.Method,
          source.PaidDate,
          source.Note,
          derivedRef(String(i + 1)),
        ),
    ),
  ];
  // Whatever the splits did not claim stays where it was: household-level money, still visible as
  // a credit, and still filed under the source's own account id. Zero writes no row at all rather
  // than a $0 payment (`CHECK (Amount > 0)`).
  if (remainder > 0) {
    // Column list identical to insertAccountPayment's.
    statements.push(
      db
        .prepare(
          `INSERT INTO Payments (Id, TenantId, BookingRequestId, AccountId, Amount, Method, PaidDate, Note, ExternalRef)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          tenantId,
          source.AccountId,
          remainder,
          source.Method,
          source.PaidDate,
          source.Note,
          derivedRef('r'),
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `DELETE FROM Payments
         WHERE TenantId = ? AND Id = ? AND AccountId IN (${petPlaceholders})
           AND BookingRequestId IS NULL`,
      )
      .bind(tenantId, paymentId, ...petIds),
  );

  try {
    await db.batch(statements);
  } catch (err) {
    // A derived ref collides with one this tenant already holds. The batch rolled back, so the
    // source payment is untouched and this is a refusal rather than a fault.
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        reason: `Attribution of payment ${paymentId} would reuse an external reference this tenant already holds; nothing was written.`,
      };
    }
    // The guard above fired, or something else did. Reported as a refusal ONLY when the source row
    // is positively confirmed gone — the precondition this function checked and lost. Re-reading to
    // decide is the difference between naming a race the sitter can retry past and swallowing a
    // genuine database fault as though it were ordinary; anything still holding its source rethrows.
    const stillThere = await db
      .prepare('SELECT 1 FROM Payments WHERE TenantId = ? AND Id = ? AND BookingRequestId IS NULL')
      .bind(tenantId, paymentId)
      .first<{ 1: number }>();
    if (!stillThere) {
      return {
        ok: false,
        reason: `Payment ${paymentId} was attributed or deleted by another request while this attribution was being applied; nothing was written.`,
      };
    }
    throw err;
  }
  return { ok: true };
}

/**
 * Add one extra charge to a booking. Uses insertPayment's INSERT...SELECT...WHERE idiom so the
 * tenant + existence guard is part of the same statement — a foreign booking id or the 'blocked'
 * sentinel inserts nothing and returns null (the route 404s on null).
 *
 * Deliberately NO status guard beyond 'blocked': a sitter adds "vet visit $45" to a stay that has
 * already happened, and that stay may since have been cancelled. `EstCost` is never touched —
 * total due is EstCost + SUM(charges), computed at read time.
 */
export async function insertBookingCharge(
  db: D1Database,
  tenantId: string,
  charge: { bookingRequestId: string; label: string; amount: number },
): Promise<string | null> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO BookingCharges (Id, TenantId, BookingRequestId, Label, Amount)
       SELECT ?, ?, ?, ?, ?
       FROM BookingRequests
       WHERE TenantId = ? AND Id = ? AND ServiceType != 'blocked'`,
    )
    .bind(
      id,
      tenantId,
      charge.bookingRequestId,
      charge.label,
      charge.amount,
      tenantId,
      charge.bookingRequestId,
    )
    .run();
  return (result.meta as { changes?: number }).changes !== 0 ? id : null;
}

/**
 * SET a booking's DERIVED extra-time charges to exactly this list (0009) — used by the create path
 * (where the delete is a no-op on a fresh row) and by the edit path, which is what makes "the
 * surcharge follows the booking's times" one rule written once.
 *
 * Three deliberate properties:
 *
 *  - **One `db.batch`**, so a delete can never land without its replacement insert. Half-applied,
 *    this would silently WAIVE money the customer was quoted.
 *  - **Scoped to `Origin IN (…)`**, so a charge the sitter typed herself (`Origin IS NULL`) is
 *    untouched — the invariant that an edit never disturbs her extras, preserved exactly.
 *  - **Each INSERT carries `insertBookingCharge`'s existence guard** (`INSERT … SELECT … FROM
 *    BookingRequests WHERE TenantId = ? AND Id = ?`), so a charge can never attach to a foreign
 *    tenant's booking, a nonexistent id, or a 'blocked'/'external' sentinel.
 *
 * The caller decides WHETHER to call this at all: `editBooking` only does so when the times actually
 * moved, which is what lets a fee the sitter deliberately deleted stay deleted through every edit
 * that does not re-open the question.
 */
export async function replaceExtraTimeCharges(
  db: D1Database,
  tenantId: string,
  bookingRequestId: string,
  charges: { label: string; amount: number; origin: ExtraTimeOrigin }[],
): Promise<void> {
  const origins = EXTRA_TIME_ORIGINS.map(() => '?').join(', ');
  const statements = [
    db
      .prepare(
        `DELETE FROM BookingCharges
          WHERE TenantId = ? AND BookingRequestId = ? AND Origin IN (${origins})`,
      )
      .bind(tenantId, bookingRequestId, ...EXTRA_TIME_ORIGINS),
    ...charges.map((charge) =>
      db
        .prepare(
          `INSERT INTO BookingCharges (Id, TenantId, BookingRequestId, Label, Amount, Origin)
           SELECT ?, ?, ?, ?, ?, ?
           FROM BookingRequests
           WHERE TenantId = ? AND Id = ? AND ServiceType NOT IN ('blocked', 'external')`,
        )
        .bind(
          crypto.randomUUID(),
          tenantId,
          bookingRequestId,
          charge.label,
          charge.amount,
          charge.origin,
          tenantId,
          bookingRequestId,
        ),
    ),
  ];
  await db.batch(statements);
}

/**
 * Delete one charge. The WHERE includes BookingRequestId so a charge id paired with the wrong
 * booking id in the URL reports false (route 404s) instead of silently deleting — deletePayment's
 * rule, for the same reason. Deleting is the only correction mechanism; there is no edit.
 */
export async function deleteBookingCharge(
  db: D1Database,
  tenantId: string,
  bookingRequestId: string,
  chargeId: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM BookingCharges WHERE TenantId = ? AND BookingRequestId = ? AND Id = ?')
    .bind(tenantId, bookingRequestId, chargeId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

export async function listChargesForBooking(
  db: D1Database,
  tenantId: string,
  bookingRequestId: string,
): Promise<BookingChargeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, BookingRequestId, Label, Amount, Origin, CreatedAt
       FROM BookingCharges WHERE TenantId = ? AND BookingRequestId = ?
       ORDER BY CreatedAt, Id`,
    )
    .bind(tenantId, bookingRequestId)
    .all<BookingChargeRow>();
  return results;
}

/** Every charge for a tenant — ONE read that the admin bookings list groups in JS, rather than
 *  a per-row query (the PaidTotal subquery's motivation, applied to a list-shaped payload). */
export async function listChargesForTenant(
  db: D1Database,
  tenantId: string,
): Promise<BookingChargeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, BookingRequestId, Label, Amount, Origin, CreatedAt
       FROM BookingCharges WHERE TenantId = ? ORDER BY BookingRequestId, CreatedAt, Id`,
    )
    .bind(tenantId)
    .all<BookingChargeRow>();
  return results;
}

/**
 * The four earnings aggregates in one round trip (Promise.all over indexed SELECTs — no KV
 * caching; revisit only if it measurably drags). `today` ('YYYY-MM-DD', tenant-timezone at the
 * route) anchors the 12-month window; months with no payments are zero-filled here in JS.
 * Revenue queries count payments regardless of the booking's later status — cash already
 * received is real revenue; `outstanding` filters to confirmed OR cancelled and applies one
 * owed-vs-paid predicate to both (see the query below) rather than a separate arm per status, so a
 * cancelled booking that carries extra charges but no assessed CancellationFee still surfaces
 * instead of silently disappearing from Earnings while still counting against the client's balance
 * elsewhere.
 */
/**
 * The base amount a booking is expected to bring in, on its own: EstCost normally, but the
 * assessed CancellationFee for a cancelled one — a cancelled-with-fee booking is a live
 * receivable. COALESCE'd to 0 so a booking with neither (never priced, or cancelled with no fee
 * assessed) resolves to a real number rather than NULLing out a sum it's added into. SQLite
 * cannot reference a SELECT alias inside an expression, so this is spliced into SELECT, WHERE and
 * ORDER BY rather than aliased once.
 */
const BASE_AMOUNT_SQL =
  "COALESCE(CASE WHEN b.Status = 'cancelled' THEN b.CancellationFee ELSE b.EstCost END, 0)";

/**
 * What a booking TOTALS to owing: the base amount above PLUS any extra charges logged against it
 * (BookingCharges) — a charge is owed on a stay that happened whether or not it was later
 * cancelled, and EstCost/CancellationFee are never mutated to absorb it. This is the single
 * "how much is this booking worth" figure the earnings payload's outstanding predicate is built
 * on (see `OUTSTANDING_WHERE_SQL` below), and `CREDITABLE_AMOUNT_SQL` reuses it too, so a charge
 * logged in the admin panel is never invisible to either. Expects a `chg` subquery
 * (SUM(BookingCharges.Amount) per booking) aliased in scope — see `CHARGES_JOIN_SQL`.
 */
const EXPECTED_AMOUNT_SQL = `(${BASE_AMOUNT_SQL} + COALESCE(chg.Total, 0))`;

/** The extra-charges LEFT JOIN `EXPECTED_AMOUNT_SQL` depends on. Carries one bind param (tenantId). */
const CHARGES_JOIN_SQL = `LEFT JOIN (
         SELECT BookingRequestId, SUM(Amount) AS Total
         FROM BookingCharges WHERE TenantId = ? GROUP BY BookingRequestId
       ) chg ON chg.BookingRequestId = b.Id`;

/**
 * A booking is OUTSTANDING when it is live (confirmed or cancelled — declined rows are never
 * billed) and under-paid once charges are counted. Read only by the earnings payload as of the
 * household-payments rework (0011) — the Venmo importer no longer ranks candidate bookings; it
 * resolves a payer straight to a household via `resolveMatchClient`/`getAccountIdsByOwner` instead
 * (see `server/lib/venmo.ts`). A cancelled booking with no assessed fee but a live charge still
 * surfaces as outstanding. Expects `paid` and `chg` subqueries aliased in scope.
 *
 * `insertPayment`'s guard is the other reader of this rule (it cannot share the SQL — it has no
 * `paid`/`chg` subqueries to hand — so it restates the two ways a terminal row can still owe:
 * a non-zero CancellationFee OR a live charges total). It must keep agreeing with this predicate
 * in both directions, or the Earnings page shows a balance whose *Record payment* button 404s.
 *
 * 'blocked' AND 'external' rows are excluded: 'blocked' rows are never billed, and 'external'
 * rows (mirrored from a connected Google Calendar) always carry a NULL EstCost, so they could
 * never satisfy the under-paid predicate anyway — the exclusion just makes that invariant
 * explicit rather than relying on NULL comparisons to fail closed.
 */
const OUTSTANDING_WHERE_SQL = `b.ServiceType NOT IN ('blocked', 'external')
     AND b.Status IN ('confirmed', 'cancelled')
     AND ${EXPECTED_AMOUNT_SQL} > COALESCE(paid.Total, 0)`;

/**
 * How much of the money received against a booking the sitter may legitimately KEEP. Identical to
 * `EXPECTED_AMOUNT_SQL` for every status except `'declined'`, which is never billed at all (see
 * `insertPayment`'s guard and the outstanding predicate above) and may therefore keep nothing — so a
 * deposit taken on a request the sitter went on to decline is owed back in full, not merely the part
 * above its old quote. Written as a CASE over the expected amount rather than as a second formula,
 * so that "the same figure, minus one status" is literal in the SQL.
 */
const CREDITABLE_AMOUNT_SQL = `(CASE WHEN b.Status = 'declined' THEN 0 ELSE ${EXPECTED_AMOUNT_SQL} END)`;

/**
 * A booking is IN CREDIT when more has been paid against it than it may keep — the exact mirror of
 * `OUTSTANDING_WHERE_SQL`'s arithmetic, and the reason an edit can no longer swallow money in
 * silence: `updateBookingForEdit` re-stamps `EstCost` and returns the row to `'pending'`, so a $250
 * stay paid in full and edited down to $100 left $150 of the customer's money on no screen at all
 * (outstanding asks only whether something is still OWED, and it filters to confirmed/cancelled).
 *
 * **Mutually exclusive with the outstanding predicate, by construction.** For the two statuses
 * outstanding covers, `CREDITABLE_AMOUNT_SQL` IS `EXPECTED_AMOUNT_SQL`, so `expected > paid` and
 * `paid > keepable` cannot both hold; for `'pending'`/`'declined'` outstanding deliberately does not
 * run at all. That is what lets this exist without disturbing the standing rule that
 * `insertPayment`'s guard and `OUTSTANDING_WHERE_SQL` must agree in both directions: a credit is not
 * a payable balance, it is a NEGATIVE one, and the UI gives it no *Record payment* button. There is
 * no refund path in this product — the sitter settles it with her client — so surfacing the figure
 * is the whole job. Expects `paid` and `chg` subqueries aliased in scope.
 */
const CREDIT_WHERE_SQL = `b.ServiceType NOT IN ('blocked', 'external')
     AND COALESCE(paid.Total, 0) > ${CREDITABLE_AMOUNT_SQL}`;

/**
 * The `paid` subquery `CREDIT_WHERE_SQL` and the outstanding predicate both expect in scope. One
 * bind param (tenantId), like `CHARGES_JOIN_SQL`.
 */
const PAYMENTS_JOIN_SQL = `LEFT JOIN (
         SELECT BookingRequestId, SUM(Amount) AS Total
         FROM Payments WHERE TenantId = ? GROUP BY BookingRequestId
       ) paid ON paid.BookingRequestId = b.Id`;

/** How much this booking is over-paid by, as the Earnings page displays it. */
const CREDIT_AMOUNT_SQL = `(COALESCE(paid.Total, 0) - ${CREDITABLE_AMOUNT_SQL})`;

/** The label every kept-overpayment charge carries. One string, so the UI and the ledger agree. */
export const KEPT_OVERPAYMENT_LABEL = 'Overpayment kept';

export type KeepCreditResult =
  { outcome: 'kept'; amount: number } | { outcome: 'not-found' | 'declined' | 'no-credit' };

/**
 * CLOSE AN OVER-PAYMENT THE CLIENT AGREED THE SITTER KEEPS, by logging it as a `BookingCharges` row.
 *
 * The credit was previously display-only: `CREDIT_WHERE_SQL` surfaced the money and nothing could
 * resolve it, so it sat on the Earnings page forever. There are exactly two honest resolutions, and
 * they must not be conflated because they say opposite things about revenue:
 *
 *   - **the money went back** — correct the payment ledger (`deletePayment`, then re-record what was
 *     actually kept). Every earnings figure sums `Payments`, so revenue falls, which is right;
 *   - **the client agreed she keeps it** (toward the next stay, a tip, a rounding) — the money really
 *     was received, so revenue must NOT move. What changes is what this booking is OWED, which is a
 *     charge. That is this function.
 *
 * **The amount is computed in the SQL from the very expressions the Earnings page displays the credit
 * with** (`CREDIT_AMOUNT_SQL` over `CREDITABLE_AMOUNT_SQL`), never passed in — the same doctrine as
 * the cancellation fee, and the reason the charge can never differ from the figure the sitter was
 * shown. `INSERT ... SELECT ... WHERE` (insertPayment's idiom) makes the guard atomic with the write,
 * and the guard IS `CREDIT_WHERE_SQL`: a booking that is not in credit inserts nothing. Since the new
 * charge raises `EXPECTED_AMOUNT_SQL` by exactly the credit, the row afterwards is neither in credit
 * nor outstanding — the two predicates stay mutually exclusive, which is what keeps this from
 * disturbing the standing rule that `insertPayment`'s guard and `OUTSTANDING_WHERE_SQL` must agree in
 * both directions.
 *
 * A `'declined'` row is refused: it may keep NOTHING (`CREDITABLE_AMOUNT_SQL` is 0 for it by rule),
 * so a charge cannot close its credit, and offering the action anyway would be a button that does not
 * work — the mirror of the "balance whose *Record payment* 404s" defect. Its only resolution is the
 * refund path. `serializeAnalytics` publishes `canKeep` from the same rule so the UI never offers it.
 *
 * Reversible by design: deleting the charge re-opens the credit, because both figures are derived
 * rather than stamped.
 */
export async function keepBookingCredit(
  db: D1Database,
  tenantId: string,
  bookingId: string,
): Promise<KeepCreditResult> {
  const id = crypto.randomUUID();
  const inserted = await db
    .prepare(
      `INSERT INTO BookingCharges (Id, TenantId, BookingRequestId, Label, Amount)
       SELECT ?, b.TenantId, b.Id, ?, ${CREDIT_AMOUNT_SQL}
       FROM BookingRequests b
       ${PAYMENTS_JOIN_SQL}
       ${CHARGES_JOIN_SQL}
       WHERE b.TenantId = ? AND b.Id = ? AND b.Status != 'declined' AND ${CREDIT_WHERE_SQL}
       RETURNING Amount`,
    )
    .bind(id, KEPT_OVERPAYMENT_LABEL, tenantId, tenantId, tenantId, bookingId)
    .first<{ Amount: number }>();
  if (inserted) return { outcome: 'kept', amount: inserted.Amount };

  // Refused, and nothing was written. One read to say WHICH refusal, so the sitter is told something
  // she can act on. 'blocked'/'external' rows read as absent, the same existence answer every other
  // money route gives them.
  const row = await db
    .prepare(
      `SELECT b.Status AS Status, ${CREDIT_AMOUNT_SQL} AS Credit
       FROM BookingRequests b
       ${PAYMENTS_JOIN_SQL}
       ${CHARGES_JOIN_SQL}
       WHERE b.TenantId = ? AND b.Id = ? AND b.ServiceType NOT IN ('blocked', 'external')`,
    )
    .bind(tenantId, tenantId, tenantId, bookingId)
    .first<{ Status: string; Credit: number }>();
  if (!row) return { outcome: 'not-found' };
  // "Nothing to close" is checked first: it is the more useful thing to say even about a declined
  // row, and it is the answer to a double-click on a credit that has already been closed.
  if (row.Credit <= 0) return { outcome: 'no-credit' };
  return row.Status === 'declined' ? { outcome: 'declined' } : { outcome: 'no-credit' };
}

/**
 * HOUSEHOLD BALANCES — what each household owes, rather than what each booking owes.
 *
 * The sitter's question is "does Jennifer owe me anything?", and until now the dashboard could only
 * answer it one booking at a time. A household is not a new concept: it is the connected component
 * of the owner<->pet graph that `buildAccounts` already derives for invoice numbering, which is why
 * two customers who share a single pet get one statement here as they do there.
 *
 * Payments are per-booking rows by default; a household is a set of bookings; so the bulk of this
 * rollup is a sum over data that already existed before this feature shipped. Migration 0011 later
 * added `Payments.AccountId` for payments that settle a household directly rather than one booking
 * (see `computeHouseholdRollup`'s account-payments read below) — those rows are the one piece of
 * schema this rollup now depends on that did not exist when it first shipped.
 *
 * ONE MONEY RULE, not a second one. `Expected` is `CREDITABLE_AMOUNT_SQL` verbatim — the quote, or
 * the assessed cancellation fee on a cancelled row, plus extra charges, and zero for a request that
 * was declined (never billed, so every dollar taken against it is the client's). Reusing exactly
 * that expression is what makes a household balance reconcile to the per-booking Earnings lists it
 * sits above: summed over a household, `Expected - Paid` is precisely its outstanding rows minus its
 * credit rows, because those two predicates are mutually exclusive over this same figure. Writing a
 * fresh "what a booking is worth" expression here would be the drift this codebase exists to
 * prevent.
 *
 * NETTING happens WITHIN a household and never across households. A credit on one booking cancelling
 * a debt on another IS the household statement. Two different households are two rows, and the
 * earnings tiles keep reporting `outstandingTotal` and `creditTotal` separately (see
 * `serializeAnalytics`) — one client owing $100 while another is owed $100 is not a settled book.
 *
 * Six tenant-scoped reads, composed by the pure `buildHouseholdBalances`: the per-booking money,
 * the booking<->pet edges (BookingRequestPets has no TenantId, so tenancy flows through its parent
 * booking, the idiom everywhere else in this file), the owner<->pet edges the graph is built from,
 * the customers themselves so a balance can carry a name, the household-level account payments
 * (`Payments.AccountId`, see above), and the deceased-pet owner edges needed to anchor a payment to
 * its household even after every pet on it has died. Deceased pets are excluded from the primary
 * owner<->pet read by `listOwnerPetLinks`, as the pure module requires; the deceased edges are fed
 * in separately as anchors, never as ordinary graph edges.
 */
export async function getHouseholdBalances(
  db: D1Database,
  tenantId: string,
): Promise<HouseholdBalanceRow[]> {
  return (await computeHouseholdRollup(db, tenantId)).households;
}

/**
 * HOUSEHOLD PAYMENTS THAT BELONG TO NO HOUSEHOLD — money received, still counted as revenue by
 * every `Payments` aggregate, and attachable to nobody. Summed per stored account id.
 *
 * How a payment gets here at all: `Payments.AccountId` holds a PET id, and `deleteCustomer`
 * cascades a pet nobody else owns — row and owner edges together — while deliberately never
 * touching `Payments`. Once those edges are gone, no graph in this database can say which
 * household the payment settled. A pet that merely DIED is NOT in this list: it keeps its owner
 * edges, so `buildPaymentAnchors` still resolves it to its own household.
 *
 * Reported rather than guessed at, and rather than dropped. Guessing a household for money is the
 * one thing this codebase refuses to do anywhere (`buildAccounts` refuses it, the Venmo importer
 * refuses it); dropping it is worse still, because the analytics revenue line goes on counting it.
 * `Σ household paidTotal + Σ orphaned = revenue` is the invariant that makes the two views agree,
 * and it is only true because this list exists.
 */
export async function getOrphanedAccountPayments(
  db: D1Database,
  tenantId: string,
): Promise<{ accountId: string; total: number }[]> {
  return (await computeHouseholdRollup(db, tenantId)).orphanedPayments;
}

type HouseholdRollup = {
  households: HouseholdBalanceRow[];
  orphanedPayments: { accountId: string; total: number }[];
};

async function computeHouseholdRollup(db: D1Database, tenantId: string): Promise<HouseholdRollup> {
  const [moneyRes, petsRes, links, ownersRes, accountPaidRes, deceasedLinks] = await Promise.all([
    db
      .prepare(
        `SELECT b.Id AS BookingId, b.EndUserId AS EndUserId,
                ${CREDITABLE_AMOUNT_SQL} AS Expected,
                COALESCE(paid.Total, 0) AS PaidTotal
         FROM BookingRequests b
         ${PAYMENTS_JOIN_SQL}
         ${CHARGES_JOIN_SQL}
         WHERE b.TenantId = ? AND b.ServiceType NOT IN ('blocked', 'external')
         ORDER BY b.StartDate, b.Id`,
      )
      .bind(tenantId, tenantId, tenantId)
      .all<{ BookingId: string; EndUserId: string | null; Expected: number; PaidTotal: number }>(),
    db
      .prepare(
        `SELECT brp.BookingRequestId AS BookingId, brp.PetId AS PetId
         FROM BookingRequestPets brp
         JOIN BookingRequests b ON b.Id = brp.BookingRequestId
         WHERE b.TenantId = ?
         ORDER BY brp.BookingRequestId, brp.PetId`,
      )
      .bind(tenantId)
      .all<{ BookingId: string; PetId: string }>(),
    listOwnerPetLinks(db, tenantId),
    db
      .prepare('SELECT Id, Name, Email FROM EndUsers WHERE TenantId = ? ORDER BY Id')
      .bind(tenantId)
      .all<{ Id: string; Name: string | null; Email: string | null }>(),
    // Payments recorded against a HOUSEHOLD rather than a booking (0011), summed per stored account
    // id. The pure module resolves each id to its household by membership, so a household renamed by
    // a newly-added pet keeps every payment ever filed against it.
    db
      .prepare(
        `SELECT AccountId, SUM(Amount) AS Total
         FROM Payments WHERE TenantId = ? AND AccountId IS NOT NULL GROUP BY AccountId`,
      )
      .bind(tenantId)
      .all<{ AccountId: string; Total: number }>(),
    // Owner edges of DECEASED pets, which form no account and name none — they only let a payment
    // filed under a pet that has since died still resolve to the household that made it.
    listDeceasedOwnerPetLinks(db, tenantId),
  ]);

  const petsByBooking = new Map<string, string[]>();
  for (const row of petsRes.results) {
    const pets = petsByBooking.get(row.BookingId) ?? [];
    pets.push(row.PetId);
    petsByBooking.set(row.BookingId, pets);
  }
  const people = new Map(ownersRes.results.map((o) => [o.Id, o]));

  const { households, unattachedPaymentAccountIds } = buildHouseholdBalances({
    links: links.map((l) => ({ ownerId: l.EndUserId, petId: l.PetId })),
    anchorLinks: deceasedLinks.map((l) => ({ ownerId: l.EndUserId, petId: l.PetId })),
    bookings: moneyRes.results.map((row) => ({
      bookingId: row.BookingId,
      ownerId: row.EndUserId,
      petIds: petsByBooking.get(row.BookingId) ?? [],
      expected: row.Expected,
      paid: row.PaidTotal,
    })),
    payments: accountPaidRes.results.map((row) => ({
      accountId: row.AccountId,
      amount: row.Total,
    })),
  });

  // `unattachedBookingIds` is deliberately not published: those bookings are still visible one by
  // one in `outstanding`/`credits`, which is where their money already shows up. What must never
  // happen is attaching them to a household they are not in, which is why the pure module returns
  // them separately rather than guessing.
  //
  // `unattachedPaymentAccountIds` IS published (see `getOrphanedAccountPayments`), and the
  // asymmetry is the point: an unattached booking's money is still readable somewhere else on the
  // page, whereas a household payment appears in exactly one place. Dropped here it would be
  // invisible everywhere while `Payments` kept counting it as revenue.
  const orphanedTotals = new Map(accountPaidRes.results.map((r) => [r.AccountId, r.Total]));
  return {
    households: households.map((h) => ({
      accountId: h.accountId,
      owners: h.ownerIds.map((id) => ({
        endUserId: id,
        name: people.get(id)?.Name ?? null,
        email: people.get(id)?.Email ?? null,
      })),
      petIds: h.petIds,
      anchorPetIds: h.anchorPetIds,
      bookingIds: h.bookingIds,
      expectedTotal: h.expectedTotal,
      paidTotal: h.paidTotal,
      balance: h.balance,
    })),
    orphanedPayments: unattachedPaymentAccountIds.map((accountId) => ({
      accountId,
      total: orphanedTotals.get(accountId) ?? 0,
    })),
  };
}

/**
 * THE DRILL-DOWN BEHIND ONE HOUSEHOLD BALANCE (Story 2.4, FR-7c) — every booking, its cost, its
 * extra charges, and every payment, so a sitter questioning a number can settle a dispute or check
 * a cancellation fee without leaving it.
 *
 * Finds the household by asking `getHouseholdBalances` for the whole tenant and matching by
 * MEMBERSHIP (`petIds.includes(accountId)`), the same resolution every other household read uses —
 * deliberately NOT a second, narrower query, because a second query is a second place the account-id-
 * renaming rule (see the 0011 migration header) could be forgotten. `expectedTotal`/`paidTotal`/
 * `balance` are that household's own fields, passed through rather than recomputed, so this can
 * never print a number the balance above it disagrees with.
 *
 * Each booking's `cost` and `expected` are read with the SAME `BASE_AMOUNT_SQL`/
 * `CREDITABLE_AMOUNT_SQL` expressions the household sum is built from (declined zeroed, cancelled
 * reading its assessed fee), which is what makes `Σ(bookings[].expected) === expectedTotal` a fact
 * of the SQL rather than a coincidence two readers happen to agree on today.
 */
type HouseholdDetailBookingRow = {
  BookingId: string;
  ServiceType: string;
  StartDate: string;
  Status: string;
  Cost: number;
  ChargesTotal: number;
  PaidTotal: number;
  Expected: number;
};

/**
 * The account graph in one place: the components `buildAccounts` derives, plus the payment anchors
 * that keep a dead pet's payments findable. Two small, tenant-indexed reads of `PetOwners` — no
 * money, no bookings — loaded ONCE per request so that resolving "which household is this?" and
 * then reading that household do not each pay for their own copy.
 */
async function loadAccountGraph(db: D1Database, tenantId: string) {
  const [links, deceasedLinks] = await Promise.all([
    listOwnerPetLinks(db, tenantId),
    listDeceasedOwnerPetLinks(db, tenantId),
  ]);
  const linkPairs = links.map((l) => ({ ownerId: l.EndUserId, petId: l.PetId }));
  const anchorPairs = deceasedLinks.map((l) => ({ ownerId: l.EndUserId, petId: l.PetId }));
  const accounts = buildAccounts(linkPairs);
  return {
    links: linkPairs,
    anchorLinks: anchorPairs,
    accounts,
    anchors: buildPaymentAnchors(accounts, anchorPairs),
  };
}

type AccountGraph = Awaited<ReturnType<typeof loadAccountGraph>>;

/**
 * One household, found by account id or by one of its owners, together with every pet id a payment
 * of it may be filed under (its live pets plus its anchors — see `householdPetIds`).
 */
function resolveHousehold(
  graph: AccountGraph,
  by: { accountId: string } | { ownerId: string },
): { account: Account; paymentPetIds: string[] } | null {
  const account =
    'ownerId' in by
      ? graph.accounts.find((a) => a.ownerIds.includes(by.ownerId))
      : graph.accounts.find(
          (a) => a.petIds.includes(by.accountId) || a.id === graph.anchors.get(by.accountId),
        );
  if (!account) return null;
  const anchorPetIds = [...graph.anchors.entries()]
    .filter(([, id]) => id === account.id)
    .map(([petId]) => petId);
  return { account, paymentPetIds: [...account.petIds, ...anchorPetIds] };
}

/**
 * ONE household's statement, read WITHOUT reading the tenant.
 *
 * The bookings that can possibly belong to this household are exactly those whose customer is one
 * of its owners, or which name one of its pets — everything else attaches elsewhere by
 * `buildHouseholdBalances`'s own rule, whatever it is. So that predicate is asked of SQL, and the
 * pure module is then handed the FULL owner<->pet graph (already loaded, and cheap) together with
 * only those candidate bookings. It attaches each one exactly as it would have in the tenant-wide
 * pass — including the edge case where a booking's customer holds no live pet and it falls back to
 * the lexicographically-first of its pets' households, which is why the candidates' pets are read
 * too and why the graph passed in is not narrowed. A candidate that turns out to belong to someone
 * else lands in someone else's row here and is simply not read.
 *
 * This is a NARROWING, never a second money rule: `BASE_AMOUNT_SQL`/`CREDITABLE_AMOUNT_SQL`,
 * `PAYMENTS_JOIN_SQL`, `CHARGES_JOIN_SQL` and `buildHouseholdBalances` are the same expressions
 * `getHouseholdBalances` sums for the Earnings page, so the drill-down and the balance above it
 * cannot drift.
 */
async function householdDetailFor(
  db: D1Database,
  tenantId: string,
  graph: AccountGraph,
  resolved: { account: Account; paymentPetIds: string[] },
): Promise<HouseholdDetailRow | null> {
  const { account, paymentPetIds } = resolved;
  const owners = account.ownerIds.map(() => '?').join(', ');
  const pets = account.petIds.map(() => '?').join(', ');
  const paymentPets = paymentPetIds.map(() => '?').join(', ');
  // "Mine, or possibly mine": customer is one of ours, or a pet of ours is on it. A superset of
  // this household's bookings, and never the whole tenant's.
  const candidateWhere = `b.TenantId = ? AND b.ServiceType NOT IN ('blocked', 'external')
       AND (b.EndUserId IN (${owners})
            OR b.Id IN (SELECT BookingRequestId FROM BookingRequestPets WHERE PetId IN (${pets})))`;
  const candidateArgs = [tenantId, ...account.ownerIds, ...account.petIds];

  const [bookingRes, paymentRows] = await Promise.all([
    db
      .prepare(
        `SELECT b.Id AS BookingId, b.EndUserId AS EndUserId, b.ServiceType AS ServiceType,
                b.StartDate AS StartDate, b.Status AS Status,
                ${BASE_AMOUNT_SQL} AS Cost,
                COALESCE(chg.Total, 0) AS ChargesTotal,
                COALESCE(paid.Total, 0) AS PaidTotal,
                ${CREDITABLE_AMOUNT_SQL} AS Expected
         FROM BookingRequests b
         ${PAYMENTS_JOIN_SQL}
         ${CHARGES_JOIN_SQL}
         WHERE ${candidateWhere}
         ORDER BY b.StartDate, b.Id`,
      )
      .bind(tenantId, tenantId, ...candidateArgs)
      .all<HouseholdDetailBookingRow & { EndUserId: string | null }>(),
    // The household's own payments, read once and used twice: summed into `paidTotal` by the pure
    // module and listed as `householdPayments`. Literally the same rows, so the statement can never
    // list a payment the balance did not count.
    db
      .prepare(
        `SELECT Id, TenantId, BookingRequestId, AccountId, Amount, Method, PaidDate, Note, CreatedAt
         FROM Payments
         WHERE TenantId = ? AND AccountId IN (${paymentPets})
         ORDER BY PaidDate DESC, CreatedAt DESC`,
      )
      .bind(tenantId, ...paymentPetIds)
      .all<PaymentRow>(),
  ]);

  const candidateIds = bookingRes.results.map((r) => r.BookingId);
  const idList = candidateIds.map(() => '?').join(', ');
  const [petsRes, chargeRes] = await Promise.all([
    candidateIds.length === 0
      ? Promise.resolve({ results: [] as { BookingId: string; PetId: string }[] })
      : db
          .prepare(
            `SELECT BookingRequestId AS BookingId, PetId
             FROM BookingRequestPets WHERE BookingRequestId IN (${idList})
             ORDER BY BookingRequestId, PetId`,
          )
          .bind(...candidateIds)
          .all<{ BookingId: string; PetId: string }>(),
    candidateIds.length === 0
      ? Promise.resolve({ results: [] as BookingChargeRow[] })
      : db
          .prepare(
            `SELECT Id, TenantId, BookingRequestId, Label, Amount, Origin, CreatedAt
             FROM BookingCharges WHERE TenantId = ? AND BookingRequestId IN (${idList})
             ORDER BY BookingRequestId, CreatedAt, Id`,
          )
          .bind(tenantId, ...candidateIds)
          .all<BookingChargeRow>(),
  ]);

  const petsByBooking = new Map<string, string[]>();
  for (const row of petsRes.results) {
    const list = petsByBooking.get(row.BookingId) ?? [];
    list.push(row.PetId);
    petsByBooking.set(row.BookingId, list);
  }

  const { households } = buildHouseholdBalances({
    links: graph.links,
    anchorLinks: graph.anchorLinks,
    bookings: bookingRes.results.map((row) => ({
      bookingId: row.BookingId,
      ownerId: row.EndUserId,
      petIds: petsByBooking.get(row.BookingId) ?? [],
      expected: row.Expected,
      paid: row.PaidTotal,
    })),
    payments: paymentRows.results.map((p) => ({ accountId: p.AccountId!, amount: p.Amount })),
  });
  // Dropped by the pure module when this household has no bookings AND no payments — "nothing
  // recorded either side", which every caller already renders as an empty statement rather than an
  // error, exactly as it did when this read the whole tenant.
  const household = households.find((h) => h.accountId === account.id);
  if (!household) return null;

  return assembleHouseholdDetail(
    household,
    new Map(bookingRes.results.map((r) => [r.BookingId, r])),
    groupChargesByBooking(chargeRes.results),
    paymentRows.results,
  );
}

/** `BookingCharges` rows keyed by their booking, in the order the query returned them. */
function groupChargesByBooking(
  rows: BookingChargeRow[],
): Map<string, { id: string; label: string; amount: number }[]> {
  const byBooking = new Map<string, { id: string; label: string; amount: number }[]>();
  for (const row of rows) {
    const list = byBooking.get(row.BookingRequestId) ?? [];
    list.push({ id: row.Id, label: row.Label, amount: row.Amount });
    byBooking.set(row.BookingRequestId, list);
  }
  return byBooking;
}

/**
 * ONE household's rows turned into its statement — pure, and shared by BOTH readers below
 * (`householdDetailFor`, which narrows its queries to one household, and `bulkHouseholdDetails`,
 * which reads the tenant once and slices it). Shared deliberately: the two differ only in HOW the
 * rows were fetched, and a second copy of this assembly is a second place the drill-down could
 * drift from the balance above it.
 *
 * `household` is whatever `buildHouseholdBalances` returned for this account — its totals are
 * passed through, never recomputed here.
 */
function assembleHouseholdDetail(
  household: {
    accountId: string;
    bookingIds: string[];
    expectedTotal: number;
    paidTotal: number;
    balance: number;
  },
  bookingsById: Map<string, HouseholdDetailBookingRow>,
  chargesByBooking: Map<string, { id: string; label: string; amount: number }[]>,
  payments: PaymentRow[],
): HouseholdDetailRow {
  return {
    accountId: household.accountId,
    // `household.bookingIds` is already ordered (the booking query sorts by StartDate, then Id)
    // — reusing that order keeps the detail list in the same sequence a sitter would expect a
    // statement to read in, for both callers: the IN-clause `householdDetailFor` issues and the
    // tenant-wide, no-IN-clause read `bulkHouseholdDetails` issues.
    bookings: household.bookingIds.map((bookingId) => {
      const row = bookingsById.get(bookingId)!;
      return {
        bookingId,
        serviceType: row.ServiceType,
        startDate: row.StartDate,
        status: row.Status,
        cost: row.Cost,
        charges: chargesByBooking.get(bookingId) ?? [],
        chargesTotal: row.ChargesTotal,
        paidTotal: row.PaidTotal,
        expected: row.Expected,
      };
    }),
    householdPayments: payments.map((p) => ({
      id: p.Id,
      amount: p.Amount,
      method: p.Method,
      paidDate: p.PaidDate,
      note: p.Note,
    })),
    expectedTotal: household.expectedTotal,
    paidTotal: household.paidTotal,
    balance: household.balance,
  };
}

/**
 * THE SAME STATEMENT AS `householdDetailFor`, FOR MANY HOUSEHOLDS, IN A FIXED NUMBER OF QUERIES.
 *
 * `householdDetailFor` costs FOUR queries per household. That is right for the one-household
 * callers it serves, and wrong the moment a caller wants every household of a tenant: the payment
 * attribution panel always previews tenant-wide, and 53 households × 4 is 212 binding calls in one
 * invocation — past Workers' 50-subrequest ceiling (Free plan) before the request does anything
 * else. That is not a slow preview, it is a preview that cannot run at all; see
 * `docs/superpowers/specs/2026-08-09-calendar-backfill-design.md` for the same budget being
 * respected elsewhere, and `server/lib/payment-csv.ts` for the same hoist-to-a-constant answer.
 *
 * So this reads the TENANT once — three queries, plus the household payments and the account graph
 * its caller already holds — and slices the result per household in memory. THREE, whether the
 * tenant has one household or a thousand.
 *
 * NO `IN (…)` LIST, HENCE NO CHUNKING AND NO VARIABLE-LIMIT ARITHMETIC TO GET WRONG: each query is
 * scoped by `TenantId` alone and binds at most three parameters (the two join subqueries plus the
 * WHERE), so the count is fixed by the code rather than by the data. These are the same tenant-wide
 * predicates `computeHouseholdRollup` already runs for the Earnings page, so the volume read here
 * is a volume this codebase already reads on its hottest admin page.
 *
 * IDENTICAL OUTPUT, NOT MERELY SIMILAR. `buildHouseholdBalances` attaches every booking to EXACTLY
 * ONE household by its own rule, so a household's row is the same whether the pure module was
 * handed that household's candidate bookings (what `householdDetailFor` does) or the tenant's
 * entire set — the bookings that belong elsewhere simply land elsewhere, as its own doc comment
 * says. The money expressions, the orderings and the assembly (`assembleHouseholdDetail`) are
 * literally the same code, so the drill-down cannot drift from the per-household reader either.
 *
 * `payments` is the caller's already-loaded set of tenant household payments, passed in rather than
 * re-read: bucketing it here by the SAME membership rule (`householdIdForPet`) is what makes each
 * household's `householdPayments` exactly the list `AccountId IN (petIds ∪ anchors)` would return.
 */
async function bulkHouseholdDetails(
  db: D1Database,
  tenantId: string,
  graph: AccountGraph,
  wantedAccountIds: Set<string>,
  payments: PaymentRow[],
  paymentsByHousehold: Map<string, PaymentRow[]>,
): Promise<Map<string, HouseholdDetailRow>> {
  const [bookingRes, petsRes, chargeRes] = await Promise.all([
    db
      .prepare(
        `SELECT b.Id AS BookingId, b.EndUserId AS EndUserId, b.ServiceType AS ServiceType,
                b.StartDate AS StartDate, b.Status AS Status,
                ${BASE_AMOUNT_SQL} AS Cost,
                COALESCE(chg.Total, 0) AS ChargesTotal,
                COALESCE(paid.Total, 0) AS PaidTotal,
                ${CREDITABLE_AMOUNT_SQL} AS Expected
         FROM BookingRequests b
         ${PAYMENTS_JOIN_SQL}
         ${CHARGES_JOIN_SQL}
         WHERE b.TenantId = ? AND b.ServiceType NOT IN ('blocked', 'external')
         ORDER BY b.StartDate, b.Id`,
      )
      .bind(tenantId, tenantId, tenantId)
      .all<HouseholdDetailBookingRow & { EndUserId: string | null }>(),
    // BookingRequestPets carries no TenantId; tenancy flows through its parent booking, the idiom
    // `computeHouseholdRollup` uses for the same edges.
    db
      .prepare(
        `SELECT brp.BookingRequestId AS BookingId, brp.PetId AS PetId
         FROM BookingRequestPets brp
         JOIN BookingRequests b ON b.Id = brp.BookingRequestId
         WHERE b.TenantId = ?
         ORDER BY brp.BookingRequestId, brp.PetId`,
      )
      .bind(tenantId)
      .all<{ BookingId: string; PetId: string }>(),
    db
      .prepare(
        `SELECT Id, TenantId, BookingRequestId, Label, Amount, Origin, CreatedAt
         FROM BookingCharges WHERE TenantId = ?
         ORDER BY BookingRequestId, CreatedAt, Id`,
      )
      .bind(tenantId)
      .all<BookingChargeRow>(),
  ]);

  const petsByBooking = new Map<string, string[]>();
  for (const row of petsRes.results) {
    const list = petsByBooking.get(row.BookingId) ?? [];
    list.push(row.PetId);
    petsByBooking.set(row.BookingId, list);
  }

  const { households } = buildHouseholdBalances({
    links: graph.links,
    anchorLinks: graph.anchorLinks,
    bookings: bookingRes.results.map((row) => ({
      bookingId: row.BookingId,
      ownerId: row.EndUserId,
      petIds: petsByBooking.get(row.BookingId) ?? [],
      expected: row.Expected,
      paid: row.PaidTotal,
    })),
    payments: payments.map((p) => ({ accountId: p.AccountId!, amount: p.Amount })),
  });

  const bookingsById = new Map(bookingRes.results.map((r) => [r.BookingId, r]));
  const chargesByBooking = groupChargesByBooking(chargeRes.results);
  const details = new Map<string, HouseholdDetailRow>();
  for (const household of households) {
    if (!wantedAccountIds.has(household.accountId)) continue;
    details.set(
      household.accountId,
      assembleHouseholdDetail(
        household,
        bookingsById,
        chargesByBooking,
        paymentsByHousehold.get(household.accountId) ?? [],
      ),
    );
  }
  return details;
}

export async function getHouseholdDetail(
  db: D1Database,
  tenantId: string,
  accountId: string,
): Promise<HouseholdDetailRow | null> {
  const graph = await loadAccountGraph(db, tenantId);
  // Membership over the component's pets OR its payment anchors: an account id from before the
  // first-sorted pet DIED is still this household's id as far as the money filed under it is
  // concerned, and a drill-down that 404'd on it would strand the payment it lists.
  const resolved = resolveHousehold(graph, { accountId });
  return resolved ? householdDetailFor(db, tenantId, graph, resolved) : null;
}

/**
 * EVERY HOUSEHOLD OF A TENANT THAT HOLDS AT LEAST ONE UNAPPLIED CREDIT, together with its detail
 * (the bookings a credit might attribute against) and the credits themselves — everything the
 * payment-attribution preview (Task 3) needs, in a number of reads that does NOT grow with how
 * many households the tenant has.
 *
 * CONSTANT MEANS CONSTANT — SIX QUERIES, FOR ANY TENANT. Not "constant apart from the detail
 * reads", which is what this used to be and what made the feature unusable on the account it was
 * built for: the graph and the payments were hoisted, the per-household detail was not, so a
 * 53-household tenant issued 4 × 53 + 4 = 216 binding calls in one invocation and blew straight
 * past Workers' 50-subrequest ceiling (Free plan). Every click of "Check for unattached credits"
 * failed. That is the same budget the calendar backfill's 200-event cap and the CSV importer's
 * hoist to a constant 7 subrequests exist to protect.
 *
 * The six: two for the account graph (`loadAccountGraph`), one for every household-level payment
 * of the tenant (`Payments WHERE AccountId IS NOT NULL` — the same predicate
 * `listPaymentsForAccount` applies per household), and three for `bulkHouseholdDetails`, which
 * reads the tenant's bookings, booking<->pet edges and charges once each and slices them per
 * household in memory. A tenant with no household credits at all pays only the first three: the
 * bulk read is skipped outright rather than issued and discarded.
 *
 * MEMBERSHIP, NEVER `AccountId = ?` EQUALITY. Payments are bucketed into households through
 * `householdIdForPet` — every account's live pets PLUS the anchors of pets that have since died
 * (`buildPaymentAnchors`) — which is exactly what `householdPetIds` resolves for a single
 * household, built once here for the whole tenant. An account id is its component's
 * lexicographically-first pet and MOVES when a pet is added, so equality would silently lose the
 * money filed under the household's older name.
 *
 * Deliberately NOT a change to `getHouseholdDetail`/`listPaymentsForAccount` themselves — a single
 * account id is one household and already cheap, and every other caller of either wants exactly
 * one household, not the whole tenant. `bulkHouseholdDetails` is a second PATH to the same rows,
 * sharing this one's money expressions, orderings and assembly step, not a rewrite of the
 * one-household reader out from under its callers.
 */
export type HouseholdAttributionCandidate = {
  accountId: string;
  detail: HouseholdDetailRow;
  credits: PaymentRow[];
};

export async function getHouseholdsWithUnappliedCredits(
  db: D1Database,
  tenantId: string,
): Promise<HouseholdAttributionCandidate[]> {
  const [graph, paymentsRes] = await Promise.all([
    loadAccountGraph(db, tenantId),
    // Column list identical to listPaymentsForAccount's — every household-level payment of the
    // tenant, in one query instead of one per household.
    db
      .prepare(
        `SELECT Id, TenantId, BookingRequestId, AccountId, Amount, Method, PaidDate, Note, CreatedAt
         FROM Payments WHERE TenantId = ? AND AccountId IS NOT NULL
         ORDER BY PaidDate DESC, CreatedAt DESC`,
      )
      .bind(tenantId)
      .all<PaymentRow>(),
  ]);

  // Every pet id a payment may be filed under, mapped to the household it resolves to — live pets
  // of each account, PLUS anchors for pets that have since died (buildPaymentAnchors) — the exact
  // membership `householdPetIds` computes per call, built once here for the whole tenant instead.
  const householdIdForPet = new Map<string, string>();
  for (const account of graph.accounts) {
    for (const petId of account.petIds) householdIdForPet.set(petId, account.id);
  }
  for (const [petId, accountId] of graph.anchors) householdIdForPet.set(petId, accountId);

  const creditsByHousehold = new Map<string, PaymentRow[]>();
  for (const row of paymentsRes.results) {
    const accountId = row.AccountId === null ? undefined : householdIdForPet.get(row.AccountId);
    // No household resolves this pet id (a `deleteCustomer` cascade orphaned it) — that payment is
    // `getOrphanedAccountPayments`'s territory, not attributable to any household here.
    if (!accountId) continue;
    const list = creditsByHousehold.get(accountId) ?? [];
    list.push(row);
    creditsByHousehold.set(accountId, list);
  }

  // In account-id order, which `buildAccounts` already sorted — the order the preview reports its
  // proposals in, and stable across runs.
  const wanted = graph.accounts.filter((account) => creditsByHousehold.has(account.id));
  // Nothing prepaid anywhere: no household has a credit to place, so there is nothing for the bulk
  // detail read to be read FOR. Skipped rather than issued and thrown away.
  if (wanted.length === 0) return [];

  const details = await bulkHouseholdDetails(
    db,
    tenantId,
    graph,
    new Set(wanted.map((account) => account.id)),
    paymentsRes.results,
    // A household's credits ARE its household-level payments: `Payments.AccountId` and
    // `BookingRequestId` are mutually exclusive by CHECK, so the list bucketed above is the same
    // list `householdPayments` must show. One bucketing, both uses — they cannot disagree.
    creditsByHousehold,
  );
  return wanted.flatMap((account) => {
    const detail = details.get(account.id);
    // `buildHouseholdBalances` drops a household with no bookings AND no payments; this one has a
    // credit, so it is always present. Guarded anyway, to hold the same "empty statement, not an
    // error" contract `householdDetailFor` has.
    if (!detail) return [];
    return [{ accountId: account.id, detail, credits: creditsByHousehold.get(account.id)! }];
  });
}

/**
 * The SAME statement, asked by the CUSTOMER whose household it is (`GET /:slug/account`).
 *
 * Exists so the customer-facing route resolves its household and reads it from ONE loaded graph
 * rather than loading it twice — once to turn `endUserId` into an account id, once to read that
 * account id back. `accountId` comes back beside the detail because a caller who holds no live pet
 * has no household at all: that is `null` and an empty statement, not an error (see `getMyAccount`).
 */
export async function getHouseholdDetailForOwner(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<{ accountId: string | null; detail: HouseholdDetailRow | null }> {
  const graph = await loadAccountGraph(db, tenantId);
  const resolved = resolveHousehold(graph, { ownerId: endUserId });
  if (!resolved) return { accountId: null, detail: null };
  return {
    accountId: resolved.account.id,
    detail: await householdDetailFor(db, tenantId, graph, resolved),
  };
}

export async function getAnalytics(
  db: D1Database,
  tenantId: string,
  today: string,
): Promise<AnalyticsData> {
  // Last 12 calendar months ending with today's month, oldest first (e.g. '2025-08'..'2026-07').
  const [y, m] = today.split('-').map(Number);
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const windowStart = `${months[0]}-01`;
  // Exclusive upper bound: first day of the month AFTER today's month. Without it, a future-dated
  // payment (post-dated deposit, clock skew) would be summed into `Total` by SQL then discarded by
  // the zero-fill map below since its month key isn't in `months` — silently dropping real revenue
  // from the response instead of excluding it up front.
  const nextMonth = new Date(Date.UTC(y, m, 1));
  const windowEnd = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`;

  // Started before the aggregate round trip and awaited after it, so the household rollup rides
  // alongside the five aggregates rather than adding a serial hop to the dashboard's hottest read.
  // ONE rollup call gives both halves of the money: what each household holds, and what belongs to
  // no household at all. Asking twice would read the whole tenant twice to answer one question.
  const householdsPending = computeHouseholdRollup(db, tenantId);

  const [monthlyRes, byServiceRes, topClientsRes, outstandingRes, creditsRes] = await Promise.all([
    db
      .prepare(
        `SELECT substr(PaidDate, 1, 7) AS Month, SUM(Amount) AS Total
         FROM Payments WHERE TenantId = ? AND PaidDate >= ? AND PaidDate < ?
         GROUP BY Month`,
      )
      .bind(tenantId, windowStart, windowEnd)
      .all<AnalyticsData['monthly'][number]>(),
    db
      .prepare(
        `SELECT b.ServiceType AS ServiceType, COALESCE(s.Label, b.ServiceType) AS Label,
                SUM(p.Amount) AS Total
         FROM Payments p
         JOIN BookingRequests b ON b.Id = p.BookingRequestId AND b.TenantId = p.TenantId
         LEFT JOIN TenantServices s ON s.TenantId = p.TenantId AND s.ServiceType = b.ServiceType
         WHERE p.TenantId = ?
         GROUP BY b.ServiceType
         ORDER BY Total DESC`,
      )
      .bind(tenantId)
      .all<AnalyticsData['byService'][number]>(),
    db
      .prepare(
        `SELECT b.EndUserId AS EndUserId, u.Name AS Name, u.Email AS Email,
                SUM(p.Amount) AS Total, COUNT(DISTINCT p.BookingRequestId) AS Bookings
         FROM Payments p
         JOIN BookingRequests b ON b.Id = p.BookingRequestId AND b.TenantId = p.TenantId
         LEFT JOIN EndUsers u ON u.Id = b.EndUserId AND u.TenantId = b.TenantId
         WHERE p.TenantId = ? AND b.EndUserId IS NOT NULL
         GROUP BY b.EndUserId
         ORDER BY Total DESC
         LIMIT 10`,
      )
      .bind(tenantId)
      .all<AnalyticsData['topClients'][number]>(),
    db
      .prepare(
        // EstCost here is the BASE amount only (quote/fee, no charges) — ChargesTotal is reported
        // separately so the UI can show the two apart (see serializeAnalytics). The outstanding
        // predicate and ORDER BY use EXPECTED_AMOUNT_SQL (base + charges) so a cancelled booking
        // with no assessed fee but a live charge still surfaces here. Declined (and any other
        // non-confirmed/cancelled) rows are excluded outright — never billed.
        `SELECT b.Id AS BookingId, u.Name AS Name, u.Email AS Email,
                b.ServiceType AS ServiceType, b.StartDate AS StartDate, b.Status AS Status,
                ${BASE_AMOUNT_SQL} AS EstCost,
                COALESCE(chg.Total, 0) AS ChargesTotal,
                COALESCE(paid.Total, 0) AS PaidTotal
         FROM BookingRequests b
         LEFT JOIN EndUsers u ON u.Id = b.EndUserId AND u.TenantId = b.TenantId
         LEFT JOIN (
           SELECT BookingRequestId, SUM(Amount) AS Total
           FROM Payments WHERE TenantId = ? GROUP BY BookingRequestId
         ) paid ON paid.BookingRequestId = b.Id
         ${CHARGES_JOIN_SQL}
         WHERE b.TenantId = ? AND ${OUTSTANDING_WHERE_SQL}
         ORDER BY (${EXPECTED_AMOUNT_SQL}) - COALESCE(paid.Total, 0) DESC`,
      )
      .bind(tenantId, tenantId, tenantId)
      .all<AnalyticsData['outstanding'][number]>(),
    db
      .prepare(
        // OVER-payments: the mirror of the query above (see CREDIT_WHERE_SQL). `Keepable` is what
        // this booking may keep in total — charges included — so the UI derives the credit as
        // `PaidTotal - Keepable` with the same one-rule arithmetic the outstanding row uses.
        `SELECT b.Id AS BookingId, u.Name AS Name, u.Email AS Email,
                b.ServiceType AS ServiceType, b.StartDate AS StartDate, b.Status AS Status,
                ${CREDITABLE_AMOUNT_SQL} AS Keepable,
                COALESCE(paid.Total, 0) AS PaidTotal
         FROM BookingRequests b
         LEFT JOIN EndUsers u ON u.Id = b.EndUserId AND u.TenantId = b.TenantId
         LEFT JOIN (
           SELECT BookingRequestId, SUM(Amount) AS Total
           FROM Payments WHERE TenantId = ? GROUP BY BookingRequestId
         ) paid ON paid.BookingRequestId = b.Id
         ${CHARGES_JOIN_SQL}
         WHERE b.TenantId = ? AND ${CREDIT_WHERE_SQL}
         ORDER BY COALESCE(paid.Total, 0) - (${CREDITABLE_AMOUNT_SQL}) DESC, b.Id`,
      )
      .bind(tenantId, tenantId, tenantId)
      .all<AnalyticsData['credits'][number]>(),
  ]);

  const byMonth = new Map(monthlyRes.results.map((r) => [r.Month, r.Total]));
  const monthly = months.map((month) => ({ Month: month, Total: byMonth.get(month) ?? 0 }));
  const { ytd, quarters } = quarterlyBreakdown(monthly, y);
  const rollup = await householdsPending;
  return {
    monthly,
    ytd,
    quarterly: quarters,
    byService: byServiceRes.results,
    topClients: topClientsRes.results,
    outstanding: outstandingRes.results,
    credits: creditsRes.results,
    households: rollup.households,
    orphanedPayments: rollup.orphanedPayments,
  };
}

export async function listProviderConnections(
  db: D1Database,
  tenantId: string,
): Promise<ProviderConnection[]> {
  const { results } = await db
    .prepare(
      'SELECT Id, TenantId, Capability, Provider, Status, ConnectedAt, CalendarId FROM ProviderConnections WHERE TenantId = ?',
    )
    .bind(tenantId)
    .all<ProviderConnection>();
  return results;
}

export async function setProviderCalendarId(
  db: D1Database,
  tenantId: string,
  capability: string,
  calendarId: string | null,
): Promise<void> {
  await db
    .prepare('UPDATE ProviderConnections SET CalendarId = ? WHERE TenantId = ? AND Capability = ?')
    .bind(calendarId, tenantId, capability)
    .run();
}

export async function updateTenantSettings(
  db: D1Database,
  tenantId: string,
  settings: {
    displayName: string;
    accentColor: string;
    timezone: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
    /** Booking horizon in months (0004); null = no limit. */
    maxAdvanceMonths?: number | null;
    /** House-sit/boarding tail-end overlap allowance in days (0006); null = no limit. REQUIRED,
     *  unlike the older optional fields above: this UPDATE overwrites the column unconditionally,
     *  so an omitted value would silently turn a tenant's rule OFF. Callers must state it. */
    housesitBoardingOverlapDays: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE Tenants SET DisplayName = ?, AccentColor = ?, Timezone = ?,
         ContactEmail = ?, ContactPhone = ?, MaxAdvanceMonths = ?,
         HousesitBoardingOverlapDays = ? WHERE Id = ?`,
    )
    .bind(
      settings.displayName,
      settings.accentColor,
      settings.timezone,
      settings.contactEmail ?? null,
      settings.contactPhone ?? null,
      settings.maxAdvanceMonths ?? null,
      settings.housesitBoardingOverlapDays,
      tenantId,
    )
    .run();
}

/**
 * UPDATE-only: service rows are created explicitly (createService / seed / migration backfill).
 * Returns false if no row matched (e.g. the service was deleted concurrently) — callers must not
 * treat that as success, since a matching TenantServiceOptions write right after would orphan.
 */
export async function setServiceConfig(
  db: D1Database,
  tenantId: string,
  serviceType: ServiceType,
  config: {
    enabled: boolean;
    /** Short widget-facing blurb; null clears it (0025). */
    description: string | null;
    questions: ServiceQuestion[];
    maxNights: number | null;
    maxPetCount: number | null;
    /** Minimum notice in days (0004); null clears back to "same-day OK". */
    minLeadDays: number | null;
    acceptedPetTypes: string[] | null;
    maxConcurrentPets: number | null;
    cancellationTiers: CancellationTier[] | null;
    /** Explicit holiday rate; null clears it back to "no holiday pricing". */
    holidayRate: number | null;
    /** The sitter's stored choice for pricing an otherwise-unpriced pet set (0005). */
    petRateMode: PetRateMode;
    /** Extra-time surcharge config (0009); null clears a side back to "no surcharge". */
    standardArrivalTime: string | null;
    standardDepartureTime: string | null;
    earlyArrivalFee: number | null;
    lateDepartureFee: number | null;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE TenantServices SET
         Enabled = ?, Description = ?, Questions = ?, MaxNights = ?,
         MaxPetCount = ?, MinLeadDays = ?, AcceptedPetTypes = ?, MaxConcurrentPets = ?,
         CancellationTiers = ?, HolidayRate = ?, PetRateMode = ?,
         StandardArrivalTime = ?, StandardDepartureTime = ?, EarlyArrivalFee = ?,
         LateDepartureFee = ?
       WHERE TenantId = ? AND ServiceType = ?`,
    )
    .bind(
      config.enabled ? 1 : 0,
      config.description,
      JSON.stringify(config.questions),
      config.maxNights,
      config.maxPetCount,
      config.minLeadDays,
      config.acceptedPetTypes === null ? null : JSON.stringify(config.acceptedPetTypes),
      config.maxConcurrentPets,
      config.cancellationTiers === null ? null : JSON.stringify(config.cancellationTiers),
      config.holidayRate,
      config.petRateMode,
      config.standardArrivalTime,
      config.standardDepartureTime,
      config.earlyArrivalFee,
      config.lateDepartureFee,
      tenantId,
      serviceType,
    )
    .run();
  return result.meta.changes > 0;
}

export async function replaceServiceOptions(
  db: D1Database,
  tenantId: string,
  serviceType: ServiceType,
  options: {
    optionKey: string;
    label: string;
    durationMinutes: number | null;
    rate: number;
    startTime: string | null;
    endTime: string | null;
    capacity: number | null;
    weekdaysOnly: boolean;
  }[],
): Promise<void> {
  // DELETE-then-INSERT as ONE atomic, single-round-trip batch: a mid-write failure can no longer
  // leave the service's options half-wiped, and N options cost one trip instead of N+1.
  const insert = db.prepare(
    `INSERT INTO TenantServiceOptions
       (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, StartTime, EndTime, Capacity, WeekdaysOnly)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // Scrub rate rows for option keys NOT in the incoming set. OptionKeys are DERIVED
  // (d30/standard/label-slug), so a deleted option re-added later re-derives the SAME key and a
  // surviving rate row would resurrect at a price the sitter never set for the new option.
  // Keys still present keep their rates (settings-PUT PATCH semantics for petRates rely on it).
  const scrubWhere =
    options.length > 0
      ? `WHERE TenantId = ? AND ServiceType = ? AND OptionKey NOT IN (${options.map(() => '?').join(', ')})`
      : 'WHERE TenantId = ? AND ServiceType = ?';
  const scrubBinds = [tenantId, serviceType, ...options.map((o) => o.optionKey)];
  await db.batch([
    db.prepare(`DELETE FROM TenantServicePetRates ${scrubWhere}`).bind(...scrubBinds),
    db.prepare(`DELETE FROM PetGroupPricing ${scrubWhere}`).bind(...scrubBinds),
    db
      .prepare('DELETE FROM TenantServiceOptions WHERE TenantId = ? AND ServiceType = ?')
      .bind(tenantId, serviceType),
    ...options.map((o) =>
      insert.bind(
        crypto.randomUUID(),
        tenantId,
        serviceType,
        o.optionKey,
        o.label,
        o.durationMinutes,
        o.rate,
        o.startTime,
        o.endTime,
        o.capacity,
        o.weekdaysOnly ? 1 : 0,
      ),
    ),
  ]);
}

const PET_GROUP_COLS = 'Id, TenantId, ServiceType, OptionKey, GroupKey, Rate, UpdatedAt';
const PET_MIX_COLS = 'TenantId, ServiceType, OptionKey, MixKey, Rate';

/**
 * Pet-id rates for one service (across every option). Written one row at a time via
 * upsertPetGroupRate; exact-match resolution happens in src/shared, scoped by OptionKey on each
 * row.
 */
export async function listPetGroupPricing(
  db: D1Database,
  tenantId: string,
  serviceType: string,
): Promise<PetGroupPricingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PET_GROUP_COLS} FROM PetGroupPricing
         WHERE TenantId = ? AND ServiceType = ?`,
    )
    .bind(tenantId, serviceType)
    .all<PetGroupPricingRow>();
  return results ?? [];
}

/** Every pet-id rate for a tenant, across services — the admin GET route and settings-GET
 * warning count read this. Per-service resolution reads keep using `listPetGroupPricing`. */
export async function listAllPetGroupPricing(
  db: D1Database,
  tenantId: string,
): Promise<PetGroupPricingRow[]> {
  const { results } = await db
    .prepare(`SELECT ${PET_GROUP_COLS} FROM PetGroupPricing WHERE TenantId = ?`)
    .bind(tenantId)
    .all<PetGroupPricingRow>();
  return results ?? [];
}

/**
 * Upsert ONE pet-id rate, keyed by UNIQUE(TenantId, ServiceType, OptionKey, GroupKey).
 *
 * Deliberately NOT a whole-set replace: group rows scale with the CLIENT BASE (one per priced
 * pet set per client), so a replace-writer would force every editor save to round-trip every
 * client's rows and let two tabs clobber each other. One row in, one row out.
 * Rate validity (whole dollars >= 1) is enforced at the admin route; CHECK (Rate > 0) backstops.
 */
export async function upsertPetGroupRate(
  db: D1Database,
  tenantId: string,
  args: { serviceType: string; optionKey: string; groupKey: string; rate: number },
): Promise<{ id: string }> {
  await db
    .prepare(
      `INSERT INTO PetGroupPricing (Id, TenantId, ServiceType, OptionKey, GroupKey, Rate)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (TenantId, ServiceType, OptionKey, GroupKey)
       DO UPDATE SET Rate = excluded.Rate, UpdatedAt = datetime('now')`,
    )
    .bind(crypto.randomUUID(), tenantId, args.serviceType, args.optionKey, args.groupKey, args.rate)
    .run();
  // The row now exists either way; read back the stable Id (kept across updates) for the caller.
  const row = await db
    .prepare(
      `SELECT Id FROM PetGroupPricing
        WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ? AND GroupKey = ?`,
    )
    .bind(tenantId, args.serviceType, args.optionKey, args.groupKey)
    .first<{ Id: string }>();
  return { id: row!.Id };
}

/** Delete one pet-id rate by row id. Tenant-scoped; false = no such row for this tenant. */
export async function deletePetGroupRateById(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM PetGroupPricing WHERE Id = ? AND TenantId = ?')
    .bind(id, tenantId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/** Every species-count rate for a tenant. Callers filter by service/option in memory. */
export async function listServicePetRates(
  db: D1Database,
  tenantId: string,
): Promise<TenantServicePetRateRow[]> {
  const { results } = await db
    .prepare(`SELECT ${PET_MIX_COLS} FROM TenantServicePetRates WHERE TenantId = ?`)
    .bind(tenantId)
    .all<TenantServicePetRateRow>();
  return results ?? [];
}

/**
 * Replace the species-count rate set for ONE (serviceType, optionKey) — delete-then-insert,
 * mirroring replaceServiceOptions. Empty list clears it. MixKey must already be canonical;
 * callers build it with buildMixKey.
 */
export async function replaceServicePetRates(
  db: D1Database,
  tenantId: string,
  serviceType: string,
  optionKey: string,
  rates: { mixKey: string; rate: number }[],
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM TenantServicePetRates
           WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ?`,
      )
      .bind(tenantId, serviceType, optionKey),
    ...rates.map((r) =>
      db
        .prepare(`INSERT INTO TenantServicePetRates (${PET_MIX_COLS}) VALUES (?, ?, ?, ?, ?)`)
        .bind(tenantId, serviceType, optionKey, r.mixKey, r.rate),
    ),
  ]);
}

export async function listBlockedRanges(db: D1Database, tenantId: string): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_COLS}
       FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = 'blocked' AND Status = 'confirmed'
       ORDER BY StartDate`,
    )
    .bind(tenantId)
    .all<BookingRow>();
  return results;
}

/**
 * Soft-cancel a confirmed blocked (time-off) row — replaces the old hard `DELETE`, which is unsafe
 * the moment a blocked row can carry a live `GCalEventId`: a deleted row leaves no outbox entry to
 * retry a failed Google delete, orphaning the event forever (the same hazard CLAUDE.md names for
 * booking cancellations). Instead the row moves to `Status = 'cancelled'` and stays put — it is
 * inert there (`listBlockedRanges` and `listCapacityRows` both filter it out, and a blocked row has
 * no `BookingRequestPets`/`Payments`/`BookingCharges` children to orphan) — and `SyncPending` is
 * re-armed so the outbox's next pass can delete the mirrored Google event, if one exists.
 *
 * `SyncPending = 1` is UNCONDITIONAL here — do not "optimize" it to
 * `CASE WHEN GCalEventId IS NULL THEN 0 ELSE 1 END`. `setBookingGCalEventId`'s CAS guards only the
 * *SyncPending clear* on `expectedStatus`, never the id write itself, so a concurrent create can
 * land its id-stamp AFTER this UPDATE commits: it stamps `GCalEventId`, observes `Status =
 * 'cancelled' != 'confirmed'`, and correctly leaves `SyncPending` untouched. If this UPDATE had
 * computed 0 (no id here yet), the row is left with a live Google event and `SyncPending = 0` —
 * orphaned forever, with nothing left to retry it. At unconditional 1, the same race just costs one
 * redundant no-op sweep (PATCH/DELETE finds the event already right, or absent, and clears the
 * flag). See spec §6 / plan risk section for the full argument.
 *
 * Returns `undefined` when no row matched — unknown id, wrong tenant, or already terminal — so the
 * caller 404s exactly like the old hard DELETE's repeat-call behavior. Returns the matched row's
 * `GCalEventId` otherwise (`null` when the block was never pushed to Google, the id to delete when
 * it was) so the caller can decide whether to also delete the Google event.
 */
export async function cancelBlockedRange(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<string | null | undefined> {
  const row = await db
    .prepare(
      `UPDATE BookingRequests SET Status = 'cancelled', SyncPending = 1
       WHERE TenantId = ? AND Id = ? AND ServiceType = 'blocked' AND Status = 'confirmed'
       RETURNING GCalEventId`,
    )
    .bind(tenantId, id)
    .first<{ GCalEventId: string | null }>();
  return row === null ? undefined : row.GCalEventId;
}

/**
 * Ids of bookings synced to Calendar and not yet cancelled, bounded to [fromDate, toDateExclusive)
 * — reconciliation's candidate set, restricted to the same window it queried Calendar for (a
 * booking outside that window couldn't possibly have appeared in the Calendar response, so it must
 * never be treated as "missing").
 *
 * Excludes `Source = 'calendar-backfill'`: an adopted booking's `GCalEventId` was stamped by the
 * backfill, not pushed to Google (adoption is deliberately read-only there), so it never gains
 * `private.bookingId` and would otherwise look "missing" from every Calendar response and get
 * cancelled (and the customer emailed) on the very next reconcile pass.
 *
 * Accepted trade: this makes adopted bookings permanently exempt from delete-detection. If a
 * sitter deletes the Google event behind an adopted stay, its booking stays `confirmed` and keeps
 * blocking that day forever — nothing here reconciles it back, because it can never appear in
 * `liveBookingIds` (built from `private.bookingId`) to be told apart from "never existed." The
 * sitter cancels it from the dashboard instead; the alternative was cancelling and emailing the
 * customer for every backfilled stay on the first cron pass, which is worse.
 */
export async function listSyncedBookingIds(
  db: D1Database,
  tenantId: string,
  fromDate: string,
  toDateExclusive: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT Id FROM BookingRequests
       WHERE TenantId = ? AND GCalEventId IS NOT NULL AND Status NOT IN ('cancelled', 'declined')
         AND ServiceType NOT IN ('external', 'blocked')
         AND Source IS NOT 'calendar-backfill'
         AND StartDate < ? AND COALESCE(EndDate, StartDate) >= ?`,
    )
    .bind(tenantId, toDateExclusive, fromDate)
    .all<{ Id: string }>();
  return results.map((r) => r.Id);
}

/**
 * Ids of confirmed blocked (time-off) rows that have a live `GCalEventId`, bounded to
 * [windowStart, windowEndExclusive) — the same window-predicate shape as `listSyncedBookingIds` and
 * `listExternalEventRowsInWindow`, and it must be handed the identical pair `reconcileWindow`
 * derives for those (spec §7): a row outside the window was never spoken for by the Calendar
 * response reconcile just read, so it must never be re-armed on the strength of that response's
 * silence.
 *
 * Reconcile's re-assertion pass diffs this set against the ids Calendar's response actually
 * returned live; whatever is missing gets `markSyncPending` so the next outbox pass PATCHes (and,
 * on a 404/410 `gone`, recreates) the event — time off is re-asserted, never treated as removed by
 * a hand-delete in Calendar (spec §2).
 */
export async function listBlockedRowsWithEventsInWindow(
  db: D1Database,
  tenantId: string,
  windowStart: string,
  windowEndExclusive: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT Id FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = 'blocked' AND Status = 'confirmed'
         AND GCalEventId IS NOT NULL
         AND StartDate < ? AND COALESCE(EndDate, StartDate) >= ?`,
    )
    .bind(tenantId, windowEndExclusive, windowStart)
    .all<{ Id: string }>();
  return results.map((r) => r.Id);
}

/**
 * Re-arm `SyncPending` on exactly the given ids, tenant-scoped AND `ServiceType = 'blocked'`.
 * Used by reconcile's re-assertion pass to mark a blocked row whose Google event has gone
 * missing, so the next outbox sweep recreates it (see `listBlockedRowsWithEventsInWindow`).
 * Chunked through `chunkArray` at `DELETE_CHUNK_SIZE` for the same D1 bound-parameter-count
 * reason `deleteExternalEventsMissing` documents — `ids` is caller-controlled and can exceed the
 * ~100-per-statement cap.
 *
 * The `ServiceType = 'blocked'` predicate is structural, not incidental — matching every sibling
 * query in this file (e.g. `listSyncPendingBookings` excludes `'external'` explicitly rather than
 * relying on those rows always being born `SyncPending = 0`). Today's only caller already sources
 * ids from `listBlockedRowsWithEventsInWindow`, itself scoped to `'blocked'`, so this predicate is
 * currently redundant — but without it, a future caller aiming this function at an `'external'`
 * row's id would put a Google-owned row into the outbox, where the sync dispatch would build a
 * booking-shaped event for it and push it back to Google, corrupting a foreign calendar's own
 * event.
 */
export async function markSyncPending(
  db: D1Database,
  tenantId: string,
  ids: string[],
): Promise<void> {
  for (const chunk of chunkArray(ids, DELETE_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    await db
      .prepare(
        `UPDATE BookingRequests SET SyncPending = 1
         WHERE TenantId = ? AND ServiceType = 'blocked' AND Id IN (${placeholders})`,
      )
      .bind(tenantId, ...chunk)
      .run();
  }
}

export async function getProviderConnection(
  db: D1Database,
  tenantId: string,
  capability: string,
): Promise<ProviderConnectionWithTokens | null> {
  return await db
    .prepare(
      `SELECT Id, TenantId, Capability, Provider, Status, ConnectedAt,
              AccessToken, RefreshToken, TokenExpiresAt, CalendarId
       FROM ProviderConnections WHERE TenantId = ? AND Capability = ?`,
    )
    .bind(tenantId, capability)
    .first<ProviderConnectionWithTokens>();
}

export async function setProviderTokens(
  db: D1Database,
  tenantId: string,
  capability: string,
  provider: string,
  t: { access: string; refresh: string; expiresAt: string; calendarId: string },
): Promise<void> {
  await db
    .prepare(
      // `calendarId` is the INITIAL target only: on re-connect, COALESCE keeps whatever calendar the
      // sitter already chose (including a Pawservation-created one, which clearProviderConnection
      // deliberately preserves) and falls back to the supplied default when none was ever set.
      `INSERT INTO ProviderConnections
         (Id, TenantId, Capability, Provider, Status, ConnectedAt, AccessToken, RefreshToken, TokenExpiresAt, CalendarId)
       VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?)
       ON CONFLICT (TenantId, Capability) DO UPDATE SET
         Provider = excluded.Provider, Status = 'connected', ConnectedAt = excluded.ConnectedAt,
         AccessToken = excluded.AccessToken, RefreshToken = excluded.RefreshToken,
         TokenExpiresAt = excluded.TokenExpiresAt,
         CalendarId = COALESCE(ProviderConnections.CalendarId, excluded.CalendarId)`,
    )
    .bind(
      crypto.randomUUID(),
      tenantId,
      capability,
      provider,
      new Date().toISOString(),
      t.access,
      t.refresh,
      t.expiresAt,
      t.calendarId,
    )
    .run();
}

/**
 * Store a refreshed access token and nothing else. A token refresh has no business rewriting the
 * connection's other columns: routing it through setProviderTokens used to re-stamp CalendarId,
 * silently collapsing a NULL (= "use primary") into the literal string 'primary'.
 */
export async function setProviderAccessToken(
  db: D1Database,
  tenantId: string,
  capability: string,
  t: { access: string; expiresAt: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE ProviderConnections SET AccessToken = ?, TokenExpiresAt = ?
       WHERE TenantId = ? AND Capability = ?`,
    )
    .bind(t.access, t.expiresAt, tenantId, capability)
    .run();
}

/**
 * Disconnect: drop every credential, keep the sitter's calendar choice. `CalendarId` is an
 * identifier, not a secret — forgetting it would make her re-pick her pet calendar after every
 * reconnect, and would let the create-calendar route make a SECOND dedicated calendar because the
 * "already points somewhere other than primary" guard had nothing left to see.
 */
export async function clearProviderConnection(
  db: D1Database,
  tenantId: string,
  capability: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ProviderConnections
       SET Status = 'disconnected', AccessToken = NULL, RefreshToken = NULL,
           TokenExpiresAt = NULL, ConnectedAt = NULL
       WHERE TenantId = ? AND Capability = ?`,
    )
    .bind(tenantId, capability)
    .run();
}

/**
 * Compare-and-swap the booking's GCalEventId: only writes `eventId` when the current value still
 * equals `expectedOld` (NULL for a first-time create, the stale id when recreating a hand-deleted
 * event). Returns whether a row actually changed — false means another writer won the race, so the
 * caller must clean up the Google event it just created rather than orphan it. `IS` is null-safe,
 * so binding NULL matches only an unset GCalEventId. Tenant-scoped like every repo function.
 *
 * `expectedStatus`, when given, guards ONLY the SyncPending clear (not the id write): an in-flight
 * push that lands after an intervening status change (e.g. a create racing a concurrent cancel)
 * must not clear the flag the status change just set, or the push that status change still needs
 * would be silently masked. The event id is still recorded either way — never orphaning the event
 * Google now has — so the next outbox sweep sees a fresh row (current Status + the just-stored
 * GCalEventId) and derives the correct follow-up op from it. Omitted (undefined binds NULL, and
 * `? IS NULL` short-circuits the CASE true) for every caller that isn't re-driving a batch, where
 * this race is negligible.
 */
export async function setBookingGCalEventId(
  db: D1Database,
  tenantId: string,
  bookingId: string,
  eventId: string,
  expectedOld: string | null,
  expectedStatus?: BookingRow['Status'],
): Promise<boolean> {
  const guard = expectedStatus ?? null;
  const result = await db
    .prepare(
      `UPDATE BookingRequests
       SET GCalEventId = ?, SyncPending = CASE WHEN ? IS NULL OR Status = ? THEN 0 ELSE SyncPending END
       WHERE TenantId = ? AND Id = ? AND GCalEventId IS ?`,
    )
    .bind(eventId, guard, guard, tenantId, bookingId, expectedOld)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Clear every stored Google event id for this tenant. Called when the sync TARGET calendar changes:
 * a stored GCalEventId names an event inside whatever calendar was configured when it was created,
 * and reconcileBookingsWithCalendar looks those ids up in the CURRENTLY configured calendar — so
 * carrying them across a switch makes reconcile see every booking as "deleted by hand in Calendar"
 * and mass-cancel real bookings. NULLing them makes reconcile skip those rows entirely
 * (listSyncedBookingIds requires GCalEventId IS NOT NULL) until the backfill re-creates them in the
 * new calendar. Returns how many rows were cleared. Tenant-scoped like every repo function.
 *
 * ponytail: deliberately the cheap half of the fix — no schema change. Ceiling: the events already
 * written to the OLD calendar are orphaned there, because once the id is cleared we can no longer
 * delete them (and we never knew which calendar they lived in). The sitter deletes the old calendar,
 * or those few stray events, by hand. Upgrade path if orphan cleanup is ever wanted: add a nullable
 * BookingRequests.GCalCalendarId written alongside GCalEventId, and this function becomes "delete
 * the events whose GCalCalendarId differs from the new target, then clear".
 *
 * Excludes ServiceType='external' rows: those are purged wholesale by deleteAllExternalEvents,
 * called first by repointCalendarTarget. The exclusion here removes the hidden order-dependency —
 * without it, NULLing an external row's GCalEventId (its upsert conflict target, see
 * upsertExternalEvent) ahead of the purge would corrupt the row instead of just deleting it.
 *
 * Also excludes Source='calendar-backfill' rows (adopted bookings): their GCalEventId points at
 * an event the SITTER created on the old calendar, not one pawservation wrote there, so it must
 * survive a target switch. NULLing it would be a double fault — it would (1) make the row a
 * candidate for listUnsyncedFutureBookings, whose backfill is not behind the isAdoptedBooking
 * guard, so the next cron pass would create a pawservation-owned DUPLICATE event for a stay that
 * already exists on the sitter's calendar, permanently (Source stays 'calendar-backfill', so
 * every other push function's isAdoptedBooking guard then refuses to ever touch what it just
 * created); and (2) drop the id out of listAdoptedEventIds, the import's idempotency key, so a
 * later backfill over the same range would re-adopt the same Google event as a second, duplicate
 * booking. `IS NOT`, not `!=`: Source is NULL for every ordinary booking, and `NULL != 'x'` is
 * NULL, not true — a plain `!=` would silently stop clearing ids for every ordinary booking and
 * break calendar switching outright. Same null-safe form as `listSyncedBookingIds` and
 * `listSyncPendingBookings`.
 */
export async function clearBookingCalendarEventIds(
  db: D1Database,
  tenantId: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE BookingRequests SET GCalEventId = NULL
       WHERE TenantId = ? AND GCalEventId IS NOT NULL AND ServiceType != 'external'
         AND Source IS NOT 'calendar-backfill'`,
    )
    .bind(tenantId)
    .run();
  return (result.meta as { changes?: number }).changes ?? 0;
}

/** Split `items` into groups of at most `size` — pure and exported so chunking arithmetic (e.g.
 * an off-by-one that would let a group exceed D1's ~100-bound-parameter-per-statement cap) is
 * unit-tested directly rather than only inferred from an HTTP-level failure. */
export function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunkArray: size must be positive');
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Bound applied to every chunked DELETE in deleteExternalEventsMissing: 1 (tenantId) + up to
 * this many ids stays safely under D1's 100-bound-parameter-per-statement cap. */
const DELETE_CHUNK_SIZE = 90;

/** Build (but don't run) the upsert statement for one materialized external row — the same
 * write upsertExternalEvent performs, exposed separately so a caller materializing many events in
 * one reconcile pass can batch several statements per db.batch() round trip instead of one D1
 * call per event. Conflict target = the partial unique index on (TenantId, GCalEventId) WHERE
 * ServiceType = 'external'. These rows are read-only mirrors: EndUserId NULL, EstCost NULL, never
 * priced, never payable, counted by listCapacityRows as blocked-like. Tenant-scoped. */
export function upsertExternalEventStatement(
  db: D1Database,
  tenantId: string,
  e: { gcalEventId: string; summary: string; startDate: string; endDateExclusive: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO BookingRequests
         (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount,
          EstCost, GCalEventId, ExternalSummary, Status, SyncPending)
       VALUES (?, ?, NULL, 'external', ?, ?, NULL, 1, NULL, ?, ?, 'confirmed', 0)
       ON CONFLICT (TenantId, GCalEventId) WHERE ServiceType = 'external' DO UPDATE SET
         StartDate = excluded.StartDate, EndDate = excluded.EndDate,
         ExternalSummary = excluded.ExternalSummary`,
    )
    .bind(crypto.randomUUID(), tenantId, e.startDate, e.endDateExclusive, e.gcalEventId, e.summary);
}

/** Materialize one Google-owned event as a ServiceType='external' row (insert or update in
 * place). Single-event convenience wrapper around upsertExternalEventStatement — see it for the
 * write's shape and invariants. Tenant-scoped. */
export async function upsertExternalEvent(
  db: D1Database,
  tenantId: string,
  e: { gcalEventId: string; summary: string; startDate: string; endDateExclusive: string },
): Promise<void> {
  await upsertExternalEventStatement(db, tenantId, e).run();
}

/** The in-window external rows' (Id, GCalEventId) — the read reconcileBookingsWithCalendar now
 * hoists to a single call, feeding BOTH the materialize-priority partition (an event already
 * holding a row is a re-upsert, not a new write) and deleteExternalEventsMissing (below), which
 * used to run this exact query itself. STRICTLY window-bounded: a row outside the queried window
 * was never spoken for by the response and must not be touched (same reasoning as
 * listSyncedBookingIds). */
export async function listExternalEventRowsInWindow(
  db: D1Database,
  tenantId: string,
  windowStart: string,
  windowEndExclusive: string,
): Promise<{ Id: string; GCalEventId: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, GCalEventId FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = 'external'
         AND StartDate < ? AND COALESCE(EndDate, StartDate) >= ?`,
    )
    .bind(tenantId, windowEndExclusive, windowStart)
    .all<{ Id: string; GCalEventId: string }>();
  return results;
}

/** Deletes in-window external rows whose Google event is no longer live. Takes the caller's
 * already-fetched `existingRows` (listExternalEventRowsInWindow) rather than re-querying, so one
 * reconcile pass reads the in-window external rows exactly once and reuses them for both the
 * materialize-priority partition and this delete.
 *
 * Deliberately does NOT do `WHERE GCalEventId NOT IN (?, ?, …)` bound directly to `liveEventIds`:
 * D1 caps bound parameters at 100 per statement, and a busy shared calendar can easily report
 * more than ~97 live events in the window, which would make that single statement throw mid-
 * reconcile — silently wedging delete-detection for every tenant with a big enough calendar.
 * Instead: diff `existingRows` against `liveEventIds` in JS (a Set, so this stays O(n)), and
 * delete the stale ones by Id in DELETE_CHUNK_SIZE-bounded chunks, each safely under the 100-param
 * cap regardless of how many events Google reports. */
export async function deleteExternalEventsMissing(
  db: D1Database,
  tenantId: string,
  existingRows: { Id: string; GCalEventId: string }[],
  liveEventIds: string[],
): Promise<number> {
  const live = new Set(liveEventIds);
  const staleIds = existingRows.filter((r) => !live.has(r.GCalEventId)).map((r) => r.Id);

  let deleted = 0;
  for (const chunk of chunkArray(staleIds, DELETE_CHUNK_SIZE)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(`DELETE FROM BookingRequests WHERE TenantId = ? AND Id IN (${placeholders})`)
      .bind(tenantId, ...chunk)
      .run();
    deleted += (result.meta as { changes?: number }).changes ?? 0;
  }
  return deleted;
}

/** Purge every materialized external row — called when the calendar target changes or the
 * connection is dropped: the rows mirrored a calendar we no longer read, and read-only rows
 * with no living source would block capacity forever with no UI to remove them. */
export async function deleteAllExternalEvents(db: D1Database, tenantId: string): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM BookingRequests WHERE TenantId = ? AND ServiceType = 'external'`)
    .bind(tenantId)
    .run();
  return (result.meta as { changes?: number }).changes ?? 0;
}

/** Outbox success path: mark one booking's calendar state as mirrored. Tenant-scoped.
 *
 * `expectedStatus`, when given, guards the clear the same way as setBookingGCalEventId's: a
 * push that started under one Status must not clear the flag if the row's Status has since
 * changed underneath it, or the follow-up push that change needs would be masked. Omitted for
 * callers outside a re-drive batch, where the race window is negligible. */
export async function clearSyncPending(
  db: D1Database,
  tenantId: string,
  bookingId: string,
  expectedStatus?: BookingRow['Status'],
): Promise<void> {
  const guard = expectedStatus ?? null;
  await db
    .prepare(
      `UPDATE BookingRequests
       SET SyncPending = CASE WHEN ? IS NULL OR Status = ? THEN 0 ELSE SyncPending END
       WHERE TenantId = ? AND Id = ?`,
    )
    .bind(guard, guard, tenantId, bookingId)
    .run();
}

const ENDUSER_COLS = 'Id, TenantId, Email, Name, Phone, VenmoUsername, Status, InvitedAt';

export async function getEndUserById(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<EndUser | null> {
  return await db
    .prepare(`SELECT ${ENDUSER_COLS} FROM EndUsers WHERE TenantId = ? AND Id = ?`)
    .bind(tenantId, id)
    .first<EndUser>();
}

/** One stored pre-fill: the customer's last answer to a question, with the question's shape at
 *  the time they gave it. See sql/schema.sql's SavedAnswers comment. */
export type SavedAnswerRow = {
  ServiceType: string;
  QuestionId: string;
  Shape: string;
  Value: string;
};

/** Every saved answer this customer has, across services. One indexed read per widget load. */
export async function listSavedAnswers(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<SavedAnswerRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ServiceType, QuestionId, Shape, Value
         FROM SavedAnswers WHERE TenantId = ? AND EndUserId = ?`,
    )
    .bind(tenantId, endUserId)
    .all<SavedAnswerRow>();
  return results ?? [];
}

/**
 * Replaces this customer's saved answers FOR ONE SERVICE with what they just submitted. Each
 * entry is upserted under its question's CURRENT shape (so the next read compares against the
 * question as it stood when the answer was given); a question the customer left blank has its
 * saved row DELETED rather than kept, because a cleared answer that silently came back next time
 * would be the feature working against them.
 *
 * Callers pass only questions that belong to `serviceType` — an answer to a key the service never
 * asked about is not saved.
 */
export async function replaceSavedAnswers(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  serviceType: string,
  entries: { questionId: string; shape: string; value: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.batch(
    entries.map((e) =>
      e.value === ''
        ? db
            .prepare(
              `DELETE FROM SavedAnswers
                 WHERE TenantId = ? AND EndUserId = ? AND ServiceType = ? AND QuestionId = ?`,
            )
            .bind(tenantId, endUserId, serviceType, e.questionId)
        : db
            .prepare(
              `INSERT INTO SavedAnswers (TenantId, EndUserId, ServiceType, QuestionId, Shape, Value)
                    VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (TenantId, EndUserId, ServiceType, QuestionId)
                 DO UPDATE SET Shape = excluded.Shape,
                               Value = excluded.Value,
                               UpdatedAt = datetime('now')`,
            )
            .bind(tenantId, endUserId, serviceType, e.questionId, e.shape, e.value),
    ),
  );
}

// --- Personal access tokens (0012) ---
// A credential the customer issues to themselves so something other than the widget can call the
// booking API as them. Only a SHA-256 of the token is ever stored; the reasoning behind that (and
// behind hashing it WITHOUT an iterated KDF) lives in server/lib/personal-access-token.ts.
// Every query below binds TenantId: there is deliberately no way to look a token up globally.

/** One row as its OWNER sees it. `TokenHash` is absent by construction, not by omission at the
 *  route — the secret and its digest have no read path out of this module. */
export type PersonalAccessTokenRow = {
  Id: string;
  Name: string;
  CreatedAt: string;
  LastUsedAt: string | null;
};

/** Stores a new token's hash and returns the row id. The plaintext never reaches this layer. */
export async function createPersonalAccessToken(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  name: string,
  tokenHash: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO PersonalAccessTokens (Id, TenantId, EndUserId, Name, TokenHash)
            VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, tenantId, endUserId, name, tokenHash)
    .run();
  return id;
}

/** This customer's LIVE tokens, newest first. A revoked token is gone from their list — the row
 *  survives (see the schema) but it is no longer something they can act on. */
export async function listPersonalAccessTokens(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<PersonalAccessTokenRow[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, Name, CreatedAt, LastUsedAt
         FROM PersonalAccessTokens
        WHERE TenantId = ? AND EndUserId = ? AND RevokedAt IS NULL
        ORDER BY CreatedAt DESC, Id`,
    )
    .bind(tenantId, endUserId)
    .all<PersonalAccessTokenRow>();
  return results ?? [];
}

/**
 * THE AUTHENTICATION LOOKUP: one indexed read on (TenantId, TokenHash), which is the whole cost of
 * authenticating a PAT request. `RevokedAt IS NULL` is in the WHERE clause rather than checked by
 * the caller, so a revoked token is refused by the same query that would otherwise have found it —
 * there is no window in which some other code path could forget the check.
 *
 * TenantId is bound, so a token minted under one sitter simply does not exist under another. That
 * is Model A holding by construction: the query cannot see across the boundary to learn that the
 * hash is valid elsewhere, which is also why the caller can only answer "no" rather than "wrong
 * tenant" the way a widget JWT's `tid` claim lets it.
 *
 * `LastUsedAt` comes back with the row so the caller can decide whether a refresh is due without a
 * second read.
 */
export async function findLivePersonalAccessToken(
  db: D1Database,
  tenantId: string,
  tokenHash: string,
): Promise<{ Id: string; EndUserId: string; LastUsedAt: string | null } | null> {
  return await db
    .prepare(
      `SELECT Id, EndUserId, LastUsedAt
         FROM PersonalAccessTokens
        WHERE TenantId = ? AND TokenHash = ? AND RevokedAt IS NULL`,
    )
    .bind(tenantId, tokenHash)
    .first<{ Id: string; EndUserId: string; LastUsedAt: string | null }>();
}

/** Stamps a token as used now. Called only when the stamp is actually stale (see
 *  `shouldRefreshLastUsed`) and only off the response path, so the ordinary request writes nothing.
 *  Two concurrent uses may both write; they write the same minute, and last-writer-wins is right. */
export async function touchPersonalAccessToken(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE PersonalAccessTokens SET LastUsedAt = datetime('now')
        WHERE TenantId = ? AND Id = ?`,
    )
    .bind(tenantId, id)
    .run();
}

/**
 * Revokes one of this customer's OWN tokens. Scoped by EndUserId as well as TenantId, so one
 * customer can neither revoke nor probe for another's token — a stranger's id is indistinguishable
 * from a nonexistent one, which is what the route's 404 says.
 *
 * `COALESCE` keeps the FIRST revocation's timestamp, so revoking twice is idempotent and does not
 * rewrite history; SQLite still counts the row as changed, so a second call reports success rather
 * than a confusing 404 for a token the caller can plainly see is already dead. Returns false only
 * when no such token belongs to this customer.
 */
export async function revokePersonalAccessToken(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE PersonalAccessTokens SET RevokedAt = COALESCE(RevokedAt, datetime('now'))
        WHERE TenantId = ? AND EndUserId = ? AND Id = ?`,
    )
    .bind(tenantId, endUserId, id)
    .run();
  return ((result.meta as { changes?: number }).changes ?? 0) > 0;
}

export async function getEndUserByEmail(
  db: D1Database,
  tenantId: string,
  email: string,
): Promise<EndUser | null> {
  return await db
    .prepare(`SELECT ${ENDUSER_COLS} FROM EndUsers WHERE TenantId = ? AND Email = ?`)
    .bind(tenantId, email)
    .first<EndUser>();
}

/**
 * Lookup-or-create a customer with NO pet. NOT a creation path any route may use on its own any
 * more: a client is a client-and-pet relationship, so both admin creation paths (manual add and
 * CSV import) go through insertInvitedCustomerWithPet for a new email and addEndUserPet for an
 * existing one. Retained as a test-seeding helper only — wiring it back into a route would put a
 * pet-less owner back on the table.
 */
export async function insertInvitedCustomer(
  db: D1Database,
  tenantId: string,
  email: string,
  name: string | null,
  phone: string | null = null,
): Promise<EndUser> {
  const existing = await getEndUserByEmail(db, tenantId, email);
  if (existing) return existing; // idempotent — never downgrade an active customer to invited
  const id = crypto.randomUUID();
  const invitedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO EndUsers (Id, TenantId, Email, Name, Phone, Status, InvitedAt)
       VALUES (?, ?, ?, ?, ?, 'invited', ?)`,
    )
    .bind(id, tenantId, email, name, phone, invitedAt)
    .run();
  return {
    Id: id,
    TenantId: tenantId,
    Email: email,
    Name: name,
    Phone: phone,
    VenmoUsername: null,
    Status: 'invited',
    InvitedAt: invitedAt,
  };
}

/**
 * Create a customer AND their first pet as ONE atomic batch (createTenantFromSignup precedent;
 * the test shim's batch is transactional): EndUsers → EndUserPets → PetOwners. "No owners without
 * pets" is enforced structurally here — if the pet insert throws, the whole batch aborts and no
 * pet-less customer is left standing. EndUsers' UNIQUE (TenantId, Email) likewise aborts the
 * batch on a concurrent duplicate create, so the caller must look the customer up first and only
 * call this for a genuinely new email (use addEndUserPet for an existing customer).
 *
 * Returns the customer WITH the id of the pet it just created (`PetId`), because the CSV import may
 * have to attach a co-owner to that very pet in its deferred second pass — a widening of the old
 * `EndUser` return, so every existing call site is untouched.
 */
export async function insertInvitedCustomerWithPet(
  db: D1Database,
  tenantId: string,
  email: string,
  name: string,
  phone: string | null,
  petName: string,
  petType: PetType,
): Promise<EndUser & { PetId: string }> {
  const id = crypto.randomUUID();
  const petId = crypto.randomUUID();
  const invitedAt = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO EndUsers (Id, TenantId, Email, Name, Phone, Status, InvitedAt)
         VALUES (?, ?, ?, ?, ?, 'invited', ?)`,
      )
      .bind(id, tenantId, email, name, phone, invitedAt),
    db
      .prepare(
        `INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(petId, tenantId, id, petName, petType),
    db
      .prepare(`INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)`)
      .bind(tenantId, petId, id),
  ]);
  return {
    Id: id,
    TenantId: tenantId,
    Email: email,
    Name: name,
    Phone: phone,
    VenmoUsername: null,
    Status: 'invited',
    InvitedAt: invitedAt,
    PetId: petId,
  };
}

/**
 * Lookup-or-create the per-tenant shadow customer behind the reserved demo login
 * (server/lib/demo.ts). Provisioned like any real client — customer AND first pet in one atomic
 * batch, so the client-AND-pet invariant holds for the shadow too — but Status 'active' (no
 * invite email path ever fires, promoteCustomerActive is a no-op) and excluded by Email from
 * listCustomers and the owner roster below. Its bookings are never persisted
 * (routes/bookings.ts short-circuits), so capacity/analytics/calendar never see it.
 */
export async function ensureDemoCustomer(
  db: D1Database,
  tenantId: string,
  email: string,
  petType: PetType,
): Promise<EndUser> {
  const existing = await getEndUserByEmail(db, tenantId, email);
  if (existing) return existing;
  const id = `eu_demo_${crypto.randomUUID()}`;
  const petId = `pet_demo_${crypto.randomUUID()}`;
  const invitedAt = new Date().toISOString();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO EndUsers (Id, TenantId, Email, Name, Phone, Status, InvitedAt)
           VALUES (?, ?, ?, 'Demo Visitor', NULL, 'active', ?)`,
        )
        .bind(id, tenantId, email, invitedAt),
      db
        .prepare(
          `INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType) VALUES (?, ?, ?, 'Biscuit', ?)`,
        )
        .bind(petId, tenantId, id, petType),
      db
        .prepare(`INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)`)
        .bind(tenantId, petId, id),
    ]);
  } catch (e) {
    // Concurrent first use: UNIQUE (TenantId, Email) aborted the whole batch — re-read the winner.
    const raced = await getEndUserByEmail(db, tenantId, email);
    if (raced) return raced;
    throw e;
  }
  return {
    Id: id,
    TenantId: tenantId,
    Email: email,
    Name: 'Demo Visitor',
    Phone: null,
    VenmoUsername: null,
    Status: 'active',
    InvitedAt: invitedAt,
  };
}

export async function listCustomers(db: D1Database, tenantId: string): Promise<EndUser[]> {
  // The reserved demo identity (lib/demo.ts) is a real row but never a client the sitter
  // manages — its email is uncreatable via admin routes, so this filter can't hide real data.
  const { results } = await db
    .prepare(
      `SELECT ${ENDUSER_COLS} FROM EndUsers WHERE TenantId = ? AND Email <> ? ORDER BY Email`,
    )
    .bind(tenantId, DEMO_EMAIL)
    .all<EndUser>();
  return results;
}

/**
 * Delete a customer and everything that would be orphaned by their departure. TWO preconditions,
 * both enforced in SQL rather than by a preceding read, and both all-or-nothing:
 *
 *  1. the customer themselves has no BookingRequests; and
 *  2. no pet that this delete WOULD cascade (one stamped with their EndUserId that no other owner
 *     holds a PetOwners edge to) is referenced by BookingRequestPets — including by SOMEONE ELSE's
 *     booking, which co-ownership makes reachable.
 *
 * Either precondition failing refuses the ENTIRE delete: every statement in the batch carries both
 * guards, so the customer, their pets, their ownership edges and their login codes are all left
 * exactly as they were. A pet with a surviving co-owner is handed to that owner instead of being
 * cascaded, so it never blocks the delete however many bookings name it.
 *
 * FOUR outcomes rather than a boolean, for the same reason removePetOwner reports three: the route
 * has to tell the sitter WHY nothing happened, and "refused" and "no such customer" want different
 * status codes and different words. 'deleted'; 'has-bookings' (precondition 1); 'pet-on-booking'
 * (precondition 2 — the co-ownership case, 409, and the one a boolean used to flatten into a
 * misleading 404); 'not-found'. Success is decided by `meta.changes` on the EndUsers delete; the
 * three failures are told apart by ONE follow-up read taken only on that path, which is safe
 * precisely because a refused batch writes nothing at all — a stale answer there picks the wording
 * of an error, never a write.
 */
export async function deleteCustomer(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<'deleted' | 'has-bookings' | 'pet-on-booking' | 'not-found'> {
  // Atomic guard: delete only when this customer has no bookings, so a booking created between
  // the route's count check and here can never orphan a live booking. The route still 409s on the
  // common path; this closes the TOCTOU with a safe no-op (0 rows -> false) on the race.
  //
  // D1 enforces foreign keys, so EndUsers can't be deleted while LoginCodes/EndUserPets/PetOwners
  // rows still reference it — and EndUserPets can't be deleted while BookingRequestPets or
  // PetOwners rows still reference IT. Cascade child-first in one batch, each statement carrying
  // the SAME guards so a TOCTOU race leaves every table untouched together rather than partially
  // cascading before a guard trips.
  //
  // Co-ownership (0019) adds the first two statements; the resulting order is:
  //   1. hand EndUserPets.EndUserId (NOT NULL + FK, the creating-owner column) to the oldest
  //      surviving co-owner for every pet that HAS one — otherwise deleting this EndUsers row
  //      leaves that column dangling;
  //   2. drop this customer's ownership edges;
  //   3. (pre-existing) cascade only the pets still stamped with this EndUserId, which after (1)
  //      are exactly the pets nobody else owns. A pet another customer co-owns is never deleted
  //      here. No BookingRequestPets delete precedes it: cascadingPetGuard has already established
  //      that not one of those pets is referenced, so there is nothing to clear and the FK cannot
  //      trip.
  const bookingGuard = `NOT EXISTS (SELECT 1 FROM BookingRequests WHERE TenantId = ? AND EndUserId = ?)`;
  // Second precondition, and the reason "this customer has no bookings" is no longer enough under
  // co-ownership: a BookingRequestPets row can reference a pet of THIS customer even when this
  // customer has no bookings of their own. Co-ownership makes that reachable through supported
  // sitter/customer actions — X creates pet P, the sitter co-owns Y onto it, Y books P (legal:
  // listEndUserPets returns co-owned pets), the sitter then unlinks Y from P (removePetOwner has
  // no booking check, by design) — leaving P owned only by X while Y's booking still names it.
  // Cascading P there would strip the last pet off a live booking and leave it showing PetCount=1
  // with no pets. So refuse the whole delete, exactly like DELETE /admin/customers/:id/pets/:petId
  // already does ("Pet has bookings; cannot remove.", 409): if ANY pet that WOULD cascade is
  // referenced by BookingRequestPets, nothing happens and the route reports the failure.
  //
  // "Would cascade" is precisely "stamped with this EndUserId AND owned by nobody else" — a pet
  // with a surviving co-owner is handed off by statement (1) rather than deleted, so it must NOT
  // block the delete. That set only ever shrinks as the batch runs (statement (1) reassigns the
  // co-owned pets out of it; nothing ever adds to it), so this guard evaluates identically at
  // every position: true throughout a successful batch (where by definition it matches no pet
  // carrying bookings) and false throughout a refused one, which is what makes the batch fail as
  // a unit. Every statement carries it for that reason — including the PetOwners and LoginCodes
  // deletes, which would otherwise strip a surviving customer's ownership edges.
  const cascadingPetGuard = `NOT EXISTS (
             SELECT 1 FROM EndUserPets orphan
              WHERE orphan.TenantId = ? AND orphan.EndUserId = ?
                AND NOT EXISTS (SELECT 1 FROM PetOwners po
                                 WHERE po.TenantId = orphan.TenantId AND po.PetId = orphan.Id
                                   AND po.EndUserId <> ?)
                AND EXISTS (SELECT 1 FROM BookingRequestPets brp WHERE brp.PetId = orphan.Id))`;
  // The EndUsers delete is deliberately LAST (children first — D1 has no ON DELETE CASCADE) and
  // is read off the end rather than by ordinal, as deleteTenantCompletely does: adding a cascade
  // statement in the middle silently renumbered a positional destructure once already.
  const batchResults = await db.batch([
    db
      .prepare(
        `UPDATE EndUserPets
            SET EndUserId = (SELECT po.EndUserId FROM PetOwners po
                              WHERE po.TenantId = EndUserPets.TenantId AND po.PetId = EndUserPets.Id
                                AND po.EndUserId <> ?
                           ORDER BY po.CreatedAt, po.EndUserId LIMIT 1)
          WHERE TenantId = ? AND EndUserId = ?
            AND EXISTS (SELECT 1 FROM PetOwners po
                         WHERE po.TenantId = EndUserPets.TenantId AND po.PetId = EndUserPets.Id
                           AND po.EndUserId <> ?)
            AND ${bookingGuard}
            AND ${cascadingPetGuard}`,
      )
      .bind(id, tenantId, id, id, tenantId, id, tenantId, id, id),
    db
      .prepare(
        `DELETE FROM PetOwners
           WHERE TenantId = ? AND EndUserId = ? AND ${bookingGuard} AND ${cascadingPetGuard}`,
      )
      .bind(tenantId, id, tenantId, id, tenantId, id, id),
    db
      .prepare(
        `DELETE FROM EndUserPets
           WHERE TenantId = ? AND EndUserId = ? AND ${bookingGuard} AND ${cascadingPetGuard}`,
      )
      .bind(tenantId, id, tenantId, id, tenantId, id, id),
    db
      .prepare(
        `DELETE FROM LoginCodes
           WHERE TenantId = ? AND EndUserId = ? AND ${bookingGuard} AND ${cascadingPetGuard}`,
      )
      .bind(tenantId, id, tenantId, id, tenantId, id, id),
    // Saved intake answers (0007) also FK to EndUsers. Unreachable on today's paths — a saved
    // answer only exists because a booking POST succeeded, and `bookingGuard` refuses the delete
    // outright in that case — but the FK is real, so cascade it rather than rely on that
    // coincidence surviving a future change. Same guards as everything else in the batch.
    db
      .prepare(
        `DELETE FROM SavedAnswers
           WHERE TenantId = ? AND EndUserId = ? AND ${bookingGuard} AND ${cascadingPetGuard}`,
      )
      .bind(tenantId, id, tenantId, id, tenantId, id, id),
    // Personal access tokens (0012) FK to EndUsers, and unlike SavedAnswers this one IS reachable:
    // a customer can hold a token without ever having booked. It must also be the strongest reason
    // in this batch to cascade rather than orphan — a live long-term credential that outlived the
    // account it authenticates as is a credential nobody is left to revoke. Same guards as the
    // rest, so a refused delete writes nothing here either.
    db
      .prepare(
        `DELETE FROM PersonalAccessTokens
           WHERE TenantId = ? AND EndUserId = ? AND ${bookingGuard} AND ${cascadingPetGuard}`,
      )
      .bind(tenantId, id, tenantId, id, tenantId, id, id),
    db
      .prepare(
        `DELETE FROM EndUsers
           WHERE TenantId = ? AND Id = ? AND ${bookingGuard} AND ${cascadingPetGuard}`,
      )
      .bind(tenantId, id, tenantId, id, tenantId, id, id),
  ]);
  const endUsersResult = batchResults[batchResults.length - 1];
  if (((endUsersResult.meta as { changes?: number }).changes ?? 0) !== 0) return 'deleted';
  // Refused (or no such customer) — and because every statement carried both guards, NOTHING was
  // written on this path. One read, two counts, to choose the wording. Order matters only in that
  // the guards are checked before absence: a customer who is gone can have neither bookings nor
  // pets (both FK to EndUsers), so a zero/zero answer really does mean "no such customer here".
  const reason = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM BookingRequests WHERE TenantId = ? AND EndUserId = ?) AS OwnBookings,
         (SELECT COUNT(*) FROM EndUserPets orphan
           WHERE orphan.TenantId = ? AND orphan.EndUserId = ?
             AND NOT EXISTS (SELECT 1 FROM PetOwners po
                              WHERE po.TenantId = orphan.TenantId AND po.PetId = orphan.Id
                                AND po.EndUserId <> ?)
             AND EXISTS (SELECT 1 FROM BookingRequestPets brp
                          WHERE brp.PetId = orphan.Id)) AS BookedCascadingPets`,
    )
    .bind(tenantId, id, tenantId, id, id)
    .first<{ OwnBookings: number; BookedCascadingPets: number }>();
  if ((reason?.OwnBookings ?? 0) > 0) return 'has-bookings';
  if ((reason?.BookedCascadingPets ?? 0) > 0) return 'pet-on-booking';
  return 'not-found';
}

export async function countBookingsForUser(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM BookingRequests WHERE TenantId = ? AND EndUserId = ?')
    .bind(tenantId, endUserId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function promoteCustomerActive(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<void> {
  await db
    .prepare("UPDATE EndUsers SET Status = 'active' WHERE TenantId = ? AND Id = ?")
    .bind(tenantId, endUserId)
    .run();
}

/**
 * Set (or clear) the client's Venmo handle. The value is stored '@'-less and is used for exactly
 * one thing: matching a row of an uploaded Venmo CSV to this client. NULL means "match on Name",
 * which is the common case — hence the field's label in the admin UI. Returns whether a row
 * changed, so the route can 404 an unknown or foreign id (the WHERE is the tenant guard).
 */
export async function setEndUserVenmoUsername(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  venmoUsername: string | null,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE EndUsers SET VenmoUsername = ? WHERE TenantId = ? AND Id = ?')
    .bind(venmoUsername, tenantId, endUserId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Every owner<->pet pairing in the tenant, ONE ROW PER LINK: a co-owned pet appears once per owner,
 * with `EndUserId` set to THAT LINK's owner rather than the pet's creating owner. The admin customer
 * list groups pets by `EndUserId` (server/routes/admin.ts), so this shape makes a co-owned pet show
 * under both clients with no change to the grouping code, and the customers-import dedupe sees a
 * shared pet's name under each owner it belongs to.
 *
 * Deceased pets are INCLUDED here on purpose: the sitter must still see them (and be able to undo a
 * mistake). Only the customer-facing lists filter them out.
 */
export async function listAllEndUserPetsByTenant(
  db: D1Database,
  tenantId: string,
): Promise<EndUserPet[]> {
  const { results } = await db
    .prepare(
      `SELECT p.Id, p.TenantId, po.EndUserId, p.Name, p.PetType, p.Notes, p.DeceasedAt, p.CreatedAt
       FROM EndUserPets p
       JOIN PetOwners po ON po.PetId = p.Id AND po.TenantId = p.TenantId
       WHERE p.TenantId = ? ORDER BY po.EndUserId, p.Name`,
    )
    .bind(tenantId)
    .all<EndUserPet>();
  return results;
}

/**
 * The pets a customer may book with. The widget's picker (`GET /:slug/me`) and the booking-time
 * ownership gate (`server/routes/bookings.ts`) both read this, so this query IS the ownership
 * boundary between customers — get it wrong and it is a cross-customer data leak, not a UX bug.
 *
 * Ownership comes from PetOwners, not EndUserPets.EndUserId: under co-ownership (0019) a second
 * owner legitimately books a pet they did not create. Deceased pets are excluded — a dead pet is
 * never bookable, and filtering here keeps this in exact lockstep with listPetIdsForOwner (which
 * will be read by the quote route, PR 2). If the two ever disagreed, a customer could quote a pet
 * they cannot book.
 *
 * NOTE the returned `EndUserId` is the pet's CREATING owner, not necessarily `endUserId` — for a
 * co-owned pet they differ. listAllEndUserPetsByTenant returns the LINK's owner in that same field
 * of the same EndUserPet type, so never treat this field as "whose list this is".
 */
export async function listEndUserPets(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<EndUserPet[]> {
  const { results } = await db
    .prepare(
      `SELECT p.Id, p.TenantId, p.EndUserId, p.Name, p.PetType, p.Notes, p.DeceasedAt, p.CreatedAt
       FROM EndUserPets p
       JOIN PetOwners po ON po.PetId = p.Id AND po.TenantId = p.TenantId
       WHERE p.TenantId = ? AND po.EndUserId = ? AND p.DeceasedAt IS NULL
       ORDER BY p.Name`,
    )
    .bind(tenantId, endUserId)
    .all<EndUserPet>();
  return results;
}

/** One owner<->pet edge, PascalCase straight off the PetOwners row. */
export type PetOwnerLink = { EndUserId: string; PetId: string };

/**
 * Every owner<->pet edge for the tenant in ONE tenant-scoped read — the union-find source for
 * invoicing accounts (`buildAccounts`, src/shared/invoicing/accounts.ts). PetOwners carries its own
 * TenantId, deliberately unlike BookingRequestPets, precisely so this is a single indexed read
 * rather than a three-way join.
 *
 * Deceased pets are excluded HERE, in the DB layer, so the pure module never learns that a
 * DeceasedAt column exists — an owner whose only pet has died therefore has no edge at all and
 * drops out of the account graph entirely, which is the intended §9.1 behavior.
 */
export async function listOwnerPetLinks(db: D1Database, tenantId: string): Promise<PetOwnerLink[]> {
  const { results } = await db
    .prepare(
      `SELECT po.EndUserId, po.PetId
       FROM PetOwners po
       JOIN EndUserPets p ON p.Id = po.PetId AND p.TenantId = po.TenantId
       WHERE po.TenantId = ? AND p.DeceasedAt IS NULL
       ORDER BY po.PetId, po.EndUserId`,
    )
    .bind(tenantId)
    .all<PetOwnerLink>();
  return results;
}

/**
 * The SAME edges for the pets `listOwnerPetLinks` leaves out — the DECEASED ones. Exactly one
 * reader wants them, and only ever to answer one question: which household does a payment filed
 * under this dead pet belong to (`buildPaymentAnchors`)?
 *
 * A deceased pet is excluded from the account graph because it cannot be booked or quoted, which
 * is a rule about BOOKINGS. `Payments.AccountId` stores a pet id, so that same exclusion silently
 * deleted household payments from every balance the moment the anchor pet died, while `Payments`
 * went on counting them as revenue. These edges are what makes the money resolvable again — and
 * they are kept in a SEPARATE list, never merged into `listOwnerPetLinks`, so a dead pet can never
 * form a component, rename an account (the account id is the first-sorted pet), or reappear in a
 * household's pet list.
 */
export async function listDeceasedOwnerPetLinks(
  db: D1Database,
  tenantId: string,
): Promise<PetOwnerLink[]> {
  const { results } = await db
    .prepare(
      `SELECT po.EndUserId, po.PetId
       FROM PetOwners po
       JOIN EndUserPets p ON p.Id = po.PetId AND p.TenantId = po.TenantId
       WHERE po.TenantId = ? AND p.DeceasedAt IS NOT NULL
       ORDER BY po.PetId, po.EndUserId`,
    )
    .bind(tenantId)
    .all<PetOwnerLink>();
  return results;
}

/**
 * The pet ids one customer owns — co-ownership included, deceased excluded. The cheapest form of
 * the ownership boundary listEndUserPets enforces, kept in deliberate lockstep with it: the two are
 * the same predicate, and a divergence would let a customer quote a pet they cannot book. Will be
 * read by the quote route (PR 2); no quote route exists yet.
 */
export async function listPetIdsForOwner(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT po.PetId
       FROM PetOwners po
       JOIN EndUserPets p ON p.Id = po.PetId AND p.TenantId = po.TenantId
       WHERE po.TenantId = ? AND po.EndUserId = ? AND p.DeceasedAt IS NULL
       ORDER BY po.PetId`,
    )
    .bind(tenantId, endUserId)
    .all<{ PetId: string }>();
  return results.map((r) => r.PetId);
}

/**
 * Create a pet and its FIRST ownership edge in one batch. A pet without a PetOwners row is
 * invisible to its own owner (every customer-facing pet list reads PetOwners, not
 * EndUserPets.EndUserId), so the two writes must never come apart.
 */
export async function addEndUserPet(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  name: string,
  petType: PetType,
  notes: string | null = null,
): Promise<EndUserPet> {
  const id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType, Notes) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, tenantId, endUserId, name, petType, notes),
    db
      .prepare(`INSERT INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)`)
      .bind(tenantId, id, endUserId),
  ]);
  const row = await db
    .prepare(
      `SELECT Id, TenantId, EndUserId, Name, PetType, Notes, DeceasedAt, CreatedAt FROM EndUserPets WHERE TenantId = ? AND Id = ?`,
    )
    .bind(tenantId, id)
    .first<EndUserPet>();
  return row!;
}

/**
 * Delete one pet — unless a booking names it. Three outcomes, because the caller must tell them
 * apart: 'not-found' (unknown or another tenant's pet → 404), 'has-bookings' (refused → 409), and
 * 'removed'.
 *
 * **A pet on a booking is part of that booking's record.** Clearing its `BookingRequestPets` rows
 * to make the delete succeed would rewrite what the stay says it was for and leave `PetCount`
 * describing pets that are no longer listed; cancel and decline are SOFT, so the join row outlives
 * the booking's active life on purpose. Refusal is therefore the right answer, and it was already
 * the intended one — the admin route's 409 and `deleteCustomer`'s `cascadingPetGuard` both say so.
 * The sitter's remedy for a pet that has died is `setPetDeceased`, which keeps the history.
 *
 * The guard is IN THE SQL, on every statement in the batch (the `deleteCustomer` pattern), not a
 * read-then-write in the caller. `BookingRequestPets` has no `ON DELETE CASCADE` and D1 enforces
 * foreign keys, so a caller-side pre-check left two ways to get a raw constraint error — i.e. a 500
 * — instead of an answer: a new call site that forgets the check, and a booking POST landing between
 * the check and the delete. Carrying the guard here means a refusal writes NOTHING (the batch is a
 * transaction) and the race cannot produce an FK error at all.
 *
 * `BookingRequestPets` has no TenantId, so the reference test is unqualified — it does not need to
 * be: the DELETEs are already scoped by `EndUserPets.TenantId`, pet ids are UUIDs, and a reference
 * from anywhere is a reason to refuse, which is the safe direction regardless.
 *
 * PetOwners is deleted first: it FKs to EndUserPets, so the other order would fail the constraint
 * rather than silently orphan a row.
 */
export async function removeEndUserPet(
  db: D1Database,
  tenantId: string,
  petId: string,
): Promise<'removed' | 'not-found' | 'has-bookings'> {
  const bookingGuard = `NOT EXISTS (SELECT 1 FROM BookingRequestPets brp WHERE brp.PetId = ?)`;
  const [, petResult] = await db.batch([
    db
      .prepare(`DELETE FROM PetOwners WHERE TenantId = ? AND PetId = ? AND ${bookingGuard}`)
      .bind(tenantId, petId, petId),
    db
      .prepare(`DELETE FROM EndUserPets WHERE TenantId = ? AND Id = ? AND ${bookingGuard}`)
      .bind(tenantId, petId, petId),
  ]);
  if ((petResult.meta as { changes?: number }).changes !== 0) return 'removed';
  // Refused, and nothing was written. One read to choose which refusal it was: a pet that is not
  // there at all can have no bookings, so "still present" is exactly "the guard stopped us".
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM EndUserPets WHERE TenantId = ? AND Id = ?`)
    .bind(tenantId, petId)
    .first<{ n: number }>();
  return (row?.n ?? 0) > 0 ? 'has-bookings' : 'not-found';
}

/**
 * Link an existing customer to an existing pet as a co-owner (sitter action). Returns false when
 * either id lives outside `tenantId` — PetOwners' FKs reference EndUserPets(Id)/EndUsers(Id)
 * without a TenantId, so D1's foreign-key enforcement can't by itself catch a cross-tenant pairing
 * (both ids can be individually valid FK targets in different tenants); this explicit check is
 * what prevents a cross-tenant ownership edge. Re-adding an existing owner is a no-op that still
 * returns true, so a double-click is harmless rather than a spurious 404.
 */
export async function addPetOwner(
  db: D1Database,
  tenantId: string,
  petId: string,
  endUserId: string,
): Promise<boolean> {
  const valid = await db
    .prepare(
      `SELECT 1 AS Ok FROM EndUserPets p, EndUsers u
        WHERE p.Id = ? AND p.TenantId = ? AND u.Id = ? AND u.TenantId = ?`,
    )
    .bind(petId, tenantId, endUserId, tenantId)
    .first<{ Ok: number }>();
  if (!valid) return false;
  await db
    .prepare('INSERT OR IGNORE INTO PetOwners (TenantId, PetId, EndUserId) VALUES (?, ?, ?)')
    .bind(tenantId, petId, endUserId)
    .run();
  return true;
}

/**
 * The pets named by `petIds` that exist in `tenantId`, with their liveness. Used by the co-owner
 * creation route to tell "no such pet / another tenant's pet" (404) apart from "that pet has passed
 * away" (400) BEFORE it writes anything — the wording is the whole reason this read exists; the
 * write itself is guarded independently in SQL (see `coOwnerLinkStmt`).
 */
export async function listPetsByIds(
  db: D1Database,
  tenantId: string,
  petIds: string[],
): Promise<{ Id: string; DeceasedAt: string | null }[]> {
  if (petIds.length === 0) return [];
  const placeholders = petIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT Id, DeceasedAt FROM EndUserPets WHERE TenantId = ? AND Id IN (${placeholders})`,
    )
    .bind(tenantId, ...petIds)
    .all<{ Id: string; DeceasedAt: string | null }>();
  return results;
}

/**
 * ONE guarded owner<->pet insert, shared by both co-owner paths below. Two properties, both in the
 * SQL rather than in a caller-side pre-check:
 *
 *  - **A pet that is not a LIVE pet of `tenantId` aborts the whole batch.** The TenantId column is
 *    written from a scalar subquery over `EndUserPets`, so an unknown id, another tenant's id or a
 *    deceased pet resolves it to NULL and trips `PetOwners.TenantId NOT NULL`. That is deliberate,
 *    and it is why `INSERT OR IGNORE` must NOT be used here: OR IGNORE would swallow that very
 *    violation and skip the row, which on the create path would commit a pet-less client — the one
 *    thing this whole feature exists to prevent.
 *  - **Re-linking an existing owner is a no-op, not a conflict.** The `NOT EXISTS` guard does the
 *    job `INSERT OR IGNORE` would otherwise have done, so a repeat call is harmless.
 */
function coOwnerLinkStmt(
  db: D1Database,
  tenantId: string,
  petId: string,
  endUserId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO PetOwners (TenantId, PetId, EndUserId)
       SELECT (SELECT p.TenantId FROM EndUserPets p
                WHERE p.Id = ? AND p.TenantId = ? AND p.DeceasedAt IS NULL), ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM PetOwners po
                           WHERE po.TenantId = ? AND po.PetId = ? AND po.EndUserId = ?)`,
    )
    .bind(petId, tenantId, petId, endUserId, tenantId, petId, endUserId);
}

/**
 * Create a customer who brings NO pet of their own and link them to pets that already exist, as ONE
 * atomic batch (`insertInvitedCustomerWithPet`'s precedent): EndUsers → one PetOwners row per pet.
 *
 * This is the second half of "no owners without pets". The first half — a client created together
 * with their first pet — is `insertInvitedCustomerWithPet`; this one is "Rob, Tina's husband", who
 * shares Tina's pets rather than bringing a new animal. Because the insert and every link commit or
 * roll back together, a bad pet id can never leave a pet-less client standing, and the bare pet-less
 * `insertInvitedCustomer` stays what it is: a test-seeding helper.
 *
 * `petIds` must be de-duplicated by the caller (PetOwners' PRIMARY KEY would otherwise abort the
 * batch) and non-empty (a zero-link call is exactly the pet-less create this refuses to be).
 * EndUsers' UNIQUE (TenantId, Email) aborts the batch on a concurrent duplicate create, so the
 * caller looks the email up first and uses `addCoOwnerToPets` for an existing client.
 */
export async function insertInvitedCustomerAsCoOwner(
  db: D1Database,
  tenantId: string,
  email: string,
  name: string,
  phone: string | null,
  petIds: string[],
): Promise<EndUser> {
  if (petIds.length === 0) throw new Error('insertInvitedCustomerAsCoOwner needs at least one pet');
  const id = crypto.randomUUID();
  const invitedAt = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO EndUsers (Id, TenantId, Email, Name, Phone, Status, InvitedAt)
         VALUES (?, ?, ?, ?, ?, 'invited', ?)`,
      )
      .bind(id, tenantId, email, name, phone, invitedAt),
    ...petIds.map((petId) => coOwnerLinkStmt(db, tenantId, petId, id)),
  ]);
  return {
    Id: id,
    TenantId: tenantId,
    Email: email,
    Name: name,
    Phone: phone,
    VenmoUsername: null,
    Status: 'invited',
    InvitedAt: invitedAt,
  };
}

/**
 * Link an EXISTING customer to several pets at once — the merge half of the same action (the email
 * the sitter typed turned out to be a client already, possibly one with pets of their own, so the
 * two billing accounts become one). All-or-nothing for the same reason: a half-linked person can see
 * some of the household's pets and not others, which is a data question the sitter cannot see.
 * `addPetOwner` remains the single-pet, one-at-a-time route-level action.
 */
export async function addCoOwnerToPets(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  petIds: string[],
): Promise<void> {
  if (petIds.length === 0) return;
  await db.batch(petIds.map((petId) => coOwnerLinkStmt(db, tenantId, petId, endUserId)));
}

/**
 * Unlink one owner from a co-owned pet. Three outcomes, because the caller must tell them apart:
 * 'not-found' (no such edge in this tenant → 404), 'last-owner' (refused: a pet with zero owners
 * would be invisible to everyone and unreachable from the account graph → 409, delete the pet
 * instead), 'removed'.
 *
 * The eligibility guard ("more than one owner exists") is folded INTO the DELETE's WHERE clause —
 * following insertPayment's INSERT...SELECT...WHERE idiom — rather than a separate read-then-write,
 * so two concurrent removals on a two-owner pet can't both pass a stale count and both delete,
 * which would leave the pet with zero owners (exactly what this function exists to forbid). D1
 * batch() is an implicit transaction (the test shim wraps batch in a real BEGIN/COMMIT too, see
 * helpers.ts), so within one call the UPDATE and DELETE see a consistent snapshot and commit or
 * roll back together.
 *
 * When the departing owner is also the pet's creating owner, EndUserPets.EndUserId is handed to the
 * oldest surviving co-owner by an UPDATE placed BEFORE the DELETE in the same batch — that column
 * is NOT NULL with an FK to EndUsers, so leaving it pointing at a customer who is on their way out
 * would dangle. That UPDATE carries its own "another owner exists" guard (EXISTS ... <> ?) so it
 * can never resolve its subquery to NULL and fail the NOT NULL constraint on a last-owner attempt.
 *
 * The UPDATE and DELETE fire under logically EQUIVALENT conditions by construction, not by relying
 * on the rest of the codebase keeping EndUserPets.EndUserId and PetOwners in sync: both require
 * `endUserId` to actually own the pet in this tenant. The two WHERE clauses aren't textually
 * identical — the UPDATE's `po3` EXISTS pins `endUserId` as a current owner and its `po2` EXISTS
 * (`<> ?`) then asks "does some OTHER owner exist", while the DELETE's `COUNT(*) > 1` asks "are
 * there more than one owner total" — but once `po3` has pinned `endUserId` as a current owner,
 * those two questions have the same answer on every row, so the conditions agree. Without that
 * equivalence, a future divergence (e.g. a not-yet-written delete path) could hit the case where
 * the UPDATE's guard fires — silently reassigning the creating-owner column — while the DELETE
 * matches nothing and the function reports 'not-found', contradicting the "nothing was written"
 * guarantee below.
 *
 * If the guarded DELETE matches zero rows, nothing was written by this call on any path — a
 * follow-up read is then made purely to decide which of 'not-found' / 'last-owner' to report; a
 * stale answer there is harmless since it never drives a write.
 */
export async function removePetOwner(
  db: D1Database,
  tenantId: string,
  petId: string,
  endUserId: string,
): Promise<'removed' | 'last-owner' | 'not-found'> {
  const [, deleteResult] = await db.batch([
    db
      .prepare(
        `UPDATE EndUserPets
            SET EndUserId = (SELECT po.EndUserId FROM PetOwners po
                              WHERE po.TenantId = EndUserPets.TenantId AND po.PetId = EndUserPets.Id
                                AND po.EndUserId <> ?
                           ORDER BY po.CreatedAt, po.EndUserId LIMIT 1)
          WHERE TenantId = ? AND Id = ? AND EndUserId = ?
            AND EXISTS (SELECT 1 FROM PetOwners po2
                         WHERE po2.TenantId = ? AND po2.PetId = ? AND po2.EndUserId <> ?)
            AND EXISTS (SELECT 1 FROM PetOwners po3
                         WHERE po3.TenantId = ? AND po3.PetId = ? AND po3.EndUserId = ?)`,
      )
      .bind(
        endUserId,
        tenantId,
        petId,
        endUserId,
        tenantId,
        petId,
        endUserId,
        tenantId,
        petId,
        endUserId,
      ),
    db
      .prepare(
        `DELETE FROM PetOwners
          WHERE TenantId = ? AND PetId = ? AND EndUserId = ?
            AND (SELECT COUNT(*) FROM PetOwners po2 WHERE po2.TenantId = ? AND po2.PetId = ?) > 1`,
      )
      .bind(tenantId, petId, endUserId, tenantId, petId),
  ]);
  if (((deleteResult.meta as { changes?: number }).changes ?? 0) !== 0) return 'removed';
  const link = await db
    .prepare('SELECT 1 AS Ok FROM PetOwners WHERE TenantId = ? AND PetId = ? AND EndUserId = ?')
    .bind(tenantId, petId, endUserId)
    .first<{ Ok: number }>();
  return link ? 'last-owner' : 'not-found';
}

/**
 * Mark a pet deceased (or undo it). NULL = alive. A deceased pet vanishes from every bookable and
 * quotable list and from the account graph, but its rows stay: past bookings must keep naming it.
 * Idempotent in BOTH senses — re-marking an already-deceased pet still matches its row and returns
 * true (so the route never 404s a harmless repeat), AND the stored DeceasedAt is left untouched
 * (COALESCE keeps the original date rather than overwriting it with a fresh `now()`), because
 * Task 6/8 surface this date to the sitter — silently moving a recorded death date forward on every
 * repeat call would be a real, user-visible bug. Returns false only when the pet is outside
 * `tenantId`.
 */
export async function setPetDeceased(
  db: D1Database,
  tenantId: string,
  petId: string,
  deceased: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(
      deceased
        ? "UPDATE EndUserPets SET DeceasedAt = COALESCE(DeceasedAt, datetime('now')) WHERE TenantId = ? AND Id = ?"
        : 'UPDATE EndUserPets SET DeceasedAt = NULL WHERE TenantId = ? AND Id = ?',
    )
    .bind(tenantId, petId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Link pets to a booking, tenant-scoped. Each insert is guarded so it only writes when BOTH the
 * booking and the pet belong to `tenantId` — a cross-tenant pet id (or a booking from another
 * tenant) silently inserts nothing. BookingRequestPets' FKs reference BookingRequests(Id)/
 * EndUserPets(Id) with no TenantId column, so D1's foreign-key enforcement doesn't catch a
 * cross-tenant mismatch on its own; this explicit tenant check is what upholds isolation here.
 */
export async function addBookingPets(
  db: D1Database,
  tenantId: string,
  bookingId: string,
  petIds: string[],
): Promise<void> {
  if (petIds.length === 0) return;
  await db.batch(
    petIds.map((petId) =>
      db
        .prepare(
          `INSERT INTO BookingRequestPets (BookingRequestId, PetId)
           SELECT ?, ?
           WHERE EXISTS (SELECT 1 FROM BookingRequests WHERE Id = ? AND TenantId = ?)
             AND EXISTS (SELECT 1 FROM EndUserPets WHERE Id = ? AND TenantId = ?)`,
        )
        .bind(bookingId, petId, bookingId, tenantId, petId, tenantId),
    ),
  );
}

/**
 * Set a booking's pet links to exactly `petIds` — the edit path's counterpart to `addBookingPets`,
 * which only ever adds. The DELETE is scoped through the parent booking's tenant (the same route
 * tenancy takes in every other `BookingRequestPets` statement, since the table has no `TenantId`
 * of its own), so it can never clear the links of a booking belonging to another sitter; the
 * inserts reuse `addBookingPets` and so keep its per-row tenant guard verbatim.
 */
export async function replaceBookingPets(
  db: D1Database,
  tenantId: string,
  bookingId: string,
  petIds: string[],
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM BookingRequestPets
        WHERE BookingRequestId = ?
          AND EXISTS (SELECT 1 FROM BookingRequests WHERE Id = ? AND TenantId = ?)`,
    )
    .bind(bookingId, bookingId, tenantId)
    .run();
  await addBookingPets(db, tenantId, bookingId, petIds);
}

/**
 * Pet names linked to ONE booking, tenant-scoped (BookingRequestPets has no TenantId, so tenancy
 * flows in via the join to BookingRequests + EndUserPets — a foreign pet id contributes nothing).
 * Ordered by Name for a deterministic, human-readable event summary.
 */
export async function listPetNamesForBooking(
  db: D1Database,
  tenantId: string,
  bookingId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT p.Name AS Name
       FROM BookingRequestPets brp
       JOIN BookingRequests br ON br.Id = brp.BookingRequestId
       JOIN EndUserPets p ON p.Id = brp.PetId AND p.TenantId = br.TenantId
       WHERE br.TenantId = ? AND br.Id = ?
       ORDER BY p.Name`,
    )
    .bind(tenantId, bookingId)
    .all<{ Name: string }>();
  return results.map((r) => r.Name);
}

/**
 * Pet names for EVERY booking in a tenant, ONE read that the admin bookings list groups in JS —
 * the same `listChargesForTenant` shape (a per-row query here would be a round-trip per booking
 * on the sitter's hottest admin GET). Tenancy flows in via the join to BookingRequests +
 * EndUserPets exactly as `listPetNamesForBooking` does; ordered by BookingRequestId then Name so
 * grouping produces a deterministic, human-readable per-row list.
 */
export async function listPetNamesForTenantBookings(
  db: D1Database,
  tenantId: string,
): Promise<{ BookingRequestId: string; Name: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT brp.BookingRequestId AS BookingRequestId, p.Name AS Name
       FROM BookingRequestPets brp
       JOIN BookingRequests br ON br.Id = brp.BookingRequestId
       JOIN EndUserPets p ON p.Id = brp.PetId AND p.TenantId = br.TenantId
       WHERE br.TenantId = ?
       ORDER BY brp.BookingRequestId, p.Name`,
    )
    .bind(tenantId)
    .all<{ BookingRequestId: string; Name: string }>();
  return results;
}

/** The fields the calendar sync layer (SyncInput) needs, joined from one booking + its service
 * label + its option's duration. Pet names are fetched separately (listPetNamesForBooking). */
export type BookingSyncRow = {
  Id: string;
  EndUserId: string | null;
  ServiceType: ServiceType;
  ServiceLabel: string;
  StartDate: string;
  EndDate: string | null;
  StartTime: string | null;
  DepartureTime: string | null;
  DurationMinutes: number | null;
  PetCount: number;
  EstCost: number | null;
  Status: 'pending' | 'confirmed';
};

const BOOKING_SYNC_COLS = `b.Id AS Id, b.EndUserId AS EndUserId, b.ServiceType AS ServiceType,
       COALESCE(s.Label, b.ServiceType) AS ServiceLabel, b.StartDate AS StartDate,
       b.EndDate AS EndDate, b.StartTime AS StartTime, b.DepartureTime AS DepartureTime,
       o.DurationMinutes AS DurationMinutes,
       b.PetCount AS PetCount, b.EstCost AS EstCost, b.Status AS Status`;

const BOOKING_SYNC_JOINS = `FROM BookingRequests b
       LEFT JOIN TenantServices s ON s.TenantId = b.TenantId AND s.ServiceType = b.ServiceType
       LEFT JOIN TenantServiceOptions o
         ON o.TenantId = b.TenantId AND o.ServiceType = b.ServiceType AND o.OptionKey = b.OptionKey`;

/** One booking's calendar-sync fields (service label + option duration joined in). Used by the
 * admin confirm route to build an event resource for a catch-up create or a retitle. */
export async function getBookingSyncData(
  db: D1Database,
  tenantId: string,
  bookingId: string,
): Promise<BookingSyncRow | null> {
  return await db
    .prepare(`SELECT ${BOOKING_SYNC_COLS} ${BOOKING_SYNC_JOINS} WHERE b.TenantId = ? AND b.Id = ?`)
    .bind(tenantId, bookingId)
    .first<BookingSyncRow>();
}

/** Non-cancelled, non-'external' rows (real bookings AND 'blocked' time off) that have NO calendar
 * event yet and are still current — the backfill candidate set when a sitter connects Google
 * Calendar after already taking bookings/blocking time off, and the only path that ever recreates
 * events lost to a repointed calendar target (`repointCalendarTarget` nulls every non-'external' id
 * without re-arming SyncPending). Capped at LIMIT; ordered by date so the soonest are synced first.
 *
 * The bound is `COALESCE(EndDate, StartDate) >= fromDate`, the same shape `listSyncPendingBookings`
 * uses and for the same reason: `StartDate >= fromDate` would skip a stay (or a block) already in
 * progress, stranding the connect-later backfill for anything spanning today. */
export async function listUnsyncedFutureBookings(
  db: D1Database,
  tenantId: string,
  today: string,
  limit: number,
): Promise<BookingSyncRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_SYNC_COLS} ${BOOKING_SYNC_JOINS}
       WHERE b.TenantId = ? AND b.GCalEventId IS NULL AND b.Status IN ('pending', 'confirmed')
         AND b.ServiceType != 'external' AND COALESCE(b.EndDate, b.StartDate) >= ?
       ORDER BY b.StartDate
       LIMIT ?`,
    )
    .bind(tenantId, today, limit)
    .all<BookingSyncRow>();
  return results;
}

/** Outbox candidates: rows whose latest state change Google has not confirmed. Real bookings AND
 * 'blocked' time off ('external' is Google-owned, materialized by reconcile and never pushed by
 * the outbox; `Source = 'calendar-backfill'` is the sitter's OWN pre-existing event, adopted
 * read-only — see below). Bounded so ancient never-synced history doesn't churn
 * every sweep, soonest first. Status here can be any of the four, and
 * CancellationFee rides along because the delete-vs-retitle decision for a cancelled row turns on
 * it (keepsCalendarEventOnCancel) — the caller derives create/update/delete from Status +
 * CancellationFee + GCalEventId.
 *
 * The bound is `COALESCE(EndDate, StartDate) >= fromDate` — the same shape `listSyncedBookingIds`
 * uses, and for the same reason: a stay that has ALREADY STARTED is still live. `StartDate >=
 * fromDate` excluded it, and a customer may cancel an in-progress stay (isCustomerCancellable),
 * so that row's SyncPending could never be drained: the ghost event stayed on the sitter's
 * calendar forever, and a fee-bearing cancel never got its [CANCELLED] retitle. It also stranded
 * the connect-later backfill for any stay spanning today.
 *
 * Excludes `Source = 'calendar-backfill'` for the same reason `listSyncedBookingIds` does, but
 * against the WRITE side: an adopted row's `GCalEventId` points at an event the SITTER created,
 * which pawservation only ever read. Adoption leaves `SyncPending = 0`, but that is only the
 * row's first moment — every ordinary lifecycle write re-arms the flag unconditionally
 * (`updateBookingStatus`, `updateBookingRequest`), including the dashboard cancel that
 * `listSyncedBookingIds`' own comment tells the sitter to use. Once armed, the caller's
 * Status + CancellationFee + GCalEventId derivation would DELETE that event (a fee-free cancel)
 * or PATCH the sitter's title and description into pawservation's rendering (a fee-bearing one).
 * The exclusion belongs here, in the candidate query, rather than in any one branch of that
 * derivation, so an operation added later is read-only by default rather than by its author
 * remembering.
 *
 * `IS NOT`, not `!=`: `Source` is NULL for every ordinary booking, and `NULL != 'x'` is NULL, not
 * true — a plain `!=` would silently empty the outbox for the entire product. */
export type SyncPendingRow = Omit<BookingSyncRow, 'Status'> & {
  Status: BookingRow['Status'];
  CancellationFee: number | null;
  GCalEventId: string | null;
};

export async function listSyncPendingBookings(
  db: D1Database,
  tenantId: string,
  fromDate: string,
  limit: number,
): Promise<SyncPendingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_SYNC_COLS}, b.CancellationFee AS CancellationFee,
              b.GCalEventId AS GCalEventId ${BOOKING_SYNC_JOINS}
       WHERE b.TenantId = ? AND b.SyncPending = 1
         AND b.ServiceType != 'external'
         AND b.Source IS NOT 'calendar-backfill'
         AND COALESCE(b.EndDate, b.StartDate) >= ?
       ORDER BY b.StartDate
       LIMIT ?`,
    )
    .bind(tenantId, fromDate, limit)
    .all<SyncPendingRow>();
  return results;
}

export async function listBookingPetsForUser(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<{ BookingRequestId: string; PetId: string; Name: string; PetType: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT brp.BookingRequestId, brp.PetId, p.Name, p.PetType
       FROM BookingRequestPets brp
       JOIN BookingRequests br ON br.Id = brp.BookingRequestId
       JOIN EndUserPets p ON p.Id = brp.PetId AND p.TenantId = br.TenantId
       WHERE br.TenantId = ? AND br.EndUserId = ?`,
    )
    .bind(tenantId, endUserId)
    .all<{ BookingRequestId: string; PetId: string; Name: string; PetType: string }>();
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNER SCOPE — instance-level tables (OwnerUsers, AllowedSitters).
// These are the ONLY functions exempt from the tenantId-first rule: both tables
// gate entry INTO the tenancy model (platform-owner accounts and the signup
// allowlist), so they cannot themselves be tenant rows. D1 access still lives
// only in this module.
// Callers normalize emails (trim + lowercase) before every read/write.
// ─────────────────────────────────────────────────────────────────────────────

/** INSTANCE SCOPE — the one calendar-sync exemption to the tenantId-first rule, same class as
 * the owner-scope functions above: the cron sweep must discover WHICH tenants to sync before any
 * tenant context exists. Read-only, and every row it returns is then processed through the
 * ordinary tenant-scoped path. Disabled tenants are excluded — read-only tenants must not sync. */
export async function listConnectedCalendarTenants(db: D1Database): Promise<Tenant[]> {
  // Table-qualified TENANT_COLS (same pattern as BOOKING_COLS_QUALIFIED above): the join against
  // ProviderConnections shares no column names with Tenants today, but qualifying defensively
  // avoids a silent ambiguous-column break if that ever changes.
  const cols = TENANT_COLS.split(', ')
    .map((col) => `t.${col}`)
    .join(', ');
  const { results } = await db
    .prepare(
      `SELECT ${cols} FROM Tenants t
       JOIN ProviderConnections pc ON pc.TenantId = t.Id
       WHERE pc.Capability = 'calendar' AND pc.Status = 'connected' AND t.DisabledAt IS NULL
       ORDER BY t.Id`,
    )
    .all<Tenant>();
  return results;
}

export async function getOwnerUserByEmail(
  db: D1Database,
  email: string,
): Promise<OwnerUser | null> {
  return await db
    .prepare('SELECT Id, Email, PasswordHash, CreatedAt FROM OwnerUsers WHERE Email = ?')
    .bind(email)
    .first<OwnerUser>();
}

/** Throws on OwnerUsers.Email UNIQUE — the caller maps that to 409 (replay that beat the nonce). */
export async function insertOwnerUser(
  db: D1Database,
  id: string,
  email: string,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare('INSERT INTO OwnerUsers (Id, Email, PasswordHash) VALUES (?, ?, ?)')
    .bind(id, email, passwordHash)
    .run();
}

/** Returns whether a row actually changed — false means the email has no owner account. */
export async function updateOwnerPasswordHash(
  db: D1Database,
  email: string,
  passwordHash: string,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE OwnerUsers SET PasswordHash = ? WHERE Email = ?')
    .bind(passwordHash, email)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function getAllowedSitter(
  db: D1Database,
  email: string,
): Promise<AllowedSitterRow | null> {
  return await db
    .prepare('SELECT Email, AddedAt, ClaimedAt, TenantId FROM AllowedSitters WHERE Email = ?')
    .bind(email)
    .first<AllowedSitterRow>();
}

/** With the claimed tenant's slug joined in (NULL until claimed). Newest first. */
export async function listAllowedSitters(
  db: D1Database,
): Promise<(AllowedSitterRow & { TenantSlug: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT a.Email, a.AddedAt, a.ClaimedAt, a.TenantId, t.Slug AS TenantSlug
       FROM AllowedSitters a
       LEFT JOIN Tenants t ON t.Id = a.TenantId
       ORDER BY a.AddedAt DESC, a.Email`,
    )
    .all<AllowedSitterRow & { TenantSlug: string | null }>();
  return results;
}

export type SitterRosterRow = {
  TenantId: string;
  Slug: string;
  DisplayName: string;
  CreatedAt: string;
  DisabledAt: string | null; // null = active
  PremiumUntil: string | null; // null = free
  Clients: number; // COUNT(EndUsers), all-time
  Bookings: number; // confirmed, non-blocked, CreatedAt >= sinceDate
  Earned: number; // SUM(Payments.Amount), PaidDate >= sinceDate
};

/**
 * Cross-tenant sitter roster — the FIRST sanctioned no-WHERE-TenantId query, safe only under
 * ownerAuth. `sinceDate` ('YYYY-MM-DD') or null = all-time. Clients are always all-time; bookings
 * window on CreatedAt, earned on PaidDate. LEFT-JOIN semantics via correlated subqueries so a
 * sitter with zero activity still returns a row (Bookings 0, Earned 0).
 */
export async function listSitterRoster(
  db: D1Database,
  sinceDate: string | null,
): Promise<SitterRosterRow[]> {
  // null window → a lower bound before any real date, so one positional bind serves both
  // windowed subqueries. CreatedAt is a datetime ('YYYY-MM-DD HH:MM:SS'); PaidDate is a date;
  // both sort correctly against a 'YYYY-MM-DD' floor.
  const floor = sinceDate ?? '0000-01-01';
  const { results } = await db
    .prepare(
      `SELECT
         t.Id AS TenantId,
         t.Slug AS Slug,
         t.DisplayName AS DisplayName,
         t.CreatedAt AS CreatedAt,
         t.DisabledAt AS DisabledAt,
         t.PremiumUntil AS PremiumUntil,
         (SELECT COUNT(*) FROM EndUsers u WHERE u.TenantId = t.Id AND u.Email <> ?) AS Clients,
         (SELECT COUNT(*) FROM BookingRequests b
            WHERE b.TenantId = t.Id AND b.Status = 'confirmed'
              AND b.ServiceType NOT IN ('blocked', 'external') AND b.CreatedAt >= ?) AS Bookings,
         (SELECT COALESCE(SUM(p.Amount), 0) FROM Payments p
            WHERE p.TenantId = t.Id AND p.PaidDate >= ?) AS Earned
       FROM Tenants t
       ORDER BY t.DisplayName COLLATE NOCASE, t.Id`,
    )
    .bind(DEMO_EMAIL, floor, floor)
    .all<SitterRosterRow>();
  return results;
}

/** Idempotent: re-adding returns the existing row untouched (customer-invite precedent). */
export async function addAllowedSitter(db: D1Database, email: string): Promise<AllowedSitterRow> {
  await db
    .prepare('INSERT INTO AllowedSitters (Email) VALUES (?) ON CONFLICT (Email) DO NOTHING')
    .bind(email)
    .run();
  return (await getAllowedSitter(db, email))!;
}

/** Guarded delete: unclaimed rows only, so a claimed sitter can never be silently removed. */
export async function deleteUnclaimedAllowedSitter(
  db: D1Database,
  email: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM AllowedSitters WHERE Email = ? AND ClaimedAt IS NULL')
    .bind(email)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Owner-scope: flip a tenant's disabled state. `true` → DisabledAt = now (widget dark + admin
 * read-only via the tenantMiddleware guard); `false` → NULL (active). Returns whether a row
 * changed (false = no such tenant, so the route can 404). Caller must invalidateTenantCache.
 */
export async function setTenantDisabled(
  db: D1Database,
  tenantId: string,
  disabled: boolean,
): Promise<boolean> {
  const result = await db
    .prepare(
      disabled
        ? "UPDATE Tenants SET DisabledAt = datetime('now') WHERE Id = ?"
        : 'UPDATE Tenants SET DisabledAt = NULL WHERE Id = ?',
    )
    .bind(tenantId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Owner-scope: set or clear a tenant's paid-through instant (0010). `null` clears it, which is
 * "free" — the same value every tenant carries until an owner grants premium. Returns whether a
 * row changed (false = no such tenant, so the route can 404). Caller must invalidateTenantCache,
 * or the change sits behind the tenant cache's TTL — for a REVOCATION that is a minute of access
 * already paid for and stopped, which is the direction that matters.
 *
 * `until` is bound as-is and must already be in the stored shape ('YYYY-MM-DD HH:MM:SS', UTC);
 * `normalizePremiumUntil` (server/lib/premium.ts) is the one place that shape is produced, so the
 * comparison `PremiumUntil > now` stays a comparison of like with like.
 */
export async function setTenantPremiumUntil(
  db: D1Database,
  tenantId: string,
  until: string | null,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE Tenants SET PremiumUntil = ? WHERE Id = ?')
    .bind(until, tenantId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Owner-scope: irreversibly delete a tenant and ALL its data. One child-first batch (D1 enforces
 * FKs with no ON DELETE CASCADE, so leaves must go before parents; the single batch means a
 * failure leaves every table untouched together). Covers all tenant-keyed tables — including
 * PetOwners, which references BOTH EndUserPets and EndUsers and so must be the first thing to go —
 * the transitively-scoped BookingRequestPets, and the claimed AllowedSitters row (email fully
 * deleted — the owner must re-invite to bring the sitter back). Returns whether the Tenants row
 * was deleted (false = no such tenant). Caller must resolve the slug first and
 * invalidateTenantCache after.
 *
 * THIS LIST IS HAND-MAINTAINED: a new tenant-keyed table that is not added here makes tenant
 * deletion fail on a foreign key.
 */
export async function deleteTenantCompletely(db: D1Database, tenantId: string): Promise<boolean> {
  const results = await db.batch([
    db.prepare('DELETE FROM PetOwners WHERE TenantId = ?').bind(tenantId),
    db
      .prepare(
        `DELETE FROM BookingRequestPets
           WHERE BookingRequestId IN (SELECT Id FROM BookingRequests WHERE TenantId = ?)`,
      )
      .bind(tenantId),
    db.prepare('DELETE FROM Payments WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM BookingCharges WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM BookingRequests WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM EndUserPets WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM LoginCodes WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM SavedAnswers WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM PersonalAccessTokens WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM EndUsers WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM TenantServiceOptions WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM PetGroupPricing WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM TenantServicePetRates WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM TenantServices WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM TenantPetTypes WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM ProviderConnections WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM TenantUsers WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM AllowedSitters WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM Tenants WHERE Id = ?').bind(tenantId),
  ]);
  const tenantResult = results[results.length - 1] as { meta: { changes?: number } };
  return (tenantResult.meta.changes ?? 0) > 0;
}

/**
 * Signup provisioning as ONE atomic batch (deleteService precedent; the test shim's batch is
 * transactional): Tenants → TenantUsers → claim the allowlist row. A replay that beat the
 * nonce race dies on TenantUsers.Email UNIQUE, aborting the WHOLE batch — no orphan tenant.
 * The new tenant carries only Id/Slug/DisplayName: every limit stays NULL (unlimited /
 * instance-default) and NO services are seeded — the onboarding wizard owns that.
 *
 * `ContactEmail` is deliberately left NULL, and the signup email must NOT be copied into it:
 * ContactEmail is PUBLIC (unauthenticated `/config` → the widget renders it as a live `mailto:`,
 * and `lib/llms.ts` emits it as JSON-LD `email` for crawlers), while the signup address is a
 * LOGIN credential that may well be personal. Publishing it silently, before the sitter has seen
 * a single prompt, is a privacy leak. The wizard instead PREFILLS the field from the admin's own
 * email (`adminEmail` on GET /admin/settings) so the sitter sees the value in a labelled input
 * and affirmatively continues — consent at the point of publication, not at signup.
 *
 * The claim UPDATE's `WHERE ... AND ClaimedAt IS NULL` guard can match ZERO rows (invite
 * revoked, or its row deleted, between the caller's checks and this batch) without D1
 * treating that as a failure — a batch only aborts on a THROWN statement, not a no-op UPDATE.
 * A batch can't gate one statement's execution on another's row count, so the Tenants/
 * TenantUsers inserts land regardless. Returns false in that case so the caller can compensate
 * (see rollbackUnclaimedTenant) — a tenant must never stand without a valid claim.
 *
 * Dog + cat pet-type REGISTRY rows are seeded (spec F1): without them a sitter who skips the
 * wizard could never take a booking.
 */
export async function createTenantFromSignup(
  db: D1Database,
  args: {
    tenantId: string;
    slug: string;
    displayName: string;
    userId: string;
    email: string;
    passwordHash: string;
    claimedAtIso?: string;
  },
): Promise<boolean> {
  const claimedAt = args.claimedAtIso ?? new Date().toISOString();
  const results = await db.batch([
    db
      // New tenants default to a 12-month booking horizon (0004's NULL-=-unlimited convention
      // still applies to every OTHER insert path — this is a signup-time default, not a schema
      // DEFAULT, so it can't silently change behavior elsewhere). A sitter can widen or clear it
      // from the wizard's profile step or Business settings.
      .prepare('INSERT INTO Tenants (Id, Slug, DisplayName, MaxAdvanceMonths) VALUES (?, ?, ?, ?)')
      .bind(args.tenantId, args.slug, args.displayName, 12),
    db
      .prepare('INSERT INTO TenantUsers (Id, TenantId, Email, PasswordHash) VALUES (?, ?, ?, ?)')
      .bind(args.userId, args.tenantId, args.email, args.passwordHash),
    db
      .prepare(
        'UPDATE AllowedSitters SET ClaimedAt = ?, TenantId = ? WHERE Email = ? AND ClaimedAt IS NULL',
      )
      .bind(claimedAt, args.tenantId, args.email),
    db
      .prepare("INSERT INTO TenantPetTypes (TenantId, PetType, Label) VALUES (?, 'dog', 'Dog')")
      .bind(args.tenantId),
    db
      .prepare("INSERT INTO TenantPetTypes (TenantId, PetType, Label) VALUES (?, 'cat', 'Cat')")
      .bind(args.tenantId),
  ]);
  const claimResult = results[2] as { meta: { changes?: number } };
  return (claimResult.meta.changes ?? 0) > 0;
}

/**
 * Best-effort compensation for createTenantFromSignup returning false: removes the tenant/
 * login/pet-type rows it just inserted so an unclaimed invite can never leave a tenant standing.
 */
export async function rollbackUnclaimedTenant(
  db: D1Database,
  tenantId: string,
  userId: string,
): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM TenantPetTypes WHERE TenantId = ?').bind(tenantId),
    db.prepare('DELETE FROM TenantUsers WHERE Id = ?').bind(userId),
    db.prepare('DELETE FROM Tenants WHERE Id = ?').bind(tenantId),
  ]);
}
