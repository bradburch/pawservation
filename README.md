# Pawservation

[![CI](https://github.com/bradburch/pawservation/actions/workflows/ci.yml/badge.svg)](https://github.com/bradburch/pawservation/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

A **multi-tenant, embeddable booking widget for pet-sitting businesses**. A sitter drops
one `<script>` tag into their website (Squarespace, Wix, plain HTML) and gets a live
booking calendar; behind it sits a full admin dashboard for running the business. One
Cloudflare Worker (Hono) serves the JSON API plus four separately-built Vite bundles
(three React apps — embed, admin, setup — plus a static demo host page), backed by D1
(SQLite) and KV. Sitter accounts are **invite-only**, managed from a platform-owner
console.

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
- **Pet co-ownership** — a pet can belong to more than one customer account (e.g.
  co-parents), and a pet can be marked deceased without losing its booking history.
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
  via an emailed single-use setup link. No open signup. The owner console can also disable
  (and later remove) a joined sitter — a disabled tenant's widget goes dark and its admin
  dashboard drops to read-only.
- **Two auth flows** — passwordless email-code sessions for customers; password + JWT for
  sitter admins (PBKDF2, with timing-safe user-enumeration defenses).
- **Billing accounts** — co-owned pets collapse into one household billing account (union-
  find over owner↔pet links), so a shared client sees one balance, not one per owner.
- **Venmo CSV import** — upload a Venmo export to preview matched transactions against
  outstanding bookings, then confirm to record payments; idempotent by transaction id.
- **Holiday pricing & one-off charges** — a service can carry a separate stored rate for
  booked nights that land on a US holiday, and sitters can add one-off extra charges to a
  booking on top of its base estimate.
- **Agent/API-readiness** — an `Idempotency-Key` header on booking creation prevents
  duplicate bookings on retry, error responses carry a stable `code` alongside the message,
  and each tenant exposes a machine-readable `llms.txt` plus JSON-LD on its embed page.
- **Zero-dependency core** — booking, capacity, pricing, and date logic in `src/shared/`
  is pure TypeScript shared by server (enforcement) and client (UX).

## Quick start (local)

Prereqs: **Node 24** (`nvm use` reads `.nvmrc` — the test harness needs the built-in
`node:sqlite`) and a wrangler login is _not_ required for local dev.

```bash
npm install
npm run seed:local   # applies sql/schema.sql + sql/seed.sql to the local D1 (resets local data)
npm run build        # build the four Vite bundles into dist/
npx wrangler dev --var ENVIRONMENT:development --var RESEND_API_KEY: --var RESEND_FROM_NOREPLY: --var RESEND_FROM_BOOKING:
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
app/          Three React apps: embed/ (widget), admin/ (dashboard + owner console),
              setup/ (signup-link page), plus shared-ui/ (API client, icons, hooks)
src/shared/   Pure booking/capacity/pricing/date logic — zero runtime dependencies
sql/          schema.sql (canonical DDL) + seed.sql (demo tenants)
migrations/   New incremental DB changes only — empty by design as of 2026-07-27
public/       embed.js loader, demo host script, landing images, CSV import example
```

Two invariants worth knowing before you touch code:

- **Tenancy:** `server/db/repo.ts` is the only module allowed to touch the `PAWBOOK_DB`
  binding; every function takes `tenantId` first and scopes SQL with `WHERE TenantId = ?`.
  `tenantMiddleware` is registered exactly once in `server/index.ts`.
- **The booking engine is pure:** `src/shared/` must stay dependency-free; nullable tenant
  config limits mean unlimited/instance-default.

## Database & migrations

`npm run deploy` ships worker code **only** — it never touches the database. Baseline
doctrine (re-baselined 2026-07-27 — full detail in `migrations/README.md`, keep the two
consistent):

- **`sql/schema.sql` IS the baseline.** Every database — local, remote, and the Vitest
  harness — is expected to match it exactly. `npm run seed:local` / `seed:remote` apply
  `sql/schema.sql` (+ optional demo `sql/seed.sql`) directly; there is nothing to replay
  on top.
- **`migrations/` is empty by design** as of 2026-07-27. The incremental history that
  built the old schema (`0001`–`0025`) was deleted in the re-baseline; it lives in git
  (`git log -- migrations/`), not on disk.
- **New schema changes:** add a file to `migrations/` starting at **`0001_*.sql`**
  (numbering restarts from the new baseline) **and** mirror the change into
  `sql/schema.sql` in the same branch — the test suite only sees what `schema.sql` has.
  Apply new migration files to the remote DB **by hand** before (or with) the deploy that
  needs them, e.g. `npx wrangler d1 execute pawbook-db --remote --file
./migrations/0001_*.sql` — otherwise the new code 500s on missing columns.

Do **not** use `npm run migrate:local` / `migrate:remote` (`wrangler d1 migrations apply`)
against existing DBs — no real DB here has a `d1_migrations` tracking table.

## Deploying

One-time provisioning:

```bash
npx wrangler d1 create pawbook-db                  # put database_id into wrangler.jsonc
npx wrangler kv namespace create PAWBOOK_CACHE     # put id into wrangler.jsonc
npx wrangler secret put TOKEN_SECRET               # strong random value (openssl rand -base64 32)
npx wrangler secret put OWNER_EMAILS               # comma-separated platform-owner email(s)
npx wrangler secret put RESEND_API_KEY             # from https://resend.com — required for login codes & signup links
npx wrangler secret put RESEND_FROM_NOREPLY        # e.g. "Pawservation <no_reply@pawservation.com>" — account access (login codes, password resets, signup links)
npx wrangler secret put RESEND_FROM_BOOKING        # e.g. "Pawservation <booking@pawservation.com>" — booking mail (invites, confirm/decline/cancel)
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
rather than ever leaking a code or link, so `RESEND_API_KEY`/`RESEND_FROM_NOREPLY`/
`RESEND_FROM_BOOKING` are effectively all required in production (email counts as
configured only when all three are set — see `server/lib/email.ts`). The two tenants
embedded on the public `/demo` page (`sunny-paws`, `happy-tails`) are the one deliberate
exception — their seeded end user has no real inbox, so they always get the on-screen code
regardless of email configuration (see `DEMO_TENANT_SLUGS` in `server/routes/auth.ts`).
Merges to `main` auto-deploy via CI.

### Staging/preview URLs

`wrangler.jsonc` sets `"preview_urls": true`, so every `npx wrangler versions upload` prints a
shareable `https://<version>-pawbook.<subdomain>.workers.dev` URL for that exact worker version —
useful for reviewing a change before promoting it to the `pawservation.com` route. `workers_dev`
stays `true` too (existing embeds point at the `*.workers.dev` URL and must keep working) —
don't touch it.

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
