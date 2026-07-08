import type {
  BookingRow,
  EndUser,
  EndUserPet,
  PetType,
  ProviderConnection,
  ProviderConnectionWithTokens,
  Tenant,
  TenantPetTypeRow,
  TenantService,
  TenantServiceOption,
  TenantUser,
} from '../types';
import type { ServiceType } from '../lib/services';
import type { ServiceQuestion } from '../../src/shared/index.js';
import { constantTimeEqual } from '../lib/timing';

/**
 * The ONLY module allowed to touch PAWBOOK_DB. Every function below either resolves a
 * tenant (getTenantBySlug) / a login (getTenantUserByEmail) or takes `tenantId` as its FIRST
 * parameter and scopes its SQL with `WHERE TenantId = ?`. Importing the D1 binding elsewhere
 * is a defect.
 */

const TENANT_COLS =
  'Id, Slug, DisplayName, AccentColor, MaxBoardingPets, MaxHouseSitsPerDay, MaxStayNights, Timezone, ContactEmail, ContactPhone';

const BOOKING_COLS =
  'Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, StartTime, OptionKey, PetType, PetCount, EstCost, GCalEventId, Status, CreatedAt';

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
      `SELECT TenantId, ServiceType, Enabled, Questions, MinNights, MaxNights, MinPetCount, MaxPetCount
       FROM TenantServices WHERE TenantId = ?`,
    )
    .bind(tenantId)
    .all<Omit<TenantService, 'Questions'> & { Questions: string }>();
  return results.map((r) => ({ ...r, Questions: JSON.parse(r.Questions) as ServiceQuestion[] }));
}

export async function listServiceOptions(
  db: D1Database,
  tenantId: string,
): Promise<TenantServiceOption[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity
       FROM TenantServiceOptions WHERE TenantId = ? ORDER BY ServiceType, DurationMinutes`,
    )
    .bind(tenantId)
    .all<TenantServiceOption>();
  return results;
}

export async function listPetTypes(db: D1Database, tenantId: string): Promise<TenantPetTypeRow[]> {
  const { results } = await db
    .prepare('SELECT TenantId, PetType, Enabled FROM TenantPetTypes WHERE TenantId = ?')
    .bind(tenantId)
    .all<TenantPetTypeRow>();
  return results;
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

/**
 * Rows that feed the capacity map: boarding + house-sitting + blocked, pending or confirmed,
 * overlapping [from, to). `excludeId` omits one row — used by the post-insert race check so a
 * just-created booking re-asks "do I still fit, ignoring myself?" against everyone else.
 */
export async function listCapacityRows(
  db: D1Database,
  tenantId: string,
  fromDate: string,
  toDateExclusive: string,
  excludeId?: string,
): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_COLS}
       FROM BookingRequests
       WHERE TenantId = ? AND Status IN ('pending', 'confirmed')
         AND ServiceType IN ('boarding', 'housesitting', 'blocked')
         AND StartDate < ? AND COALESCE(EndDate, StartDate) >= ?
         AND (? IS NULL OR Id != ?)`,
    )
    .bind(tenantId, toDateExclusive, fromDate, excludeId ?? null, excludeId ?? null)
    .all<BookingRow>();
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
 * ever points at a row in the SAME tenant, enforced by how bookings are created).
 */
export async function listBookingsForTenant(
  db: D1Database,
  tenantId: string,
): Promise<(BookingRow & { Email: string | null; Name: string | null })[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BOOKING_COLS_QUALIFIED}, BookingRequests.Declined AS Declined,
              EndUsers.Email AS Email, EndUsers.Name AS Name
       FROM BookingRequests
       LEFT JOIN EndUsers ON EndUsers.Id = BookingRequests.EndUserId
         AND EndUsers.TenantId = BookingRequests.TenantId
       WHERE BookingRequests.TenantId = ? AND BookingRequests.ServiceType != 'blocked'
       ORDER BY BookingRequests.StartDate DESC, BookingRequests.CreatedAt DESC`,
    )
    .bind(tenantId)
    .all<BookingRow & { Email: string | null; Name: string | null }>();
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
    maxBoardingPets: number | null;
    maxHouseSitsPerDay: number | null;
    maxStayNights: number | null;
    timezone: string | null;
    contactEmail?: string | null;
    contactPhone?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE Tenants SET DisplayName = ?, AccentColor = ?, MaxBoardingPets = ?,
         MaxHouseSitsPerDay = ?, MaxStayNights = ?, Timezone = ?,
         ContactEmail = ?, ContactPhone = ? WHERE Id = ?`,
    )
    .bind(
      settings.displayName,
      settings.accentColor,
      settings.maxBoardingPets,
      settings.maxHouseSitsPerDay,
      settings.maxStayNights,
      settings.timezone,
      settings.contactEmail ?? null,
      settings.contactPhone ?? null,
      tenantId,
    )
    .run();
}

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
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO TenantServices (TenantId, ServiceType, Enabled, Questions, MinNights, MaxNights, MinPetCount, MaxPetCount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (TenantId, ServiceType) DO UPDATE SET
         Enabled = excluded.Enabled, Questions = excluded.Questions, MinNights = excluded.MinNights,
         MaxNights = excluded.MaxNights, MinPetCount = excluded.MinPetCount, MaxPetCount = excluded.MaxPetCount`,
    )
    .bind(
      tenantId,
      serviceType,
      config.enabled ? 1 : 0,
      JSON.stringify(config.questions),
      config.minNights,
      config.maxNights,
      config.minPetCount,
      config.maxPetCount,
    )
    .run();
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
  }[],
): Promise<void> {
  // DELETE-then-INSERT as ONE atomic, single-round-trip batch: a mid-write failure can no longer
  // leave the service's options half-wiped, and N options cost one trip instead of N+1.
  const insert = db.prepare(
    `INSERT INTO TenantServiceOptions
       (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit, StartTime, EndTime, Capacity)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ),
    ),
  ]);
}

export async function setPetTypeEnabled(
  db: D1Database,
  tenantId: string,
  petType: PetType,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO TenantPetTypes (TenantId, PetType, Enabled) VALUES (?, ?, ?)
       ON CONFLICT (TenantId, PetType) DO UPDATE SET Enabled = excluded.Enabled`,
    )
    .bind(tenantId, petType, enabled ? 1 : 0)
    .run();
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
  const result = await db
    .prepare(
      `DELETE FROM EndUsers WHERE TenantId = ? AND Id = ?
         AND NOT EXISTS (SELECT 1 FROM BookingRequests WHERE TenantId = ? AND EndUserId = ?)`,
    )
    .bind(tenantId, id, tenantId, id)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
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
): Promise<{ BookingRequestId: string; PetId: string; Name: string; PetType: 'dog' | 'cat' }[]> {
  const { results } = await db
    .prepare(
      `SELECT brp.BookingRequestId, brp.PetId, p.Name, p.PetType
       FROM BookingRequestPets brp
       JOIN BookingRequests br ON br.Id = brp.BookingRequestId
       JOIN EndUserPets p ON p.Id = brp.PetId AND p.TenantId = br.TenantId
       WHERE br.TenantId = ? AND br.EndUserId = ?`,
    )
    .bind(tenantId, endUserId)
    .all<{ BookingRequestId: string; PetId: string; Name: string; PetType: 'dog' | 'cat' }>();
  return results;
}
