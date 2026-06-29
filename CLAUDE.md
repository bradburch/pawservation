# CLAUDE.md — Pawbook

Open-source, embeddable, multi-tenant booking widget on Cloudflare Workers (Hono + React, D1 + KV). Pure booking/date/pricing logic lives in `src/shared/` (zero runtime deps); the Worker is in `server/`; the embed widget + admin dashboard are in `app/`.

## Verification gate (run before claiming done, committing, or pushing)

CI runs a single job — **Typecheck · Lint · Format · Test · Build** — and **all five must pass**. Run all five locally; they mirror CI exactly:

```bash
npm run typecheck   # wrangler types + tsc -b
npm run lint        # eslint .
npm run format      # prettier --check .   ← easy to forget; SEPARATE from lint
npm test            # vitest run
npm run build       # vite build
```

- **`npm run format` is a hard CI gate and is independent of `npm run lint`** (ESLint and Prettier are separate — lint can pass while format fails). New/changed files frequently fail it. If it reports issues, fix with `npm run format:fix` (prettier --write), then re-run the gate.
- A task is not "green" until **all five** pass. Don't report success on a subset.
- When delegating implementation to subagents, include this full five-command gate in their instructions.

## Tests

Vitest backed by in-memory SQLite (`node:sqlite`) via `createTestEnv()` in `server/__tests__/helpers.ts`. Tests run the real `sql/schema.sql` + `sql/seed.sql`. Mock external HTTP (Google, Resend) with `vi.spyOn(globalThis, 'fetch')`. Note: `node:sqlite` enforces foreign keys by default; production D1 has them OFF — write SQL that's correct under both.

## Load-bearing project rules

- **DB isolation:** `server/db/repo.ts` is the ONLY module that touches `PAWBOOK_DB`. Every function takes `tenantId` first and scopes SQL with `WHERE TenantId = ?`. Importing the D1 binding elsewhere is a defect.
- **Migrations lockstep:** schema changes add a numbered file in `migrations/` AND update `sql/schema.sql` in the same change (fresh installs build from `schema.sql`; upgrades replay the migration). SQLite can't `ALTER` a CHECK — widen via the table-rebuild dance (see `migrations/0002`, `0003`).
- **Secrets never reach clients:** OAuth token columns are read only by server-internal repo paths; the client-facing `listProviderConnections`/`providerViews` must never select or return them.
- **Fail closed on email:** never leak a login code or invite; in production return 5xx rather than degrade (see `routes/auth.ts`).

## Design/plan docs

Specs and implementation plans live under `docs/superpowers/`. Check there for the rationale behind recent features before changing them.
