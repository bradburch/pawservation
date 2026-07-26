# Migrations

## Fresh installs

Fresh databases are provisioned from `sql/schema.sql` + `sql/seed.sql`, **not** from this
directory — `sql/schema.sql` is the canonical DDL and already includes everything through
`0019_pet_co_ownership.sql` (keep this line in step with the highest-numbered migration mirrored
into `schema.sql`). Use:

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

- **Local dev DB**: wiped and reseeded from `sql/schema.sql` (the Fresh installs path above),
  which already carries everything through `0019_pet_co_ownership.sql` — so the local DB
  needs **no** migrations applied; it isn't on the incremental-apply path below at all.
- **Remote DB**: fully migrated through `0019` — `0001`–`0015` were applied by hand
  2026-07-20 (verified via read-only schema probes), and `0016`–`0019` have since been
  applied by hand as each shipped, most recently `0019` on 2026-07-25. Note
  `0011_contact_and_notes.sql` errors with "duplicate column" on this DB — its columns
  were applied out of band before the renumbering — and that error is safe: D1 rolls the
  whole file back, and the end state is already present.

**Order: migrate first, then deploy.** The worker unconditionally `SELECT`s columns/tables
added by every migration through `0019` — e.g. `AcceptedPetTypes`, `MaxConcurrentPets`,
`MaxPerDay`, and `Label` (added by `0014`/`0015`), and `PetOwners`/`EndUserPets.DeceasedAt`
(added by `0019`, see below) — and **500s on every request** if any of those are missing.
`0007`–`0019` are now fully applied to both local and remote, so there is nothing pending;
the same rule applies to any future migration: apply it before (or with) the deploy that
needs it, never after. Backward-compatible additive migrations (like `0012`–`0018`) are safe
to apply ahead of a deploy, since the currently-running worker just ignores the new columns
until the new code ships.

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
