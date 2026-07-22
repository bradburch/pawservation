---
name: running-pawbook
description: Launch and drive Pawbook locally (wrangler dev on :8787) without sending real email — seed D1, safe env overrides, demo logins for the embed widget and admin dashboard. Use when asked to run, demo, screenshot, or manually verify the app.
---

# Running Pawbook locally

Cloudflare Worker (Hono) + D1 + three Vite bundles (embed widget, admin dashboard, demo host). Verified cold-start from a fresh worktree on 2026-07-07.

## Launch

```bash
npm install                 # if node_modules is missing/stale
npm run seed:local          # applies sql/schema.sql + sql/seed.sql to local D1 (fresh state)
npm run build               # build the Vite bundles into dist/
npx wrangler dev --var ENVIRONMENT:development --var RESEND_API_KEY: --var RESEND_FROM_NOREPLY: --var RESEND_FROM_BOOKING:
```

Server: **http://localhost:8787** (landing → /admin, /demo; widget at /embed/:slug).

**Why the `--var` overrides (do not skip):** `.dev.vars` contains a REAL `RESEND_API_KEY`, so with it active the widget's identify flow sends actual email — and the seeded addresses (`@example.com`, `.test`) are undeliverable, which 502s the login step. Blanking `RESEND_API_KEY`/`RESEND_FROM_NOREPLY`/`RESEND_FROM_BOOKING` makes `isEmailConfigured()` false (it requires all three), and `ENVIRONMENT=development` then shows the 6-digit login code ON SCREEN (see `server/routes/auth.ts`). Never edit or overwrite `.dev.vars` itself — `TOKEN_SECRET` must keep coming from it or every API route 503s.

`npm run dev` also works (build --watch + wrangler dev) but reads `.dev.vars` as-is → real email mode. Prefer the explicit `wrangler dev --var` line above for demos.

## Drive it

**Embed widget** — `http://localhost:8787/embed/sunny-paws`:

- Sign in as `jess@example.com` → the code appears on-screen in dev mode. (If email is live instead, read the code from D1: `npx wrangler d1 execute pawbook-db --local --command "SELECT Code FROM LoginCodes ORDER BY rowid DESC LIMIT 1"`.)
- Walks has a windowed option ("Morning Walk · 11:00–14:00") — good for exercising slot capacity; a full day renders struck-through in the month grid.
- Book: pick service → duration/option → date → pet (Bella/Mochi) → Check availability → Send request (creates a `pending` booking).

**Admin dashboard** — `http://localhost:8787/admin`:

- Login `admin@sunnypaws.example` / `demo1234` (committed demo seed; second tenant: `dana@happytails.test` / `demo1234`, slug `happy-tails`).
- Bookings section (first in nav): pending rows get Confirm/Decline, confirmed rows get Cancel. Cancelling frees the day in the widget's month grid.

**Demo host page** — `http://localhost:8787/demo` shows two tenants' widgets embedded via `public/embed.js`.

## Gotchas

- Local D1/KV state lives under `.wrangler/` per checkout — a fresh worktree has none until `seed:local` runs.
- Re-running `seed:local` resets all data (INSERT OR REPLACE seed; schema is IF NOT EXISTS).
- Do NOT use `npm run migrate:*` against existing DBs without the baselining procedure in `migrations/README.md` (migration 0002 is destructive on re-run).
- Widget auth tokens are per-slug in sessionStorage; admin token in localStorage — a stale admin session survives reloads via `GET /api/admin/session`.
