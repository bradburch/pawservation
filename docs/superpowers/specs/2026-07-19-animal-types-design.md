# Configurable animal types — custom species + per-service acceptance

**Date:** 2026-07-19
**Status:** Superseded in part — see amendment
**Branch:** `custom-services`

> **Amended 2026-07-20:** The `TenantPetTypes.Enabled` enable/disable model in this spec was
> superseded by `2026-07-19-service-level-attributes-design.md` (migration 0015) and never
> shipped as written. Corrections to the stale claims below:
>
> - **`TenantPetTypes.Enabled` is retired.** The column still physically exists but is dead —
>   0015 materializes it into per-service `AcceptedPetTypes` lists and nothing reads it. Pet
>   types are now a pure **registry** (slug + `Label`); there is no live enable/disable flag.
> - **Settings GET/PUT carry no enabled flags.** GET returns `petTypes` as `{ petType, label }[]`
>   (`server/routes/admin.ts`, no `enabled`); PUT has no `petTypes: string[]` enabled-slug list.
> - **The tenant-level "enabled type" booking gate is deleted, not "stays" (§F1/§Testing).**
>   Booking now does a registry-membership check plus per-service `validatePetTypeAcceptance`
>   (`src/shared/booking/service-rules.ts`, called from `server/routes/bookings.ts`); there is
>   no tenant-wide type disable left to "win".
> - **PetsSection is a pure registry editor** (add / rename / delete rows) — no enable checkbox
>   or staged enable draft.
> - **The wizard has no pet-type toggles.** `WizardProfileStep.tsx` shows a pointer line ("Pet
>   types you accept are managed under Pets, and per service under Services") instead.
> - The delete-guard and CSV skip-reason copy referencing an "enabled pet type" no longer apply;
>   gating is registry membership, not an enabled flag.

## Problem

Pawbook is hardcoded to dogs and cats. The enum lives in four places at once:
a `CHECK (PetType IN ('dog','cat'))` on `TenantPetTypes` **and** on
`EndUserPets` (`sql/schema.sql`), the `PET_TYPES` const + `isPetType` guard
(`server/lib/services.ts`), and display literals (`petType === 'dog' ? 'Dogs'
: 'Cats'` in `PetsSection.tsx` / `WizardProfileStep.tsx`). A sitter who also
takes rabbits, birds, or reptiles cannot say so, and no service can say
"boarding is dogs-only but check-ins take anything."

Owner's directive: sitters can add other animal types, and each type can be
configured as accepted-or-not per service.

## Design

Two pieces, mirroring how services already went custom
(`2026-07-07-custom-services-design.md`): the type list becomes per-tenant
**rows** (slug + label, enable/disable, add/rename/delete), and each service
gains an acceptance list with the codebase's standing **NULL = unlimited**
semantics (NULL/absent = accepts every enabled type).

### 1. Data model

**`TenantPetTypes`** is rebuilt (SQLite cannot drop a CHECK in place):

```sql
CREATE TABLE IF NOT EXISTS TenantPetTypes (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  PetType TEXT NOT NULL,            -- per-tenant slug ('dog', 'rabbit', …), immutable
  Label TEXT NOT NULL,              -- display name ('Dogs', 'Rabbits'), renamable
  Enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (TenantId, PetType)
);
```

- Slug is derived from the label via the existing `slugifyServiceLabel`
  (rename does not re-slug — same identity model as services). Listing order
  is `ORDER BY PetType` — deterministic with no new column, which
  `profilePutBody`'s index-wise compare depends on.
- `dog`/`cat` are ordinary rows, not special: renamable and (when
  unreferenced) deletable like any custom type.

**`EndUserPets`** is rebuilt to drop its CHECK; the `PetType` column itself is
already a plain TEXT slug, so existing pets keep working untouched.
`BookingRequests.PetType` has **no** CHECK (comment only) — no rebuild;
its comment changes to "tenant pet-type slug".

**`TenantServices`** gains one nullable column:

```sql
AcceptedPetTypes TEXT  -- JSON array of pet-type slugs; NULL = accepts all enabled types
```

**JSON column, not a junction table.** Weighed both:

- Consistency: `Questions` on the same table set the precedent for
  per-service JSON config; the settings PUT's field-level PATCH semantics
  (`'questions' in svc ? … : current`) extend to it verbatim.
- Queryability: nothing ever filters by acceptance in SQL — booking
  validation already loads the full service row (`listServices` in
  `bookings.ts`) and checks in code, exactly like `Questions`/`MinNights`.
- A junction table would also have to join the `deleteService` batch and the
  settings-PUT write path for zero benefit.

An **empty array is invalid** for an enabled service (rejected on PUT, like
"needs at least one price option") — "accepts nothing" is expressed by
disabling the service, so NULL/absent stays the only "no restriction" value.

### 2. Migration `0014_custom_pet_types.sql` (+ schema/seed lockstep)

Next number after 0013. Applied manually per `migrations/README.md`
convention (`wrangler d1 execute … --file`); `sql/schema.sql` is updated to
the same final shape in the same commit, since the Vitest harness and fresh
installs only see `schema.sql`.

1. `PRAGMA defer_foreign_keys = true;` — `BookingRequestPets.PetId`
   references `EndUserPets(Id)`, so the rebuilds need FK checks deferred.
2. Rebuild `TenantPetTypes` (create-copy-drop-rename), backfilling
   `Label = CASE PetType WHEN 'dog' THEN 'Dogs' ELSE 'Cats' END`.
3. **Backfill missing rows**: for every tenant, `INSERT` a `dog` and `cat`
   row with `Enabled = 0` where absent. Required, not cosmetic — today the
   settings GET synthesizes both toggles from the code enum, so seeded
   Happy Tails (dog row only) would silently lose its Cats toggle the moment
   the list becomes rows-driven (finding F1 below).
4. Rebuild `EndUserPets` without the CHECK; recreate
   `idx_EndUserPets_Tenant_User`.
5. `ALTER TABLE TenantServices ADD COLUMN AcceptedPetTypes TEXT;` — NULL for
   every existing service = accepts all, i.e. today's behavior exactly.

`sql/seed.sql`: pet-type inserts gain `Label`; add one enabled custom row
(`tnt_sunnypaws`, `rabbit`, `Rabbits`) so a fresh local run demos the feature
end-to-end (tests asserting exact type lists are updated alongside).

**New-tenant provisioning**: `createTenantFromSignup` currently seeds _no_
pet-type rows (finding F1). Its atomic batch gains two inserts — `dog`/`Dogs`
and `cat`/`Cats`, `Enabled = 1` — so new tenants still default to dog+cat.
Deliberate small behavior change: today a fresh signup tenant shows both
toggles _off_ (enum-synthesized); seeding them on removes the "sitter skips
the wizard and no pet can ever book" foot-gun. Wizard toggles still let the
sitter turn either off.

### 3. Server: types, repo, routes

**`server/lib/services.ts`**: `PET_TYPES` and `isPetType` are deleted.
`PetType` becomes `string` (same move `ServiceType` already made: "validated
against rows, not an enum"). Validation everywhere becomes membership in the
tenant's `TenantPetTypes` rows.

**`server/db/repo.ts`** (sole `PAWBOOK_DB` toucher, `tenantId` first arg):

- `listPetTypes` returns `Label` too, `ORDER BY PetType`.
- New: `createPetType(db, tenantId, slug, label)`,
  `renamePetType(db, tenantId, slug, label)`,
  `deletePetType(db, tenantId, slug)`,
  `countPetTypeReferences(db, tenantId, slug)` — `EndUserPets` rows plus
  `BookingRequests.PetType` rows of any status, mirroring
  `countBookingsForService`'s "history included" rule.
- `setServiceConfig` gains `acceptedPetTypes: string[] | null` (stored as
  JSON text / NULL); `listServices` parses it back.

**Type CRUD endpoints** (admin-auth'd, mirroring the services split —
enable/disable rides the settings draft, structural changes are immediate):

- `POST /api/:slug/admin/pet-types` `{ label }` → slugify, reject empty slug
  or duplicate (409). Created enabled.
- `PUT /api/:slug/admin/pet-types/:petType` `{ label }` → rename label only.
- `DELETE /api/:slug/admin/pet-types/:petType` → **blocked with 409 while
  referenced** by any customer pet or any booking (the `deleteService`
  precedent: history included, deletion never orphans a slug that admin
  lists and CSV exports would otherwise render as a bare token). Error copy
  points at the alternative: "…is on N pets or bookings — disable it
  instead." An unreferenced delete also scrubs the slug from any service's
  `AcceptedPetTypes` array (config, not history — safe to clean).

**Settings GET** (`admin.ts`): `petTypes` becomes
`[{ petType, label, enabled }]` read from rows (no more enum synthesis).
Each service gains `acceptedPetTypes: string[] | null`.

**Settings PUT**: `petTypes?: string[]` keeps its shape (enabled slugs) —
validated as a subset of the tenant's existing slugs; the write loops over
the tenant's rows instead of `PET_TYPES`. Per-service `acceptedPetTypes`
follows the questions PATCH idiom (absent = keep current); values must be a
subset of the tenant's type slugs; empty array on an enabled service → 400.

**Admin add-pet + CSV import** (`admin.ts`): `isPetType` checks become
"slug exists and is enabled for this tenant" — the CSV skip-reason copy
already says "not an enabled pet type" and now covers custom types for free.

**Public config** (`public.ts`): `petTypes` changes from `string[]` to
`[{ slug, label }]` (enabled only), and each service carries
`acceptedPetTypes: string[] | null`. The only consumer of the old array is
the `WidgetConfig` type in `app/shared-ui/api.ts` (nothing reads it in the
embed today — finding F3), so the break is type-level.

### 4. Enforcement — shared, zero-dep

New pure function in `src/shared/booking/service-rules.ts` (keeps the
directory dependency-free):

```ts
/** null accepted = service accepts every enabled type. Returns first error or null. */
export function validatePetTypeAcceptance(
  accepted: string[] | null,
  serviceLabel: string,
  pets: { name: string; petType: string }[],
  labelOf: (slug: string) => string,
): string | null;
```

Plain-language error, e.g. `Boarding doesn't accept rabbits — Peanut can't
join this booking.` (`labelOf` falls back to the raw slug).

**Server** (`bookings.ts` POST): after the existing tenant-level
enabled-type loop (which stays — tenant-level disable always wins), call the
helper with `service.AcceptedPetTypes` and the chosen pets; 400 on error.
This checks **every** selected pet, not the denormalized single
`BookingRequests.PetType` (which remains first-pet-only, unchanged).

**Widget** (`app/embed/BookTab.tsx`): pets are sitter-managed (customers
cannot create them — finding F3), so the mirror is display-only: with a
service selected, chips for unaccepted pets render disabled with a hint
("not accepted for {service label}") and are dropped from `selectedPets`;
the same shared helper gates the submit button alongside
`questionsError`/`constraintsError`. Labels come from `config.petTypes`.
The pet-chip species tag shows the label instead of the raw slug.

### 5. Admin UI

**Pets section** (`PetsSection.tsx`) — the management home:

- One row per type: enable checkbox (staged draft + save bar, as today, now
  labeled from `p.label`), inline rename, and delete for any type
  (immediate PUT/DELETE like services' add/delete; delete
  `window.confirm`-guarded and surfacing the 409 "disable instead" copy).
- "Add a pet type" input + button → immediate POST + settings refresh
  (the `AddServiceForm` pattern).

**Per-service acceptance** lives in the **F-redesign service editor**
(`2026-07-19-services-rates-redesign.md`), not the old long form: a fourth
group after Booking limits —

```
Accepted pets
 [✓ Dogs] [✓ Cats] [✗ Rabbits]
```

A row of toggle chips over the tenant's enabled types, editing the staged
draft. NULL renders as all-checked; unchecking one materializes an explicit
list; re-checking all normalizes back to NULL on save (so services keep
auto-accepting types the sitter adds later — an explicit list does not, and
the group shows a one-line hint saying so). The card's facts line gains a
lowest-priority fragment when an explicit list is set (`Dogs only`,
`Dogs & Cats`). If the F redesign hasn't landed when this builds, the same
chip row appends to the current flat editor — the group is self-contained.

**Wizard profile step** (`WizardProfileStep.tsx`): the toggles already map
over `settings.petTypes`; the hardcoded ternary becomes `p.label`, so the
step generalizes to however many types the tenant has. No add-type in the
wizard — the hint points at the Pets section.

### 6. Copy

- Preset summaries (`app/admin/presets.ts`): "up to 8 dogs" → "up to 8 pets"
  (×3 walk presets).
- Landing FAQ (`server/index.ts`, LOCKED_CSP static body): "Dogs and cats
  only." → "You choose which animal types you accept." (finding F5).

## Code findings that shaped the direction (flagged)

- **F1 — fresh tenants have no `TenantPetTypes` rows.** The settings GET
  fabricates the dog/cat list from the code enum; seeded tenants only have
  rows for enabled types. Rows-as-source-of-truth therefore _requires_ both
  the migration backfill (step 3) and signup-batch seeding — neither was in
  the original directive. Includes the deliberate new-tenant
  default-enabled change argued above.
- **F2 — `EndUserPets` has its own CHECK enum**, so the "customer side
  aligns" item is a second table rebuild, not a compat shim. Conversely
  `BookingRequests.PetType` has no CHECK — no rebuild, history untouched.
- **F3 — customers cannot create pets in the widget** (sitter-managed via
  Clients + CSV). The customer-side scope shrinks to display/filtering;
  all type-gating on pet creation lives in admin routes. Also: nothing in
  the embed reads `config.petTypes` today, so its wire change is safe.
- **F4 — `PET_TYPES`/`isPetType` are server-only**, not in `src/shared` —
  there is no shared enum to generalize; the shared surface is the new
  acceptance validator only.
- **F5 — the script-free landing page hard-claims "Dogs and cats only"** —
  ships false the moment this lands; included in scope.

## Out of scope (YAGNI)

- Per-type pricing and per-type capacity pools (capacity stays pet-counted;
  `capacity.ts`'s math is type-blind and correct as-is).
- Per-type intake questions; type icons/emoji; drag-ordering of types.
- Customer self-service pet creation.
- Backfilling `BookingRequests.PetType` history or blocking renames on it —
  labels resolve at display time, slugs are immutable.

## Testing

Through the real schema via `createTestEnv()` (harness executes
`sql/schema.sql`, so the lockstep update is what the tests see):

- **Acceptance rejection**: service with `AcceptedPetTypes = '["dog"]'`,
  booking with a cat pet → 400 with the plain-language message; mixed
  dog+cat selection also rejected (any offending pet fails the booking).
- **All-types default**: `AcceptedPetTypes` NULL accepts every enabled type,
  including a freshly added custom one.
- **Tenant gate still wins**: type disabled tenant-wide rejects even when
  the service's list names it.
- **Custom type CRUD**: POST creates (slugified, enabled), duplicate → 409,
  empty-slug label → 400; rename round-trips through settings GET; PUT
  `petTypes` toggles custom slugs; PUT rejects unknown slugs and an empty
  `acceptedPetTypes` on an enabled service.
- **Referenced-type guard**: DELETE blocked (409) while an `EndUserPets` row
  or a booking of any status references the slug; unreferenced delete
  succeeds and scrubs the slug from service acceptance lists.
- **Provisioning**: `createTenantFromSignup` yields dog+cat rows enabled;
  settings GET on a fresh tenant lists both from rows (no enum).
- **Regressions**: admin add-pet and CSV import gate on enabled rows
  (existing `admin-pets` / `customers-import` tests updated for the new
  source of truth); `services.test.ts`'s "exactly dog and cat" assertion is
  deleted with the enum.
- Widget filtering/labeling: manual pass via the `running-pawbook` skill
  (seeded Rabbits row) — chips disable per service, labels render, submit
  gate matches the server verdict.
