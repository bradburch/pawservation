import type {
  BookingRow,
  EndUser,
  PetType,
  ProviderConnection,
  Tenant,
  TenantPetTypeRow,
  TenantService,
  TenantServiceOption,
  TenantUser,
} from '../types';
import type { ServiceType } from '../lib/services';
import { constantTimeEqual } from '../lib/timing';

/**
 * The ONLY module allowed to touch PAWBOOK_DB. Every function below either resolves a
 * tenant (getTenantBySlug) / a login (getTenantUserByEmail) or takes `tenantId` as its FIRST
 * parameter and scopes its SQL with `WHERE TenantId = ?`. Importing the D1 binding elsewhere
 * is a defect.
 */

const TENANT_COLS =
  'Id, Slug, DisplayName, AccentColor, MaxBoardingPets, MaxHouseSitsPerDay, MaxStayNights, Timezone';

const BOOKING_COLS =
  'Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetType, PetCount, EstCost, Status, CreatedAt';

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
    .prepare('SELECT TenantId, ServiceType, Enabled FROM TenantServices WHERE TenantId = ?')
    .bind(tenantId)
    .all<TenantService>();
  return results;
}

export async function listServiceOptions(
  db: D1Database,
  tenantId: string,
): Promise<TenantServiceOption[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit
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

export async function upsertEndUser(
  db: D1Database,
  tenantId: string,
  email: string,
): Promise<EndUser> {
  const existing = await db
    .prepare('SELECT Id, TenantId, Email FROM EndUsers WHERE TenantId = ? AND Email = ?')
    .bind(tenantId, email)
    .first<EndUser>();
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db
    .prepare('INSERT INTO EndUsers (Id, TenantId, Email) VALUES (?, ?, ?)')
    .bind(id, tenantId, email)
    .run();
  return { Id: id, TenantId: tenantId, Email: email };
}

export async function createLoginCode(
  db: D1Database,
  tenantId: string,
  endUserId: string,
  code: string,
  expiresAtIso: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO LoginCodes (Id, TenantId, EndUserId, Code, ExpiresAt) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, tenantId, endUserId, code, expiresAtIso)
    .run();
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
    estCost: number | null;
    status: 'pending' | 'confirmed';
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO BookingRequests
         (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetType, PetCount, EstCost, Status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.estCost,
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
      `SELECT ${BOOKING_COLS}
       FROM BookingRequests
       WHERE TenantId = ? AND EndUserId = ?
       ORDER BY StartDate DESC`,
    )
    .bind(tenantId, endUserId)
    .all<BookingRow>();
  return results;
}

export async function listProviderConnections(
  db: D1Database,
  tenantId: string,
): Promise<ProviderConnection[]> {
  const { results } = await db
    .prepare(
      'SELECT Id, TenantId, Capability, Provider, Status, ConnectedAt FROM ProviderConnections WHERE TenantId = ?',
    )
    .bind(tenantId)
    .all<ProviderConnection>();
  return results;
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
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE Tenants SET DisplayName = ?, AccentColor = ?, MaxBoardingPets = ?,
         MaxHouseSitsPerDay = ?, MaxStayNights = ?, Timezone = ? WHERE Id = ?`,
    )
    .bind(
      settings.displayName,
      settings.accentColor,
      settings.maxBoardingPets,
      settings.maxHouseSitsPerDay,
      settings.maxStayNights,
      settings.timezone,
      tenantId,
    )
    .run();
}

export async function setServiceEnabled(
  db: D1Database,
  tenantId: string,
  serviceType: ServiceType,
  enabled: boolean,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO TenantServices (TenantId, ServiceType, Enabled) VALUES (?, ?, ?)
       ON CONFLICT (TenantId, ServiceType) DO UPDATE SET Enabled = excluded.Enabled`,
    )
    .bind(tenantId, serviceType, enabled ? 1 : 0)
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
  }[],
): Promise<void> {
  // DELETE-then-INSERT as ONE atomic, single-round-trip batch: a mid-write failure can no longer
  // leave the service's options half-wiped, and N options cost one trip instead of N+1.
  const insert = db.prepare(
    `INSERT INTO TenantServiceOptions
       (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

export async function setProviderStatus(
  db: D1Database,
  tenantId: string,
  capability: string,
  provider: string,
  status: 'disconnected' | 'connected-stub',
): Promise<void> {
  const connectedAt = status === 'connected-stub' ? new Date().toISOString() : null;
  await db
    .prepare(
      `INSERT INTO ProviderConnections (Id, TenantId, Capability, Provider, Status, ConnectedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (TenantId, Capability)
       DO UPDATE SET Provider = excluded.Provider, Status = excluded.Status, ConnectedAt = excluded.ConnectedAt`,
    )
    .bind(crypto.randomUUID(), tenantId, capability, provider, status, connectedAt)
    .run();
}
