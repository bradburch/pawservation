# Calendar OAuth + Invite-only Customers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graduate the Google Calendar capability from a status-flip stub into real OAuth2 + calendar-event creation on booking, and flip the customer model to gated invite-only with provider-managed customers and invite emails.

**Architecture:** Real Google OAuth2 authorization-code flow; the callback is a single global route (no slug) carrying tenant identity in a signed, single-use `state`. Refresh/access tokens are AES-GCM encrypted at rest with a key derived from `TOKEN_SECRET`. Calendar event creation is best-effort (via `executionCtx.waitUntil`) so Google never blocks or fails a booking. Gating happens at `/identify`: only existing `EndUsers` may get a login code; the provider manages that list and adding a customer sends a Resend invite.

**Tech Stack:** Cloudflare Workers, Hono, D1 (SQLite), KV, WebCrypto (`crypto.subtle`), React (admin), Vitest + `node:sqlite`.

## Global Constraints

- **Repo isolation:** `server/db/repo.ts` is the ONLY module that touches `PAWBOOK_DB`; every function takes `tenantId` as its first param and scopes SQL with `WHERE TenantId = ?`.
- **Never expose OAuth tokens to any client.** Token columns are read only by server-internal code paths; the client-facing `listProviderConnections`/`providerViews` must NOT select or return them.
- **Tokens encrypted at rest** with AES-GCM; key derived from `TOKEN_SECRET` via HKDF-SHA256 (info `"pawbook-gcal-token"`). No new encryption secret.
- **Fail-closed email:** mirror existing `/identify` posture — never leak a code/secret; in production return 5xx rather than silently degrade. Dev (`ENVIRONMENT==='development'`) without a provider may skip sending.
- **Migrations:** add `migrations/0003_calendar_oauth_and_invites.sql` AND update `sql/schema.sql` in lockstep (fresh installs build from `schema.sql`; upgrades replay the migration). SQLite cannot `ALTER` a CHECK — widen via table rebuild.
- **Tests:** Vitest backed by in-memory `node:sqlite` via `createTestEnv()` in `server/__tests__/helpers.ts`. Mock Google/Resend HTTP with `vi.spyOn(globalThis, 'fetch')`.
- **Booking integrity is paramount:** calendar sync failures are caught, logged, and swallowed — they never change the booking response.
- **Commands:** `npm test`, `npm run typecheck`, `npm run lint`.

## File Structure

**New files**
- `migrations/0003_calendar_oauth_and_invites.sql` — schema upgrade.
- `server/lib/token-crypto.ts` — AES-GCM `encryptToken`/`decryptToken` (HKDF key).
- `server/lib/oauth-state.ts` — sign/verify HMAC `state` payloads.
- `server/lib/google-calendar.ts` — Google OAuth + Calendar REST + pure `buildEventResource`.
- `server/lib/calendar-sync.ts` — `syncBookingToCalendar` (orchestrates repo + google-calendar).
- `server/routes/oauth.ts` — global `GET /oauth/google/callback`.
- Tests: `server/__tests__/token-crypto.test.ts`, `oauth-state.test.ts`, `google-calendar.test.ts`, `oauth-callback.test.ts`, `invites.test.ts`, `migration-0003.test.ts`.

**Modified files**
- `sql/schema.sql`, `sql/seed.sql`, `server/types.ts`, `server/db/repo.ts`, `server/lib/providers.ts`, `server/lib/email.ts`, `server/routes/auth.ts`, `server/routes/admin.ts`, `server/routes/bookings.ts`, `server/index.ts`, `env.d.ts`, `.dev.vars`.
- `app/shared-ui/api.ts`, `app/admin/App.tsx`.
- Existing tests updated for gating: `server/__tests__/booking-flow.test.ts`, `identify-email.test.ts`, `isolation.test.ts` (via seeded demo customers — see Task 9).

**Dependency order:** Task 1 (schema) is the foundation. Phase 1 (Tasks 2–7) and Phase 2 (Tasks 8–11) are independent of each other after Task 1. Frontend (Tasks 12–13) comes last.

---

### Task 1: Schema migration, types, env, secrets

**Files:**
- Create: `migrations/0003_calendar_oauth_and_invites.sql`
- Modify: `sql/schema.sql`, `server/types.ts`, `env.d.ts`, `.dev.vars`
- Test: `server/__tests__/migration-0003.test.ts`

**Interfaces:**
- Produces: DB columns `BookingRequests.StartTime`, `BookingRequests.GCalEventId`, `EndUsers.Name`, `EndUsers.InvitedAt`, `EndUsers.Status`, `ProviderConnections.{AccessToken,RefreshToken,TokenExpiresAt,CalendarId}` and widened `Status` CHECK including `'connected'`. Types `EndUser`, `BookingRow`, `ProviderConnectionWithTokens`. Env vars `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`.

- [ ] **Step 1: Write the failing migration test**

Create `server/__tests__/migration-0003.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const SCHEMA_DIR = join(import.meta.dirname, '..', '..', 'sql');
const MIGRATION = join(
  import.meta.dirname, '..', '..', 'migrations', '0003_calendar_oauth_and_invites.sql',
);

describe('migration 0003 — calendar tokens + invite columns', () => {
  it('upgrades a pre-0003 DB: adds columns, backfills Status=active, keeps FK integrity', () => {
    const db = new DatabaseSync(':memory:');
    // Minimal pre-0003 shape (subset of the old schema) for the affected tables.
    db.exec(`
      CREATE TABLE Tenants (Id TEXT PRIMARY KEY, Slug TEXT NOT NULL UNIQUE, DisplayName TEXT NOT NULL,
        AccentColor TEXT NOT NULL DEFAULT '#4f46e5', CreatedAt TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE EndUsers (Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id),
        Email TEXT NOT NULL, CreatedAt TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (TenantId, Email));
      CREATE TABLE BookingRequests (Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id),
        EndUserId TEXT REFERENCES EndUsers(Id), ServiceType TEXT NOT NULL, StartDate TEXT NOT NULL,
        EndDate TEXT, OptionKey TEXT, PetType TEXT, PetCount INTEGER NOT NULL DEFAULT 1, EstCost INTEGER,
        Status TEXT NOT NULL DEFAULT 'pending', CreatedAt TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE ProviderConnections (Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id),
        Capability TEXT NOT NULL, Provider TEXT NOT NULL,
        Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected','connected-stub')),
        ConnectedAt TEXT, UNIQUE (TenantId, Capability));
      INSERT INTO Tenants (Id, Slug, DisplayName) VALUES ('t1','s1','T1');
      INSERT INTO EndUsers (Id, TenantId, Email) VALUES ('e1','t1','old@example.com');
      INSERT INTO ProviderConnections (Id, TenantId, Capability, Provider, Status)
        VALUES ('p1','t1','calendar','google-calendar','connected-stub');
    `);

    db.exec(readFileSync(MIGRATION, 'utf8'));

    // Grandfathered customer is 'active'.
    const eu = db.prepare(`SELECT Status, Name, InvitedAt FROM EndUsers WHERE Id='e1'`).get() as
      { Status: string; Name: null; InvitedAt: null };
    expect(eu.Status).toBe('active');
    expect(eu.Name).toBeNull();

    // New booking columns exist.
    db.prepare(`SELECT StartTime, GCalEventId FROM BookingRequests`).all();

    // Status CHECK now admits 'connected'; token columns exist.
    db.exec(`UPDATE ProviderConnections SET Status='connected', AccessToken='x', RefreshToken='y',
             TokenExpiresAt='2030-01-01T00:00:00Z', CalendarId='primary' WHERE Id='p1'`);
    const pc = db.prepare(`SELECT Status, AccessToken FROM ProviderConnections WHERE Id='p1'`).get() as
      { Status: string; AccessToken: string };
    expect(pc.Status).toBe('connected');
    expect(pc.AccessToken).toBe('x');

    expect(db.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0);
  });

  it('schema.sql alone (fresh install) already has every 0003 column', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(readFileSync(join(SCHEMA_DIR, 'schema.sql'), 'utf8'));
    db.prepare(`SELECT StartTime, GCalEventId FROM BookingRequests`).all();
    db.prepare(`SELECT Name, InvitedAt, Status FROM EndUsers`).all();
    db.prepare(`SELECT AccessToken, RefreshToken, TokenExpiresAt, CalendarId FROM ProviderConnections`).all();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- migration-0003`
Expected: FAIL (migration file does not exist / columns missing).

- [ ] **Step 3: Write the migration**

Create `migrations/0003_calendar_oauth_and_invites.sql`:

```sql
-- Phase 1 (Google Calendar OAuth) + Phase 2 (invite-only customers).
-- Run against already-provisioned DBs (local first, then remote):
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0003_calendar_oauth_and_invites.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0003_calendar_oauth_and_invites.sql

-- 1. BookingRequests: time-of-day for timed events + the created Google event id.
ALTER TABLE BookingRequests ADD COLUMN StartTime TEXT;
ALTER TABLE BookingRequests ADD COLUMN GCalEventId TEXT;

-- 2. EndUsers become the provider-managed customer list. Existing rows are grandfathered 'active'
--    (the DEFAULT applies to every backfilled row), so the new gate never locks out prior bookers.
ALTER TABLE EndUsers ADD COLUMN Name TEXT;
ALTER TABLE EndUsers ADD COLUMN InvitedAt TEXT;
ALTER TABLE EndUsers ADD COLUMN Status TEXT NOT NULL DEFAULT 'active' CHECK (Status IN ('invited', 'active'));

-- 3. ProviderConnections: widen Status CHECK to include 'connected' + add encrypted-token columns.
--    SQLite cannot ALTER a CHECK, so rebuild the table preserving FK + UNIQUE and copying rows.
PRAGMA foreign_keys=OFF;
CREATE TABLE ProviderConnections_new (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Capability TEXT NOT NULL,
  Provider TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected', 'connected-stub', 'connected')),
  ConnectedAt TEXT,
  AccessToken TEXT,
  RefreshToken TEXT,
  TokenExpiresAt TEXT,
  CalendarId TEXT,
  UNIQUE (TenantId, Capability)
);
INSERT INTO ProviderConnections_new (Id, TenantId, Capability, Provider, Status, ConnectedAt)
  SELECT Id, TenantId, Capability, Provider, Status, ConnectedAt FROM ProviderConnections;
DROP TABLE ProviderConnections;
ALTER TABLE ProviderConnections_new RENAME TO ProviderConnections;
PRAGMA foreign_keys=ON;
```

- [ ] **Step 4: Update `sql/schema.sql`** — add the columns to the canonical CREATE TABLEs.

In `EndUsers`, after the `Email TEXT NOT NULL,` line add:
```sql
  Name TEXT,
  InvitedAt TEXT,
  Status TEXT NOT NULL DEFAULT 'active' CHECK (Status IN ('invited', 'active')),
```

In `BookingRequests`, after the `PetCount INTEGER NOT NULL DEFAULT 1,` line add:
```sql
  StartTime TEXT, -- 'HH:MM' wall-clock for timed bookings (walk/check-in); NULL = all-day event
  GCalEventId TEXT, -- Google Calendar event id created for this booking; NULL if none/unsynced
```

Replace the `ProviderConnections` CREATE TABLE with:
```sql
CREATE TABLE IF NOT EXISTS ProviderConnections (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Capability TEXT NOT NULL,
  Provider TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected', 'connected-stub', 'connected')),
  ConnectedAt TEXT,
  -- AES-GCM ciphertext (base64 iv||ct), key derived from TOKEN_SECRET. NEVER returned to a client.
  AccessToken TEXT,
  RefreshToken TEXT,
  TokenExpiresAt TEXT,
  CalendarId TEXT,
  UNIQUE (TenantId, Capability)
);
```

- [ ] **Step 5: Update `server/types.ts`**

Extend `EndUser`:
```ts
export type EndUser = {
  Id: string;
  TenantId: string;
  Email: string;
  Name: string | null;
  Status: 'invited' | 'active';
  InvitedAt: string | null;
};
```

Add `StartTime` and `GCalEventId` to `BookingRow` (after `PetCount: number;`):
```ts
  StartTime: string | null;
  GCalEventId: string | null;
```

Add a tokens-bearing variant after `ProviderConnection`:
```ts
/** Server-internal: includes encrypted OAuth token columns. NEVER serialize to a client. */
export type ProviderConnectionWithTokens = ProviderConnection & {
  AccessToken: string | null;
  RefreshToken: string | null;
  TokenExpiresAt: string | null;
  CalendarId: string | null;
};
```

- [ ] **Step 6: Update `env.d.ts`** — add inside `interface Env`:
```ts
  /** Google OAuth2 client id. `wrangler secret put GOOGLE_CLIENT_ID`. */
  GOOGLE_CLIENT_ID: string;
  /** Google OAuth2 client secret. `wrangler secret put GOOGLE_CLIENT_SECRET`. */
  GOOGLE_CLIENT_SECRET: string;
  /** Absolute URL of the global OAuth callback, registered in Google Cloud. Used in the consent
   *  URL and the code exchange (must match exactly). e.g. https://<worker>/oauth/google/callback */
  GOOGLE_OAUTH_REDIRECT_URI: string;
```
> These are typed non-optional for ergonomics in the calendar code; routes guard at runtime when unset (Task 6).

- [ ] **Step 7: Update `.dev.vars`** — append (placeholder values for local dev; real creds via `wrangler secret put` in prod):
```
GOOGLE_CLIENT_ID=dev-google-client-id
GOOGLE_CLIENT_SECRET=dev-google-client-secret
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8787/oauth/google/callback
```

- [ ] **Step 8: Update `server/db/repo.ts` column lists** so existing SELECTs surface the new booking columns. Replace `BOOKING_COLS`:
```ts
const BOOKING_COLS =
  'Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, StartTime, OptionKey, PetType, PetCount, EstCost, GCalEventId, Status, CreatedAt';
```

- [ ] **Step 9: Run tests + typecheck**

Run: `npm test -- migration-0003 && npm run typecheck`
Expected: migration tests PASS; typecheck PASS.

- [ ] **Step 10: Commit**

```bash
git add migrations/0003_calendar_oauth_and_invites.sql sql/schema.sql server/types.ts server/db/repo.ts env.d.ts .dev.vars server/__tests__/migration-0003.test.ts
git commit -m "feat: 0003 migration — calendar token + invite columns; types + env"
```

---

### Task 2: Token encryption (`token-crypto.ts`)

**Files:**
- Create: `server/lib/token-crypto.ts`
- Test: `server/__tests__/token-crypto.test.ts`

**Interfaces:**
- Produces: `encryptToken(secret: string, plaintext: string): Promise<string>`, `decryptToken(secret: string, blob: string): Promise<string>` (base64 `iv||ciphertext`, AES-GCM-256, HKDF-derived key).

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/token-crypto.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../lib/token-crypto';

const SECRET = 'test-secret-0123456789';

describe('token-crypto', () => {
  it('round-trips a token through encrypt/decrypt', async () => {
    const blob = await encryptToken(SECRET, 'refresh-abc-123');
    expect(blob).not.toContain('refresh-abc-123');
    expect(await decryptToken(SECRET, blob)).toBe('refresh-abc-123');
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const a = await encryptToken(SECRET, 'same');
    const b = await encryptToken(SECRET, 'same');
    expect(a).not.toBe(b);
    expect(await decryptToken(SECRET, a)).toBe('same');
    expect(await decryptToken(SECRET, b)).toBe('same');
  });

  it('fails to decrypt under the wrong secret', async () => {
    const blob = await encryptToken(SECRET, 'secret-data');
    await expect(decryptToken('different-secret-xyz', blob)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- token-crypto` → FAIL (module missing).

- [ ] **Step 3: Implement**

Create `server/lib/token-crypto.ts`:
```ts
/**
 * AES-GCM encryption for OAuth tokens at rest in D1. The key is derived from TOKEN_SECRET via
 * HKDF-SHA256, so no extra secret is needed and the token store is useless without TOKEN_SECRET.
 * Ciphertext is base64(iv ‖ ct); the 12-byte IV is random per call.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode('pawbook-gcal-token') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptToken(secret: string, plaintext: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return btoa(String.fromCharCode(...out));
}

export async function decryptToken(secret: string, blob: string): Promise<string> {
  const key = await deriveKey(secret);
  const bytes = Uint8Array.from(atob(blob), (ch) => ch.charCodeAt(0));
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return dec.decode(pt);
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npm test -- token-crypto` → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/token-crypto.ts server/__tests__/token-crypto.test.ts
git commit -m "feat: AES-GCM token encryption (HKDF key from TOKEN_SECRET)"
```

---

### Task 3: Signed single-use OAuth state (`oauth-state.ts`)

**Files:**
- Create: `server/lib/oauth-state.ts`
- Test: `server/__tests__/oauth-state.test.ts`

**Interfaces:**
- Consumes: `constantTimeEqual` from `server/lib/timing.ts`.
- Produces: `type StatePayload = { tenantId: string; nonce: string; exp: number }`; `signState(secret, payload): Promise<string>`; `verifyState(secret, state, nowMs): Promise<StatePayload | null>`.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/oauth-state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { signState, verifyState } from '../lib/oauth-state';

const SECRET = 'test-secret-0123456789';
const NOW = 1_900_000_000_000;

describe('oauth-state', () => {
  const payload = { tenantId: 't1', nonce: 'n1', exp: NOW + 600_000 };

  it('round-trips a valid, unexpired state', async () => {
    const s = await signState(SECRET, payload);
    expect(await verifyState(SECRET, s, NOW)).toEqual(payload);
  });

  it('rejects a tampered payload', async () => {
    const s = await signState(SECRET, payload);
    const [body, sig] = s.split('.');
    const forged = btoa(JSON.stringify({ ...payload, tenantId: 'evil' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifyState(SECRET, `${forged}.${sig}`, NOW)).toBeNull();
    void body;
  });

  it('rejects a wrong signing secret', async () => {
    const s = await signState(SECRET, payload);
    expect(await verifyState('another-secret-xyz', s, NOW)).toBeNull();
  });

  it('rejects an expired state', async () => {
    const s = await signState(SECRET, { ...payload, exp: NOW - 1 });
    expect(await verifyState(SECRET, s, NOW)).toBeNull();
  });

  it('rejects malformed input', async () => {
    expect(await verifyState(SECRET, 'garbage', NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- oauth-state` → FAIL.

- [ ] **Step 3: Implement**

Create `server/lib/oauth-state.ts`:
```ts
import { constantTimeEqual } from './timing';

/**
 * CSRF defense for the OAuth callback, which cannot be session-authed (Google redirects with no
 * Authorization header). `state = base64url(payload).base64url(HMAC-SHA256(payload, TOKEN_SECRET))`.
 * The `nonce` is additionally stored single-use in KV by the routes, so replay is blocked even
 * within `exp`.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export type StatePayload = { tenantId: string; nonce: string; exp: number };

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

export async function signState(secret: string, payload: StatePayload): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, body));
  return `${body}.${sig}`;
}

export async function verifyState(
  secret: string, state: string, nowMs: number,
): Promise<StatePayload | null> {
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = b64url(await hmac(secret, body));
  if (!constantTimeEqual(sig, expected)) return null;
  let payload: StatePayload;
  try {
    payload = JSON.parse(dec.decode(b64urlToBytes(body)));
  } catch {
    return null;
  }
  if (
    typeof payload.tenantId !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number'
  )
    return null;
  if (payload.exp < nowMs) return null;
  return payload;
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npm test -- oauth-state` → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/oauth-state.ts server/__tests__/oauth-state.test.ts
git commit -m "feat: signed single-use OAuth state helper"
```

---

### Task 4: Google Calendar client (`google-calendar.ts`)

**Files:**
- Create: `server/lib/google-calendar.ts`
- Test: `server/__tests__/google-calendar.test.ts`

**Interfaces:**
- Produces:
  - `buildAuthUrl(env: Env, state: string): string`
  - `exchangeCode(env: Env, code: string): Promise<TokenSet>` where `TokenSet = { accessToken: string; refreshToken: string; expiresAt: string }`
  - `refreshAccessToken(env: Env, refreshToken: string): Promise<{ accessToken: string; expiresAt: string }>`
  - `createEvent(accessToken: string, calendarId: string, event: object): Promise<{ id: string }>`
  - `deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>`
  - `buildEventResource(b: CalendarBooking): EventResource` (pure)
  - `revokeToken(token: string): Promise<void>`
  - `type CalendarBooking = { serviceLabel: string; startDate: string; endDate: string | null; startTime: string | null; durationMinutes: number | null; petCount: number; estCost: number | null; customerEmail: string | null; timezone: string }`

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/google-calendar.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthUrl, buildEventResource, createEvent, exchangeCode, refreshAccessToken,
} from '../lib/google-calendar';

const env = {
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csecret',
  GOOGLE_OAUTH_REDIRECT_URI: 'https://w/oauth/google/callback',
} as unknown as Env;

describe('google-calendar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('buildAuthUrl carries scope, offline access, consent prompt, redirect + state', () => {
    const url = new URL(buildAuthUrl(env, 'STATE123'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('redirect_uri')).toBe('https://w/oauth/google/callback');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events');
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('state')).toBe('STATE123');
  });

  it('exchangeCode posts the code and maps the token response', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }),
        { status: 200 }),
    );
    const set = await exchangeCode(env, 'auth-code');
    expect(set.accessToken).toBe('at');
    expect(set.refreshToken).toBe('rt');
    expect(new Date(set.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(spy).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', expect.anything());
  });

  it('refreshAccessToken returns a new access token + expiry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at2', expires_in: 3600 }), { status: 200 }),
    );
    const r = await refreshAccessToken(env, 'rt');
    expect(r.accessToken).toBe('at2');
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('createEvent POSTs to the calendar and returns the new id', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_1' }), { status: 200 }),
    );
    const { id } = await createEvent('AT', 'primary', { summary: 'x' });
    expect(id).toBe('evt_1');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer AT' });
  });

  it('createEvent throws on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 401 }));
    await expect(createEvent('AT', 'primary', {})).rejects.toThrow();
  });

  it('buildEventResource: all-day range uses date start/end (exclusive)', () => {
    const r = buildEventResource({
      serviceLabel: 'Boarding', startDate: '2030-01-10', endDate: '2030-01-13', startTime: null,
      durationMinutes: null, petCount: 2, estCost: 150, customerEmail: 'a@b.c', timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ date: '2030-01-10' });
    expect(r.end).toEqual({ date: '2030-01-13' });
    expect(r.summary).toContain('Boarding');
    expect(r.summary).toContain('a@b.c');
  });

  it('buildEventResource: all-day single day uses next-day exclusive end', () => {
    const r = buildEventResource({
      serviceLabel: 'Day care', startDate: '2030-01-10', endDate: null, startTime: null,
      durationMinutes: null, petCount: 1, estCost: 40, customerEmail: null, timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ date: '2030-01-10' });
    expect(r.end).toEqual({ date: '2030-01-11' });
  });

  it('buildEventResource: timed booking uses dateTime + timeZone, end = start + duration', () => {
    const r = buildEventResource({
      serviceLabel: 'Walks', startDate: '2030-01-10', endDate: null, startTime: '09:30',
      durationMinutes: 60, petCount: 1, estCost: 35, customerEmail: 'a@b.c', timezone: 'America/Los_Angeles',
    });
    expect(r.start).toEqual({ dateTime: '2030-01-10T09:30:00', timeZone: 'America/Los_Angeles' });
    expect(r.end).toEqual({ dateTime: '2030-01-10T10:30:00', timeZone: 'America/Los_Angeles' });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- google-calendar` → FAIL.

- [ ] **Step 3: Implement**

Create `server/lib/google-calendar.ts`:
```ts
/**
 * Google OAuth2 + Calendar v3 REST client. All network calls go through fetch (mockable in tests).
 * `buildEventResource` is pure so event shaping is unit-tested without touching the network.
 */
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

export type TokenSet = { accessToken: string; refreshToken: string; expiresAt: string };

export function buildAuthUrl(env: Env, state: string): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

function expiresAtFrom(expiresInSeconds: number): string {
  // 60s safety margin so a near-expiry token is treated as expired before a call fails.
  return new Date(Date.now() + (expiresInSeconds - 60) * 1000).toISOString();
}

export async function exchangeCode(env: Env, code: string): Promise<TokenSet> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: expiresAtFrom(j.expires_in) };
}

export async function refreshAccessToken(
  env: Env, refreshToken: string,
): Promise<{ accessToken: string; expiresAt: string }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { accessToken: j.access_token, expiresAt: expiresAtFrom(j.expires_in) };
}

export async function createEvent(
  accessToken: string, calendarId: string, event: object,
): Promise<{ id: string }> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    },
  );
  if (!res.ok) throw new Error(`Google createEvent failed (${res.status})`);
  const j = (await res.json()) as { id: string };
  return { id: j.id };
}

export async function deleteEvent(
  accessToken: string, calendarId: string, eventId: string,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
  );
  // 410 Gone = already deleted; treat as success.
  if (!res.ok && res.status !== 410) throw new Error(`Google deleteEvent failed (${res.status})`);
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: 'POST' });
}

export type CalendarBooking = {
  serviceLabel: string;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  petCount: number;
  estCost: number | null;
  customerEmail: string | null;
  timezone: string;
};

type EventResource = {
  summary: string;
  description: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
};

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addMinutesToLocal(date: string, time: string, minutes: number): string {
  // Treat the wall-clock value as UTC purely for arithmetic; the timeZone field carries the real
  // zone, so adding minutes here yields the correct local end time (even across an hour/day roll).
  const d = new Date(`${date}T${time}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
}

export function buildEventResource(b: CalendarBooking): EventResource {
  const who = b.customerEmail ?? 'booking';
  const summary = `${b.serviceLabel} — ${who} (${b.petCount} pet${b.petCount === 1 ? '' : 's'})`;
  const description =
    `Service: ${b.serviceLabel}` + (b.estCost != null ? `\nEstimated cost: $${b.estCost}` : '');

  if (b.startTime) {
    const startDateTime = `${b.startDate}T${b.startTime}:00`;
    const endDateTime = addMinutesToLocal(b.startDate, b.startTime, b.durationMinutes ?? 60);
    return {
      summary,
      description,
      start: { dateTime: startDateTime, timeZone: b.timezone },
      end: { dateTime: endDateTime, timeZone: b.timezone },
    };
  }
  const endDate = b.endDate ?? addDaysIso(b.startDate, 1);
  return { summary, description, start: { date: b.startDate }, end: { date: endDate } };
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npm test -- google-calendar` → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/lib/google-calendar.ts server/__tests__/google-calendar.test.ts
git commit -m "feat: Google Calendar OAuth + event REST client"
```

---

### Task 5: Repo functions for provider tokens + booking event id

**Files:**
- Modify: `server/db/repo.ts`
- Test: extend `server/__tests__/tenant-config.test.ts` OR add `server/__tests__/provider-tokens.test.ts` (use the latter for isolation).

**Interfaces:**
- Consumes: `ProviderConnectionWithTokens` (Task 1).
- Produces:
  - `getProviderConnection(db, tenantId, capability): Promise<ProviderConnectionWithTokens | null>`
  - `setProviderTokens(db, tenantId, capability, provider, t: { access: string; refresh: string; expiresAt: string; calendarId: string }): Promise<void>` (sets Status `'connected'`)
  - `clearProviderConnection(db, tenantId, capability): Promise<void>` (Status `'disconnected'`, nulls tokens)
  - `setBookingGCalEventId(db, tenantId, bookingId, eventId): Promise<void>`
  - `getEndUserById(db, tenantId, id): Promise<EndUser | null>`

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/provider-tokens.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  clearProviderConnection, getProviderConnection, setBookingGCalEventId, setProviderTokens,
} from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

describe('provider token repo', () => {
  it('upserts tokens with connected status, then clears them', async () => {
    const { env } = createTestEnv();
    await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
      access: 'enc-a', refresh: 'enc-r', expiresAt: '2030-01-01T00:00:00Z', calendarId: 'primary',
    });
    let conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(conn?.Status).toBe('connected');
    expect(conn?.AccessToken).toBe('enc-a');
    expect(conn?.CalendarId).toBe('primary');

    await clearProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(conn?.Status).toBe('disconnected');
    expect(conn?.AccessToken).toBeNull();
  });

  it('setBookingGCalEventId writes the event id onto a booking', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, PetCount, Status)
              VALUES ('b1', '${TENANT_A}', 'daycare', '2030-02-01', 1, 'pending')`);
    await setBookingGCalEventId(env.PAWBOOK_DB, TENANT_A, 'b1', 'evt_xyz');
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='b1'`).get() as
      { GCalEventId: string };
    expect(row.GCalEventId).toBe('evt_xyz');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- provider-tokens` → FAIL.

- [ ] **Step 3: Implement** — append to `server/db/repo.ts` (and add `ProviderConnectionWithTokens` to the type import at top):
```ts
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
      crypto.randomUUID(), tenantId, capability, provider, new Date().toISOString(),
      t.access, t.refresh, t.expiresAt, t.calendarId,
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
```
> Note: keep `listProviderConnections` unchanged (it must NOT select token columns — it feeds the client).

- [ ] **Step 4: Run to verify it passes** — Run: `npm test -- provider-tokens && npm run typecheck` → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/db/repo.ts server/__tests__/provider-tokens.test.ts
git commit -m "feat: repo functions for provider OAuth tokens + booking event id"
```

---

### Task 6: OAuth routes (start / global callback / disconnect)

**Files:**
- Create: `server/routes/oauth.ts`
- Modify: `server/routes/admin.ts`, `server/index.ts`, `server/lib/providers.ts`
- Test: `server/__tests__/oauth-callback.test.ts`

**Interfaces:**
- Consumes: `buildAuthUrl`, `exchangeCode` (Task 4); `signState`, `verifyState` (Task 3); `encryptToken` (Task 2); `setProviderTokens`, `clearProviderConnection`, `getProviderConnection`, `getTenantById` (Task 5 / repo).
- Produces: `GET /oauth/google/callback`; admin `GET /api/:slug/admin/providers/calendar/oauth/start` → `{ url }`; admin `POST /api/:slug/admin/providers/calendar/disconnect`.

- [ ] **Step 1: Widen the provider status type in `server/lib/providers.ts`** — change `ProviderView.status` and `providerViews`'s row type:
```ts
export type ProviderView = CapabilityDescriptor & {
  status: 'disconnected' | 'connected-stub' | 'connected';
  connectedAt: string | null;
};
```
(`providerViews` body is unchanged — `row?.Status ?? 'disconnected'` already returns whatever is stored.)

- [ ] **Step 2: Write the failing callback test**

Create `server/__tests__/oauth-callback.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../index';
import { getProviderConnection } from '../db/repo';
import { decryptToken } from '../lib/token-crypto';
import { signState } from '../lib/oauth-state';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';

const NONCE = 'nonce-1';
async function primedState(env: Env, over: Partial<{ tenantId: string; exp: number }> = {}) {
  await env.PAWBOOK_CACHE.put(`gcal:nonce:${NONCE}`, '1');
  return signState(TEST_SECRET, {
    tenantId: over.tenantId ?? TENANT_A, nonce: NONCE, exp: over.exp ?? Date.now() + 600_000,
  });
}
function call(env: Env, state: string, code = 'auth-code') {
  return app.request(`/oauth/google/callback?code=${code}&state=${encodeURIComponent(state)}`, {}, env);
}

describe('GET /oauth/google/callback', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exchanges the code and stores encrypted tokens with connected status', async () => {
    const { env } = createTestEnv();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
    );
    const res = await call(env, await primedState(env));
    expect(res.status).toBe(200);
    const conn = await getProviderConnection(env.PAWBOOK_DB, TENANT_A, 'calendar');
    expect(conn?.Status).toBe('connected');
    expect(conn?.AccessToken).not.toBe('at'); // stored encrypted
    expect(await decryptToken(TEST_SECRET, conn!.AccessToken!)).toBe('at');
    expect(await decryptToken(TEST_SECRET, conn!.RefreshToken!)).toBe('rt');
  });

  it('rejects a tampered state (no token exchange)', async () => {
    const { env } = createTestEnv();
    const spy = vi.spyOn(globalThis, 'fetch');
    const res = await call(env, (await primedState(env)) + 'x');
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a replayed/used nonce', async () => {
    const { env } = createTestEnv();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
    );
    const state = await primedState(env);
    expect((await call(env, state)).status).toBe(200); // consumes nonce
    expect((await call(env, state)).status).toBe(400); // replay rejected
  });

  it('rejects an expired state', async () => {
    const { env } = createTestEnv();
    const res = await call(env, await primedState(env, { exp: Date.now() - 1 }));
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Run to verify it fails** — Run: `npm test -- oauth-callback` → FAIL.

- [ ] **Step 4: Implement the global callback route**

Create `server/routes/oauth.ts`:
```ts
import { Hono } from 'hono';
import { getTenantById, setProviderTokens } from '../db/repo';
import { exchangeCode } from '../lib/google-calendar';
import { verifyState } from '../lib/oauth-state';
import { encryptToken } from '../lib/token-crypto';
import type { AppEnv } from '../types';

const NONCE_KEY = (nonce: string) => `gcal:nonce:${nonce}`;

/** Tiny HTML page that signals the opener (admin dashboard) and closes the popup. */
function resultPage(ok: boolean): Response {
  const msg = ok ? 'pawbook:calendar-connected' : 'pawbook:calendar-error';
  const html = `<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Error'}</title>
<body style="font:14px system-ui;padding:2rem">${ok ? 'Google Calendar connected. You can close this window.' : 'Connection failed. Please try again.'}
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(msg)},'*')}catch(e){}setTimeout(function(){window.close()},800)</script></body>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export const oauthRoutes = new Hono<AppEnv>().get('/oauth/google/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return resultPage(false);

  const payload = await verifyState(c.env.TOKEN_SECRET, state, Date.now());
  if (!payload) return resultPage(false);

  // Single-use nonce: must exist, and is deleted on use so the callback can't be replayed.
  const seen = await c.env.PAWBOOK_CACHE.get(NONCE_KEY(payload.nonce));
  if (!seen) return resultPage(false);
  await c.env.PAWBOOK_CACHE.delete(NONCE_KEY(payload.nonce));

  const tenant = await getTenantById(c.env.PAWBOOK_DB, payload.tenantId);
  if (!tenant) return resultPage(false);

  try {
    const tokens = await exchangeCode(c.env, code);
    await setProviderTokens(c.env.PAWBOOK_DB, tenant.Id, 'calendar', 'google-calendar', {
      access: await encryptToken(c.env.TOKEN_SECRET, tokens.accessToken),
      refresh: await encryptToken(c.env.TOKEN_SECRET, tokens.refreshToken),
      expiresAt: tokens.expiresAt,
      calendarId: 'primary',
    });
  } catch {
    return resultPage(false);
  }
  return resultPage(true);
});
```

- [ ] **Step 5: Mount the callback in `server/index.ts`** — add the import and route BEFORE the page routes:
```ts
import { oauthRoutes } from './routes/oauth';
```
and after the `app.route('/api', adminRoutes);` line:
```ts
app.route('/', oauthRoutes); // global OAuth callback — no slug, no tenant middleware
```

- [ ] **Step 6: Add admin start + disconnect routes in `server/routes/admin.ts`**

Add imports:
```ts
import { buildAuthUrl, revokeToken } from '../lib/google-calendar';
import { signState } from '../lib/oauth-state';
import { decryptToken } from '../lib/token-crypto';
import { clearProviderConnection, getProviderConnection, setProviderTokens } from '../db/repo';
```
> `setProviderTokens` may already be needed elsewhere; ensure it is in the existing import block from `../db/repo` without duplicating.

Append these two routes to the `adminRoutes` chain (after the existing `.../connect` route):
```ts
  .get('/:slug/admin/providers/calendar/oauth/start', async (c) => {
    const tenant = c.get('tenant');
    if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_OAUTH_REDIRECT_URI)
      return c.json({ error: 'Google Calendar is not configured on this server.' }, 503);
    const nonce = crypto.randomUUID();
    await c.env.PAWBOOK_CACHE.put(`gcal:nonce:${nonce}`, '1', { expirationTtl: 600 });
    const state = await signState(c.env.TOKEN_SECRET, {
      tenantId: tenant.Id, nonce, exp: Date.now() + 600_000,
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
  });
```

- [ ] **Step 7: Run tests + typecheck + lint** — Run: `npm test -- oauth-callback && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 8: Commit**
```bash
git add server/routes/oauth.ts server/routes/admin.ts server/index.ts server/lib/providers.ts server/__tests__/oauth-callback.test.ts
git commit -m "feat: Google Calendar OAuth start/callback/disconnect routes"
```

---

### Task 7: Create a calendar event on booking

**Files:**
- Create: `server/lib/calendar-sync.ts`
- Modify: `server/routes/bookings.ts`
- Test: `server/__tests__/calendar-sync.test.ts`

**Interfaces:**
- Consumes: `getProviderConnection`, `setProviderTokens`, `setBookingGCalEventId`, `getEndUserById` (repo); `createEvent`, `refreshAccessToken`, `buildEventResource`, `CalendarBooking` (Task 4); `encryptToken`/`decryptToken` (Task 2); `SERVICE_CATALOG`, `DEFAULT_TIMEZONE`.
- Produces: `syncBookingToCalendar(env, tenant, b: SyncInput): Promise<void>` where `SyncInput = { bookingId: string; endUserId: string | null; serviceType: ServiceType; startDate: string; endDate: string | null; startTime: string | null; durationMinutes: number | null; petCount: number; estCost: number | null }`.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/calendar-sync.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncBookingToCalendar } from '../lib/calendar-sync';
import { setProviderTokens } from '../db/repo';
import { encryptToken } from '../lib/token-crypto';
import { createTestEnv, TENANT_A, TEST_SECRET } from './helpers';
import type { Tenant } from '../types';

const tenant = { Id: TENANT_A, Slug: 'sunny-paws', Timezone: null } as Tenant;

async function connectCalendar(env: Env, expiresAt: string) {
  await setProviderTokens(env.PAWBOOK_DB, TENANT_A, 'calendar', 'google-calendar', {
    access: await encryptToken(TEST_SECRET, 'access-1'),
    refresh: await encryptToken(TEST_SECRET, 'refresh-1'),
    expiresAt, calendarId: 'primary',
  });
}
function seedBooking(raw: { exec: (s: string) => void }, id: string) {
  raw.exec(`INSERT INTO BookingRequests (Id, TenantId, ServiceType, StartDate, EndDate, PetCount, EstCost, Status)
            VALUES ('${id}', '${TENANT_A}', 'boarding', '2030-03-01', '2030-03-04', 1, 150, 'pending')`);
}

describe('syncBookingToCalendar', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates an event and persists the event id when connected', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2030-01-01T00:00:00Z'); // not expired
    seedBooking(raw, 'b1');
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'evt_b1' }), { status: 200 }),
    );
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b1', endUserId: null, serviceType: 'boarding', startDate: '2030-03-01',
      endDate: '2030-03-04', startTime: null, durationMinutes: null, petCount: 1, estCost: 150,
    });
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id='b1'`).get() as { GCalEventId: string };
    expect(row.GCalEventId).toBe('evt_b1');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('no-ops when the calendar is not connected', async () => {
    const { env, raw } = createTestEnv();
    seedBooking(raw, 'b2');
    const spy = vi.spyOn(globalThis, 'fetch');
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b2', endUserId: null, serviceType: 'boarding', startDate: '2030-03-01',
      endDate: '2030-03-04', startTime: null, durationMinutes: null, petCount: 1, estCost: 150,
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refreshes an expired access token before creating the event', async () => {
    const { env, raw } = createTestEnv();
    await connectCalendar(env, '2000-01-01T00:00:00Z'); // expired
    seedBooking(raw, 'b3');
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'evt_b3' }), { status: 200 }));
    await syncBookingToCalendar(env, tenant, {
      bookingId: 'b3', endUserId: null, serviceType: 'boarding', startDate: '2030-03-01',
      endDate: '2030-03-04', startTime: null, durationMinutes: null, petCount: 1, estCost: 150,
    });
    expect(spy).toHaveBeenCalledTimes(2);
    const eventCall = spy.mock.calls[1];
    expect((eventCall[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer access-2' });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- calendar-sync` → FAIL.

- [ ] **Step 3: Implement**

Create `server/lib/calendar-sync.ts`:
```ts
import { DEFAULT_TIMEZONE } from '../../src/shared/index.js';
import { getEndUserById, getProviderConnection, setBookingGCalEventId, setProviderTokens } from '../db/repo';
import { buildEventResource, createEvent, refreshAccessToken } from './google-calendar';
import { SERVICE_CATALOG } from './services';
import type { ServiceType } from './services';
import { decryptToken, encryptToken } from './token-crypto';
import type { Tenant } from '../types';

export type SyncInput = {
  bookingId: string;
  endUserId: string | null;
  serviceType: ServiceType;
  startDate: string;
  endDate: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  petCount: number;
  estCost: number | null;
};

/**
 * Best-effort: create a Google Calendar event for a booking and persist its id. Callers run this
 * via executionCtx.waitUntil and ignore rejections — a Google failure must never affect a booking.
 */
export async function syncBookingToCalendar(env: Env, tenant: Tenant, b: SyncInput): Promise<void> {
  const conn = await getProviderConnection(env.PAWBOOK_DB, tenant.Id, 'calendar');
  if (!conn || conn.Status !== 'connected' || !conn.AccessToken || !conn.RefreshToken) return;

  let accessToken = await decryptToken(env.TOKEN_SECRET, conn.AccessToken);
  if (!conn.TokenExpiresAt || conn.TokenExpiresAt <= new Date().toISOString()) {
    const refreshToken = await decryptToken(env.TOKEN_SECRET, conn.RefreshToken);
    const refreshed = await refreshAccessToken(env, refreshToken);
    accessToken = refreshed.accessToken;
    await setProviderTokens(env.PAWBOOK_DB, tenant.Id, 'calendar', conn.Provider, {
      access: await encryptToken(env.TOKEN_SECRET, refreshed.accessToken),
      refresh: conn.RefreshToken, // already-encrypted; unchanged
      expiresAt: refreshed.expiresAt,
      calendarId: conn.CalendarId ?? 'primary',
    });
  }

  const customer = b.endUserId
    ? await getEndUserById(env.PAWBOOK_DB, tenant.Id, b.endUserId)
    : null;

  const resource = buildEventResource({
    serviceLabel: SERVICE_CATALOG[b.serviceType].label,
    startDate: b.startDate,
    endDate: b.endDate,
    startTime: b.startTime,
    durationMinutes: b.durationMinutes,
    petCount: b.petCount,
    estCost: b.estCost,
    customerEmail: customer?.Email ?? null,
    timezone: tenant.Timezone ?? DEFAULT_TIMEZONE,
  });

  const { id } = await createEvent(accessToken, conn.CalendarId ?? 'primary', resource);
  await setBookingGCalEventId(env.PAWBOOK_DB, tenant.Id, b.bookingId, id);
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npm test -- calendar-sync` → PASS.

- [ ] **Step 5: Wire into `server/routes/bookings.ts`**

Add import:
```ts
import { syncBookingToCalendar } from '../lib/calendar-sync';
```
In the `POST /:slug/bookings` handler, replace the final `return c.json({ id, estCost, status: 'pending' }, 201);` with:
```ts
    // Best-effort calendar sync — never blocks or fails the booking. Use waitUntil in production;
    // in tests (no ExecutionContext) await it so behavior is deterministic.
    const sync = syncBookingToCalendar(c.env, tenant, {
      bookingId: id,
      endUserId: c.get('endUserId'),
      serviceType: type,
      startDate: start,
      endDate,
      startTime: null, // no booking path collects a time yet (deferred); all events are all-day
      durationMinutes: option.DurationMinutes,
      petCount: pets,
      estCost,
    }).catch((err) => {
      console.error('calendar sync failed', err);
    });
    try {
      c.executionCtx.waitUntil(sync);
    } catch {
      await sync;
    }

    return c.json({ id, estCost, status: 'pending' }, 201);
```

- [ ] **Step 6: Add a booking-flow assertion**

Append to `server/__tests__/booking-flow.test.ts` a test that with a connected calendar a booking persists `GCalEventId`. Reuse the file's existing `identify` helper (which performs identify→verify→token). Add at the end of the top-level `describe`:
```ts
  it('creates a calendar event when the tenant calendar is connected', async () => {
    const { env, raw } = createTestEnv();
    // jess is a seeded active customer (see seed.sql), so gated identify succeeds.
    await import('../db/repo').then(({ setProviderTokens }) =>
      import('../lib/token-crypto').then(async ({ encryptToken }) => {
        await setProviderTokens(env.PAWBOOK_DB, 'tnt_sunnypaws', 'calendar', 'google-calendar', {
          access: await encryptToken('test-secret-0123456789', 'at'),
          refresh: await encryptToken('test-secret-0123456789', 'rt'),
          expiresAt: '2031-01-01T00:00:00Z', calendarId: 'primary',
        });
      }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'evt_book' }), { status: 200 }));

    const token = await identify(env, 'sunny-paws', 'jess@example.com');
    const res = await app.request('/api/sunny-paws/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'daycare', startDate: '2030-09-09', petCount: 1 }),
    }, env);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = raw.prepare(`SELECT GCalEventId FROM BookingRequests WHERE Id=?`).get(id) as { GCalEventId: string };
    expect(row.GCalEventId).toBe('evt_book');
  });
```
> Add `import { vi } from 'vitest'` and `import { createTestEnv } from './helpers'` if not already present at the top of the file, and `afterEach(() => vi.restoreAllMocks())` inside the describe. (This test depends on Task 9 seeding `jess@example.com`; if running Task 7 before Task 9, temporarily insert the customer via `raw.exec`.)

- [ ] **Step 7: Run tests + typecheck + lint** — Run: `npm test && npm run typecheck && npm run lint` → PASS. (Booking-flow gating tests fully pass after Task 9.)

- [ ] **Step 8: Commit**
```bash
git add server/lib/calendar-sync.ts server/routes/bookings.ts server/__tests__/calendar-sync.test.ts server/__tests__/booking-flow.test.ts
git commit -m "feat: create Google Calendar event on booking (best-effort)"
```

---

### Task 8: Repo functions for invite-only customers

**Files:**
- Modify: `server/db/repo.ts`
- Test: `server/__tests__/customers-repo.test.ts`

**Interfaces:**
- Produces:
  - `getEndUserByEmail(db, tenantId, email): Promise<EndUser | null>`
  - `insertInvitedCustomer(db, tenantId, email, name: string | null): Promise<EndUser>` (idempotent; never downgrades an existing `active` row)
  - `listCustomers(db, tenantId): Promise<EndUser[]>`
  - `deleteCustomer(db, tenantId, id): Promise<boolean>`
  - `countBookingsForUser(db, tenantId, endUserId): Promise<number>`
  - `promoteCustomerActive(db, tenantId, endUserId): Promise<void>`
- Removes: `upsertEndUser` (replaced by `getEndUserByEmail` + `insertInvitedCustomer`).

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/customers-repo.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  countBookingsForUser, deleteCustomer, getEndUserByEmail, insertInvitedCustomer,
  listCustomers, promoteCustomerActive,
} from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

describe('customer repo', () => {
  it('inserts an invited customer and is idempotent (no active downgrade)', async () => {
    const { env } = createTestEnv();
    const a = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'new@example.com', 'New Person');
    expect(a.Status).toBe('invited');
    expect(a.Name).toBe('New Person');

    await promoteCustomerActive(env.PAWBOOK_DB, TENANT_A, a.Id);
    const again = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'new@example.com', 'Ignored');
    expect(again.Id).toBe(a.Id);
    expect(again.Status).toBe('active'); // not downgraded
  });

  it('getEndUserByEmail returns null for unknown', async () => {
    const { env } = createTestEnv();
    expect(await getEndUserByEmail(env.PAWBOOK_DB, TENANT_A, 'nobody@example.com')).toBeNull();
  });

  it('lists and deletes customers; counts bookings', async () => {
    const { env, raw } = createTestEnv();
    const c = await insertInvitedCustomer(env.PAWBOOK_DB, TENANT_A, 'c@example.com', null);
    expect((await listCustomers(env.PAWBOOK_DB, TENANT_A)).some((u) => u.Id === c.Id)).toBe(true);
    expect(await countBookingsForUser(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(0);

    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk1','${TENANT_A}','${c.Id}','daycare','2030-04-01',1,'pending')`);
    expect(await countBookingsForUser(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(1);

    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, c.Id)).toBe(true);
    expect(await deleteCustomer(env.PAWBOOK_DB, TENANT_A, 'missing')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- customers-repo` → FAIL.

- [ ] **Step 3: Implement** — in `server/db/repo.ts`, REMOVE `upsertEndUser` and add:
```ts
const ENDUSER_COLS = 'Id, TenantId, Email, Name, Status, InvitedAt';

export async function getEndUserByEmail(
  db: D1Database, tenantId: string, email: string,
): Promise<EndUser | null> {
  return await db
    .prepare(`SELECT ${ENDUSER_COLS} FROM EndUsers WHERE TenantId = ? AND Email = ?`)
    .bind(tenantId, email)
    .first<EndUser>();
}

export async function insertInvitedCustomer(
  db: D1Database, tenantId: string, email: string, name: string | null,
): Promise<EndUser> {
  const existing = await getEndUserByEmail(db, tenantId, email);
  if (existing) return existing; // idempotent — never downgrade an active customer to invited
  const id = crypto.randomUUID();
  const invitedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO EndUsers (Id, TenantId, Email, Name, Status, InvitedAt)
       VALUES (?, ?, ?, ?, 'invited', ?)`,
    )
    .bind(id, tenantId, email, name, invitedAt)
    .run();
  return { Id: id, TenantId: tenantId, Email: email, Name: name, Status: 'invited', InvitedAt: invitedAt };
}

export async function listCustomers(db: D1Database, tenantId: string): Promise<EndUser[]> {
  const { results } = await db
    .prepare(`SELECT ${ENDUSER_COLS} FROM EndUsers WHERE TenantId = ? ORDER BY Email`)
    .bind(tenantId)
    .all<EndUser>();
  return results;
}

export async function deleteCustomer(
  db: D1Database, tenantId: string, id: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM EndUsers WHERE TenantId = ? AND Id = ?')
    .bind(tenantId, id)
    .run();
  return (result.meta as { changes?: number }).changes !== 0;
}

export async function countBookingsForUser(
  db: D1Database, tenantId: string, endUserId: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM BookingRequests WHERE TenantId = ? AND EndUserId = ?')
    .bind(tenantId, endUserId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function promoteCustomerActive(
  db: D1Database, tenantId: string, endUserId: string,
): Promise<void> {
  await db
    .prepare("UPDATE EndUsers SET Status = 'active' WHERE TenantId = ? AND Id = ?")
    .bind(tenantId, endUserId)
    .run();
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npm test -- customers-repo` → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/db/repo.ts server/__tests__/customers-repo.test.ts
git commit -m "feat: repo functions for invite-only customers"
```

---

### Task 9: Seed demo customers + invite email

**Files:**
- Modify: `sql/seed.sql`, `server/lib/email.ts`
- Test: extend `server/__tests__/identify-email.test.ts` is NOT needed here; add `server/__tests__/invite-email.test.ts`.

**Interfaces:**
- Produces: seeded `EndUsers` `jess@example.com` (active) for the three demo tenants; `sendInvite(env, to: string, displayName: string, widgetUrl: string): Promise<void>`.

- [ ] **Step 1: Seed demo customers** — add to `sql/seed.sql` (after the `EndUsers` table would have rows; place near the bookings section). Insert:
```sql
-- Demo customers. Invite-only gating means /identify only succeeds for known customers, so the
-- demo widget (and the existing identify/booking tests) need a seeded, already-active customer.
INSERT OR REPLACE INTO EndUsers (Id, TenantId, Email, Name, Status) VALUES
  ('eu_sp_jess', 'tnt_sunnypaws', 'jess@example.com', 'Jess Demo', 'active'),
  ('eu_ht_jess', 'tnt_happytails', 'jess@example.com', 'Jess Demo', 'active'),
  ('eu_pr_jess', 'tnt_pawsandrelax', 'jess@example.com', 'Jess Demo', 'active');
```

- [ ] **Step 2: Write the failing invite-email test**

Create `server/__tests__/invite-email.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendInvite } from '../lib/email';

const env = { RESEND_API_KEY: 'k', RESEND_FROM: 'Pawbook <b@x.com>' } as unknown as Env;

describe('sendInvite', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts an invite email via Resend including the widget link', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await sendInvite(env, 'guest@example.com', 'Sunny Paws', 'https://w/embed/sunny-paws');
    const init = spy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.to).toBe('guest@example.com');
    expect(body.subject).toContain('Sunny Paws');
    expect(body.html).toContain('https://w/embed/sunny-paws');
  });

  it('throws when email is not configured', async () => {
    await expect(sendInvite({} as Env, 'a@b.c', 'X', 'https://w')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails** — Run: `npm test -- invite-email` → FAIL.

- [ ] **Step 4: Implement `sendInvite`** — append to `server/lib/email.ts`:
```ts
/** Send a booking invite. Throws if email is not configured or Resend rejects the request. */
export async function sendInvite(
  env: Env, to: string, displayName: string, widgetUrl: string,
): Promise<void> {
  if (!isEmailConfigured(env)) throw new Error('Email is not configured.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.RESEND_FROM,
      to,
      subject: `You're invited to book with ${displayName}`,
      text: `${displayName} has invited you to book online. Get started here: ${widgetUrl}`,
      html: `<p>${displayName} has invited you to book online.</p><p><a href="${widgetUrl}">Book now</a></p>`,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }
}
```

- [ ] **Step 5: Run to verify it passes** — Run: `npm test -- invite-email` → PASS.

- [ ] **Step 6: Commit**
```bash
git add sql/seed.sql server/lib/email.ts server/__tests__/invite-email.test.ts
git commit -m "feat: invite email (Resend) + seed demo customers for gated identify"
```

---

### Task 10: Gate `/identify` + promote on `/verify`

**Files:**
- Modify: `server/routes/auth.ts`
- Test: `server/__tests__/invites.test.ts` (gating + promotion); existing identify/booking tests now rely on seeded `jess` from Task 9.

**Interfaces:**
- Consumes: `getEndUserByEmail`, `promoteCustomerActive` (Task 8); `consumeLoginCode`, `createLoginCode` (repo).

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/invites.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertInvitedCustomer } from '../db/repo';
import { createTestEnv } from './helpers';

function identify(env: Env, email: string) {
  return app.request('/api/sunny-paws/identify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  }, env);
}

describe('invite-only identify', () => {
  it('rejects an un-invited email with 403', async () => {
    const { env } = createTestEnv();
    const res = await identify(env, 'stranger@example.com');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { prototypeCode?: string };
    expect(body.prototypeCode).toBeUndefined();
  });

  it('accepts a seeded active customer', async () => {
    const { env } = createTestEnv();
    const res = await identify(env, 'jess@example.com');
    expect(res.status).toBe(200);
  });

  it('accepts an invited customer and promotes them to active on verify', async () => {
    const { env, raw } = createTestEnv();
    const cust = await insertInvitedCustomer(env.PAWBOOK_DB, 'tnt_sunnypaws', 'invited@example.com', 'Inv');
    const idRes = await identify(env, 'invited@example.com');
    expect(idRes.status).toBe(200);
    const { codeId, prototypeCode } = (await idRes.json()) as { codeId: string; prototypeCode: string };

    const vRes = await app.request('/api/sunny-paws/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codeId, code: prototypeCode }),
    }, env);
    expect(vRes.status).toBe(200);
    const row = raw.prepare(`SELECT Status FROM EndUsers WHERE Id=?`).get(cust.Id) as { Status: string };
    expect(row.Status).toBe('active');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- invites` → FAIL (identify currently auto-creates + returns 200 for strangers).

- [ ] **Step 3: Implement gating + promotion** in `server/routes/auth.ts`:

Replace the import line:
```ts
import { consumeLoginCode, createLoginCode, upsertEndUser } from '../db/repo';
```
with:
```ts
import { consumeLoginCode, createLoginCode, getEndUserByEmail, promoteCustomerActive } from '../db/repo';
```

In `/identify`, replace:
```ts
    const user = await upsertEndUser(c.env.PAWBOOK_DB, tenant.Id, email);
```
with:
```ts
    // Invite-only: only customers the provider has added may receive a code. Do NOT auto-create.
    const user = await getEndUserByEmail(c.env.PAWBOOK_DB, tenant.Id, email);
    if (!user) return c.json({ error: 'This provider books by invitation only.' }, 403);
```

In `/verify`, after a successful `consumeLoginCode` (i.e., after the `if (!endUserId) ...` guard) and before minting the token, add:
```ts
    // First successful sign-in promotes an invited customer to active.
    await promoteCustomerActive(c.env.PAWBOOK_DB, tenant.Id, endUserId);
```

- [ ] **Step 4: Run to verify it passes** — Run: `npm test -- invites` → PASS. Then run the full suite: `npm test` → all PASS (booking-flow/identify-email/isolation now use seeded `jess`).

> If `isolation.test.ts` or `booking-flow.test.ts` uses a tenant/email pair not seeded in Task 9, add the corresponding `EndUsers` seed row (active) rather than weakening the gate.

- [ ] **Step 5: Commit**
```bash
git add server/routes/auth.ts server/__tests__/invites.test.ts
git commit -m "feat: gate identify to invited customers; promote on first verify"
```

---

### Task 11: Customer management admin routes

**Files:**
- Modify: `server/routes/admin.ts`
- Test: `server/__tests__/customers-admin.test.ts`

**Interfaces:**
- Consumes: `listCustomers`, `insertInvitedCustomer`, `deleteCustomer`, `countBookingsForUser` (Task 8); `sendInvite`, `isEmailConfigured` (email); `adminAuth` (middleware).
- Produces: `GET /:slug/admin/customers`, `POST /:slug/admin/customers`, `DELETE /:slug/admin/customers/:id`.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/customers-admin.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeaders, createTestEnv, TENANT_A } from './helpers';

const SLUG = 'sunny-paws';

describe('admin customers', () => {
  it('adds, lists, and removes a customer', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };

    const add = await app.request(`/api/${SLUG}/admin/customers`, {
      method: 'POST', headers, body: JSON.stringify({ email: 'guest@example.com', name: 'Guest' }),
    }, env);
    expect(add.status).toBe(201);
    const created = (await add.json()) as { id: string; status: string };
    expect(created.status).toBe('invited');

    const list = await app.request(`/api/${SLUG}/admin/customers`,
      { headers: await adminHeaders(TENANT_A) }, env);
    const { customers } = (await list.json()) as { customers: { email: string }[] };
    expect(customers.some((c) => c.email === 'guest@example.com')).toBe(true);

    const del = await app.request(`/api/${SLUG}/admin/customers/${created.id}`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) }, env);
    expect(del.status).toBe(204);
  });

  it('rejects an invalid email with 400', async () => {
    const { env } = createTestEnv();
    const headers = { ...(await adminHeaders(TENANT_A)), 'Content-Type': 'application/json' };
    const res = await app.request(`/api/${SLUG}/admin/customers`,
      { method: 'POST', headers, body: JSON.stringify({ email: 'nope' }) }, env);
    expect(res.status).toBe(400);
  });

  it('refuses to delete a customer with bookings (409)', async () => {
    const { env, raw } = createTestEnv();
    raw.exec(`INSERT INTO EndUsers (Id, TenantId, Email, Status) VALUES ('eu1','${TENANT_A}','has@example.com','active')`);
    raw.exec(`INSERT INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, PetCount, Status)
              VALUES ('bk1','${TENANT_A}','eu1','daycare','2030-05-01',1,'pending')`);
    const res = await app.request(`/api/${SLUG}/admin/customers/eu1`,
      { method: 'DELETE', headers: await adminHeaders(TENANT_A) }, env);
    expect(res.status).toBe(409);
  });

  it('requires admin auth', async () => {
    const { env } = createTestEnv();
    const res = await app.request(`/api/${SLUG}/admin/customers`, {}, env);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npm test -- customers-admin` → FAIL.

- [ ] **Step 3: Implement** — in `server/routes/admin.ts`:

Add imports (merge into existing `../db/repo` import block; add the email import):
```ts
import {
  countBookingsForUser, deleteCustomer, insertInvitedCustomer, listCustomers,
} from '../db/repo';
import { isEmailConfigured, sendInvite } from '../lib/email';
```
Add an email regex near `COLOR_RE`:
```ts
const CUSTOMER_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```
Append these routes to the `adminRoutes` chain:
```ts
  .get('/:slug/admin/customers', async (c) => {
    const tenant = c.get('tenant');
    const customers = await listCustomers(c.env.PAWBOOK_DB, tenant.Id);
    return c.json({
      customers: customers.map((u) => ({
        id: u.Id, email: u.Email, name: u.Name, status: u.Status, invitedAt: u.InvitedAt,
      })),
    });
  })

  .post('/:slug/admin/customers', async (c) => {
    const tenant = c.get('tenant');
    const body = await c.req
      .json<{ email?: unknown; name?: unknown }>()
      .catch(() => ({}) as { email?: unknown; name?: unknown });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : null;
    if (!CUSTOMER_EMAIL_RE.test(email)) return c.json({ error: 'Enter a valid email.' }, 400);

    const customer = await insertInvitedCustomer(c.env.PAWBOOK_DB, tenant.Id, email, name);

    // Send the invite. Fail closed when email is configured but the send fails; in dev with no
    // provider, skip sending (the row still exists so the customer can be told out-of-band).
    if (isEmailConfigured(c.env)) {
      const widgetUrl = new URL(`/embed/${tenant.Slug}`, c.req.url).toString();
      try {
        await sendInvite(c.env, email, tenant.DisplayName, widgetUrl);
      } catch {
        return c.json({ error: 'Customer saved, but the invite email could not be sent.' }, 502);
      }
    }
    return c.json(
      { id: customer.Id, email: customer.Email, name: customer.Name, status: customer.Status },
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
  });
```

- [ ] **Step 4: Run tests + typecheck + lint** — Run: `npm test -- customers-admin && npm run typecheck && npm run lint` → PASS.

- [ ] **Step 5: Commit**
```bash
git add server/routes/admin.ts server/__tests__/customers-admin.test.ts
git commit -m "feat: admin customer management routes (list/add/remove + invite)"
```

---

### Task 12: Admin API client additions

**Files:**
- Modify: `app/shared-ui/api.ts`

**Interfaces:**
- Produces: client methods `adminCustomers.list/add/remove` and `adminCalendar.start/disconnect`. (Naming used by Task 13.)

- [ ] **Step 1: Add types + methods** — in `app/shared-ui/api.ts`, add after the `api` object (or extend it). Add a `Customer` type near the others:
```ts
export type Customer = {
  id: string;
  email: string;
  name: string | null;
  status: 'invited' | 'active';
  invitedAt?: string | null;
};
```
Append a new exported client (uses the same `request` helper + bearer header):
```ts
export const adminApi = {
  customers: {
    list: (slug: string, token: string) =>
      request<{ customers: Customer[] }>(`/api/${slug}/admin/customers`, { headers: authHeaders(token) }),
    add: (slug: string, token: string, email: string, name: string) =>
      request<{ id: string; status: string }>(`/api/${slug}/admin/customers`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders(token) },
        body: JSON.stringify({ email, name }),
      }),
    remove: (slug: string, token: string, id: string) =>
      request<unknown>(`/api/${slug}/admin/customers/${id}`, {
        method: 'DELETE',
        headers: authHeaders(token),
      }),
  },
  calendar: {
    start: (slug: string, token: string) =>
      request<{ url: string }>(`/api/${slug}/admin/providers/calendar/oauth/start`, {
        headers: authHeaders(token),
      }),
    disconnect: (slug: string, token: string) =>
      request<{ status: string }>(`/api/${slug}/admin/providers/calendar/disconnect`, {
        method: 'POST',
        headers: authHeaders(token),
      }),
  },
};
```

- [ ] **Step 2: Typecheck + lint** — Run: `npm run typecheck && npm run lint` → PASS.

- [ ] **Step 3: Commit**
```bash
git add app/shared-ui/api.ts
git commit -m "feat: admin API client for customers + calendar OAuth"
```

---

### Task 13: Admin UI — Customers panel + real calendar connect

**Files:**
- Modify: `app/admin/App.tsx`

**Interfaces:**
- Consumes: `adminApi` (Task 12); the existing `adminFetch`, `token`, `slug`, `refresh`, `handle`, `settings.providers` in `App.tsx`.

> No automated UI tests exist in this repo; verify via typecheck/build and the manual steps below.

- [ ] **Step 1: Import the admin API client** — add to the imports at the top of `app/admin/App.tsx`:
```ts
import { adminApi, type Customer } from '../shared-ui/api.js';
```

- [ ] **Step 2: Replace the calendar provider connect behavior**

In the Integrations `<section>` (the `settings.providers.map(...)` block), special-case `calendar`. Replace the list item body with:
```tsx
          {settings.providers.map((p) => (
            <li key={p.capability}>
              {p.label} — <em>{p.status}</em>{' '}
              {p.capability === 'calendar' ? (
                p.status === 'connected' ? (
                  <button onClick={() => void disconnectCalendar()}>Disconnect</button>
                ) : (
                  <button onClick={() => void connectCalendar()}>Connect Google Calendar</button>
                )
              ) : (
                p.status === 'disconnected' && (
                  <button onClick={() => void connect(p.capability)}>Connect (stub)</button>
                )
              )}
            </li>
          ))}
```
Update the helper note text below the list to: `Google Calendar uses real OAuth; other integrations are prototype stubs.`

- [ ] **Step 3: Add the calendar connect/disconnect handlers + popup message listener**

Near the existing `connect` handler, add:
```tsx
  const connectCalendar = async () => {
    setError('');
    try {
      const { url } = await adminApi.calendar.start(slug, token);
      window.open(url, 'pawbook-gcal', 'width=520,height=640');
    } catch (e) {
      handle(e);
    }
  };

  const disconnectCalendar = async () => {
    setError('');
    try {
      await adminApi.calendar.disconnect(slug, token);
      await refresh();
    } catch (e) {
      handle(e);
    }
  };
```
Add an effect that refreshes when the OAuth popup signals success:
```tsx
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data === 'pawbook:calendar-connected') void refresh();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [refresh]);
```
> `slug`, `token`, `refresh`, `handle`, `setError` already exist in the authenticated dashboard component scope (same scope as `connect`). Place these alongside it.

- [ ] **Step 4: Add the Customers panel**

Add customer state + loader in the dashboard component (near other `useState`):
```tsx
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [custEmail, setCustEmail] = useState('');
  const [custName, setCustName] = useState('');

  const loadCustomers = useCallback(async () => {
    const { customers } = await adminApi.customers.list(slug, token);
    setCustomers(customers);
  }, [slug, token]);

  useEffect(() => {
    loadCustomers().catch(handle);
  }, [loadCustomers, handle]);

  const addCustomer = async () => {
    setError('');
    try {
      await adminApi.customers.add(slug, token, custEmail.trim().toLowerCase(), custName.trim());
      setCustEmail('');
      setCustName('');
      await loadCustomers();
    } catch (e) {
      handle(e);
    }
  };

  const removeCustomer = async (id: string) => {
    setError('');
    try {
      await adminApi.customers.remove(slug, token, id);
      await loadCustomers();
    } catch (e) {
      handle(e);
    }
  };
```
Add a `<section>` (place it before the Integrations section):
```tsx
      <section>
        <h2>Customers (invite-only)</h2>
        <p><small>Only invited customers can request bookings. Adding one emails them an invite.</small></p>
        <div className="ad-row">
          <input
            type="email" placeholder="customer@email.com" value={custEmail}
            onChange={(e) => setCustEmail(e.target.value)}
          />
          <input
            type="text" placeholder="Name (optional)" value={custName}
            onChange={(e) => setCustName(e.target.value)}
          />
          <button onClick={() => void addCustomer()}>Add customer</button>
        </div>
        <ul>
          {customers.map((cust) => (
            <li key={cust.id}>
              {cust.email}{cust.name ? ` (${cust.name})` : ''} — <em>{cust.status}</em>{' '}
              <button onClick={() => void removeCustomer(cust.id)}>Remove</button>
            </li>
          ))}
        </ul>
      </section>
```

- [ ] **Step 5: Build + typecheck + lint** — Run: `npm run typecheck && npm run lint && npm run build` → PASS.

- [ ] **Step 6: Manual verification**

```bash
npm run seed:local
npm run dev
```
- Open `http://localhost:8787/admin`, sign in (`admin@sunnypaws.example` / `demo1234`).
- Customers panel lists the seeded `jess@example.com (Jess Demo) — active`.
- Add `guest@example.com`; it appears as `invited`. Remove it.
- Open `http://localhost:8787/embed/sunny-paws`; identify as `stranger@example.com` → "invitation only" error; identify as `jess@example.com` → code path works.
- (Calendar connect requires real Google creds set via `wrangler secret put`; with placeholder dev creds the consent popup opens but Google rejects the client — expected in local dev.)

- [ ] **Step 7: Commit**
```bash
git add app/admin/App.tsx
git commit -m "feat: admin Customers panel + real Google Calendar connect"
```

---

## Self-Review (completed against the spec)

- **Spec coverage:** ProviderConnections token cols + status widen (Task 1/5/6); BookingRequests GCalEventId + StartTime (Task 1); EndUsers Name/InvitedAt/Status + grandfathering (Task 1); token encryption (Task 2); signed single-use state (Task 3/6); google-calendar client incl. timed/all-day event (Task 4); event-on-booking via waitUntil (Task 7); gated identify + promote (Task 10); customer CRUD + delete-with-bookings 409 (Task 8/11); invite email fail-closed (Task 9/11); migration-0003 test (Task 1); booking-flow calendar assertion (Task 7); admin UI (Task 13). README docs update for the new secrets is a follow-up doc task (not code) — note below.
- **Type consistency:** `ProviderConnectionWithTokens`, `EndUser` (with Status), `CalendarBooking`, `SyncInput`, `Customer` defined once and consumed with matching field names. `setProviderTokens` signature identical across Tasks 5/6/7.
- **Placeholders:** none — every code/test step is concrete.

## Post-implementation follow-ups (not in scope of these tasks)

- Update `README.md` Roadmap (Phase 1/2 → shipped) and the "Deploy" section to document `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI` and the `0003` migration. Do this as a docs commit after the suite is green.
