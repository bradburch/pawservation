# Migrations

## Fresh installs

Fresh databases are provisioned from `sql/schema.sql` + `sql/seed.sql`, **not** from this
directory — `sql/schema.sql` is the canonical DDL and already includes everything through
`0025_service_description.sql` (keep this line in step with the highest-numbered migration
mirrored into `schema.sql`). Use:

```
npm run seed:local   # wrangler d1 execute pawbook-db --local  --file=./sql/schema.sql && ...seed.sql
npm run seed:remote  # same, against the remote DB
```

Do **not** run `migrate:local` / `migrate:remote` (`wrangler d1 migrations apply`) against a
freshly-seeded DB — the tables already exist (from schema.sql), so replaying these files would
fail or duplicate work.

## Existing/already-provisioned DBs

No real DB in this project has ever gone through `wrangler d1 migrations apply` — every
migration to date has been applied manually via `wrangler d1 execute ... --file`, so **no
`d1_migrations` tracking table exists on any real DB**. `main`'s `migrate:local`/`migrate:remote`
npm scripts exist but aren't the established convention here; this merge doesn't change that —
keep applying new migration files manually with `d1 execute --file` until a deliberate decision
is made to adopt tracked migrations.

Current state:

- **Local dev DB**: `sql/schema.sql` already carries everything through
  `0025_service_description.sql`, so a local DB built **from scratch** (`npm run seed:local` against
  no existing DB) needs no migrations applied. A local DB seeded before today predates
  `0020`–`0025` and is on the incremental-apply path below like any other already-provisioned DB —
  apply `0020`–`0025` with the `--local` commands in the `0020`/`0021`, `0022`/`0023`, `0024`, and
  `0025` sections. **`seed:local` alone will NOT repair it**: `schema.sql` is
  `CREATE … IF NOT EXISTS`, so the old narrow `RateUnit` CHECK survives and `seed.sql`'s `'walk'`
  rows then fail — see the `seed:local` note in the `0024` section for the two ways out.
- **Remote DB**: fully migrated through `0024` (applied 2026-07-27) (**`0025` is NOT yet applied
  — see its section below; it must be applied before this branch merges**) — `0001`–`0015` were applied
  by hand 2026-07-20 (verified via read-only schema probes), `0016`–`0019` have since been
  applied by hand as each shipped, most recently `0019` on 2026-07-25, and `0020`–`0023` (below)
  were applied by hand on 2026-07-26 (verified via read-only `sqlite_master` probes matching
  `sql/schema.sql` column-for-column). Note `0011_contact_and_notes.sql` errors with "duplicate
  column" on this DB — its columns were applied out of band before the renumbering — and that
  error is safe: D1 rolls the whole file back, and the end state is already present.

**Order: migrate first, then deploy.** The worker unconditionally `SELECT`s columns/tables
added by every migration through `0019` — e.g. `AcceptedPetTypes`, `MaxConcurrentPets`,
`MaxPerDay`, and `Label` (added by `0014`/`0015`), and `PetOwners`/`EndUserPets.DeceasedAt`
(added by `0019`, see below) — and **500s on every request** if any of those are missing.
`0007`–`0023` are now fully applied to remote (`0020`–`0023` as of 2026-07-26, see those sections
below); `0024` is not — apply it before merging its branch, and **before `0025`** (its section
explains why that order is not optional). A local DB still needs `0020`–`0024` unless it was built
from scratch — a `seed:local` over an EXISTING local DB does not repair it, see the Local dev DB
bullet above. Apply each migration before (or
with) the deploy that needs it, never after. Backward-compatible additive migrations (like
`0012`–`0018`, and `0020`–`0023`) are safe to apply ahead of a deploy, since the currently-running
worker just ignores the new columns/tables until the new code ships. `0024` is also safe ahead of a
deploy for the opposite reason — it only _widens_ a CHECK and renames a unit the old worker merely
prints — but it is **not** safe to run twice, and deploying `0024`'s code without the migration 500s
new-sitter onboarding. Both are covered in its section.

`0007`–`0015` were applied, in order, with:

```
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0007_booking_lifecycle.sql
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0008_payments.sql
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0009_service_slots.sql
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0010_slot_index.sql
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0011_contact_and_notes.sql
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0012_weekday_only.sql
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0013_invite_signup_owner_console.sql
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0014_custom_pet_types.sql
npx wrangler d1 execute pawbook-db --remote --file=./migrations/0015_service_level_attributes.sql
```

`0016`–`0018` were applied the same way, one `wrangler d1 execute --file` per migration, in
order; see the `### 0019_pet_co_ownership.sql` section below for how `0019` was applied.

### ⚠️ `0002_tenant_config_limits.sql` is DATA-DESTRUCTIVE if ever re-run against a live DB

It rebuilds the `Tenants` table, copying forward only 6 columns (`Id`, `Slug`, `DisplayName`,
`AccentColor`, `MaxBoardingPets`, `CreatedAt`). Re-running it against a DB that already has real
data in `MaxHouseSitsPerDay`, `MaxStayNights`, or `Timezone` **wipes those columns back to
NULL** for every tenant. Never re-run an already-applied migration against a live DB — write a
new one instead.

### 0019_pet_co_ownership.sql

Adds `PetOwners` (owner↔pet edge list, PK `(PetId, EndUserId)`, with its own `TenantId`),
`EndUserPets.DeceasedAt`, and a backfill of exactly one `PetOwners` row per existing pet. Additive
and non-destructive, but **not idempotent** — the backfill `INSERT` would fail on the PK a second
time. Mirrored into `sql/schema.sql` and `sql/seed.sql`, so fresh installs and the Vitest harness
get it without running this file.

**Apply 0019 to the remote DB BEFORE merging the PR** — merging to `main` runs `npx wrangler
deploy` unconditionally (`.github/workflows/ci.yml`), so the deploy is not something you get to
time separately: the merge _is_ the deploy. The new worker `SELECT`s `PetOwners` and
`EndUserPets.DeceasedAt` unconditionally on the widget's `/me` and on the admin customer list, and
500s on every one of those requests if the table/column is missing. Applying ahead of the merge is
safe: the currently-deployed worker never reads either, so the new table/column just sits there.

```
npx wrangler d1 execute pawbook-db --local  --file ./migrations/0019_pet_co_ownership.sql
npx wrangler d1 execute pawbook-db --remote --file ./migrations/0019_pet_co_ownership.sql
```

#### Verify the backfill, and repair the gap the window leaves

Between applying 0019 and the new worker actually going live, the OLD worker keeps writing
`EndUserPets` rows with **no** `PetOwners` edge — and every new read is an `INNER JOIN` on
`PetOwners`, so such a pet is permanently invisible to its owner and to the sitter, silently and
with no error. Same hazard after any rollback to the old worker.

```sql
-- Verify the backfill (these two must be equal):
SELECT (SELECT COUNT(*) FROM EndUserPets) AS pets, (SELECT COUNT(*) FROM PetOwners) AS edges;

-- Idempotent repair — safe to re-run; fixes pets created by the old worker:
INSERT OR IGNORE INTO PetOwners (TenantId, PetId, EndUserId) SELECT TenantId, Id, EndUserId FROM EndUserPets;
```

Reading the numbers: `edges` **short** of `pets` means some pets have no owner edge and are
therefore invisible — always fix it, never merge on it. It is _expected_ while the old worker is
still live (that is the window described above), so a shortfall before the merge is not a sign
anything went wrong; it just has to be repaired. `edges` **exceeding** `pets` is normal once
co-owners exist, and is never a problem.

When to run each:

- **Verify** right after applying 0019, and again immediately before merging the PR. If `edges` is
  short of `pets`, **run the repair below, re-verify until the two are equal, then merge.**
- **Repair** whenever verify shows a shortfall: before the merge (per above), once the deploy is
  confirmed live — run it then even if the pre-merge check was clean, since the window stays open
  until the new worker is actually serving — and again after **any** rollback to a worker that
  predates 0019. It is `INSERT OR IGNORE`, so re-running it costs nothing and can only add the
  missing creating-owner edges — unlike 0019's own bare `INSERT ... SELECT` backfill, which fails on
  the primary key the second time.

Run both with `--command` rather than `--file`:

```
npx wrangler d1 execute pawbook-db --remote --command "SELECT (SELECT COUNT(*) FROM EndUserPets) AS pets, (SELECT COUNT(*) FROM PetOwners) AS edges;"
npx wrangler d1 execute pawbook-db --remote --command "INSERT OR IGNORE INTO PetOwners (TenantId, PetId, EndUserId) SELECT TenantId, Id, EndUserId FROM EndUserPets;"
```

### 0020_pet_group_pricing.sql and 0021_pet_mix_rates.sql — applied to remote 2026-07-26

Add two new, unrelated tables for explicit pet-set pricing (part of the pet-mix-rates feature):
`PetGroupPricing` (0020, rates for a specific set of pet ids, keyed per service) and
`TenantServicePetRates` (0021, rates for a species count like "2 dogs", keyed per option). Both are
purely additive — new tables only, no column changes to existing tables — and **nothing in the
running worker reads either table yet**, so applying them ahead of a deploy is safe with no
window-of-inconsistency concerns like 0019's backfill had. Mirrored into `sql/schema.sql`, so
fresh installs and the Vitest harness get them without running these files.

Both were applied to the remote DB on 2026-07-26, ahead of merging this PR — merging to `main`
runs `npx wrangler deploy` unconditionally, so timing the migration separately from the deploy
isn't an option once the merge happens. Verified afterwards via a read-only `sqlite_master`
query: both tables match `sql/schema.sql` column-for-column.

```
npx wrangler d1 execute pawbook-db --local  --file ./migrations/0020_pet_group_pricing.sql
npx wrangler d1 execute pawbook-db --remote --file ./migrations/0020_pet_group_pricing.sql
npx wrangler d1 execute pawbook-db --local  --file ./migrations/0021_pet_mix_rates.sql
npx wrangler d1 execute pawbook-db --remote --file ./migrations/0021_pet_mix_rates.sql
```

**Gotcha hit while applying, worth recording because it will recur:** the first `--remote --file`
attempt for `0020` failed with `Authentication error [code: 10000]` on the `/import` endpoint. The
immediately following `--file` call for `0021` succeeded, and re-running `0020` afterwards then
also succeeded — so the failure was transient, not a missing scope or a real auth problem. **A
retry is the first thing to try** if this recurs. Separately: because `0020` is a single `CREATE
TABLE` statement with no second statement after it, it could also have been applied with
`--remote --command` instead of `--file`, with no partial-apply risk — unlike `0019`, where
`--command` would have been dangerous because its backfill is a second statement (a failure
partway through would leave the table created but the backfill not run).

### 0022_booking_source.sql — applied to remote 2026-07-26 (verified: column present)

Adds `BookingRequests.Source` (TEXT, attribution channel like 'mcp', 'voice', etc.; NULL = embed
widget). Purely additive — a single `ALTER TABLE` to add one optional column — and **nothing in
the running worker reads it yet**, so applying ahead of a deploy is safe. Mirrored into
`sql/schema.sql`, so fresh installs and the Vitest harness get it without running this file.

**NOT IDEMPOTENT** — plain ALTER TABLE fails if re-run against an existing database (the column
already exists). Apply exactly once per database.

```
npx wrangler d1 execute pawbook-db --local  --command "ALTER TABLE BookingRequests ADD COLUMN Source TEXT;"
npx wrangler d1 execute pawbook-db --remote --command "ALTER TABLE BookingRequests ADD COLUMN Source TEXT;"
```

### 0023_booking_idempotency.sql — applied to remote 2026-07-26 (verified: column + index present)

Adds `BookingRequests.IdempotencyKey` (TEXT, client-supplied replay-protection key for the
`Idempotency-Key` header on `POST /api/:slug/bookings`; NULL = no key supplied) plus a unique
index scoped `(TenantId, EndUserId, IdempotencyKey)` — deliberately scoped per customer, not
tenant-wide, so one customer's key can never collide with or leak another's booking, and
`WHERE IdempotencyKey IS NOT NULL` so unkeyed bookings (the common case) never collide with each
other. Purely additive — the running worker doesn't read the column until this PR's code ships —
so applying ahead of a deploy is safe. Mirrored into `sql/schema.sql`, so fresh installs and the
Vitest harness get it without running this file.

**NOT IDEMPOTENT** — plain `ALTER TABLE` fails if re-run against an existing database (the column
already exists). Apply exactly once per database, as two separate statements (`ALTER TABLE` then
`CREATE UNIQUE INDEX`) so a transient failure on the second statement doesn't require re-running
the first:

```
npx wrangler d1 execute pawbook-db --local  --command "ALTER TABLE BookingRequests ADD COLUMN IdempotencyKey TEXT;"
npx wrangler d1 execute pawbook-db --local  --command "CREATE UNIQUE INDEX IF NOT EXISTS idx_BookingRequests_IdempotencyKey ON BookingRequests (TenantId, EndUserId, IdempotencyKey) WHERE IdempotencyKey IS NOT NULL;"
npx wrangler d1 execute pawbook-db --remote --command "ALTER TABLE BookingRequests ADD COLUMN IdempotencyKey TEXT;"
npx wrangler d1 execute pawbook-db --remote --command "CREATE UNIQUE INDEX IF NOT EXISTS idx_BookingRequests_IdempotencyKey ON BookingRequests (TenantId, EndUserId, IdempotencyKey) WHERE IdempotencyKey IS NOT NULL;"
```

### 0024_walk_rate_unit.sql — applied to remote 2026-07-27

Adds `'walk'` to the `RateUnit` CHECK on **both** `TenantServices` and `TenantServiceOptions`, then
moves existing walk services onto it. Walks are priced per **walk**, not per visit; check-ins keep
`'visit'`. The billing noun is printed straight from `TenantServices.RateUnit`, so a new noun has to
be a real allowed value rather than a display-time substitution.

SQLite cannot `ALTER` a CHECK constraint, so this **rebuilds both tables** (precedent:
`0006_custom_services.sql`) — `CREATE … _new`, copy every column, `DROP`, `RENAME`. Neither table
has any explicit index (their `UNIQUE` constraints travel with the table definition), so nothing
needs recreating; FKs are handled with `PRAGMA defer_foreign_keys` exactly as `0006` does, since D1
runs the file in a transaction where `PRAGMA foreign_keys` is a no-op.

#### ⚠️ RUN ONCE ONLY — never re-run `0024` after `0025` has been applied

`0024` rebuilds `TenantServices` from an **explicit column list frozen at the `0023` shape**.
`0025_service_description.sql` adds `TenantServices.Description`, which is not in that list — so
re-running `0024` on a database that already has `0025` **silently drops `Description` and all its
data, and reports success.** There is no error to notice.

That is not a cosmetic loss: `repo.listServices()` `SELECT`s `Description` unconditionally and is
called from 13 non-test sites including both the create and the list path in
`server/routes/bookings.ts`, so a missing column is a **total per-tenant outage** — no bookings can
be made or read until it is restored.

`server/__tests__/migration-0024.test.ts` asserts `0024` is re-runnable, but it does so against the
pre-`0025` schema (its `OLD_DDL` has no `Description`, correctly for its own era). It therefore
**cannot** catch this, and is not permission to re-run the file.

#### Apply order: `0024` **before** `0025` — steps 1–3 are done

`0024` must precede `0025`, because `0024`'s rebuild would eat `Description` if that column already
existed. The sequence, and where it stands:

1. **Done** (2026-07-27) — applied `0024` to remote: 12 queries, both CHECKs widened, 5 walk
   services and 9 walk options moved to `'walk'`, both check-ins correctly left on `'visit'`, no
   false positives, 15 services / 18 options / 4 bookings / 3 tenants all preserved.
2. **Done** — merged the walk-rate-unit PR (**merging to `main` IS the deploy** — see below).
3. **Done** — rebased the `0025` PR on the new `main`.
4. **Remaining** — apply `0025` to remote.
5. **Remaining** — merge the `0025` PR.

`0024` was applied against a DB at `0023` that was not yet at `0025` — the column lists in the file
are `sql/schema.sql`'s exact post-`0023` shape, which is precisely why it must never run again.

#### `0024` must be on remote BEFORE the merge, or new-sitter onboarding 500s

Merging to `main` runs `npx wrangler deploy` unconditionally, so the merge _is_ the deploy and the
migration cannot be timed separately afterwards. The new worker creates services with
`rateUnit: tpl.rateUnit` (`server/routes/admin.ts` → `repo.createService`), and the walk template is
now `'walk'` — which **violates the pre-`0024` CHECK**. The `catch` around that insert only
recognises `UNIQUE constraint failed`, so a CHECK violation rethrows as a **500** on every attempt
to add a walk service. Applying `0024` first is safe in the other direction: the currently-running
worker only ever prints whatever string the column holds, and the CHECK is merely widened.

The data step matches walk services by name (`RateUnit='visit' AND (ServiceType LIKE '%walk%' OR
Label LIKE '%walk%')`) because no column records which template a row came from. Marked with a
`-- ponytail:` comment in the file, wrong in both directions and accepted in both: a check-in
service named "Walk & feed" is swept in and prints `/walk`, and a real walk named "Morning stroll"
keeps `/visit` forever (so one tenant can show `$22/visit` beside `$22/walk` on rows that behave
identically). It changes a noun, never a price, a quantity, a capacity, or a booking.

```
npx wrangler d1 execute pawbook-db --local  --file ./migrations/0024_walk_rate_unit.sql
npx wrangler d1 execute pawbook-db --remote --file ./migrations/0024_walk_rate_unit.sql
```

Verify afterwards (both CHECKs widened, walk rows moved):

```
npx wrangler d1 execute pawbook-db --remote --command "SELECT ServiceType, Label, RateUnit FROM TenantServices ORDER BY TenantId, SortOrder;"
```

#### `npm run seed:local` fails on a local DB that predates `0024`

`sql/schema.sql` is `CREATE TABLE IF NOT EXISTS`, so re-seeding an existing local DB **keeps the old
narrow-CHECK tables** — and then `sql/seed.sql`'s `RateUnit='walk'` rows fail with `CHECK constraint
failed: TenantServices`. Either apply `0024` to the local DB first (the `--local` command above), or
throw the local DB away and let `seed:local` build it from scratch:

```
rm -rf .wrangler/state/v3/d1 && npm run seed:local
```

### 0025_service_description.sql — ⚠️ NOT YET APPLIED to remote; apply BEFORE merging

Adds `TenantServices.Description` (TEXT, the optional short blurb a sitter writes for one of their
services, shown to pet owners in the embed widget's service picker; NULL = no blurb). Purely
additive — a single `ALTER TABLE` adding one optional column, no CHECK constraint (the 200-char
cap is a product decision enforced in `server/routes/admin.ts`, so changing it must never require
a table rebuild). Mirrored into `sql/schema.sql` and `sql/seed.sql`, so fresh installs and the
Vitest harness get it without running this file.

**Apply to the remote DB BEFORE merging the PR.** Unlike `0022`/`0023`, this column is **not**
unread by the shipping worker: `listServices` in `server/db/repo.ts` `SELECT`s `Description`
unconditionally, and that query is on the widget's `/config` path and the admin settings page — so
a missing column **500s both** the moment the new worker goes live. Merging to `main` runs `npx
wrangler deploy` unconditionally, so the merge _is_ the deploy and there is no window to apply it
afterwards. Applying ahead of the merge is safe: the currently-deployed worker never reads the
column, so it just sits there.

**NOT IDEMPOTENT** — plain `ALTER TABLE` fails if re-run against an existing database (the column
already exists). Apply exactly once per database. It is a single statement, so `--command` carries
no partial-apply risk:

```
npx wrangler d1 execute pawbook-db --local  --command "ALTER TABLE TenantServices ADD COLUMN Description TEXT;"
npx wrangler d1 execute pawbook-db --remote --command "ALTER TABLE TenantServices ADD COLUMN Description TEXT;"
```
