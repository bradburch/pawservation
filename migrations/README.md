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

- **Fresh installs:** `npm run seed:local` / `seed:remote` (schema.sql then seed.sql). Never
  `wrangler d1 migrations apply`.
- **New schema changes:** add a file here starting at **`0001_*.sql`** (numbering restarts from
  the new baseline) AND mirror the change into `sql/schema.sql` in the same branch — the test
  suite only sees what schema.sql has. Apply to the remote DB by hand (`npx wrangler d1 execute
pawbook-db --remote --file ./migrations/NNNN_*.sql`, or `--command "…"` for a single statement)
  **before merging** — merging to `main` auto-deploys, so the merge IS the deploy.
- **Local DB drift:** `schema.sql` is `CREATE … IF NOT EXISTS`, so re-seeding never rebuilds an
  existing table. If your local DB predates a schema change:
  `rm -rf .wrangler/state/v3/d1 && npm run seed:local`.

`0001_venmo_import.sql` is the first migration since the baseline (`EndUsers.VenmoUsername` +
`Payments.ExternalRef` — the Venmo CSV import's idempotency mechanism, from `feat/venmo-import`
#86). It has already been MERGED to `main` and applied to the remote DB.

`0002_holiday_and_charges.sql` adds `TenantServices.HolidayRate` (nullable) and the
`BookingCharges` table + index (this branch, `feat/holiday-and-extras`). It is additive only (one
`ALTER TABLE … ADD COLUMN`, one `CREATE TABLE`), so applying it to the remote DB is a no-op for the
currently-running worker and can safely happen before this branch merges to `main` (merging
auto-deploys, so the merge IS the deploy).

`0003_*.sql` is reserved for the open Google Calendar work (`#88`) — not yet written. Numbering is
sequential by merge order from here: each new branch picks up the next unused number as of when it
branches, and a gap or an out-of-order arrival is fine (additive changes don't collide) as long as
every migration that lands on `main` is also applied to the remote DB by hand before that merge.

Pre-2026-07-27 migration numbers cited in code comments (e.g. "0015", "0019") refer to the deleted historical series in git history, not to files under the new numbering.
