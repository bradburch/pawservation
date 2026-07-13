# Migrations

## Fresh installs

Fresh databases are provisioned from `sql/schema.sql` + `sql/seed.sql`, **not** from this
directory — `sql/schema.sql` is the canonical DDL and already includes everything through
`0011_contact_and_notes.sql`. Use:

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

- **Local dev DB**: has `0001`–`0008` applied (custom-services numbering — `0006_custom_services.sql`
  through `0008_payments.sql`). Needs `0009_service_slots.sql`, `0010_slot_index.sql`,
  `0011_contact_and_notes.sql` applied next, in that order.
- **Remote DB**: has `0001`–`0005` applied. Needs the full `0006`–`0011` run, in order, at next
  deploy — none of the custom-services, booking-lifecycle, payments, service-slots, slot-index,
  or contact/notes migrations have reached it yet.

Apply with, e.g.:

```
npx wrangler d1 execute pawbook-db --local  --file=./migrations/0009_service_slots.sql
npx wrangler d1 execute pawbook-db --local  --file=./migrations/0010_slot_index.sql
npx wrangler d1 execute pawbook-db --local  --file=./migrations/0011_contact_and_notes.sql
```

### ⚠️ `0002_tenant_config_limits.sql` is DATA-DESTRUCTIVE if ever re-run against a live DB

It rebuilds the `Tenants` table, copying forward only 6 columns (`Id`, `Slug`, `DisplayName`,
`AccentColor`, `MaxBoardingPets`, `CreatedAt`). Re-running it against a DB that already has real
data in `MaxHouseSitsPerDay`, `MaxStayNights`, or `Timezone` **wipes those columns back to
NULL** for every tenant. Never re-run an already-applied migration against a live DB — write a
new one instead.
