# Migrations

## Fresh installs

Fresh databases are provisioned from `sql/schema.sql` + `sql/seed.sql`, **not** from this
directory — `sql/schema.sql` is the canonical DDL and already includes everything through
`0015_service_level_attributes.sql`. Use:

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

State as of this merge:

- **Local dev DB**: wiped and reseeded from `sql/schema.sql` (the Fresh installs path above),
  which already carries everything through `0015_service_level_attributes.sql` — so the local DB
  needs **no** migrations applied; it isn't on the incremental-apply path below at all.
- **Remote DB**: fully migrated through `0015` (applied by hand 2026-07-20; verified via
  read-only schema probes). Note `0011_contact_and_notes.sql` errors with "duplicate column"
  on this DB — its columns were applied out of band before the renumbering — and that
  error is safe: D1 rolls the whole file back, and the end state is already present.

**Order: migrate first, then deploy.** The new worker unconditionally `SELECT`s
`AcceptedPetTypes`, `MaxConcurrentPets`, `MaxPerDay`, and `Label` (added by `0014`/`0015`) and
**500s on every request** if those columns are missing — so it must not go live until `0007`–
`0015` are applied. This direction is safe: `0012`–`0015` are backward-compatible with the
currently-deployed worker (additive columns it simply ignores), so applying them ahead of the
deploy breaks nothing that is already running.

Apply with, e.g.:

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

### ⚠️ `0002_tenant_config_limits.sql` is DATA-DESTRUCTIVE if ever re-run against a live DB

It rebuilds the `Tenants` table, copying forward only 6 columns (`Id`, `Slug`, `DisplayName`,
`AccentColor`, `MaxBoardingPets`, `CreatedAt`). Re-running it against a DB that already has real
data in `MaxHouseSitsPerDay`, `MaxStayNights`, or `Timezone` **wipes those columns back to
NULL** for every tenant. Never re-run an already-applied migration against a live DB — write a
new one instead.
