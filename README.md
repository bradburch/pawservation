# Pawbook

[![CI](https://github.com/bradburch/pawbook/actions/workflows/ci.yml/badge.svg)](https://github.com/bradburch/pawbook/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

An open-source, embeddable, **multi-tenant booking widget**. Drop a booking calendar
into any website — Squarespace, Wix, or plain HTML — with a single `<script>` tag. Built on
Cloudflare Workers (Hono + React) with isolated per-tenant configuration, availability and
capacity rules, and pricing.

> **Status — early release (v0.1).** The booking flow stores requests in D1 (Cloudflare's
> SQLite). **Not yet implemented:** real Google Calendar sync (Phase 1) and email +
> invite-only customers (Phase 2). See [Roadmap](#roadmap).

## Features

- **One-tag embed** — an auto-resizing iframe with an origin- and source-validated
  `postMessage` channel; no third-party JS on the host page.
- **Multi-tenant** — each provider is a tenant resolved from the URL, with isolated config,
  services, pricing, accepted pet types, and bookings.
- **Capacity-aware availability** — per-tenant, per-day capacity and conflict rules (boarding
  cap, house-sit cap, max stay length, and business timezone — each **nullable for
  unlimited / instance-default**), plus blocked dates, computed from a single source of truth.
- **Two auth flows** — passwordless email-code sessions for customers; password + JWT
  sessions for the tenant admin dashboard.
- **Zero runtime dependencies** in the booking/date/pricing core (pure TypeScript).

## Embed it

```html
<script src="https://<your-worker>/embed.js" data-pawbook-tenant="your-slug"></script>
```

The loader injects an auto-resizing iframe, validates every `postMessage` by **origin and
source**, and re-dispatches a `pawbook:booked` DOM event on the host page so you can react to
completed bookings. Script-stripping hosts (e.g. Wix "Embed a site") can use the plain-iframe
variant shown in the admin dashboard.

## How it works

```
Host site ──<script>──▶ /embed.js ──iframe──▶ /embed/:slug  (React widget)
                                                    │
                                                    ▼
                              Hono Worker ──▶ D1 (per-tenant config + bookings)
                                          └─▶ KV (caches, login codes)
```

The Worker serves the built widget/admin assets and an API under `/api/:slug/*`. Tenancy is
resolved from the slug; capacity and pricing rules live in `src/shared/` (pure functions).

## Local development

```bash
npm install
npm run seed:local                                # schema + demo tenants (Sunny Paws, Happy Tails, Paws & Relax)
printf 'TOKEN_SECRET=%s\nENVIRONMENT=development\n' "$(openssl rand -base64 32)" > .dev.vars
npm run dev                                        # builds the widget + runs wrangler dev
```

- Demo page (two tenants side by side): `http://localhost:8787/demo`
- Widget: `http://localhost:8787/embed/sunny-paws`
- Admin dashboard: `http://localhost:8787/admin`

## Deploy

```bash
npx wrangler d1 create pawbook-db                  # put database_id into wrangler.jsonc
npx wrangler kv namespace create PAWBOOK_CACHE # put id into wrangler.jsonc
npx wrangler secret put TOKEN_SECRET               # a strong random value (openssl rand -base64 32)
npm run deploy
npm run seed:remote                                # ⚠️ demo tenants/logins — do NOT run against a real prod DB
```

### Database migrations

`npm run deploy` ships **worker code only** — it does **not** touch the database. A fresh install
gets the full, current schema from `sql/schema.sql` (via `seed:remote`). But when you upgrade an
**already-provisioned** database, you must apply any new files in `migrations/` yourself, or the new
code will query columns that don't exist yet and every `/api/:slug/*` route will 500.

Apply pending migrations against the live DB (each file is idempotent-by-intent; run the ones added
since your last deploy):

```bash
npx wrangler d1 execute pawbook-db --remote --file ./migrations/0002_tenant_config_limits.sql
```

Use `--local` instead of `--remote` for your dev database. (Fresh installs created from
`sql/schema.sql` already include every column and do **not** need to replay migration files.)

### Email delivery (login codes)

In local development (`ENVIRONMENT=development`) login codes are shown on screen. **Production
emails them and fails closed if no provider is configured** — `/identify` returns 503 rather than
ever leaking a code. Set two secrets to enable email:

```bash
npx wrangler secret put RESEND_API_KEY             # from https://resend.com (free tier)
npx wrangler secret put RESEND_FROM                # e.g. "Pawbook <bookings@yourdomain.com>" (verified sender)
```

When `RESEND_API_KEY` is set, the `/identify` response no longer returns the code — it is emailed.

## Tests & quality

```bash
npm test          # Vitest, backed by in-memory SQLite (node:sqlite)
npm run typecheck # wrangler types + tsc -b
npm run lint      # ESLint
npm run format    # Prettier check
```

## Project structure

```
app/            React apps — embed widget, admin dashboard, shared UI/API client
server/         Hono Worker — routes, auth/token, tenant resolution, availability, db
src/shared/     Pure booking/date/pricing logic (zero runtime dependencies)
sql/            D1 schema + demo seed
public/         embed.js loader + demo host
```

## Roadmap

- **Phase 1 — Google Calendar OAuth.** Per-tenant "Connect Calendar" so bookings create real
  calendar events.
- **Phase 2 — Email + invite-only customers.** Real email delivery (login codes, invites) and
  a provider-managed customer list.
- **Phase 3 — Self-serve tenant signup, custom domains, billing.**

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md). By participating you
agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). To report a security issue, see
[SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Brad Burch
