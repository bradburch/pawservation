import type {
  AllowedSitterRow,
  AnalyticsData,
  BookingChargeRow,
  BookingRow,
  CancellationTier,
  EndUser,
  EndUserPet,
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
import type { CapacityKind, RateUnit, ServiceShape, ServiceType } from '../lib/services';
import type { PaymentMethod, PetRateMode } from '../lib/validation';
import type { ServiceQuestion } from '../../src/shared/index.js';
import { parseMixKey, quarterlyBreakdown } from '../../src/shared/index.js';
import { constantTimeEqual } from '../lib/timing';
import { DEMO_EMAIL } from '../lib/demo';

/**
 * The ONLY module allowed to touch PAWBOOK_DB. Every function below either resolves a
 * tenant (getTenantBySlug) / a login (getTenantUserByEmail) or takes `tenantId` as its FIRST
 * parameter and scopes its SQL with `WHERE TenantId = ?`. Importing the D1 binding elsewhere
 * is a defect.
 */

const TENANT_COLS =
  'Id, Slug, DisplayName, AccentColor, Timezone, ContactEmail, ContactPhone, MaxAdvanceMonths, HousesitBoardingOverlapDays, DisabledAt';

const BOOKING_COLS =
  'Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, StartTime, OptionKey, PetCount, EstCost, CancellationFee, GCalEventId, Status, CreatedAt';

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
              AcceptedPetTypes, MaxConcurrentPets, CancellationTiers, HolidayRate, PetRateMode
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
 * Rows that feed the capacity map: bookings whose service draws from a capacity pool
 * (CapacityKind boarding/housesit — custom services included) + blocked ranges, pending or
 * confirmed, overlapping [from, to). `excludeId` omits one row — used by the post-insert race
 * check so a just-created booking re-asks "do I still fit, ignoring myself?" against everyone else.
 */
export async function listCapacityRows(
  db: D1Database,
  tenantId: string,
  fromDate: string,
  toDateExclusive: string,
  excludeId?: string,
): Promise<CapacityRow[]> {
  const cols = BOOKING_COLS.split(', ')
    .map((c) => `b.${c}`)
    .join(', ');
  const { results } = await db
    .prepare(
      `SELECT ${cols}, s.CapacityKind
       FROM BookingRequests b
       LEFT JOIN TenantServices s ON s.TenantId = b.TenantId AND s.ServiceType = b.ServiceType
       WHERE b.TenantId = ? AND b.Status IN ('pending', 'confirmed')
         AND (b.ServiceType IN ('blocked', 'external') OR s.CapacityKind IN ('boarding', 'housesit'))
         AND b.StartDate < ? AND COALESCE(b.EndDate, b.StartDate) >= ?
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
 * matching the pattern `listCapacityRows` already uses for boarding/house-sit.
 */
export async function countSlotBookings(
  db: D1Database,
  tenantId: string,
  serviceType: ServiceType,
  optionKey: string,
  date: string,
  excludeId?: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(PetCount), 0) AS n FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ? AND StartDate = ?
         AND Status IN ('pending', 'confirmed') AND (? IS NULL OR Id != ?)`,
    )
    .bind(tenantId, serviceType, optionKey, date, excludeId ?? null, excludeId ?? null)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Per-date pet counts against one option over [fromDate, toDateExclusive) — ONE query for
 * a whole month grid, so `monthAvailability` never issues one DB round-trip per day (the
 * "build the map once" pattern `buildCapacity` already uses for boarding/house-sit).
 */
export async function listSlotBookingCounts(
  db: D1Database,
  tenantId: string,
  serviceType: ServiceType,
  optionKey: string,
  fromDate: string,
  toDateExclusive: string,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT StartDate, COALESCE(SUM(PetCount), 0) AS n FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ?
         AND StartDate >= ? AND StartDate < ? AND Status IN ('pending', 'confirmed')
       GROUP BY StartDate`,
    )
    .bind(tenantId, serviceType, optionKey, fromDate, toDateExclusive)
    .all<{ StartDate: string; n: number }>();
  return new Map(results.map((r) => [r.StartDate, r.n]));
}

/** Real bookings are born sync-pending; the outbox clears on push success. */
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
         (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Answers, Status, Source, IdempotencyKey, SyncPending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.estCost,
      JSON.stringify(row.answers ?? {}),
      row.status,
      row.source ?? null,
      row.idempotencyKey ?? null,
      row.serviceType === 'blocked' ? 0 : 1,
    )
    .run();
  return id;
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

export async function listBookingsForUser(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_COLS}
       FROM BookingRequests
       WHERE TenantId = ? AND EndUserId = ?
       ORDER BY StartDate DESC`,
    )
    .bind(tenantId, endUserId)
    .all<BookingRow>();
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
 */
export async function getBookingForUser(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  id: string,
): Promise<BookingRow | null> {
  return await db
    .prepare(
      `SELECT ${BOOKING_COLS} FROM BookingRequests
       WHERE TenantId = ? AND EndUserId = ? AND Id = ?
         AND ServiceType NOT IN ('blocked', 'external')`,
    )
    .bind(tenantId, endUserId, id)
    .first<BookingRow>();
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
      `SELECT Id, TenantId, BookingRequestId, Amount, Method, PaidDate, Note, CreatedAt
       FROM Payments WHERE TenantId = ? AND BookingRequestId = ?
       ORDER BY PaidDate DESC, CreatedAt DESC`,
    )
    .bind(tenantId, bookingRequestId)
    .all<PaymentRow>();
  return results;
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
      `SELECT Id, TenantId, BookingRequestId, Label, Amount, CreatedAt
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
      `SELECT Id, TenantId, BookingRequestId, Label, Amount, CreatedAt
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
 * "how much is this booking worth" figure shared by the earnings payload's outstanding predicate
 * AND the Venmo importer's candidate balances, so a charge logged in the admin panel is never
 * invisible to either. Expects a `chg` subquery (SUM(BookingCharges.Amount) per booking) aliased
 * in scope — see `CHARGES_JOIN_SQL`.
 */
const EXPECTED_AMOUNT_SQL = `(${BASE_AMOUNT_SQL} + COALESCE(chg.Total, 0))`;

/** The extra-charges LEFT JOIN `EXPECTED_AMOUNT_SQL` depends on. Carries one bind param (tenantId). */
const CHARGES_JOIN_SQL = `LEFT JOIN (
         SELECT BookingRequestId, SUM(Amount) AS Total
         FROM BookingCharges WHERE TenantId = ? GROUP BY BookingRequestId
       ) chg ON chg.BookingRequestId = b.Id`;

/**
 * A booking is OUTSTANDING when it is live (confirmed or cancelled — declined rows are never
 * billed) and under-paid once charges are counted. Shared verbatim by the earnings payload and
 * the Venmo importer's candidate set so the sitter can never be offered a booking the Earnings
 * page does not consider owing, and a cancelled booking with no assessed fee but a live charge
 * still surfaces as outstanding. Expects `paid` and `chg` subqueries aliased in scope.
 *
 * `insertPayment`'s guard is the third reader of this rule (it cannot share the SQL — it has no
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

export type OutstandingBookingRow = {
  BookingId: string;
  EndUserId: string | null;
  ServiceType: string;
  StartDate: string;
  Expected: number;
  PaidTotal: number;
};

/**
 * Every under-paid booking for this tenant, carrying the client who owes it — the candidate set the
 * Venmo importer matches a received payment against. Same outstanding predicate as the earnings
 * payload (shared consts above), different projection: EndUserId matters here and nowhere else.
 * `Expected` already includes extra charges (see `EXPECTED_AMOUNT_SQL`), so a Venmo payment that
 * covers a booking's quote PLUS a logged charge still matches.
 */
export async function listOutstandingBookings(
  db: D1Database,
  tenantId: string,
): Promise<OutstandingBookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT b.Id AS BookingId, b.EndUserId AS EndUserId, b.ServiceType AS ServiceType,
              b.StartDate AS StartDate,
              ${EXPECTED_AMOUNT_SQL} AS Expected,
              COALESCE(paid.Total, 0) AS PaidTotal
       FROM BookingRequests b
       LEFT JOIN (
         SELECT BookingRequestId, SUM(Amount) AS Total
         FROM Payments WHERE TenantId = ? GROUP BY BookingRequestId
       ) paid ON paid.BookingRequestId = b.Id
       ${CHARGES_JOIN_SQL}
       WHERE b.TenantId = ? AND ${OUTSTANDING_WHERE_SQL}
       ORDER BY b.StartDate DESC, b.Id`,
    )
    .bind(tenantId, tenantId, tenantId)
    .all<OutstandingBookingRow>();
  return results;
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

  const [monthlyRes, byServiceRes, topClientsRes, outstandingRes] = await Promise.all([
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
  ]);

  const byMonth = new Map(monthlyRes.results.map((r) => [r.Month, r.Total]));
  const monthly = months.map((month) => ({ Month: month, Total: byMonth.get(month) ?? 0 }));
  const { ytd, quarters } = quarterlyBreakdown(monthly, y);
  return {
    monthly,
    ytd,
    quarterly: quarters,
    byService: byServiceRes.results,
    topClients: topClientsRes.results,
    outstanding: outstandingRes.results,
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
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE TenantServices SET
         Enabled = ?, Description = ?, Questions = ?, MaxNights = ?,
         MaxPetCount = ?, MinLeadDays = ?, AcceptedPetTypes = ?, MaxConcurrentPets = ?,
         CancellationTiers = ?, HolidayRate = ?, PetRateMode = ?
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

export async function deleteBlockedRange(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      "DELETE FROM BookingRequests WHERE TenantId = ? AND Id = ? AND ServiceType = 'blocked'",
    )
    .bind(tenantId, id)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Ids of bookings synced to Calendar and not yet cancelled, bounded to [fromDate, toDateExclusive)
 * — reconciliation's candidate set, restricted to the same window it queried Calendar for (a
 * booking outside that window couldn't possibly have appeared in the Calendar response, so it must
 * never be treated as "missing").
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
         AND ServiceType != 'external'
         AND StartDate < ? AND COALESCE(EndDate, StartDate) >= ?`,
    )
    .bind(tenantId, toDateExclusive, fromDate)
    .all<{ Id: string }>();
  return results.map((r) => r.Id);
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
 */
export async function clearBookingCalendarEventIds(
  db: D1Database,
  tenantId: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE BookingRequests SET GCalEventId = NULL
       WHERE TenantId = ? AND GCalEventId IS NOT NULL AND ServiceType != 'external'`,
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
 */
export async function insertInvitedCustomerWithPet(
  db: D1Database,
  tenantId: string,
  email: string,
  name: string,
  phone: string | null,
  petName: string,
  petType: PetType,
): Promise<EndUser> {
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
  const [, , , , , endUsersResult] = await db.batch([
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
    db
      .prepare(
        `DELETE FROM EndUsers
           WHERE TenantId = ? AND Id = ? AND ${bookingGuard} AND ${cascadingPetGuard}`,
      )
      .bind(tenantId, id, tenantId, id, tenantId, id, id),
  ]);
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
 * Count bookings referencing a pet, scoped to the tenant. BookingRequestPets has no TenantId, so
 * tenancy flows in via a join to EndUserPets — a foreign pet id counts as 0 (never a cross-tenant
 * existence oracle) regardless of D1's own foreign-key enforcement, since BookingRequestPets' FKs
 * reference BookingRequests(Id)/EndUserPets(Id) without a TenantId and so can't detect a
 * cross-tenant mismatch on their own.
 */
export async function countBookingPetRefs(
  db: D1Database,
  tenantId: string,
  petId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM BookingRequestPets brp
       JOIN EndUserPets p ON p.Id = brp.PetId
       WHERE brp.PetId = ? AND p.TenantId = ?`,
    )
    .bind(petId, tenantId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function removeEndUserPet(
  db: D1Database,
  tenantId: string,
  petId: string,
): Promise<boolean> {
  // PetOwners (0019) FKs to EndUserPets, so its row(s) for this pet must be deleted first — D1
  // enforces foreign keys, so deleting EndUserPets first would fail with a constraint error rather
  // than silently leave an orphaned PetOwners row.
  const [, petResult] = await db.batch([
    db.prepare('DELETE FROM PetOwners WHERE TenantId = ? AND PetId = ?').bind(tenantId, petId),
    db.prepare('DELETE FROM EndUserPets WHERE TenantId = ? AND Id = ?').bind(tenantId, petId),
  ]);
  return (petResult.meta as { changes?: number }).changes !== 0;
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
  DurationMinutes: number | null;
  PetCount: number;
  EstCost: number | null;
  Status: 'pending' | 'confirmed';
};

const BOOKING_SYNC_COLS = `b.Id AS Id, b.EndUserId AS EndUserId, b.ServiceType AS ServiceType,
       COALESCE(s.Label, b.ServiceType) AS ServiceLabel, b.StartDate AS StartDate,
       b.EndDate AS EndDate, b.StartTime AS StartTime, o.DurationMinutes AS DurationMinutes,
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

/** Future (StartDate >= today), non-cancelled, real (non-'blocked') bookings that have NO calendar
 * event yet — the backfill candidate set when a sitter connects Google Calendar after already
 * taking bookings. Capped at LIMIT; ordered by date so the soonest are synced first. */
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
         AND b.ServiceType NOT IN ('blocked', 'external') AND b.StartDate >= ?
       ORDER BY b.StartDate
       LIMIT ?`,
    )
    .bind(tenantId, today, limit)
    .all<BookingSyncRow>();
  return results;
}

/** Outbox candidates: rows whose latest state change Google has not confirmed. Real bookings
 * only ('blocked' is never synced; 'external' is Google-owned). Bounded so ancient never-synced
 * history doesn't churn every sweep, soonest first. Status here can be any of the four, and
 * CancellationFee rides along because the delete-vs-retitle decision for a cancelled row turns on
 * it (keepsCalendarEventOnCancel) — the caller derives create/update/delete from Status +
 * CancellationFee + GCalEventId.
 *
 * The bound is `COALESCE(EndDate, StartDate) >= fromDate` — the same shape `listSyncedBookingIds`
 * uses, and for the same reason: a stay that has ALREADY STARTED is still live. `StartDate >=
 * fromDate` excluded it, and a customer may cancel an in-progress stay (isCustomerCancellable),
 * so that row's SyncPending could never be drained: the ghost event stayed on the sitter's
 * calendar forever, and a fee-bearing cancel never got its [CANCELLED] retitle. It also stranded
 * the connect-later backfill for any stay spanning today. */
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
         AND b.ServiceType NOT IN ('blocked', 'external')
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
