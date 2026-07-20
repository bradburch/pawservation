import type {
  AllowedSitterRow,
  AnalyticsData,
  BookingRow,
  EndUser,
  EndUserPet,
  OwnerUser,
  PaymentRow,
  PetType,
  ProviderConnection,
  ProviderConnectionWithTokens,
  Tenant,
  TenantPetTypeRow,
  TenantService,
  TenantServiceOption,
  TenantUser,
} from '../types';
import type { CapacityKind, RateUnit, ServiceShape, ServiceType } from '../lib/services';
import type { PaymentMethod } from '../lib/validation';
import type { ServiceQuestion } from '../../src/shared/index.js';
import { constantTimeEqual } from '../lib/timing';

/**
 * The ONLY module allowed to touch PAWBOOK_DB. Every function below either resolves a
 * tenant (getTenantBySlug) / a login (getTenantUserByEmail) or takes `tenantId` as its FIRST
 * parameter and scopes its SQL with `WHERE TenantId = ?`. Importing the D1 binding elsewhere
 * is a defect.
 */

const TENANT_COLS = 'Id, Slug, DisplayName, AccentColor, Timezone, ContactEmail, ContactPhone';

const BOOKING_COLS =
  'Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, StartTime, OptionKey, PetType, PetCount, EstCost, GCalEventId, Status, Declined, CreatedAt';

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

export async function listServices(db: D1Database, tenantId: string): Promise<TenantService[]> {
  const { results } = await db
    .prepare(
      `SELECT TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind,
              SortOrder, Questions, MinNights, MaxNights, MinPetCount, MaxPetCount, AcceptedPetTypes,
              MaxConcurrentPets, MaxPerDay
       FROM TenantServices WHERE TenantId = ? ORDER BY SortOrder, Label`,
    )
    .bind(tenantId)
    .all<
      Omit<TenantService, 'Questions' | 'AcceptedPetTypes'> & {
        Questions: string;
        AcceptedPetTypes: string | null;
      }
    >();
  return results.map((r) => ({
    ...r,
    Questions: JSON.parse(r.Questions) as ServiceQuestion[],
    AcceptedPetTypes:
      r.AcceptedPetTypes === null ? null : (JSON.parse(r.AcceptedPetTypes) as string[]),
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
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO TenantServices
         (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind, SortOrder)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
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
      `SELECT Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity, WeekdaysOnly
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

/** Customer pets + bookings of ANY status referencing the slug — history included, mirroring
 * countBookingsForService's rule, so deletion never orphans a slug that admin lists and CSV
 * exports would otherwise render as a bare token. */
export async function countPetTypeReferences(
  db: D1Database,
  tenantId: string,
  petType: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM EndUserPets WHERE TenantId = ? AND PetType = ?)
            + (SELECT COUNT(*) FROM BookingRequests WHERE TenantId = ? AND PetType = ?) AS n`,
    )
    .bind(tenantId, petType, tenantId, petType)
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
  const statements = [
    db
      .prepare('DELETE FROM TenantPetTypes WHERE TenantId = ? AND PetType = ?')
      .bind(tenantId, petType),
  ];
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
         AND (b.ServiceType = 'blocked' OR s.CapacityKind IN ('boarding', 'housesit'))
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
 * Count non-cancelled bookings against one option on one date — enforces a windowed option's
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
      `SELECT COUNT(*) AS n FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ? AND StartDate = ?
         AND Status IN ('pending', 'confirmed') AND (? IS NULL OR Id != ?)`,
    )
    .bind(tenantId, serviceType, optionKey, date, excludeId ?? null, excludeId ?? null)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Per-date booking counts against one option over [fromDate, toDateExclusive) — ONE query for
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
      `SELECT StartDate, COUNT(*) AS n FROM BookingRequests
       WHERE TenantId = ? AND ServiceType = ? AND OptionKey = ?
         AND StartDate >= ? AND StartDate < ? AND Status IN ('pending', 'confirmed')
       GROUP BY StartDate`,
    )
    .bind(tenantId, serviceType, optionKey, fromDate, toDateExclusive)
    .all<{ StartDate: string; n: number }>();
  return new Map(results.map((r) => [r.StartDate, r.n]));
}

export async function insertBookingRequest(
  db: D1Database,
  tenantId: string,
  row: {
    endUserId: string | null;
    serviceType: ServiceType | 'blocked';
    startDate: string;
    endDate: string | null;
    optionKey: string | null;
    petType: PetType | null;
    petCount: number;
    startTime?: string | null;
    estCost: number | null;
    status: 'pending' | 'confirmed';
    answers?: Record<string, string>;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO BookingRequests
         (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetType, PetCount, StartTime, EstCost, Answers, Status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      tenantId,
      row.endUserId,
      row.serviceType,
      row.startDate,
      row.endDate,
      row.optionKey,
      row.petType,
      row.petCount,
      row.startTime ?? null,
      row.estCost,
      JSON.stringify(row.answers ?? {}),
      row.status,
    )
    .run();
  return id;
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
      `SELECT ${BOOKING_COLS}, Declined
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
): Promise<(BookingRow & { Email: string | null; Name: string | null; PaidTotal: number })[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_COLS_QUALIFIED}, EndUsers.Email AS Email, EndUsers.Name AS Name,
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
    .all<BookingRow & { Email: string | null; Name: string | null; PaidTotal: number }>();
  return results;
}

/**
 * Sitter-driven lifecycle transition. The guard is entirely in SQL so it's atomic with the write:
 * 'blocked' rows aren't real bookings (never surfaced or manageable here), and 'cancelled' is
 * terminal — once cancelled, no further transition matches. Confirming an already-confirmed row
 * still matches (harmless no-op). Returns whether a row actually changed.
 *
 * 'declined' is a sitter's "no" to a still-pending request: stored as Status 'cancelled' with the
 * Declined flag set (the Status CHECK can't grow a value without a table rebuild), and only valid
 * from 'pending' — a confirmed booking is cancelled, never declined.
 */
export async function updateBookingStatus(
  db: D1Database,
  tenantId: string,
  id: string,
  status: 'confirmed' | 'cancelled' | 'declined',
): Promise<boolean> {
  const result =
    status === 'declined'
      ? await db
          .prepare(
            `UPDATE BookingRequests SET Status = 'cancelled', Declined = 1
             WHERE TenantId = ? AND Id = ? AND ServiceType != 'blocked' AND Status = 'pending'`,
          )
          .bind(tenantId, id)
          .run()
      : await db
          .prepare(
            `UPDATE BookingRequests SET Status = ?
             WHERE TenantId = ? AND Id = ? AND ServiceType != 'blocked' AND Status != 'cancelled'`,
          )
          .bind(status, tenantId, id)
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
 * Record a payment iff the booking exists for THIS tenant, is not a 'blocked' sentinel, and is
 * not cancelled — the guard lives in the SQL (INSERT ... SELECT ... WHERE) so it is atomic with
 * the write, like updateBookingStatus's guarded UPDATE. 'pending' is deliberately allowed:
 * deposits are commonly collected before a booking is confirmed. Returns the new payment id, or
 * null when the guard refused (route 404s on null, the existing idiom).
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
  },
): Promise<string | null> {
  const id = crypto.randomUUID();
  const result = await db
    .prepare(
      `INSERT INTO Payments (Id, TenantId, BookingRequestId, Amount, Method, PaidDate, Note)
       SELECT ?, ?, ?, ?, ?, ?, ?
       FROM BookingRequests
       WHERE TenantId = ? AND Id = ? AND ServiceType != 'blocked' AND Status != 'cancelled'`,
    )
    .bind(
      id,
      tenantId,
      payment.bookingRequestId,
      payment.amount,
      payment.method,
      payment.paidDate,
      payment.note,
      tenantId,
      payment.bookingRequestId,
    )
    .run();
  return (result.meta as { changes?: number }).changes !== 0 ? id : null;
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
 * The four earnings aggregates in one round trip (Promise.all over indexed SELECTs — no KV
 * caching; revisit only if it measurably drags). `today` ('YYYY-MM-DD', tenant-timezone at the
 * route) anchors the 12-month window; months with no payments are zero-filled here in JS.
 * Revenue queries count payments regardless of the booking's later status — cash already
 * received is real revenue; only `outstanding` filters to confirmed (and skips EstCost IS NULL:
 * a booking with no estimate has no computable balance).
 */
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
        `SELECT b.Id AS BookingId, u.Name AS Name, u.Email AS Email,
                b.ServiceType AS ServiceType, b.StartDate AS StartDate,
                b.EstCost AS EstCost, COALESCE(paid.Total, 0) AS PaidTotal
         FROM BookingRequests b
         LEFT JOIN EndUsers u ON u.Id = b.EndUserId AND u.TenantId = b.TenantId
         LEFT JOIN (
           SELECT BookingRequestId, SUM(Amount) AS Total
           FROM Payments WHERE TenantId = ? GROUP BY BookingRequestId
         ) paid ON paid.BookingRequestId = b.Id
         WHERE b.TenantId = ? AND b.Status = 'confirmed' AND b.ServiceType != 'blocked'
           AND b.EstCost IS NOT NULL AND COALESCE(paid.Total, 0) < b.EstCost
         ORDER BY b.EstCost - COALESCE(paid.Total, 0) DESC`,
      )
      .bind(tenantId, tenantId)
      .all<AnalyticsData['outstanding'][number]>(),
  ]);

  const byMonth = new Map(monthlyRes.results.map((r) => [r.Month, r.Total]));
  return {
    monthly: months.map((month) => ({ Month: month, Total: byMonth.get(month) ?? 0 })),
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
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE Tenants SET DisplayName = ?, AccentColor = ?, Timezone = ?,
         ContactEmail = ?, ContactPhone = ? WHERE Id = ?`,
    )
    .bind(
      settings.displayName,
      settings.accentColor,
      settings.timezone,
      settings.contactEmail ?? null,
      settings.contactPhone ?? null,
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
    questions: ServiceQuestion[];
    minNights: number | null;
    maxNights: number | null;
    minPetCount: number | null;
    maxPetCount: number | null;
    acceptedPetTypes: string[] | null;
    maxConcurrentPets: number | null;
    maxPerDay: number | null;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE TenantServices SET
         Enabled = ?, Questions = ?, MinNights = ?, MaxNights = ?, MinPetCount = ?, MaxPetCount = ?,
         AcceptedPetTypes = ?, MaxConcurrentPets = ?, MaxPerDay = ?
       WHERE TenantId = ? AND ServiceType = ?`,
    )
    .bind(
      config.enabled ? 1 : 0,
      JSON.stringify(config.questions),
      config.minNights,
      config.maxNights,
      config.minPetCount,
      config.maxPetCount,
      config.acceptedPetTypes === null ? null : JSON.stringify(config.acceptedPetTypes),
      config.maxConcurrentPets,
      config.maxPerDay,
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
    rateUnit: 'night' | 'day' | 'visit';
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
       (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity, WeekdaysOnly)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch([
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
        o.rateUnit,
        o.startTime,
        o.endTime,
        o.capacity,
        o.weekdaysOnly ? 1 : 0,
      ),
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
       WHERE TenantId = ? AND GCalEventId IS NOT NULL AND Status != 'cancelled'
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
      `INSERT INTO ProviderConnections
         (Id, TenantId, Capability, Provider, Status, ConnectedAt, AccessToken, RefreshToken, TokenExpiresAt, CalendarId)
       VALUES (?, ?, ?, ?, 'connected', ?, ?, ?, ?, ?)
       ON CONFLICT (TenantId, Capability) DO UPDATE SET
         Provider = excluded.Provider, Status = 'connected', ConnectedAt = excluded.ConnectedAt,
         AccessToken = excluded.AccessToken, RefreshToken = excluded.RefreshToken,
         TokenExpiresAt = excluded.TokenExpiresAt, CalendarId = excluded.CalendarId`,
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

export async function clearProviderConnection(
  db: D1Database,
  tenantId: string,
  capability: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ProviderConnections
       SET Status = 'disconnected', AccessToken = NULL, RefreshToken = NULL,
           TokenExpiresAt = NULL, CalendarId = NULL, ConnectedAt = NULL
       WHERE TenantId = ? AND Capability = ?`,
    )
    .bind(tenantId, capability)
    .run();
}

export async function setBookingGCalEventId(
  db: D1Database,
  tenantId: string,
  bookingId: string,
  eventId: string,
): Promise<void> {
  await db
    .prepare('UPDATE BookingRequests SET GCalEventId = ? WHERE TenantId = ? AND Id = ?')
    .bind(eventId, tenantId, bookingId)
    .run();
}

export async function getEndUserById(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<EndUser | null> {
  return await db
    .prepare(
      'SELECT Id, TenantId, Email, Name, Status, InvitedAt FROM EndUsers WHERE TenantId = ? AND Id = ?',
    )
    .bind(tenantId, id)
    .first<EndUser>();
}

const ENDUSER_COLS = 'Id, TenantId, Email, Name, Phone, Status, InvitedAt';

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
    Status: 'invited',
    InvitedAt: invitedAt,
  };
}

export async function listCustomers(db: D1Database, tenantId: string): Promise<EndUser[]> {
  const { results } = await db
    .prepare(`SELECT ${ENDUSER_COLS} FROM EndUsers WHERE TenantId = ? ORDER BY Email`)
    .bind(tenantId)
    .all<EndUser>();
  return results;
}

export async function deleteCustomer(
  db: D1Database,
  tenantId: string,
  id: string,
): Promise<boolean> {
  // Atomic guard: delete only when this customer has no bookings, so a booking created between
  // the route's count check and here can never orphan a live booking. The route still 409s on the
  // common path; this closes the TOCTOU with a safe no-op (0 rows -> false) on the race.
  //
  // D1 enforces foreign keys, so EndUsers can't be deleted while LoginCodes/EndUserPets rows
  // still reference it — and EndUserPets can't be deleted while BookingRequestPets rows still
  // reference IT (possible even though this customer has no bookings of their own: addBookingPets
  // only checks tenant match, not that a pet's owner is the booking's customer). Cascade child-first
  // in one batch, each statement carrying the same NOT-EXISTS bookings guard so a TOCTOU race leaves
  // every table untouched together rather than partially cascading before the guard trips.
  const bookingGuard = `NOT EXISTS (SELECT 1 FROM BookingRequests WHERE TenantId = ? AND EndUserId = ?)`;
  const [, , , endUsersResult] = await db.batch([
    db
      .prepare(
        `DELETE FROM BookingRequestPets
           WHERE PetId IN (SELECT Id FROM EndUserPets WHERE TenantId = ? AND EndUserId = ?)
             AND ${bookingGuard}`,
      )
      .bind(tenantId, id, tenantId, id),
    db
      .prepare(`DELETE FROM EndUserPets WHERE TenantId = ? AND EndUserId = ? AND ${bookingGuard}`)
      .bind(tenantId, id, tenantId, id),
    db
      .prepare(`DELETE FROM LoginCodes WHERE TenantId = ? AND EndUserId = ? AND ${bookingGuard}`)
      .bind(tenantId, id, tenantId, id),
    db
      .prepare(`DELETE FROM EndUsers WHERE TenantId = ? AND Id = ? AND ${bookingGuard}`)
      .bind(tenantId, id, tenantId, id),
  ]);
  return (endUsersResult.meta as { changes?: number }).changes !== 0;
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

export async function listAllEndUserPetsByTenant(
  db: D1Database,
  tenantId: string,
): Promise<EndUserPet[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, EndUserId, Name, PetType, Notes, CreatedAt
       FROM EndUserPets WHERE TenantId = ? ORDER BY EndUserId, Name`,
    )
    .bind(tenantId)
    .all<EndUserPet>();
  return results;
}

export async function listEndUserPets(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<EndUserPet[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, EndUserId, Name, PetType, Notes, CreatedAt
       FROM EndUserPets WHERE TenantId = ? AND EndUserId = ? ORDER BY Name`,
    )
    .bind(tenantId, endUserId)
    .all<EndUserPet>();
  return results;
}

export async function addEndUserPet(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  name: string,
  petType: PetType,
  notes: string | null = null,
): Promise<EndUserPet> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType, Notes) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, tenantId, endUserId, name, petType, notes)
    .run();
  const row = await db
    .prepare(
      `SELECT Id, TenantId, EndUserId, Name, PetType, Notes, CreatedAt FROM EndUserPets WHERE TenantId = ? AND Id = ?`,
    )
    .bind(tenantId, id)
    .first<EndUserPet>();
  return row!;
}

/**
 * Count bookings referencing a pet, scoped to the tenant. BookingRequestPets has no TenantId, so
 * tenancy flows in via a join to EndUserPets — a foreign pet id counts as 0 (never a cross-tenant
 * existence oracle) even with production D1's foreign keys OFF.
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
  const result = await db
    .prepare('DELETE FROM EndUserPets WHERE TenantId = ? AND Id = ?')
    .bind(tenantId, petId)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

/**
 * Link pets to a booking, tenant-scoped. Each insert is guarded so it only writes when BOTH the
 * booking and the pet belong to `tenantId` — a cross-tenant pet id (or a booking from another
 * tenant) silently inserts nothing, upholding isolation even with production D1's foreign keys OFF.
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
// only in this module. See migrations/0013_invite_signup_owner_console.sql.
// Callers normalize emails (trim + lowercase) before every read/write.
// ─────────────────────────────────────────────────────────────────────────────

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
 * Signup provisioning as ONE atomic batch (deleteService precedent; the test shim's batch is
 * transactional): Tenants → TenantUsers → claim the allowlist row. A replay that beat the
 * nonce race dies on TenantUsers.Email UNIQUE, aborting the WHOLE batch — no orphan tenant.
 * The new tenant carries only Id/Slug/DisplayName: every limit stays NULL (unlimited /
 * instance-default) and NO services are seeded — the onboarding wizard owns that.
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
      .prepare('INSERT INTO Tenants (Id, Slug, DisplayName) VALUES (?, ?, ?)')
      .bind(args.tenantId, args.slug, args.displayName),
    db
      .prepare('INSERT INTO TenantUsers (Id, TenantId, Email, PasswordHash) VALUES (?, ?, ?, ?)')
      .bind(args.userId, args.tenantId, args.email, args.passwordHash),
    db
      .prepare(
        'UPDATE AllowedSitters SET ClaimedAt = ?, TenantId = ? WHERE Email = ? AND ClaimedAt IS NULL',
      )
      .bind(claimedAt, args.tenantId, args.email),
    db
      .prepare("INSERT INTO TenantPetTypes (TenantId, PetType, Label) VALUES (?, 'dog', 'Dogs')")
      .bind(args.tenantId),
    db
      .prepare("INSERT INTO TenantPetTypes (TenantId, PetType, Label) VALUES (?, 'cat', 'Cats')")
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
