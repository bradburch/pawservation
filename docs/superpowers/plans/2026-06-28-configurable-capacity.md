# Configurable Capacity, Stay Length & Timezone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make boarding capacity, house-sit capacity, max stay length, and business timezone per-tenant settings where unset (`NULL`) means unlimited/auto-pass-through, and unify the two capacity engines into one config-aware engine.

**Architecture:** The shared capacity engine (`src/shared/booking/capacity.ts`) gains a `CapacityLimits` parameter where `null` = no limit. The server's forked copy (`tenantRangeHasConflict`/`dayBlocksBoarding`) is deleted and the server calls the shared engine with the tenant's limits. House-sits become first-class capacity events (no longer collapsed into boarding) so `MaxHouseSitsPerDay` is meaningful. Three new nullable `Tenants` columns plus a nullable `MaxBoardingPets` carry the config; new tenants default to unlimited while existing tenants keep their values via a table-rebuild migration. Invisible defensive bounds (CPU/overflow rails) replace the old business caps.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, D1 (SQLite), Vitest, React (admin/embed apps), node:sqlite test shim.

## Global Constraints

- Multi-tenant isolation: every domain table carries `TenantId`; never query without it.
- `null` capacity/limit = unlimited (auto pass-through). Admin-blocked dates ALWAYS block, regardless of limits.
- Timezone cannot be "unlimited"; unset falls back to `DEFAULT_TIMEZONE = 'America/Los_Angeles'`.
- Defensive rails are safety bounds, NOT business caps: `DEFENSIVE_MAX_PET_COUNT = 1000`, `DEFENSIVE_MAX_NIGHTS = 3650`. They reject malformed input, never "over capacity".
- Rates are free-typed whole dollars ≥ 1 (unchanged).
- Dates are `YYYY-MM-DD`, end date exclusive (checkout day, no overnight).
- New tenants default ALL four config columns to `NULL`. Existing tenants keep current values.
- TDD: write the failing test first, watch it fail, implement minimally, watch it pass, commit. One logical change per commit.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Verify each task with `npx vitest run <file>` and, before final commit of a task touching types, `npm run typecheck`.

---

### Task 1: Make the shared capacity engine config-aware

**Files:**

- Modify: `src/shared/booking/capacity.ts`
- Modify: `src/shared/index.ts`
- Test: `server/__tests__/capacity.test.ts` (new)

**Interfaces:**

- Produces:
  - `type CapacityLimits = { maxBoardingPets: number | null; maxHouseSitsPerDay: number | null }`
  - `dayBlocksRequest(capacity: DayCapacity, requestType: 'boarding' | 'house-sit', limits: CapacityLimits, requestPets?: number): boolean`
  - `rangeHasConflict(startDate: string, endDateExclusive: string, requestType: 'boarding' | 'house-sit', capacityByDate: Map<string, DayCapacity>, limits: CapacityLimits, requestPetCount?: number): boolean`
  - `isUnavailableDate(capacity: DayCapacity, limits: CapacityLimits): boolean`
  - `findOpenings(capacity, opts)` where `opts` gains `limits: CapacityLimits`
  - Unchanged: `buildCapacity`, `walkHasConflict`, `CapacityEvent`, `DayCapacity`
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/capacity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildCapacity,
  rangeHasConflict,
  type CapacityEvent,
  type CapacityLimits,
} from '../../src/shared/index.js';

const boarding = (start: string, end: string, petCount = 1): CapacityEvent => ({
  start_date: start,
  end_date: end,
  type: 'boarding',
  petCount,
});
const houseSit = (start: string, end: string): CapacityEvent => ({
  start_date: start,
  end_date: end,
  type: 'house-sit',
});
const blocked = (start: string, end: string): CapacityEvent => ({
  start_date: start,
  end_date: end,
  type: 'blocked',
});

const UNLIMITED: CapacityLimits = { maxBoardingPets: null, maxHouseSitsPerDay: null };

describe('rangeHasConflict with CapacityLimits', () => {
  it('auto-passes-through unlimited boarding (many overlaps, no limit)', () => {
    const cap = buildCapacity([
      boarding('2028-08-01', '2028-08-10', 5),
      boarding('2028-08-01', '2028-08-10', 9),
    ]);
    expect(rangeHasConflict('2028-08-02', '2028-08-06', 'boarding', cap, UNLIMITED, 7)).toBe(false);
  });

  it('still blocks admin-blocked dates even when unlimited', () => {
    const cap = buildCapacity([blocked('2028-08-03', '2028-08-05')]);
    expect(rangeHasConflict('2028-08-01', '2028-08-06', 'boarding', cap, UNLIMITED, 1)).toBe(true);
  });

  it('enforces a configured boarding pet cap', () => {
    const cap = buildCapacity([boarding('2028-08-01', '2028-08-05', 2)]);
    const limit3: CapacityLimits = { maxBoardingPets: 3, maxHouseSitsPerDay: null };
    // 2 already boarding mid-range: a 1-pet request fits (2+1<=3), a 2-pet request does not (2+2>3).
    expect(rangeHasConflict('2028-08-02', '2028-08-04', 'boarding', cap, limit3, 1)).toBe(false);
    expect(rangeHasConflict('2028-08-02', '2028-08-04', 'boarding', cap, limit3, 2)).toBe(true);
  });

  it('shares a boundary day (soft bookend) under a configured cap', () => {
    const cap = buildCapacity([boarding('2028-08-01', '2028-08-03', 2)]);
    const limit2: CapacityLimits = { maxBoardingPets: 2, maxHouseSitsPerDay: null };
    expect(rangeHasConflict('2028-08-03', '2028-08-05', 'boarding', cap, limit2, 2)).toBe(false);
  });

  it('enforces a configured house-sit cap; unlimited lets them stack', () => {
    const cap = buildCapacity([houseSit('2028-09-01', '2028-09-04')]);
    const oneSit: CapacityLimits = { maxBoardingPets: null, maxHouseSitsPerDay: 1 };
    expect(rangeHasConflict('2028-09-02', '2028-09-03', 'house-sit', cap, oneSit, 1)).toBe(true);
    expect(rangeHasConflict('2028-09-02', '2028-09-03', 'house-sit', cap, UNLIMITED, 1)).toBe(
      false,
    );
  });

  it('keeps the structural house-sit/boarding ≤1-day overlap rule regardless of limits', () => {
    const cap = buildCapacity([boarding('2028-09-01', '2028-09-10', 1)]);
    // A house-sit overlapping 2 boarding days conflicts even with unlimited house-sits.
    expect(rangeHasConflict('2028-09-02', '2028-09-04', 'house-sit', cap, UNLIMITED, 1)).toBe(true);
    // Overlapping exactly 1 boarding day is allowed.
    expect(rangeHasConflict('2028-09-01', '2028-09-02', 'house-sit', cap, UNLIMITED, 1)).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/capacity.test.ts`
Expected: FAIL — `CapacityLimits` is not exported and `rangeHasConflict` has the old signature.

- [ ] **Step 3: Implement the config-aware engine**

In `src/shared/booking/capacity.ts`, replace the comment block at the top (lines 4-9) with:

```ts
// Single source of truth for the booking calendar's capacity + conflict rules,
// shared between the web client (calendar UX) and the web server (validation).
//
// Capacity is per-tenant config via CapacityLimits: a `null` dimension is UNLIMITED
// (auto pass-through) and is never compared. Admin-blocked dates always block.
// House-sit/boarding may overlap by at most one day (structural rule, not a number).
// Boundary (bookend) sharing: the start/end day of an existing booking may be
// shared by a new booking's endpoint, EXCEPT for blocked events.

/** Per-tenant capacity limits. `null` means no limit (auto pass-through). */
export type CapacityLimits = {
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
};
```

Replace `isUnavailableDate` (old lines 69-72) with:

```ts
/** A day is unavailable when blocked, or a configured boarding/house-sit limit is met. */
export function isUnavailableDate(capacity: DayCapacity, limits: CapacityLimits): boolean {
  if (capacity.blocked >= 1) return true;
  if (limits.maxHouseSitsPerDay !== null && capacity.houseSits >= limits.maxHouseSitsPerDay)
    return true;
  if (limits.maxBoardingPets !== null && capacity.boarding >= limits.maxBoardingPets) return true;
  return false;
}
```

Replace `dayBlocksRequest` (old lines 85-93) with:

```ts
/**
 * Can a request of `requestPets` pets NOT occupy this day in isolation? A block is always a
 * hard stop. Otherwise each request type is governed only by its OWN configured limit; a `null`
 * limit never blocks (auto pass-through). Cross-type interaction (a house-sit may not overlap
 * occupied boarding by more than one day) is enforced at the range level, not here.
 */
export function dayBlocksRequest(
  capacity: DayCapacity,
  requestType: 'boarding' | 'house-sit',
  limits: CapacityLimits,
  requestPets = 1,
): boolean {
  if (capacity.blocked >= 1) return true;
  if (requestType === 'boarding') {
    const pets = Math.max(1, requestPets);
    return limits.maxBoardingPets !== null && capacity.boarding + pets > limits.maxBoardingPets;
  }
  return limits.maxHouseSitsPerDay !== null && capacity.houseSits + 1 > limits.maxHouseSitsPerDay;
}
```

Replace `rangeHasConflict` (old lines 101-139) with:

```ts
export function rangeHasConflict(
  startDate: string,
  endDateExclusive: string,
  requestType: 'boarding' | 'house-sit',
  capacityByDate: Map<string, DayCapacity>,
  limits: CapacityLimits,
  requestPetCount = 1,
): boolean {
  const requestEnd = addDays(endDateExclusive, -1); // last occupied night
  const requestPets = Math.max(1, requestPetCount);
  let houseSitBoardingOverlapDays = 0;

  for (let date = startDate; date < endDateExclusive; date = addDays(date, 1)) {
    const capacity = capacityByDate.get(date);
    if (!capacity) continue;

    // Structural rule: a house-sit may overlap existing boarding by at most one day.
    if (requestType === 'house-sit' && capacity.boarding > 0) {
      houseSitBoardingOverlapDays += 1;
      if (houseSitBoardingOverlapDays > 1) return true;
    }

    if (!dayBlocksRequest(capacity, requestType, limits, requestPets)) continue;

    const isRequestEndpoint = date === startDate || date === requestEnd;
    if (isRequestEndpoint && capacity.isBoundary) continue;

    // Soft bookend: an unavailable (non-blocked) endpoint is allowed when the next day has
    // room for this request — the existing booking is ending here.
    if (isRequestEndpoint && capacity.blocked === 0) {
      const next = capacityByDate.get(addDays(date, 1));
      if (!next || !dayBlocksRequest(next, requestType, limits, requestPets)) continue;
    }

    return true;
  }

  return false;
}
```

Update `findOpenings` (old lines 158-200): add `limits: CapacityLimits` to the `opts` object type and pass it into the `rangeHasConflict` call. The `opts` type becomes:

```ts
  opts: {
    requestType: RequestType;
    from: string;
    to: string;
    nights?: number;
    limit?: number;
    petCount?: number;
    limits: CapacityLimits;
  },
```

and the inner call becomes:

```ts
!rangeHasConflict(
  start,
  end,
  opts.requestType as 'boarding' | 'house-sit',
  capacity,
  opts.limits,
  opts.petCount,
);
```

In `src/shared/index.ts`, update the capacity export block to add `CapacityLimits`:

```ts
export {
  buildCapacity,
  rangeHasConflict,
  walkHasConflict,
  type CapacityEvent,
  type CapacityLimits,
  type DayCapacity,
} from './booking/capacity.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/__tests__/capacity.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/booking/capacity.ts src/shared/index.ts server/__tests__/capacity.test.ts
git commit -m "feat(capacity): config-aware shared engine with null=unlimited

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Make business timezone configurable in the date helpers

**Files:**

- Modify: `src/shared/util/dates.ts`
- Test: `server/__tests__/dates-timezone.test.ts` (new)

**Interfaces:**

- Produces:
  - `const DEFAULT_TIMEZONE = 'America/Los_Angeles'`
  - `getPacificDateStr(date?: Date, timezone?: string): string` (timezone defaults to `DEFAULT_TIMEZONE`)
- Consumes: nothing.

Scope note: only the "what day is it / is it in the past" path is parameterized (this is all the live behavior). The unwired cancellation-window helpers (`pacificDayStartUtcMs`, `hoursUntilStart`) keep `DEFAULT_TIMEZONE` and can be threaded when that feature lands.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/dates-timezone.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, getPacificDateStr } from '../../src/shared/util/dates.js';

describe('getPacificDateStr timezone parameter', () => {
  it('defaults to the instance default timezone', () => {
    expect(DEFAULT_TIMEZONE).toBe('America/Los_Angeles');
    // 2028-01-01 07:00 UTC is still 2027-12-31 in Los Angeles (UTC-8).
    const d = new Date('2028-01-01T07:00:00Z');
    expect(getPacificDateStr(d)).toBe('2027-12-31');
  });

  it('honors an explicit timezone', () => {
    // Same instant is already 2028-01-01 in Europe/London (UTC+0).
    const d = new Date('2028-01-01T07:00:00Z');
    expect(getPacificDateStr(d, 'Europe/London')).toBe('2028-01-01');
    // …and 2028-01-01 in Asia/Tokyo (UTC+9) well before that.
    expect(getPacificDateStr(d, 'Asia/Tokyo')).toBe('2028-01-01');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/dates-timezone.test.ts`
Expected: FAIL — `DEFAULT_TIMEZONE` is not exported and `getPacificDateStr` ignores a timezone arg.

- [ ] **Step 3: Implement**

In `src/shared/util/dates.ts`, change line 6-7 from:

```ts
/** The business timezone. All Pacific date math/formatting routes through this. */
export const PACIFIC = 'America/Los_Angeles';
```

to:

```ts
/** Instance-default business timezone used when a tenant has none set. */
export const DEFAULT_TIMEZONE = 'America/Los_Angeles';
/** @deprecated internal alias for offset helpers; prefer DEFAULT_TIMEZONE. */
export const PACIFIC = DEFAULT_TIMEZONE;
```

Change `getPacificDateStr` (old lines 107-109) to:

```ts
export function getPacificDateStr(
  date: Date = new Date(),
  timezone: string = DEFAULT_TIMEZONE,
): string {
  return date.toLocaleDateString('en-CA', { timeZone: timezone });
}
```

(Leave `pacificOffsetMinutes`, `pacificDayStartUtcMs`, `hoursUntilStart` referencing `PACIFIC` — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/__tests__/dates-timezone.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/shared/util/dates.ts server/__tests__/dates-timezone.test.ts
git commit -m "feat(dates): parameterize business timezone (DEFAULT_TIMEZONE)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Schema, migration, types, repo, and third demo tenant

**Files:**

- Modify: `sql/schema.sql`
- Create: `migrations/0002_tenant_config_limits.sql`
- Modify: `sql/seed.sql`
- Modify: `server/types.ts`
- Modify: `server/db/repo.ts`
- Test: `server/__tests__/tenant-config.test.ts` (new)

**Interfaces:**

- Produces:
  - `Tenant` type with `MaxBoardingPets: number | null`, `MaxHouseSitsPerDay: number | null`, `MaxStayNights: number | null`, `Timezone: string | null`
  - `updateTenantSettings(db, tenantId, settings)` where `settings: { displayName: string; accentColor: string; maxBoardingPets: number | null; maxHouseSitsPerDay: number | null; maxStayNights: number | null; timezone: string | null }`
  - Seed tenant `tnt_pawsandrelax` (slug `paws-and-relax`) with all config columns `NULL`
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `server/__tests__/tenant-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getTenantBySlug, updateTenantSettings } from '../db/repo';
import { createTestEnv, TENANT_A } from './helpers';

describe('tenant config columns', () => {
  it('new demo tenant defaults all limits to null (unlimited)', async () => {
    const { env } = createTestEnv();
    const t = await getTenantBySlug(env.PAWBOOK_DB, 'paws-and-relax');
    expect(t).not.toBeNull();
    expect(t!.MaxBoardingPets).toBeNull();
    expect(t!.MaxHouseSitsPerDay).toBeNull();
    expect(t!.MaxStayNights).toBeNull();
    expect(t!.Timezone).toBeNull();
  });

  it('existing demo tenant keeps its configured boarding cap', async () => {
    const { env } = createTestEnv();
    const t = await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws');
    expect(t!.MaxBoardingPets).toBe(2);
  });

  it('round-trips all config fields including explicit nulls', async () => {
    const { env } = createTestEnv();
    await updateTenantSettings(env.PAWBOOK_DB, TENANT_A, {
      displayName: 'Sunny Paws',
      accentColor: '#2563eb',
      maxBoardingPets: null,
      maxHouseSitsPerDay: 1,
      maxStayNights: 30,
      timezone: 'Europe/London',
    });
    const t = await getTenantBySlug(env.PAWBOOK_DB, 'sunny-paws');
    expect(t!.MaxBoardingPets).toBeNull();
    expect(t!.MaxHouseSitsPerDay).toBe(1);
    expect(t!.MaxStayNights).toBe(30);
    expect(t!.Timezone).toBe('Europe/London');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/tenant-config.test.ts`
Expected: FAIL — `paws-and-relax` not seeded; new columns/type fields absent.

- [ ] **Step 3a: Update schema**

In `sql/schema.sql`, replace the `Tenants` table (lines 4-11) with:

```sql
CREATE TABLE IF NOT EXISTS Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  -- All four are NULL = unlimited / instance-default. New tenants omit them.
  MaxBoardingPets INTEGER,
  MaxHouseSitsPerDay INTEGER,
  MaxStayNights INTEGER,
  Timezone TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 3b: Create the migration**

Create `migrations/0002_tenant_config_limits.sql`:

```sql
-- Make MaxBoardingPets nullable (NULL = unlimited) and add the new optional config columns.
-- SQLite cannot ALTER away a NOT NULL/DEFAULT, so rebuild Tenants preserving existing rows and
-- their MaxBoardingPets values (existing sitters keep their cap; only new tenants default to NULL).
-- Run against already-provisioned DBs:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0002_tenant_config_limits.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0002_tenant_config_limits.sql
PRAGMA foreign_keys=OFF;
ALTER TABLE Tenants RENAME TO Tenants_old;
CREATE TABLE Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  MaxBoardingPets INTEGER,
  MaxHouseSitsPerDay INTEGER,
  MaxStayNights INTEGER,
  Timezone TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO Tenants (Id, Slug, DisplayName, AccentColor, MaxBoardingPets, CreatedAt)
  SELECT Id, Slug, DisplayName, AccentColor, MaxBoardingPets, CreatedAt FROM Tenants_old;
DROP TABLE Tenants_old;
PRAGMA foreign_keys=ON;
```

- [ ] **Step 3c: Seed the third tenant**

In `sql/seed.sql`, the first INSERT (lines 9-11) stays (Sunny Paws=2, Happy Tails=4). Immediately after it, add a brand-new tenant on the new defaults (all config columns omitted → NULL):

```sql
-- A brand-new sitter on the NEW defaults: unlimited boarding/house-sits/stay length, default
-- timezone (all four config columns omitted → NULL). Edit its values via the admin dashboard.
INSERT OR REPLACE INTO Tenants (Id, Slug, DisplayName, AccentColor) VALUES
  ('tnt_pawsandrelax', 'paws-and-relax', 'Paws & Relax', '#059669');
```

Add its login to the `TenantUsers` INSERT (reuse the Sunny Paws "demo1234" hash for demo parity) — append a row:

```sql
  ('tu_pawsandrelax', 'tnt_pawsandrelax', 'admin@pawsandrelax.example', 'pbkdf2$600000$4f4aa1b2f29635a386a62fbce18336ae$8eaa4c479048f11664af6dd8a6118996921474eb6c72ba6c4b6caf66155fc6ae');
```

Add its services to the `TenantServices` INSERT — append:

```sql
  ('tnt_pawsandrelax', 'boarding', 1),
  ('tnt_pawsandrelax', 'housesitting', 1),
  ('tnt_pawsandrelax', 'walk', 1),
```

Add its priced options to the `TenantServiceOptions` INSERT — append:

```sql
  ('opt_pr_board', 'tnt_pawsandrelax', 'boarding', 'standard', 'Standard', NULL, 45, 'night'),
  ('opt_pr_house', 'tnt_pawsandrelax', 'housesitting', 'standard', 'Standard', NULL, 65, 'night'),
  ('opt_pr_walk30', 'tnt_pawsandrelax', 'walk', 'd30', '30 minutes', 30, 22, 'visit'),
```

Add its pet types to the `TenantPetTypes` INSERT — append:

```sql
  ('tnt_pawsandrelax', 'dog', 1),
  ('tnt_pawsandrelax', 'cat', 1),
```

Note: append each new row to the EXISTING multi-row `VALUES` lists — fix the preceding row's trailing comma/semicolon so the list stays valid SQL (the last row in each statement ends with `;`).

- [ ] **Step 3d: Update the Tenant type**

In `server/types.ts`, replace the `Tenant` type (lines 5-11) with:

```ts
export type Tenant = {
  Id: string;
  Slug: string;
  DisplayName: string;
  AccentColor: string;
  MaxBoardingPets: number | null; // null = unlimited
  MaxHouseSitsPerDay: number | null; // null = unlimited
  MaxStayNights: number | null; // null = unlimited
  Timezone: string | null; // null = DEFAULT_TIMEZONE
};
```

- [ ] **Step 3e: Update repo column list and updater**

In `server/db/repo.ts`, change `TENANT_COLS` (line 22) to:

```ts
const TENANT_COLS =
  'Id, Slug, DisplayName, AccentColor, MaxBoardingPets, MaxHouseSitsPerDay, MaxStayNights, Timezone';
```

Replace `updateTenantSettings` (lines 260-271) with:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/__tests__/tenant-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sql/schema.sql migrations/0002_tenant_config_limits.sql sql/seed.sql server/types.ts server/db/repo.ts server/__tests__/tenant-config.test.ts
git commit -m "feat(schema): nullable tenant config columns + paws-and-relax demo tenant

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Unify server availability on the shared engine (delete the fork)

**Files:**

- Modify: `server/lib/availability.ts`
- Modify: `server/__tests__/availability.test.ts`

**Interfaces:**

- Consumes: `rangeHasConflict`, `CapacityLimits`, `buildCapacity` (Task 1); `Tenant` with nullable fields (Task 3).
- Produces:
  - `rowsToCapacityEvents(rows: BookingRow[]): CapacityEvent[]` now emits `'house-sit'` for housesitting rows.
  - `tenantRangeHasConflict`/`dayBlocksBoarding` REMOVED.
  - `checkAvailability(...)` unchanged signature; routes house-sit through the shared house-sit path.

- [ ] **Step 1: Update the test (the parity-pin test for the deleted fork is replaced)**

In `server/__tests__/availability.test.ts`:

Change the import block (lines 1-12) to drop `tenantRangeHasConflict` and `rangeHasConflict`/`buildCapacity` (no longer needed here — Task 1 covers the engine):

```ts
import { describe, expect, it } from 'vitest';
import app from '../index';
import { insertBookingRequest } from '../db/repo';
import { checkAvailability, rowsToCapacityEvents } from '../lib/availability';
import { SERVICE_CATALOG } from '../lib/services';
import type { Tenant, TenantServiceOption } from '../types';
import { createTestEnv, TENANT_A } from './helpers';
```

Delete the entire `describe('tenantRangeHasConflict', ...)` block (old lines 26-73) and the `boarding`/`blocked` helpers above it (old lines 14-24) — they tested the deleted fork; Task 1's `capacity.test.ts` now owns engine coverage.

The three inline tenant literals (old lines 299-305, 311-317, 331-337) lack the new fields. Add a helper near the top of the file (after the imports) and use it:

```ts
function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    Id: TENANT_A,
    Slug: 'sunny-paws',
    DisplayName: 'Sunny Paws',
    AccentColor: '#000000',
    MaxBoardingPets: 2,
    MaxHouseSitsPerDay: null,
    MaxStayNights: null,
    Timezone: null,
    ...over,
  };
}
```

Replace each `const tenant = { Id: TENANT_A, ... MaxBoardingPets: 2 };` literal with `const t = tenant();` and update the following `checkAvailability(env, tenant, ...)` call in that test to `checkAvailability(env, t, ...)`.

Update the `'house-sitting consumes a boarding slot ...'` test (old lines 330-358): rename it and adjust the comment to reflect the new model — a house-sit overlapping existing boarding on 2+ days conflicts via the structural overlap rule. The assertion (`available: false`) is unchanged. Use `MaxHouseSitsPerDay: null` (unlimited) so the conflict is proven to come from the overlap rule, not a house-sit cap:

```ts
it('house-sit conflicts when it overlaps existing boarding by more than a day', async () => {
  const { env } = createTestEnv();
  const t = tenant(); // MaxHouseSitsPerDay null = unlimited; conflict must come from overlap rule
  const o = opt({
    ServiceType: 'housesitting',
    OptionKey: 'standard',
    DurationMinutes: null,
    Rate: 70,
    RateUnit: 'night',
  });
  // Seed: 1 pet boarding Jun 20-25. A house-sit Jun 21-23 overlaps boarding on Jun 21 AND 22.
  const res = await checkAvailability(env, t, 'housesitting', o, '2028-06-21', '2028-06-23', 2);
  expect(res).toMatchObject({ available: false });
  expect(SERVICE_CATALOG.housesitting.shape).toBe('range');
});
```

Add a new test proving the unlimited demo tenant auto-passes a large overlapping boarding request:

```ts
it('unlimited tenant (paws-and-relax) accepts overlapping boardings', async () => {
  const { env } = createTestEnv();
  await insertBookingRequest(env.PAWBOOK_DB, 'tnt_pawsandrelax', {
    endUserId: null,
    serviceType: 'boarding',
    startDate: '2028-05-01',
    endDate: '2028-05-10',
    optionKey: 'standard',
    petType: null,
    petCount: 8,
    estCost: null,
    status: 'confirmed',
  });
  const res = (await (
    await app.request(
      '/api/paws-and-relax/availability?type=boarding&start=2028-05-02&end=2028-05-06&pets=9',
      {},
      env,
    )
  ).json()) as { available: boolean };
  expect(res.available).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/availability.test.ts`
Expected: FAIL — `rowsToCapacityEvents` still maps housesitting→boarding (overlap test reasoning differs) and the unlimited tenant test hits the old fork. Compile errors on removed import are expected too.

- [ ] **Step 3: Rewrite the server availability module**

In `server/lib/availability.ts`, replace the imports (lines 1-12) with:

```ts
import {
  addDays,
  billableUnits,
  buildCapacity,
  nightsBetween,
  rangeHasConflict,
  walkHasConflict,
  type CapacityEvent,
  type CapacityLimits,
} from '../../src/shared/index.js';
import { listCapacityRows } from '../db/repo';
import { SERVICE_CATALOG, type ServiceType } from '../lib/services';
import type { BookingRow, Tenant, TenantServiceOption } from '../types';
```

Replace the header comment + `dayBlocksBoarding` + `tenantRangeHasConflict` (old lines 14-58) with a small limits helper:

```ts
/**
 * Per-tenant availability built on the shared capacity engine. The tenant's nullable config
 * columns map straight onto CapacityLimits (null = unlimited / auto pass-through).
 */
function tenantLimits(tenant: Tenant): CapacityLimits {
  return {
    maxBoardingPets: tenant.MaxBoardingPets,
    maxHouseSitsPerDay: tenant.MaxHouseSitsPerDay,
  };
}
```

Replace `rowsToCapacityEvents` (old lines 60-69) with (house-sit is now first-class):

```ts
export function rowsToCapacityEvents(rows: BookingRow[]): CapacityEvent[] {
  return rows.map((row) => ({
    start_date: row.StartDate,
    end_date: row.EndDate ?? undefined,
    type:
      row.ServiceType === 'blocked'
        ? 'blocked'
        : row.ServiceType === 'housesitting'
          ? 'house-sit'
          : 'boarding',
    petCount: row.PetCount,
  }));
}
```

Replace `checkRange` (old lines 91-128) with:

```ts
async function checkRange(
  env: Env,
  tenant: Tenant,
  serviceType: ServiceType,
  option: TenantServiceOption,
  startDate: string,
  endDateExclusive: string,
  petCount: number,
  excludeBookingId?: string,
): Promise<AvailabilityResult> {
  const requestType = serviceType === 'housesitting' ? 'house-sit' : 'boarding';
  const limits = tenantLimits(tenant);
  // A boarding request for more pets than a CONFIGURED per-day cap can never fit, even on an empty
  // calendar (the range walk skips empty days). Skipped entirely when boarding is unlimited.
  if (
    requestType === 'boarding' &&
    tenant.MaxBoardingPets !== null &&
    petCount > tenant.MaxBoardingPets
  ) {
    return { available: false, reason: 'That exceeds our boarding capacity.' };
  }
  // Fetch one day PAST checkout so the soft-bookend look-ahead sees a booking starting on the
  // checkout day (without +1, listCapacityRows clips that row and a final night can double-book).
  const rows = await listCapacityRows(
    env.PAWBOOK_DB,
    tenant.Id,
    startDate,
    addDays(endDateExclusive, 1),
    excludeBookingId,
  );
  const capacity = buildCapacity(rowsToCapacityEvents(rows));
  if (rangeHasConflict(startDate, endDateExclusive, requestType, capacity, limits, petCount)) {
    return { available: false, reason: 'Those dates are not available.' };
  }
  return {
    available: true,
    estCost: estimateCost(serviceType, option, startDate, endDateExclusive),
    nights: nightsBetween(startDate, endDateExclusive),
  };
}
```

(Leave `estimateCost`, `checkSingle`, and `checkAvailability` unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/availability.test.ts server/__tests__/capacity.test.ts`
Expected: PASS.

Then full suite to catch fallout: `npx vitest run`
Expected: PASS (booking-flow/isolation tests still green — house-sit modeling only changes housesitting rows; seed has none).

- [ ] **Step 5: Commit**

```bash
git add server/lib/availability.ts server/__tests__/availability.test.ts
git commit -m "refactor(availability): unify on shared engine; model house-sits as first-class

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Configurable max stay length + defensive rails in validation

**Files:**

- Modify: `server/lib/validation.ts`
- Modify: `server/routes/public.ts`
- Modify: `server/__tests__/validation.test.ts`

**Interfaces:**

- Consumes: `getPacificDateStr` timezone arg (Task 2); `Tenant` nullable fields (Task 3).
- Produces:
  - `const DEFENSIVE_MAX_NIGHTS = 3650`, `const DEFENSIVE_MAX_PET_COUNT = 1000`
  - `isFutureOrToday(value: string, timezone?: string): boolean`
  - `validateBoardingRange(start: string, end: string, maxStayNights: number | null, timezone?: string): DateRangeError | null`
  - `validateSingleDate(date: string, timezone?: string): DateRangeError | null`
  - `isValidPetCount` bounded by `DEFENSIVE_MAX_PET_COUNT`
  - `MAX_RANGE_NIGHTS` and `MAX_PET_COUNT` REMOVED.

- [ ] **Step 1: Write/adjust the failing test**

First inspect existing references: `npx vitest run server/__tests__/validation.test.ts` and open the file. Replace any `MAX_RANGE_NIGHTS`/`MAX_PET_COUNT` references and add the cases below. Append this describe block to `server/__tests__/validation.test.ts`:

```ts
import { DEFENSIVE_MAX_NIGHTS, isValidPetCount, validateBoardingRange } from '../lib/validation';

describe('configurable stay length', () => {
  it('rejects a stay over the tenant max with the configured number', () => {
    const err = validateBoardingRange('2028-01-01', '2028-01-20', 10);
    expect(err?.error).toBe('Stays are limited to 10 nights.');
  });

  it('allows any realistic stay when maxStayNights is null (auto pass-through)', () => {
    expect(validateBoardingRange('2028-01-01', '2030-01-01', null)).toBeNull();
  });

  it('still rejects an absurd range beyond the defensive rail even when unlimited', () => {
    const end = '2099-01-01';
    expect(validateBoardingRange('2026-01-01', end, null)?.status).toBe(400);
    expect(DEFENSIVE_MAX_NIGHTS).toBe(3650);
  });

  it('pet count is bounded by the defensive rail, not a business cap of 50', () => {
    expect(isValidPetCount(60)).toBe(true); // 60 > old 50 cap, allowed now
    expect(isValidPetCount(1001)).toBe(false); // beyond defensive rail
  });
});
```

(If the existing file already imports `describe/expect/it`, do not duplicate that import; merge the new symbol imports into the existing `from '../lib/validation'` import.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/validation.test.ts`
Expected: FAIL — new exports/signature absent.

- [ ] **Step 3: Implement**

In `server/lib/validation.ts`, replace lines 9-13 with:

```ts
/** Safety rail (NOT a business cap): bounds the per-request capacity loop so an unlimited stay
 * length can't burn CPU. ~10 years — far beyond any real booking. */
export const DEFENSIVE_MAX_NIGHTS = 3650;

/** Safety rail (NOT a business cap): input sanity bound on a single request's pet count. */
export const DEFENSIVE_MAX_PET_COUNT = 1000;
```

Replace `isValidPetCount` (old lines 16-20) with:

```ts
export function isValidPetCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= DEFENSIVE_MAX_PET_COUNT
  );
}
```

Replace `isFutureOrToday` (old lines 32-34) with:

```ts
export function isFutureOrToday(value: string, timezone?: string): boolean {
  return value >= getPacificDateStr(undefined, timezone);
}
```

Replace `validateBoardingRange` (old lines 43-53) with:

```ts
export function validateBoardingRange(
  start: string,
  end: string,
  maxStayNights: number | null,
  timezone?: string,
): DateRangeError | null {
  if (!isRealDate(start)) return { error: 'Invalid start date.', status: 400 };
  if (!isRealDate(end) || end <= start) return { error: 'Invalid end date.', status: 400 };
  if (!isFutureOrToday(start, timezone)) return { error: 'That date is in the past.', status: 400 };
  const nights = nightsBetween(start, end);
  // Defensive rail first: an over-rail range is malformed input, not "over capacity".
  if (nights > DEFENSIVE_MAX_NIGHTS) return { error: 'Invalid date range.', status: 400 };
  if (maxStayNights !== null && nights > maxStayNights)
    return { error: `Stays are limited to ${maxStayNights} nights.`, status: 400 };
  return null;
}
```

Replace `validateSingleDate` (old lines 56-60) with:

```ts
export function validateSingleDate(date: string, timezone?: string): DateRangeError | null {
  if (!isRealDate(date)) return { error: 'Invalid date.', status: 400 };
  if (!isFutureOrToday(date, timezone)) return { error: 'That date is in the past.', status: 400 };
  return null;
}
```

In `server/routes/public.ts`, pass the tenant's stay limit and timezone. In the `/:slug/availability` handler, change the two validation calls (old lines 65 and 69):

```ts
const rangeError = validateBoardingRange(
  start,
  end,
  tenant.MaxStayNights,
  tenant.Timezone ?? undefined,
);
```

```ts
const dateError = validateSingleDate(start, tenant.Timezone ?? undefined);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/validation.test.ts server/__tests__/availability.test.ts`
Expected: PASS. The existing `'rejects an over-long range'` availability test (2027→2099) still 400s via the defensive rail.

- [ ] **Step 5: Commit**

```bash
git add server/lib/validation.ts server/routes/public.ts server/__tests__/validation.test.ts
git commit -m "feat(validation): per-tenant max stay length + defensive rails

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Admin settings + public config expose and validate the new fields

**Files:**

- Modify: `server/routes/admin.ts`
- Modify: `server/routes/public.ts`
- Modify: `server/__tests__/admin.test.ts`

**Interfaces:**

- Consumes: `updateTenantSettings` new shape (Task 3); `DEFENSIVE_MAX_NIGHTS`, `DEFENSIVE_MAX_PET_COUNT` (Task 5).
- Produces: GET `/admin/settings` and GET `/config` responses include `maxBoardingPets`, `maxHouseSitsPerDay`, `maxStayNights`, `timezone` (nullable). PUT `/admin/settings` accepts and validates them (null clears to unlimited).

- [ ] **Step 1: Write the failing test**

Append to `server/__tests__/admin.test.ts` (reuse existing `createTestEnv`/`adminHeaders`/`TENANT_A` imports already in the file):

```ts
describe('configurable limits via admin settings', () => {
  it('persists null (unlimited) and new limit fields, surfaced in config', async () => {
    const { env } = createTestEnv();
    const put = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'content-type': 'application/json' },
        body: JSON.stringify({
          maxBoardingPets: null,
          maxHouseSitsPerDay: 1,
          maxStayNights: 14,
          timezone: 'America/New_York',
        }),
      },
      env,
    );
    expect(put.status).toBe(204);
    const cfg = (await (await app.request('/api/sunny-paws/config', {}, env)).json()) as {
      maxBoardingPets: number | null;
      maxHouseSitsPerDay: number | null;
      maxStayNights: number | null;
      timezone: string | null;
    };
    expect(cfg.maxBoardingPets).toBeNull();
    expect(cfg.maxHouseSitsPerDay).toBe(1);
    expect(cfg.maxStayNights).toBe(14);
    expect(cfg.timezone).toBe('America/New_York');
  });

  it('rejects an invalid timezone', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'content-type': 'application/json' },
        body: JSON.stringify({ timezone: 'Mars/Phobos' }),
      },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('accepts a boarding cap above the old ceiling of 50', async () => {
    const { env } = createTestEnv();
    const res = await app.request(
      '/api/sunny-paws/admin/settings',
      {
        method: 'PUT',
        headers: { ...(await adminHeaders(TENANT_A)), 'content-type': 'application/json' },
        body: JSON.stringify({ maxBoardingPets: 80 }),
      },
      env,
    );
    expect(res.status).toBe(204);
  });
});
```

Confirm `app` is imported in `admin.test.ts`; if not, add `import app from '../index';`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/__tests__/admin.test.ts`
Expected: FAIL — new fields not validated/persisted/exposed; 80 rejected by the old 1–50 check.

- [ ] **Step 3: Implement**

In `server/routes/admin.ts`:

Add to imports from `'../lib/validation'` (line 21):

```ts
import {
  DEFENSIVE_MAX_NIGHTS,
  DEFENSIVE_MAX_PET_COUNT,
  isRealDate,
  isValidDuration,
  isValidRate,
} from '../lib/validation';
```

Add two validators after `const COLOR_RE` (line 24):

```ts
/** A nullable limit: null (unlimited) or a positive integer within a defensive ceiling. */
function isNullableLimit(value: unknown, max: number): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= max)
  );
}

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
```

Extend `SettingsBody` (lines 28-34):

```ts
type SettingsBody = {
  displayName?: string;
  accentColor?: string;
  maxBoardingPets?: number | null;
  maxHouseSitsPerDay?: number | null;
  maxStayNights?: number | null;
  timezone?: string | null;
  petTypes?: string[];
  services?: ServiceBody[];
};
```

In the GET `/admin/settings` response (after line 52 `maxBoardingPets: tenant.MaxBoardingPets,`) add:

```ts
      maxHouseSitsPerDay: tenant.MaxHouseSitsPerDay,
      maxStayNights: tenant.MaxStayNights,
      timezone: tenant.Timezone,
```

In the PUT handler, replace the field-resolution + validation (old lines 85-92). A field present in the body is applied (including explicit `null` to clear); an absent field keeps the current value:

```ts
const maxBoardingPets = 'maxBoardingPets' in body ? body.maxBoardingPets! : tenant.MaxBoardingPets;
const maxHouseSitsPerDay =
  'maxHouseSitsPerDay' in body ? body.maxHouseSitsPerDay! : tenant.MaxHouseSitsPerDay;
const maxStayNights = 'maxStayNights' in body ? body.maxStayNights! : tenant.MaxStayNights;
const timezone = 'timezone' in body ? body.timezone! : tenant.Timezone;
const petTypes = body.petTypes;
const services = body.services ?? [];

if (!displayName) return c.json({ error: 'Display name required.' }, 400);
if (!COLOR_RE.test(accentColor)) return c.json({ error: 'Accent color must be #rrggbb.' }, 400);
if (!isNullableLimit(maxBoardingPets, DEFENSIVE_MAX_PET_COUNT))
  return c.json(
    { error: 'Boarding capacity must be a positive number, or blank for no limit.' },
    400,
  );
if (!isNullableLimit(maxHouseSitsPerDay, DEFENSIVE_MAX_PET_COUNT))
  return c.json(
    { error: 'House-sit capacity must be a positive number, or blank for no limit.' },
    400,
  );
if (!isNullableLimit(maxStayNights, DEFENSIVE_MAX_NIGHTS))
  return c.json(
    { error: 'Max stay nights must be a positive number, or blank for no limit.' },
    400,
  );
if (!isValidTimezone(timezone)) return c.json({ error: 'Unknown timezone.' }, 400);
```

Update the `updateTenantSettings` call (old lines 119-123) to pass all fields:

```ts
await updateTenantSettings(c.env.PAWBOOK_DB, tenant.Id, {
  displayName,
  accentColor,
  maxBoardingPets,
  maxHouseSitsPerDay,
  maxStayNights,
  timezone: timezone ?? null,
});
```

In `server/routes/public.ts`, in the `/:slug/config` JSON (after line 21 `maxBoardingPets: tenant.MaxBoardingPets,`) add:

```ts
      maxHouseSitsPerDay: tenant.MaxHouseSitsPerDay,
      maxStayNights: tenant.MaxStayNights,
      timezone: tenant.Timezone,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run server/__tests__/admin.test.ts`
Expected: PASS. Then `npx vitest run` (full suite) and `npm run typecheck`.
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.ts server/routes/public.ts server/__tests__/admin.test.ts
git commit -m "feat(admin): configure house-sit cap, stay length, timezone; null=unlimited

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Admin dashboard UI for the new settings

**Files:**

- Modify: `app/shared-ui/api.ts`
- Modify: `app/admin/App.tsx`

**Interfaces:**

- Consumes: config/settings API shapes (Task 6).
- Produces: admin form inputs for boarding cap (blank = unlimited), house-sit cap, max stay nights, timezone; `TenantConfig` type with nullable fields.

- [ ] **Step 1: Update the shared API type**

In `app/shared-ui/api.ts`, update `TenantConfig` (the block around lines 17-25) to:

```ts
export type TenantConfig = {
  slug: string;
  displayName: string;
  accentColor: string;
  maxBoardingPets: number | null;
  maxHouseSitsPerDay: number | null;
  maxStayNights: number | null;
  timezone: string | null;
  petTypes: string[];
  services: ServiceConfig[];
};
```

- [ ] **Step 2: Update the admin settings state + form**

In `app/admin/App.tsx`:

Update the settings type (around line 47) — change `maxBoardingPets: number;` to:

```ts
maxBoardingPets: number | null;
maxHouseSitsPerDay: number | null;
maxStayNights: number | null;
timezone: string | null;
```

Where the settings object is built from the GET response (around line 222 `maxBoardingPets: settings.maxBoardingPets,`), ensure the three new fields are carried through identically (add `maxHouseSitsPerDay`, `maxStayNights`, `timezone` alongside it in the same object literal).

Replace the "Max boarding pets per day" `<label>` (lines 319-333) with four inputs. Blank input ⇒ `null` (unlimited); a number ⇒ that cap:

```tsx
        <label>
          Max boarding pets per day <span className="ad-hint">(blank = no limit)</span>
          <input
            type="number"
            min={1}
            value={settings.maxBoardingPets ?? ''}
            onChange={(e) =>
              setSettings({
                ...settings,
                maxBoardingPets: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Max house-sits per day <span className="ad-hint">(blank = no limit)</span>
          <input
            type="number"
            min={1}
            value={settings.maxHouseSitsPerDay ?? ''}
            onChange={(e) =>
              setSettings({
                ...settings,
                maxHouseSitsPerDay: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Max stay length (nights) <span className="ad-hint">(blank = no limit)</span>
          <input
            type="number"
            min={1}
            value={settings.maxStayNights ?? ''}
            onChange={(e) =>
              setSettings({
                ...settings,
                maxStayNights: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <label>
          Business timezone <span className="ad-hint">(blank = America/Los_Angeles)</span>
          <input
            type="text"
            placeholder="America/Los_Angeles"
            value={settings.timezone ?? ''}
            onChange={(e) =>
              setSettings({
                ...settings,
                timezone: e.target.value === '' ? null : e.target.value,
              })
            }
          />
        </label>
```

Where settings are saved (the PUT body construction — search for where `maxBoardingPets` is sent, near the save handler), include the three new fields in the request body so they round-trip: `maxHouseSitsPerDay`, `maxStayNights`, `timezone`.

(The `.ad-hint` class is cosmetic; if no matching style exists it renders as plain inline text — acceptable. Do not add CSS unless an `.ad-hint`/hint convention already exists in the admin stylesheet.)

- [ ] **Step 3: Verify build + types**

Run: `npm run typecheck`
Expected: PASS (no type errors in app or server).

Run: `npx vitest run`
Expected: full suite PASS.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `npm run seed:local` then start the dev server (`npm run dev` or the project's documented command) and open the admin dashboard for `paws-and-relax`. Confirm the four inputs render blank (unlimited) and saving a value persists.

- [ ] **Step 5: Commit**

```bash
git add app/shared-ui/api.ts app/admin/App.tsx
git commit -m "feat(admin-ui): inputs for house-sit cap, stay length, timezone (blank=unlimited)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run the full suite: `npx vitest run` → all PASS.
- [ ] Typecheck: `npm run typecheck` → no errors.
- [ ] Lint: `npm run lint` → clean (fix any new findings).
- [ ] Grep for leftover hardcoded business caps: `grep -rn "MAX_RANGE_NIGHTS\|MAX_PET_COUNT\|tenantRangeHasConflict\|>= 2\b" server/lib src/shared` → only defensive rails / structural rules remain, with comments.
- [ ] Confirm `git log --oneline` shows one focused commit per task.

## Self-review notes (coverage map)

- Boarding capacity configurable, null=unlimited → Tasks 1, 3, 4, 6, 7.
- House-sit capacity configurable, null=unlimited → Tasks 1, 3, 4, 6, 7.
- Max stay length configurable, null=unlimited → Tasks 5, 6, 7.
- Timezone per-tenant, default fallback → Tasks 2, 3, 5, 6, 7.
- One unified engine (fork deleted) → Tasks 1, 4.
- Defensive rails as invisible bounds → Tasks 5, 6.
- New tenants default unlimited; existing keep values → Task 3 (migration + seed).
- Third editable demo tenant on new defaults → Task 3.
- Costs stay per-tenant (no change) → confirmed, untouched.
