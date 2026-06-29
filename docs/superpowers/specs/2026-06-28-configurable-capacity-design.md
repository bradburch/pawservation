# Configurable capacity, stay length & timezone — design

**Date:** 2026-06-28
**Status:** Approved (pending spec review)
**Branch target:** off `main`

## Problem

Several business values that belong to the individual pet sitter are hardcoded in
the application instead of being per-tenant configuration:

- **Boarding capacity is fixed at 2 pets/day** and **house-sits at 1/day** in the
  shared engine (`src/shared/booking/capacity.ts`). The server keeps a _forked
  copy_ (`tenantRangeHasConflict`) that honors `tenant.MaxBoardingPets`, so there
  are two parallel capacity engines and only one is config-aware. The code
  comments flag this as a deliberate "D-E deviation" with the graduation path:
  _"add an optional `maxPets` param to the shared functions instead."_
- **`MaxBoardingPets` has a forced default of 2 and a hard ceiling of 50**
  (`sql/schema.sql:9`, `server/routes/admin.ts:91`). There is no notion of
  "no limit."
- **Max stay length is hardcoded** at `MAX_RANGE_NIGHTS = 365`
  (`server/lib/validation.ts:10`).
- **The business timezone is hardcoded** to `America/Los_Angeles`
  (`src/shared/util/dates.ts:7`).

A pet sitter should set these. If a sitter sets nothing, the system should **auto
pass through** (no limit) rather than impose an arbitrary cap.

Costs/rates are **already** per-tenant (the `TenantServiceOptions` table, priced
server-side in `estimateCost`) and are out of scope except to confirm they stay
that way.

## Goals

1. Boarding capacity, house-sit capacity, and max stay length are per-tenant
   settings where **unset (`NULL`) means unlimited — an auto pass-through**.
2. Business timezone is a per-tenant setting; unset falls back to an instance
   default (timezone needs _a_ value — it can't be "unlimited").
3. **One** capacity engine. Delete the server fork; the shared engine becomes
   config-aware via an explicit limits parameter.
4. Defensive safety rails (CPU/overflow guards) remain as invisible bounds far
   above any realistic value — never acting as a business cap.
5. New tenants default to unlimited. Existing tenants keep their current values.

## Non-goals

- Dynamic/seasonal pricing, deposits, lead times, cancellation windows.
- Per-service-type concurrency beyond boarding + house-sit.
- A literal config file. Config stays in per-tenant D1 settings + admin dashboard.

## Design

### 1. Capacity model: `null` = unlimited

Introduce a limits type in the shared layer and thread it through the engine:

```ts
export type CapacityLimits = {
  maxBoardingPets: number | null; // null = no boarding pet-count limit
  maxHouseSitsPerDay: number | null; // null = no house-sit count limit
};
```

Affected shared functions (`src/shared/booking/capacity.ts`):

- `dayBlocksRequest(capacity, requestType, limits, requestPets)` — a `null`
  dimension is never compared, so it never blocks. Concretely:
  - `capacity.blocked >= 1` → always blocks (admin "I'm away" markers are not a
    capacity number and are never subject to limits).
  - boarding request: blocks only when
    `limits.maxBoardingPets !== null && capacity.boarding + pets > limits.maxBoardingPets`.
  - house-sit request: blocks only when
    `limits.maxHouseSitsPerDay !== null && capacity.houseSits + 1 > limits.maxHouseSitsPerDay`.
- `rangeHasConflict(start, endExclusive, requestType, capacityByDate, limits, requestPetCount)`
  — same soft-bookend / boundary-sharing logic as today, now reading `limits`.
- `isUnavailableDate(capacity, limits)` — used by calendar cell display; a day is
  "full" only against configured limits (always full when `blocked >= 1`).
- `findOpenings(...)` — accepts `limits` and forwards it.

The existing cross-type interaction (a house-sit request can't overlap occupied
boarding by more than one day — the `houseSitBoardingOverlapDays` rule) is
**structural**, not a numeric cap, and is preserved. When both limits are `NULL`,
the only things that block are admin-blocked dates and that one-day overlap rule —
i.e. effectively auto pass-through.

### 2. Delete the server fork

`server/lib/availability.ts` currently reimplements the boarding path
(`tenantRangeHasConflict`, `dayBlocksBoarding`). Both are removed. `checkRange`
builds a `CapacityLimits` from the tenant and calls the shared
`rangeHasConflict`. The isolation pre-check (`petCount > MaxBoardingPets`) becomes
conditional: it only rejects when `MaxBoardingPets !== null`.

### 3. Schema & types

`sql/schema.sql` `Tenants` table:

```sql
MaxBoardingPets    INTEGER,           -- was NOT NULL DEFAULT 2; NULL = unlimited
MaxHouseSitsPerDay INTEGER,           -- new; NULL = unlimited
MaxStayNights      INTEGER,           -- new; NULL = unlimited
Timezone           TEXT               -- new; NULL = instance default
```

- New tenants: all four columns omitted → `NULL` → unlimited / default timezone.
- A migration file (`sql/migrations/`) adds the three new columns and drops the
  `NOT NULL DEFAULT 2` from `MaxBoardingPets` for existing DBs. **Existing rows
  keep their current `MaxBoardingPets` value** (e.g. live sitters at 2 stay at 2);
  only brand-new tenants default to unlimited.
- The `Tenant` type (`server/types`) updates `MaxBoardingPets` to `number | null`
  and adds the three new optional fields.

### 4. Admin route & validation

`server/routes/admin.ts` PUT `/:slug/admin/settings`:

- Replace `maxBoardingPets < 1 || maxBoardingPets > 50` with: accept `null`
  (unlimited) **or** a positive integer `>= 1` and `<= DEFENSIVE_MAX_CAPACITY`.
- Add the same null-or-positive validation for `maxHouseSitsPerDay` and
  `maxStayNights`.
- Validate `timezone`: `null` or a value accepted by `Intl.DateTimeFormat`
  (try/catch on construction — no hardcoded allowlist).
- `updateTenantSettings` (`server/db/repo.ts`) persists all four; `NULL` is a
  first-class value (an explicit "clear the limit" action).

The GET settings response and the public `GET /:slug/config` both expose the four
fields so the widget calendar's availability UX matches the server.

### 5. Max stay length & defensive bounds

`server/lib/validation.ts`:

- `validateBoardingRange` takes the tenant's `maxStayNights`. When `null`, no
  business limit on stay length. The error message uses the configured number.
- **Defensive CPU rail:** the capacity loop steps one day at a time, so an
  unbounded range is a DoS vector. Keep an internal `DEFENSIVE_MAX_NIGHTS`
  (e.g. 3650 — ~10 years, far above any real stay) that bounds the loop
  regardless of config. It is a safety rail, commented as such, not a business
  cap; a request beyond it is rejected as malformed, not "over capacity."
- **Defensive pet-count rail:** keep an internal `DEFENSIVE_MAX_PET_COUNT`
  (high, e.g. 1000) as input sanity to prevent overflow/abuse, replacing the
  business-feeling `MAX_PET_COUNT = 50`. It does not cap what a sitter may
  configure for `maxBoardingPets`.

### 6. Timezone

`src/shared/util/dates.ts`:

- Keep `PACIFIC = 'America/Los_Angeles'` but rename its role to
  `DEFAULT_TIMEZONE` (the instance default fallback).
- `getPacificDateStr` / `isFutureOrToday` / `pacificDayStartUtcMs` /
  `hoursUntilStart` accept an optional `timezone` argument defaulting to
  `DEFAULT_TIMEZONE`. Server validation passes `tenant.Timezone ?? DEFAULT_TIMEZONE`.
- The widget receives the tenant timezone via the config API for its
  past/future date checks.
- Scope note: this is a focused thread-through of the timezone parameter, not a
  rewrite of the date module. Callers that have no tenant context keep the
  default.

## Data flow (boarding availability, after change)

1. Widget calls `GET /:slug/availability` (or builds its calendar from
   `GET /:slug/config` limits).
2. Server loads tenant → builds `CapacityLimits { maxBoardingPets,
maxHouseSitsPerDay }` and reads `maxStayNights`, `timezone`.
3. `validateBoardingRange` checks dates against `maxStayNights` (or unlimited) and
   the defensive rail, using the tenant timezone for the past check.
4. `checkRange` builds capacity from DB rows and calls shared `rangeHasConflict`
   with the limits. `null` dimensions never block.
5. Same engine, same limits power the client calendar so UX and server agree.

## Error handling

- Invalid configured limit (non-integer, `< 1`, above defensive max) → 400 from
  admin route with a clear message.
- Invalid timezone string → 400.
- Stay beyond `maxStayNights` → 400 "Stays are limited to N nights." Stay beyond
  the defensive rail (only reachable when unlimited) → 400 "Invalid date range."
- A `petCount` over the configured `maxBoardingPets` → existing 400 "That exceeds
  our boarding capacity." Skipped entirely when capacity is unlimited.

## Testing

- **Rewrite `availability.test.ts`**: it currently pins the server fork to the
  shared impl at max = 2. Re-point it at the unified engine driven by explicit
  `CapacityLimits`.
- New shared `capacity.test.ts` cases:
  - `maxBoardingPets: null` → many overlapping boardings all pass (auto
    pass-through); admin-blocked dates still block.
  - configured `maxBoardingPets: 3` → 4th pet on a day is rejected; soft-bookend
    still works.
  - `maxHouseSitsPerDay: null` vs `1`.
  - house-sit/boarding one-day overlap rule preserved under both null and set.
- Validation tests: `maxStayNights` null (unlimited up to defensive rail) vs set;
  defensive rail rejects absurd ranges even when unlimited.
- Timezone test: `isFutureOrToday` respects a passed non-Pacific timezone.
- Update `sql/seed.sql`: keep Sunny Paws at an explicit `MaxBoardingPets = 2` and
  Happy Tails at `4` to demonstrate configured limits; **add a third demo tenant
  that uses the new defaults** — all four config columns omitted/`NULL`
  (unlimited boarding, unlimited house-sits, unlimited stay length, default
  timezone). This represents a brand-new sitter and exercises the auto
  pass-through path. It has a slug + dashboard login so its values can be edited
  later through the admin dashboard. It is enabled for the standard services with
  example rates so it is bookable out of the box.

## Files touched

- `src/shared/booking/capacity.ts` — `CapacityLimits`, parameterized functions.
- `src/shared/util/dates.ts` — `DEFAULT_TIMEZONE`, optional timezone args.
- `src/shared/index.ts` — export `CapacityLimits`.
- `server/lib/availability.ts` — delete fork, call shared engine with limits.
- `server/lib/validation.ts` — configurable stay length, defensive rails.
- `server/routes/admin.ts` — null-or-positive validation, timezone validation.
- `server/routes/public.ts` (config endpoint) — expose new fields.
- `server/db/repo.ts` — persist/read new columns.
- `server/types` — `Tenant` type updates.
- `sql/schema.sql` + new `sql/migrations/*.sql` — nullable column + 3 new columns.
- `sql/seed.sql` — explicit demo values.
- Tests: `availability.test.ts`, `capacity.test.ts`, validation/dates tests.
- Widget/calendar config consumption (read new limits).

## Open questions

None outstanding. Decisions locked: per-tenant DB config; unset = unlimited; new
tenants default unlimited while existing keep their values; defensive bounds are
invisible safety rails.
