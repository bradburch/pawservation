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

/**
 * The ONLY module allowed to touch EMBED_PROTO_DB. Every function below either resolves a
 * tenant (getTenantBySlug) / a login (getTenantUserByEmail) or takes `tenantId` as its FIRST
 * parameter and scopes its SQL with `WHERE TenantId = ?`. Importing the D1 binding elsewhere
 * is a defect.
 */

export async function getTenantBySlug(db: D1Database, slug: string): Promise<Tenant | null> {
  return await db
    .prepare(
      'SELECT Id, Slug, DisplayName, AccentColor, MaxBoardingPets FROM Tenants WHERE Slug = ?',
    )
    .bind(slug)
    .first<Tenant>();
}

export async function getTenantById(db: D1Database, tenantId: string): Promise<Tenant | null> {
  return await db
    .prepare('SELECT Id, Slug, DisplayName, AccentColor, MaxBoardingPets FROM Tenants WHERE Id = ?')
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

/** Atomically consume a valid, unexpired, unused code. Returns the end user id or null. */
export async function consumeLoginCode(
  db: D1Database,
  tenantId: string,
  codeId: string,
  code: string,
  nowIso: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `UPDATE LoginCodes SET UsedAt = ?
       WHERE Id = ? AND TenantId = ? AND Code = ? AND UsedAt IS NULL AND ExpiresAt > ?
       RETURNING EndUserId`,
    )
    .bind(nowIso, codeId, tenantId, code, nowIso)
    .first<{ EndUserId: string }>();
  return row?.EndUserId ?? null;
}

/** Rows that feed the capacity map: boarding + house-sitting + blocked, pending or confirmed, overlapping [from, to). */
export async function listCapacityRows(
  db: D1Database,
  tenantId: string,
  fromDate: string,
  toDateExclusive: string,
): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetType, PetCount, EstCost, Status, CreatedAt
       FROM BookingRequests
       WHERE TenantId = ? AND Status IN ('pending', 'confirmed')
         AND ServiceType IN ('boarding', 'housesitting', 'blocked')
         AND StartDate < ? AND COALESCE(EndDate, StartDate) >= ?`,
    )
    .bind(tenantId, toDateExclusive, fromDate)
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

export async function listBookingsForUser(
  db: D1Database,
  tenantId: string,
  endUserId: string,
): Promise<BookingRow[]> {
  const { results } = await db
    .prepare(
      `SELECT Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetType, PetCount, EstCost, Status, CreatedAt
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
  settings: { displayName: string; accentColor: string; maxBoardingPets: number },
): Promise<void> {
  await db
    .prepare(
      'UPDATE Tenants SET DisplayName = ?, AccentColor = ?, MaxBoardingPets = ? WHERE Id = ?',
    )
    .bind(settings.displayName, settings.accentColor, settings.maxBoardingPets, tenantId)
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
  // Prototype: DELETE-then-INSERT without a transaction, matching the sequential-await style used
  // elsewhere in this module. The admin route validates every option before calling this, so a
  // mid-write failure is not expected; a production version would wrap these in db.batch().
  await db
    .prepare('DELETE FROM TenantServiceOptions WHERE TenantId = ? AND ServiceType = ?')
    .bind(tenantId, serviceType)
    .run();
  for (const o of options) {
    await db
      .prepare(
        `INSERT INTO TenantServiceOptions
           (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        tenantId,
        serviceType,
        o.optionKey,
        o.label,
        o.durationMinutes,
        o.rate,
        o.rateUnit,
      )
      .run();
  }
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
      `SELECT Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetType, PetCount, EstCost, Status, CreatedAt
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
