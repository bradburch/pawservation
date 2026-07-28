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

## Current migration files

- **`0003_gcal_sync.sql`** (feat/gcal-source-of-truth) — adds `BookingRequests.SyncPending`,
  `BookingRequests.ExternalSummary`, and the `idx_BookingRequests_External` unique index. Additive
  and old-worker-safe: safe to pre-apply to prod **before** merging the branch (apply each
  statement via `wrangler d1 execute pawbook-db --remote --command "…"` — not `--file`, per the
  remote-migrations gotcha — see `docs/superpowers/plans/2026-07-27-gcal-ops.md` for the exact
  commands). `0001` and `0002` are reserved by the unmerged venmo/holiday branches respectively;
  this branch's DDL is appended to `0003` rather than split into new files.

Pre-2026-07-27 migration numbers cited in code comments (e.g. "0015", "0019") refer to the deleted historical series in git history, not to files under the new numbering.
