# Migrations

## Baseline doctrine (re-baselined 2026-07-27)

**`sql/schema.sql` IS the baseline.** Every database — local, remote, and the Vitest harness
(`server/__tests__/helpers.ts` executes schema.sql + seed.sql directly) — is expected to match it
exactly. The incremental migrations that built the old schema (`0001`–`0025`) were deleted in the
2026-07-27 re-baseline; their full history lives in git (`git log -- migrations/`). The remote
DB's old `d1_migrations` ledger was stale and was never the applied-state authority — every
migration was applied by hand with `wrangler d1 execute` — and it is dropped in the baseline
reset (see `docs/superpowers/plans/2026-07-27-schema-config-ops.md`).

## Rules

- **Fresh installs:** `npm run seed:local` / `seed:remote` (schema.sql, then seed.sql, then
  seed-demo.sql). Never `wrangler d1 migrations apply`.
- **Two seed files.** `sql/seed.sql` is the minimal base fixture the Vitest harness loads and the
  suite asserts against; `sql/seed-demo.sql` is the lived-in demo layered on top (extra clients, a
  booking per enabled service, deliberate conflicts, dated relative to `now`). `seed-demo.sql` is
  also where the demo tenants' **configuration** is kept current — the booking horizon, pet-rate
  mode, species acceptance, notice periods, capacity, cancellation policies, holiday rates and
  intake questions a sitter who signed up today would have. The base fixture stays deliberately
  under-configured because tests want those rules off; configure the demo tenants in
  `seed-demo.sql`, never in `seed.sql`. Both are
  `INSERT OR REPLACE`, so re-seeding is idempotent — the demo simply rolls its dates forward.
  Tests opt into the demo with `createTestEnv({ demoActivity: true })`. The demo database holds no
  static dates: `seed-demo.sql` re-stamps `seed.sql`'s seven hardcoded bookings (same ids) relative
  to `now`, because a fixed date the sliding window eventually walks over silently changes the
  demo's conflicts. **If you add a statically-dated booking to `seed.sql`, re-stamp it in
  `seed-demo.sql`** — `server/__tests__/seed-demo.test.ts` fails if you don't.
- **New schema changes:** add a file here starting at **`0001_*.sql`** (numbering restarts from
  the new baseline) AND mirror the change into `sql/schema.sql` in the same branch — the test
  suite only sees what schema.sql has. Apply to the remote DB by hand (`npx wrangler d1 execute
pawbook-db --remote --file ./migrations/NNNN_*.sql`, or `--command "…"` for a single statement)
  **before merging** — merging to `main` auto-deploys, so the merge IS the deploy.
- **Local DB drift:** `schema.sql` is `CREATE … IF NOT EXISTS`, so re-seeding never rebuilds an
  existing table. If your local DB predates a schema change:
  `rm -rf .wrangler/state/v3/d1 && npm run seed:local`.

## Current migration files

- **`0001_venmo_import.sql`** (`feat/venmo-import` #86) — adds `EndUsers.VenmoUsername` +
  `Payments.ExternalRef`, the Venmo CSV import's idempotency mechanism. **MERGED** to `main` and
  applied to the remote DB.
- **`0002_holiday_and_charges.sql`** (`feat/holiday-and-extras` #87) — adds
  `TenantServices.HolidayRate` (nullable) and the `BookingCharges` table + index. Additive only
  (one `ALTER TABLE … ADD COLUMN`, one `CREATE TABLE`). **MERGED** to `main` and applied to the
  remote DB.
- **`0003_gcal_sync.sql`** (`feat/gcal-source-of-truth` #88) — adds
  `BookingRequests.SyncPending`, `BookingRequests.ExternalSummary`, and the
  `idx_BookingRequests_External` unique index. **MERGED** to `main` and applied to the remote DB.
- **`0004_booking_window.sql`** (`feat/booking-window`) — adds `TenantServices.MinLeadDays`
  (per-service minimum notice in days) and `Tenants.MaxAdvanceMonths` (profile-level booking
  horizon in months). Both nullable, NULL = unlimited. Additive only (two
  `ALTER TABLE … ADD COLUMN`s). Must be applied to the remote DB **before** the branch merges —
  the new worker's `listServices`/`TENANT_COLS` SELECTs name both columns.

- **`0005_pet_rate_mode.sql`** (`fixes-batch-2-pr1`) — adds `TenantServices.PetRateMode`
  (`'exact' | 'linear'`, `NOT NULL DEFAULT 'exact'`), the sitter-opted-in per-pet multiplier.
  Additive only (one `ALTER TABLE … ADD COLUMN`), and the default backfills every existing row
  with today's refuse-an-unpriced-set behaviour, so applying it moves no price. **APPLIED** to the
  remote DB by hand.
- **`0006_overlap_days.sql`** (`housesit-boarding-overlap`) — adds
  `Tenants.HousesitBoardingOverlapDays` (nullable, `DEFAULT 1`), the tenant-wide house-sit/boarding
  overlap allowance: 0 = never overlap, 1 = the default one handover day, 2 = one at each end of
  a stay, NULL = no limit. Additive only (one `ALTER TABLE … ADD COLUMN`), and SQLite stamps every
  existing row with the DEFAULT 1 — the intent the previously hardcoded rule already had — so no
  backfill statement is needed. **APPLIED** to the remote DB by hand.

- **`0007_saved_answers.sql`** (`widget-edit-and-saved-answers`) — adds the `SavedAnswers` table
  and its lookup index: a customer's last intake answer per `(TenantId, EndUserId, ServiceType,
QuestionId)`, re-offered as the pre-fill on their next booking of that service. Each row also
  stores the question's `Shape` (`questionShape()` = type + normalized label) as of the answer, so
  a reworded or retyped question drops its stale answer instead of pre-filling it. Additive only
  (one `CREATE TABLE`, one `CREATE INDEX`) — no `Tenants` column, so the KV tenant-config cache
  key needs **no** bump. **APPLIED** to the remote DB — not by hand this time: `sql/schema.sql`
  uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, and `npm run seed:remote`
  applies `schema.sql` on every run, so the table and its index were created as a side effect of a
  `seed:remote` run rather than by a deliberate `wrangler d1 execute --file
./migrations/0007_saved_answers.sql`. Harmless for this file specifically (its statements are
  idempotent `IF NOT EXISTS` forms), but do not count on `seed:remote` to apply a migration in
  general — see the warning below.

- **`0008_departure_time.sql`** (`hardening-and-remaining-features`) — adds
  `BookingRequests.DepartureTime` (nullable 'HH:MM'), the owner's estimated departure/pick-up time.
  Additive only (one `ALTER TABLE … ADD COLUMN`); NULL for every existing row, which is exactly
  "no departure time given" — the behaviour of every booking taken before it. Deliberately no
  ordering `CHECK`: on a range stay the departure is a time on the END date and may legally be
  earlier in the day than the arrival, so the rule is single-day-only and lives in
  `server/lib/booking-times.ts`, which knows the service's shape. No `Tenants` column, so the KV
  tenant-config cache key needs **no** bump. **NOT YET APPLIED to the remote DB** — must be
  hand-applied before this branch merges, or the new worker's `BOOKING_COLS` SELECT 500s.

- **`0009_extra_time_surcharge.sql`** (`hardening-and-remaining-features`) — adds
  `TenantServices.StandardArrivalTime` / `StandardDepartureTime` / `EarlyArrivalFee` /
  `LateDepartureFee` (the hours a stay normally starts and ends, plus a FLAT whole-dollar fee for an
  owner-set arrival before / departure after each) and `BookingCharges.Origin` (provenance:
  NULL = the sitter typed the charge, `'extra_time_early'`/`'extra_time_late'` = derived from the
  booking's times). Additive only — five `ALTER TABLE … ADD COLUMN`s, each side needing BOTH its time
  and its fee to charge anything, so NULL everywhere is the feature off and every existing row keeps
  today's behaviour exactly. The fee is deliberately NOT part of `EstCost`: it lands as a
  `BookingCharges` row, so `estimateCost` stays "units of time × a stored rate" and total due stays
  `EstCost + SUM(charges)` — putting it inside `estimateCost` would have let the
  `PetRateMode = 'linear'` multiplier scale a $20 fee to $60 for three dogs. No `Tenants` column, so
  the KV tenant-config cache key needs **no** bump. **NOT YET APPLIED to the remote DB** — must be
  hand-applied before this branch merges, or `listServices`' SELECT and the settings PUT's UPDATE
  500 on missing columns.

**All three of the above (0005, 0006, 0007) are applied to the remote DB as of this writing.**
Do **not** re-run `0005_pet_rate_mode.sql` or `0006_overlap_days.sql` by hand against the remote
DB — each is a bare `ALTER TABLE … ADD COLUMN`, SQLite has no `ADD COLUMN IF NOT EXISTS`, and
re-running either **will error** with "duplicate column name" against a DB that already has it.
This repo has already produced exactly this confusion once from a stale ledger in this file
claiming a migration was unapplied when it was not — check the actual remote schema
(`wrangler d1 execute pawbook-db --remote --command "PRAGMA table_info(Tenants)"` or the
equivalent table) before hand-applying anything numbered 0005–0007, rather than trusting a status
word in this file alone.

Numbering is sequential by merge order: each new branch picks up the next unused number as of when
it branches, and a gap or an out-of-order arrival is fine (additive changes don't collide) as long
as every migration that lands on `main` is also applied to the remote DB by hand before that
merge.

Pre-2026-07-27 migration numbers cited in code comments (e.g. "0015", "0019") refer to the deleted historical series in git history, not to files under the new numbering.
