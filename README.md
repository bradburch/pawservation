# Pawservation

[![CI](https://github.com/bradburch/pawservation/actions/workflows/ci.yml/badge.svg)](https://github.com/bradburch/pawservation/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

A **multi-tenant, embeddable booking widget for pet-sitting businesses**. A sitter drops
one `<script>` tag into their website (Squarespace, Wix, plain HTML) and gets a live
booking calendar; behind it sits a full admin dashboard for running the business. One
Cloudflare Worker (Hono) serves the JSON API plus four separately-built React bundles,
backed by D1 (SQLite) and KV. Sitter accounts are **invite-only**, managed from a
platform-owner console.

See [docs/index.md](./docs/index.md) for a project overview, or `CALENDAR_LOGIC.md` for
the availability/conflict math.

## Features

- **One-tag embed** — `public/embed.js` injects an auto-resizing iframe; every
  `postMessage` is validated by origin and source, and a `pawservation:booked` DOM event
  fires on the host page (`pawbook:booked` still fires as a compatibility alias for
  pre-rebrand integrations). A plain-iframe variant exists for script-stripping hosts.
  Don't subscribe to both events on the same host page — one booking fires both, so pick one.
- **Multi-tenant** — every request is scoped to a tenant resolved from the URL slug, with
  isolated services, pricing, pets, customers, and bookings.
- **Custom services** — each tenant defines its own service list (from templates or from
  scratch) with per-option label/duration/price, time windows, weekday-only scheduling,
  slot capacity, and custom intake questions.
- **Per-service capacity & rules** — boarding caps, house-sits-per-day, max stay nights,
  and accepted animal types are all service-level attributes; blank means unlimited.
- **Custom animal types** — tenants aren't limited to dogs and cats; add any species and
  accept it per service.
- **Admin dashboard** — lands on a monthly **Calendar** view of bookings and time off;
  plus bookings (confirm/decline/cancel), earnings and payment tracking, client list with
  CSV import, services & rates card grid, time off, embed codes, and in-app help.
- **Google Calendar sync** — per-tenant OAuth connect; bookings create calendar events,
  cancelling/declining deletes them, and events deleted in Google reconcile the booking
  back to cancelled.
- **Onboarding wizard** — first login walks a new sitter through business profile,
  services, and pricing presets; skippable and re-runnable, always additive.
- **Invite-only signup + owner console** — the platform owner (identified by the
  `OWNER_EMAILS` secret) allowlists sitter emails; sitters self-serve from the login page
  via an emailed single-use setup link. No open signup.
- **Two auth flows** — passwordless email-code sessions for customers; password + JWT for
  sitter admins (PBKDF2, with timing-safe user-enumeration defenses).
- **Zero-dependency core** — booking, capacity, pricing, and date logic in `src/shared/`
  is pure TypeScript shared by server (enforcement) and client (UX).

## Quick start (local)

Prereqs: **Node 24** (`nvm use` reads `.nvmrc` — the test harness needs the built-in
`node:sqlite`) and a wrangler login is _not_ required for local dev.

```bash
npm install
npm run seed:local   # applies sql/schema.sql + sql/seed.sql to the local D1 (resets local data)
npm run build        # build the four Vite bundles into dist/
npx wrangler dev --var ENVIRONMENT:development --var RESEND_API_KEY: --var RESEND_FROM:
```

> **Why not plain `npm run dev`?** `npm run dev` reads `.dev.vars` as-is. If your
> `.dev.vars` holds a real `RESEND_API_KEY`, the customer login flow sends **actual
> email** — and the seeded demo addresses (`@example.com`, `.test`) are undeliverable,
> which breaks login with a 502. The `--var` overrides above blank the email provider so
> login codes (and signup links) render **on screen** instead. `npm run dev` is still
> useful for its `vite build --watch`, just know it runs in real-email mode.
>
> Never delete or overwrite `.dev.vars` — `TOKEN_SECRET` must come from it, or every
> request 503s (deliberate boot gate). On a fresh clone with no `.dev.vars`, create one:
>
> ```bash
> printf 'TOKEN_SECRET=%s\nENVIRONMENT=development\n' "$(openssl rand -base64 32)" > .dev.vars
> ```

Then open **http://localhost:8787**:

| URL                 | What                                                        |
| ------------------- | ----------------------------------------------------------- |
| `/`                 | Marketing landing page                                      |
| `/demo`             | Demo host page — two tenants' widgets embedded side by side |
| `/embed/sunny-paws` | The booking widget for the seeded "Sunny Paws" tenant       |
| `/admin`            | Sitter admin dashboard (also the invite-signup entry point) |
| `/setup`            | Create-password page reached from emailed signup links      |

Seeded demo logins:

- **Admin dashboard:** `admin@sunnypaws.example` / `demo1234` (slug `sunny-paws`), or
  `dana@happytails.test` / `demo1234` (slug `happy-tails`).
- **Widget customer:** sign in as `jess@example.com` — in dev mode the 6-digit code
  appears on screen. Pets Bella/Mochi are pre-registered.

## Everyday commands

| Command                                                | What it does                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `npm run dev`                                          | Build + watch widgets, run `wrangler dev` (reads `.dev.vars` → real email; see above) |
| `npm run seed:local`                                   | Reset the local D1 from `sql/schema.sql` + `sql/seed.sql`                             |
| `npm test`                                             | Vitest against a real in-memory SQLite (`server/**/*.test.ts`)                        |
| `npx vitest run server/__tests__/availability.test.ts` | Run one test file                                                                     |
| `npx vitest run -t "conflict"`                         | Filter tests by name                                                                  |
| `npm run test:watch`                                   | Vitest watch mode                                                                     |
| `npm run typecheck`                                    | Regenerates `worker-configuration.d.ts` (`wrangler types`), then `tsc -b`             |
| `npm run lint`                                         | ESLint                                                                                |
| `npm run format`                                       | Prettier check (CI fails on drift; `npm run format:fix` repairs)                      |
| `npm run build`                                        | Vite build → `dist/` (embed, admin, demo, setup bundles)                              |
| `npm run deploy`                                       | Build + `wrangler deploy` — ships **worker code only**, never the DB                  |

CI (`.github/workflows/ci.yml`) gates every PR on typecheck → lint → format → test →
build, and **auto-deploys to Cloudflare on merge to `main`**.

## Project layout

```
server/       Hono Worker — routes, tenant middleware, auth/tokens, availability, db/repo.ts
app/          Four React apps: embed/ (widget), admin/ (dashboard + owner console),
              setup/ (signup-link page), shared-ui/ (API client, icons, hooks)
src/shared/   Pure booking/capacity/pricing/date logic — zero runtime dependencies
sql/          schema.sql (canonical DDL) + seed.sql (demo tenants)
migrations/   Incremental DB changes for already-provisioned databases
public/       embed.js loader, demo host script, landing images, CSV import example
```

Two invariants worth knowing before you touch code:

- **Tenancy:** `server/db/repo.ts` is the only module allowed to touch the `PAWBOOK_DB`
  binding; every function takes `tenantId` first and scopes SQL with `WHERE TenantId = ?`.
  `tenantMiddleware` is registered exactly once in `server/index.ts`.
- **The booking engine is pure:** `src/shared/` must stay dependency-free; nullable tenant
  config limits mean unlimited/instance-default.

## Database & migrations

`npm run deploy` ships worker code **only** — it never touches the database. The two
lifecycles:

- **Fresh install:** provision from `sql/schema.sql` (+ optional demo `sql/seed.sql`) via
  `npm run seed:local` / `seed:remote`. The schema already includes everything through
  `migrations/0015_service_level_attributes.sql`; do not replay migration files on top.
- **Already-provisioned DB:** apply new files in `migrations/` **by hand**, in order,
  before (or with) the deploy that needs them — otherwise the new code 500s on missing
  columns:

  ```bash
  npx wrangler d1 execute pawbook-db --remote --file=./migrations/0007_booking_lifecycle.sql
  # ...one command per file, in numeric order (use --local for the dev DB)
  ```

**Current remote state:** the production DB has `0001`–`0006` applied and needs
`0007`–`0015` run, in order, at the next deploy (see `migrations/README.md` for the exact
list and state).

Do **not** use `npm run migrate:local` / `migrate:remote` (`wrangler d1 migrations apply`)
against existing DBs — no real DB here has a `d1_migrations` tracking table, and
re-running `0002` against live data is destructive. When you change the schema, add a
`migrations/` file **and** update `sql/schema.sql` to match (tests run against
`schema.sql`).

## Deploying

One-time provisioning:

```bash
npx wrangler d1 create pawbook-db                  # put database_id into wrangler.jsonc
npx wrangler kv namespace create PAWBOOK_CACHE     # put id into wrangler.jsonc
npx wrangler secret put TOKEN_SECRET               # strong random value (openssl rand -base64 32)
npx wrangler secret put OWNER_EMAILS               # comma-separated platform-owner email(s)
npx wrangler secret put RESEND_API_KEY             # from https://resend.com — required for login codes & signup links
npx wrangler secret put RESEND_FROM                # e.g. "Pawservation <bookings@pawservation.com>" (verified sender)
# Optional — Google Calendar sync:
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_OAUTH_REDIRECT_URI  # e.g. https://<your-worker>/oauth/google/callback — must match Google Cloud exactly
```

Then:

```bash
npm run deploy       # build + wrangler deploy (worker code only)
npx wrangler d1 execute pawbook-db --remote --file=./sql/schema.sql   # fresh DB only
```

Production **fails closed** without email: customer login and sitter signup return 503
rather than ever leaking a code or link, so `RESEND_API_KEY`/`RESEND_FROM` are effectively
required in production. Merges to `main` auto-deploy via CI.

## Provisioning the first sitter

Signup is invite-only and sitter-initiated:

1. **Bootstrap yourself as owner:** put your email in the `OWNER_EMAILS` secret, open
   `/admin`, and use the "Get set up" form with that email. You'll receive a single-use
   setup link (`/setup?t=…`) to choose a password — that logs you into the **owner
   console**.
2. **Allowlist the sitter:** in the owner console, add the sitter's email to the
   allowlist.
3. **Sitter claims the account:** the sitter opens `/admin`, enters their email in the
   same "Get set up" form, follows their emailed link, and sets a business name +
   password. The tenant (slug derived from the business name) is provisioned atomically.
4. **Onboarding wizard:** on first login the wizard walks them through profile, services,
   and pricing — after which their widget at `/embed/<slug>` is live.

In local dev (email blanked), the setup link is shown on screen instead of emailed.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](./SECURITY.md).
Non-trivial features start as a written design spec in `docs/superpowers/specs/` before
code.

## License

[MIT](./LICENSE) © 2026 Brad Burch
