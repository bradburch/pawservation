# Migrations

## Fresh installs

Fresh databases are provisioned from `sql/schema.sql` + `sql/seed.sql`, **not** from this
directory — `sql/schema.sql` is the canonical DDL and already includes everything through
`0007_slot_index.sql`. Use:

```
npm run seed:local   # wrangler d1 execute pawbook-db --local  --file=./sql/schema.sql && ...seed.sql
npm run seed:remote  # same, against the remote DB
```

Do **not** run `migrate:local` / `migrate:remote` (`wrangler d1 migrations apply`) against a
freshly-seeded DB — the tables already exist (from schema.sql), so replaying these files would
fail or duplicate work.

## Existing/already-provisioned DBs — READ BEFORE RUNNING `migrate:*`

Every DB that was ever provisioned before wrangler's migration tracking was introduced (i.e.
any real DB in use today) had `0001`–`0007` applied manually via `wrangler d1 execute ... --file`.
None of those runs went through `wrangler d1 migrations apply`, so **no `d1_migrations` tracking
table exists on any real DB**, and wrangler doesn't know these seven migrations were already
applied.

If you run `npm run migrate:local` / `migrate:remote` on one of these DBs without baselining
first, wrangler will try to apply `0001_add_login_codes_attempts.sql` from scratch and fail
(the `Attempts` column already exists) — and if that failure is ever worked around, `0002` is
**data-destructive on re-run** (see the warning below). **Never run `migrate:remote` before
baselining.**

### Baselining procedure (run once, per DB, before ever running `migrate:*`)

Create wrangler's tracking table and mark `0001`–`0007` as already applied, without actually
executing their statements again:

```sql
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO d1_migrations (name) VALUES ('0001_add_login_codes_attempts.sql');
INSERT INTO d1_migrations (name) VALUES ('0002_tenant_config_limits.sql');
INSERT INTO d1_migrations (name) VALUES ('0003_calendar_oauth_and_invites.sql');
INSERT INTO d1_migrations (name) VALUES ('0004_customer_pets.sql');
INSERT INTO d1_migrations (name) VALUES ('0005_service_rules.sql');
INSERT INTO d1_migrations (name) VALUES ('0006_service_slots.sql');
INSERT INTO d1_migrations (name) VALUES ('0007_slot_index.sql');
```

Run this against `--local` and/or `--remote` with `wrangler d1 execute pawbook-db <flag> --command "..."`
(or save it to a `.sql` file and use `--file`) for whichever environment you're baselining.
Verify the filenames above against the current contents of this directory before running —
if new migration files have been added since this README was written, extend the list to
match (`ls migrations/`).

Once baselined, `migrate:local` / `migrate:remote` will only apply migrations numbered after
`0007`, which is the intended, safe use of those scripts going forward.

### ⚠️ `0002_tenant_config_limits.sql` is DATA-DESTRUCTIVE if ever re-run against a live DB

It rebuilds the `Tenants` table, copying forward only 6 columns (`Id`, `Slug`, `DisplayName`,
`AccentColor`, `MaxBoardingPets`, `CreatedAt`). Re-running it against a DB that already has real
data in `MaxHouseSitsPerDay`, `MaxStayNights`, or `Timezone` **wipes those columns back to
NULL** for every tenant. This is exactly what baselining (above) prevents — do the baseline
INSERTs, never a real replay of `0002`, against any DB that already has this schema.
