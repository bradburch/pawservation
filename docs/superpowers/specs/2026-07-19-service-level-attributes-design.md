# Service-level capacity + pet-type attributes

**Date:** 2026-07-19
**Status:** Shipped — one rationale amended, see below
**Branch:** `custom-services`

> **Amended 2026-07-20:** The **F4** rationale for keeping `findOpenings` ("kept because it is
> exported shared API — external consumers mirror its semantics") no longer holds:
> `findOpenings` is **not re-exported from the barrel** `src/shared/index.ts`. It still exists in
> `src/shared/booking/capacity.ts` but is not part of the public shared surface, so the
> "external mirrors" justification for keeping it is unsupported. (`isUnavailableDate` was
> correctly deleted as stated.)

## Problem

Three booking attributes live on `Tenants` even though each one describes a
_service_, not the business: `MaxBoardingPets` (pet-counted daily cap for the
boarding pool), `MaxHouseSitsPerDay` (day-counted cap for the house-sit pool),
and `MaxStayNights` (stay-length ceiling applied to every range service).
Likewise `TenantPetTypes.Enabled` is a tenant-global on/off switch layered on
top of the per-service `AcceptedPetTypes` lists that the animal-types work
(`2026-07-19-animal-types-design.md`) already added — two gates expressing one
idea.

Owner's directive (verbatim): _"For the json, maxBoardingPets: 4,
maxHouseSitsPerDay: null, maxStayNights: 14, as well as petTypes are
service-level attributes. They are not 'global' attributes."_

So: caps move onto the services they describe, stay length collapses into the
existing per-service `MaxNights`, and `TenantPetTypes` becomes a pure registry
(slug + label) whose behavior is driven entirely by per-service acceptance.

## Design

### 1. Data model — `TenantServices` gains two cap columns

```sql
-- Both NULL = unlimited, matching MinNights/MaxNights/MinPetCount/MaxPetCount.
MaxConcurrentPets INTEGER,  -- CapacityKind='boarding': pets in care per day for THIS service
MaxPerDay INTEGER,          -- CapacityKind='housesit': bookings of THIS service per day
```

Two named columns, not one kind-interpreted `Capacity` column: the wire fields
and UI labels are distinct per kind, the settings PUT can reject a cap set on
the wrong kind explicitly (silent-ignore hides sitter mistakes), and the names
follow the existing `Max*` column style. A cap on a `CapacityKind='none'`
service is meaningless and rejected on PUT.

`Tenants.MaxBoardingPets` / `MaxHouseSitsPerDay` / `MaxStayNights` and
`TenantPetTypes.Enabled` are **retired in place** (decision argued in §8):
the columns stay in the table; no code reads or writes them.

### 2. Migration `0015_service_level_attributes.sql` (+ schema/seed lockstep)

Applied manually per `migrations/README.md` (`wrangler d1 execute … --file`);
`sql/schema.sql` updated to the same final shape in the same commit (the
Vitest harness and fresh installs only see `schema.sql` — retired columns stay
in it, commented `-- RETIRED by 0015`, so schema.sql, the local DB, and the
remote DB keep the exact same shape).

1. `ALTER TABLE TenantServices ADD COLUMN MaxConcurrentPets INTEGER;` and
   `… ADD COLUMN MaxPerDay INTEGER;`
2. **Copy caps per kind** — plain correlated copies; NULL (unlimited) copies
   through as NULL:

   ```sql
   UPDATE TenantServices SET MaxConcurrentPets =
     (SELECT MaxBoardingPets FROM Tenants t WHERE t.Id = TenantId)
   WHERE CapacityKind = 'boarding';
   UPDATE TenantServices SET MaxPerDay =
     (SELECT MaxHouseSitsPerDay FROM Tenants t WHERE t.Id = TenantId)
   WHERE CapacityKind = 'housesit';
   ```

3. **Stay length → `MaxNights`, effective-min copy** (refinement over the
   plain "copy where NULL" directive — see finding F2): today BOTH limits are
   enforced at booking time, so the effective ceiling is the smaller one.
   A plain copy-where-NULL would silently _loosen_ any service whose explicit
   `MaxNights` exceeds the tenant cap:

   ```sql
   UPDATE TenantServices SET MaxNights =
     (SELECT CASE
        WHEN MaxNights IS NULL THEN t.MaxStayNights
        WHEN t.MaxStayNights IS NULL THEN MaxNights
        ELSE MIN(MaxNights, t.MaxStayNights) END
      FROM Tenants t WHERE t.Id = TenantId)
   WHERE Shape = 'range';
   ```

4. **Materialize `Enabled = 0` into acceptance lists** — with the tenant gate
   gone, a NULL acceptance list would suddenly accept a tenant's _disabled_
   types (seeded Happy Tails: cats become bookable — finding F1). For every
   tenant that has any disabled row, each service with `AcceptedPetTypes IS
NULL` gets the explicit enabled-slug list (`json_group_array` over the
   enabled rows, `ORDER BY PetType`).
5. **Scrub disabled slugs from explicit lists** (`json_each` filter) — an
   explicit list naming a disabled slug was dead under the tenant gate and
   would come alive without this.
6. **Disable any enabled service whose list emptied in step 5** — the
   documented rule is "accepts nothing = disable the service", and such a
   service was already unbookable (every booking died at the tenant gate), so
   disabling preserves behavior and keeps the empty-list invariant.
7. Steps 4–6 leave `TenantPetTypes.Enabled` and the three `Tenants` columns
   with their old values — retired, unread.

`sql/seed.sql` is rewritten to the **post-0015 state** so seeded and migrated
DBs are equivalent: the `Tenants` insert drops `MaxBoardingPets`; Sunny Paws
boarding gets `MaxConcurrentPets = 2`, Happy Tails boarding `4`; Happy Tails'
services carry `AcceptedPetTypes = '["dog"]'` (its cat row stays in the
registry — accepted nowhere, demoing the chips) and its inserts stop naming
`Enabled` on pet types. `migrations/README.md` state section gains 0015 for
both DBs.

### 3. Capacity engine — per-service pools, still pure

`src/shared/booking/capacity.ts` reworks from one tenant-wide
boarding/house-sit pool pair to one pool **per service**. `CapacityLimits` is
deleted; events and the request carry service identity:

```ts
export type PoolKind = 'boarding' | 'housesit';

export type CapacityEvent = {
  start_date: string;
  end_date?: string; // exclusive
  kind: PoolKind | 'blocked';
  serviceType?: string; // pool identity; required unless kind='blocked'
  petCount?: number; // boarding-kind only; default 1
};

export type DayCapacity = {
  byService: Map<string, number>; // pets (boarding-kind) / bookings (housesit-kind)
  boardingTotal: number; // ALL boarding-kind pets — drives the structural house-sit rule
  blocked: number;
  isBoundary: boolean;
};

/** What the caller wants to book, carrying its own service's cap. */
export type CapacityRequest = {
  serviceType: string;
  kind: PoolKind;
  cap: number | null; // the service's MaxConcurrentPets / MaxPerDay; null = unlimited
  petCount?: number; // boarding-kind only
};

buildCapacity(events: CapacityEvent[]): Map<string, DayCapacity>;
dayBlocksRequest(day: DayCapacity, request: CapacityRequest): boolean;
rangeHasConflict(start, endExclusive, request, capacityByDate): boolean;
walkHasConflict(date, capacityByDate): boolean; // unchanged
findOpenings(capacity, { request | timed, from, to, nights?, limit? }): Opening[];
```

Semantics, explicitly:

- **A day blocks a request** when blocked, or when the request's own
  service's occupancy plus the request would exceed the request's own `cap`
  (`null` never blocks — auto pass-through preserved). Other services'
  occupancy is invisible to the cap check.
- **The structural house-sit rule stays tenant-wide**: a house-sit request may
  overlap `boardingTotal > 0` days by at most one day, across _all_
  boarding-kind services — it models the sitter's physical absence, not a
  pool. Unchanged in effect for today's tenants.
- **Boundary/bookend sharing stays global** (`isBoundary` set by any
  non-blocked event's endpoints; soft bookend re-checks the next day with the
  same per-service rule) — identical to today for one-pool-per-kind tenants.
- The standalone over-cap guard (an N-pet request over its cap fails even on
  an empty calendar) moves onto the request's own cap.
- `isUnavailableDate` is **deleted** — no callers anywhere (finding F4).
  `findOpenings` keeps its signature-reworked form but is flagged: no in-repo
  callers either; kept because it is exported shared API (external consumers,
  e.g. the deployed booking MCP, mirror its semantics) — do not delete here.

**Behavior change to state plainly:** capacity now counts **per service**.
Two boarding-kind services (possible today — a custom service cloned from the
boarding template) no longer share one pool; a tenant that had cap 4 with two
boarding-kind services ends up with 4 + 4 after the migration's per-kind copy.
Same for multiple housesit-kind services. For tenants with one service per
kind — the norm, and all three seed tenants — behavior is bit-for-bit
identical. This is the owner's directive, accepted as designed.

**Server wiring** (`server/lib/availability.ts`): `tenantLimits()` is
deleted; `rowsToCapacityEvents` adds `serviceType: row.ServiceType` (already
in `BOOKING_COLS` — `listCapacityRows` and its SQL are unchanged).
`listServices` selects the two new columns and the `TenantService` type in
`server/types.ts` gains them (nullable numbers).
`checkRange` builds the `CapacityRequest` from the service row
(`kind: service.CapacityKind`, `cap: MaxConcurrentPets | MaxPerDay` by kind)
and its fast-path "That exceeds our boarding capacity." reason reads the
service cap. `monthAvailability`'s `used`/`max` become the request service's
own pool count and cap (`day.byService.get(service.ServiceType)` /
the service's cap column). `checkAvailability`'s outer signature is unchanged.

### 4. Stay length — `validateBoardingRange` reads the service

`server/lib/validation.ts` keeps `validateBoardingRange(start, end,
maxNights, timezone)` as-is; the two callers change what they pass:

- `routes/bookings.ts` POST and `routes/public.ts` `/availability` pass
  `service.MaxNights` instead of `tenant.MaxStayNights`.

This _fixes a latent gap_ (finding F3): the public availability quote never
enforced per-service `MaxNights` (only the booking POST did, via
`validateServiceConstraints`) — quote and booking now agree.
`validateServiceConstraints`' own maxNights check in the POST becomes
redundant (validateBoardingRange fires first, its "Stays are limited to N
nights." copy wins) but **stays**: it is the widget's client-side mirror and
harmless defense in depth. `DEFENSIVE_MAX_NIGHTS` (3650) remains the backstop
exactly as today.

### 5. Pet types — pure registry, acceptance-derived behavior

`TenantPetTypes` becomes a registry: slug + label, add/rename/delete with the
existing reference guards (0014's CRUD endpoints unchanged in shape).
`Enabled` stops driving anything; `setPetTypeEnabled` is deleted from
`repo.ts`; `listPetTypes` stops selecting the column.

- **Booking gate** (`routes/bookings.ts`): the tenant-level enabled loop is
  replaced by a _registry membership_ check per chosen pet (unknown slug =
  corrupt data, still 400 "That pet type is not accepted."). The behavioral
  gate is now solely `validatePetTypeAcceptance` against the chosen service
  (NULL = accepts every registry type). The union-of-enabled-services
  derivation the directive names is therefore _implicit_: a type is bookable
  iff some enabled service accepts it, enforced per booking by that service's
  own list — no separate union computation needed server-side.
- **Widget** (`config.petTypes`): becomes the full registry
  `[{ slug, label }]` — it serves as the label map; the per-service offered
  list already derives from `service.acceptedPetTypes` in `BookTab.tsx`
  (NULL = all). Its "tenant-level disable" mirror comment/check reduces to
  registry membership. No visual change beyond types formerly hidden by the
  tenant toggle now appearing wherever a service accepts them (the migration
  materialization in §2 prevents exactly that for migrated tenants).
- **Delete guard copy**: "disable it instead" no longer parses — becomes
  "…is on N pets or bookings and can't be deleted. Uncheck it under each
  service's Accepted pets instead." Same 409, same `countPetTypeReferences`
  - `deletePetTypeAndScrub` (scrub-to-empty on an enabled service still
    normalizes to NULL, unchanged).
- **Sitter-side pet creation gates** (admin add-pet, CSV import): become
  registry membership — a sitter may record a pet of a type no service
  currently accepts (it just can't be booked). CSV skip copy: "'X' is not
  one of your pet types".

### 6. Wire shapes — field by field

**Settings GET** (`/api/:slug/admin/settings`):

| field                                                    | change                                                                                                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `maxBoardingPets`, `maxHouseSitsPerDay`, `maxStayNights` | **removed**                                                                                                                       |
| `petTypes`                                               | `[{ petType, label }]` — `enabled` removed                                                                                        |
| `services[].capacityKind`                                | **added** (`'boarding' \| 'housesit' \| 'none'`) — the editor must know which cap field to render (finding F5: not exposed today) |
| `services[].maxConcurrentPets`, `services[].maxPerDay`   | **added**, `number \| null`                                                                                                       |

**Settings PUT**: top-level `maxBoardingPets` / `maxHouseSitsPerDay` /
`maxStayNights` / `petTypes` **removed** from `SettingsBody` (and from
`patchNullable`'s key union). `ServiceBody` gains `maxConcurrentPets?:
number | null` and `maxPerDay?: number | null` with the standing per-service
PATCH idiom (absent = keep current), guarded by
`isNullableLimit(…, DEFENSIVE_MAX_PET_COUNT)` — the same 1..1000 sanity
ceiling both tenant caps used. A non-null `maxConcurrentPets` on a
non-boarding-kind service (or `maxPerDay` on non-housesit) → 400
`` `${label}: that capacity doesn't apply to this service.` ``.
`updateTenantSettings` drops the three caps; `setServiceConfig` gains the two.

**Public config** (`/api/:slug/config`): `maxBoardingPets`,
`maxHouseSitsPerDay`, `maxStayNights` **removed** (nothing in the embed reads
them — type-level break in `app/shared-ui/api.ts` only); `petTypes` becomes
the full registry (same `[{ slug, label }]` shape, semantics per §5). The new
service caps are **not** exposed publicly — the widget never saw the tenant
caps either; availability verdicts come from the server.

### 7. Admin UI

- **BusinessSection** loses the three `NullableNumberField`s (name, color,
  contact, timezone remain).
- **ServiceEditor** "Booking limits" group gains, by `capacityKind`:
  `'boarding'` → "Boarding spots per day (pets)" bound to
  `maxConcurrentPets`; `'housesit'` → "House-sits per day" bound to
  `maxPerDay`; `'none'` → nothing new. Min/max nights keep their existing
  `shape === 'range'` condition. `ServiceForm` in `app/admin/shared.ts` gains
  `capacityKind` + the two cap fields; `App.tsx` `save()` sends them and
  drops the tenant caps + `petTypes` from the PUT body.
- **PetsSection** becomes pure registry management: the enable checkbox row
  disappears; add/rename/delete stay exactly as built (immediate calls +
  refresh). Intro copy points at each service's Accepted pets chips as the
  on/off control.
- **Wizard profile step** (`WizardProfileStep.tsx`): the pet toggles are
  **removed** (decision: §8). The step keeps name/contact/timezone/color; the
  existing "Add more types any time under Pets." hint remains as a one-line
  pointer. `profilePutBody` drops its `petTypes` diff; `ProfileDraft` drops
  the field. New tenants still provision `dog`+`cat` rows
  (`createTenantFromSignup` keeps its inserts, minus naming `Enabled`), and
  template-created services start with NULL caps = unlimited — same defaults
  as today's fresh tenant.

### 8. Decisions on the open questions

- **Drop vs retire-in-place → retire in place.** Every real DB is migrated by
  hand and the remote DB is chronically behind (README: remote still needs
  0006–0014). Dropping `Tenants` columns via rebuild repeats the 0002
  foot-gun the README warns about in bold; even D1's `ALTER TABLE … DROP
COLUMN` would make schema.sql diverge from any DB that hasn't run 0015 the
  moment seed/tests assume the new shape. Retire-in-place keeps 0015
  purely additive (ALTER ADD + UPDATEs — never destructive), keeps
  schema.sql in exact lockstep, and makes "stop reading"
  compiler-enforced: `TENANT_COLS` and the `Tenant` type in
  `server/types.ts` drop the three fields, so any stale read is a type/SQL
  error, not a wrong answer. A future cleanup migration (0016+, out of
  scope) drops the dead columns once every DB has 0015. `TenantPetTypes.
Enabled` follows identically (column stays, unread; `TenantPetTypeRow`
  drops the field).
- **Wizard pet toggles → removed.** The alternatives (inline registry
  add/remove) mix immediate POST/DELETE calls into a step built on staged
  diff-PUT semantics, complicating Skip/Escape for near-zero value — new
  tenants get dog+cat seeded and per-service acceptance already has a home.
  Removal is the simplest path that keeps onboarding fast.

### 9. Docs & copy

- `CALENDAR_LOGIC.md` — rewrite the capacity sections for per-service pools
  (tenant-wide pool language is now wrong); the structural house-sit rule and
  bookend math are unchanged and stay documented as tenant-wide/global.
- `CLAUDE.md` — the invariant line "Tenant config limits (boarding cap,
  house-sits/day, max stay, timezone) are nullable = unlimited" narrows to
  timezone; note caps/stay-length now live on `TenantServices` with the same
  NULL semantics.
- Regenerate `docs/data-model.html` (gitignored — one line in the plan).
- Audit help/explainer copy (`2026-07-19-help-and-explainers-design.md`
  surfaces) and any Business-section copy that points at the old cap fields.

## Code findings that shaped the direction (flagged)

- **F1 — dropping the tenant pet gate is a live behavior change without the
  migration's materialization step.** Seeded Happy Tails (cat `Enabled=0`,
  services' `AcceptedPetTypes` NULL) would start accepting cats. Steps 4–6 of
  0015 (materialize, scrub, disable-if-emptied) exist solely to preserve each
  tenant's effective acceptance exactly.
- **F2 — plain "copy MaxStayNights where MaxNights IS NULL" can loosen
  limits.** Both ceilings are enforced today, so the effective limit is their
  min; the migration uses the effective-min copy instead (directive refined,
  not contradicted).
- **F3 — the public `/availability` quote never enforced per-service
  `MaxNights`** (only `validateBoardingRange` with the tenant cap; no
  `validateServiceConstraints` call). Unifying on the service's `MaxNights`
  closes the quote/booking disagreement as a side effect.
- **F4 — `isUnavailableDate` and `findOpenings` have zero in-repo callers**
  (barrel-exported only). `isUnavailableDate` is deleted with the rework;
  `findOpenings` is signature-reworked and kept (exported engine API with
  known external mirrors).
- **F5 — the settings GET doesn't expose `capacityKind`**, so the editor
  cannot yet decide which cap field a service warrants; the field is added to
  the GET payload and `ServiceForm`.
- **F6 — `listCapacityRows` needs no SQL change**: it already returns
  `ServiceType` (in `BOOKING_COLS`) and joins `CapacityKind`; the per-service
  rework is entirely in the pure engine + `rowsToCapacityEvents`.
- **F7 — KV-cached tenant objects are forward-safe**: new code only _removes_
  tenant-field reads, so stale cached tenants (with the retired fields) parse
  fine; no cache version bump needed.

## Out of scope (YAGNI)

- Per-option capacity (`TenantServiceOptions.Capacity`) — already exists,
  untouched.
- Dropping the retired columns (future 0016+ cleanup migration).
- Making the structural house-sit/boarding overlap rule per-service, or any
  cross-pool sharing model.
- Premium/billing; widget visuals beyond the derived types list; per-type
  pricing.

## Testing

Through the real schema via `createTestEnv()` (the lockstep `sql/schema.sql`
is what the harness executes):

- **Engine unit tests** (`capacity.test.ts`, rewritten to `CapacityRequest`):
  null-cap pass-through; per-service cap enforcement incl. petCount math;
  **two boarding-kind services don't share a pool** (service A full, service
  B same dates still books); two housesit-kind pools independent; structural
  house-sit rule still fires on _any_ boarding-kind occupancy
  (`boardingTotal`); boundary/soft-bookend under a per-service cap;
  empty-calendar over-cap rejection against the request's own cap.
- **Migration 0015** (`migration-0015.test.ts`, per the
  `migration-0006`/`migration-0014` precedent — build the pre-0015 schema,
  apply the file): caps copied per kind onto the right services; NULL caps
  preserved; effective-min MaxNights (all four NULL/NULL, NULL/value,
  value/NULL, both-set cases); disabled-type materialization fills only NULL
  lists; explicit lists scrubbed; emptied enabled service becomes disabled;
  `none`-kind services untouched.
- **Settings round-trip**: PUT service caps → GET returns them;
  `capacityKind` present in GET; cap on wrong-kind service → 400; PATCH
  semantics (absent cap field keeps current); removed tenant fields no longer
  round-trip; petTypes registry shape (no `enabled`).
- **Booking-gate derivation**: pet of a registry type accepted via a
  NULL-acceptance service books; type excluded from every service's list is
  rejected by the acceptance check; unknown slug still 400; post-migration
  Happy Tails cat booking still rejected (materialization proof, end to end).
- **Availability**: quote endpoint now rejects over-`MaxNights` ranges
  (the F3 fix, asserted); `checkRange` fast-path reason reads the service
  cap; month grid `used`/`max` per service.
- **Existing files transitioning** (enumerated): `capacity.test.ts`
  (rewrite), `availability.test.ts` + `month-availability.test.ts` (caps
  seeded onto service rows), `tenant-config.test.ts` (tenant-cap settings
  cases move to service-cap cases), `animal-acceptance.test.ts` (tenant-gate
  cases become registry/acceptance cases), `pet-types-admin.test.ts` /
  `pet-types-repo.test.ts` (Enabled toggling removed; delete-guard copy),
  `admin-pets.test.ts` + `customers-import.test.ts` (registry-membership
  gate), `admin.test.ts`, `booking-flow.test.ts`, `custom-services.test.ts`,
  `services.test.ts` (payload shapes), `isolation.test.ts` (unchanged
  invariant, re-run). Widget behavior: manual pass via the `running-pawbook`
  skill (Happy Tails dogs-only chips, Sunny Paws caps on the calendar).
