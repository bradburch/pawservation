# Pawservation

[![CI](https://github.com/bradburch/pawservation/actions/workflows/ci.yml/badge.svg)](https://github.com/bradburch/pawservation/actions/workflows/ci.yml)
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
  fires on the host page. A plain-iframe variant exists for script-stripping hosts.
- **Multi-tenant** — every request is scoped to a tenant resolved from the URL slug, with
  isolated services, pricing, pets, customers, and bookings.
- **Custom services** — each tenant defines its own service list (from templates or from
  scratch) with per-option label/duration/price, time windows, weekday-only scheduling,
  slot capacity, and custom intake questions.
- **Per-service capacity & rules** — boarding caps, house-sits-per-day, max stay nights,
  and accepted animal types are all service-level attributes; blank means unlimited. Every
  cap is denominated in **pets, not bookings**, and every check asks whether the requested
  _set_ fits (`used + petCount > cap`) — the boarding/house-sit pools and the per-option
  daily slot cap alike, so a slot with one place left refuses a two-pet request. The
  customer's month grid takes the selected `petIds` and is painted with the same arithmetic,
  so the calendar can't offer a day the quote then refuses. There is deliberately no minimum
  stay and no minimum pet count.
- **House-sit / boarding handover rule** — the sitter can only be in one place, so the two
  are held apart by a tenant-wide allowance (`HousesitBoardingOverlapDays`): never overlap,
  one handover day (the default), one at each end of a stay, or no limit. A shared day only
  ever counts as a genuine handover — one stay ending as the other begins — so a boarding
  dropped into the middle of a house sit is refused at any allowance.
- **Custom animal types** — tenants aren't limited to dogs and cats; add any species and
  accept it per service.
- **Pet co-ownership** — a pet can belong to more than one customer account (e.g.
  co-parents), and a pet can be marked deceased without losing its booking history.
- **Admin dashboard** — lands on a monthly **Calendar** view of bookings and time off;
  plus bookings (confirm/decline/cancel), earnings and payment tracking, client list with
  CSV import, services & rates card grid, time off, embed codes, and in-app help.
- **Google Calendar sync is two-way** — per-tenant OAuth connect; bookings are pushed out
  with retry via an outbox, and a 15-minute cron sweep reconciles both directions: a
  booking declined (or cancelled with nothing owed) in Pawservation deletes its event
  while a cancellation carrying a fee keeps it and retitles it `[CANCELLED]`, an event
  deleted in Google reconciles the booking back to cancelled, and a foreign event
  hand-kept on the connected calendar is read back and blocks new requests like a time-off
  day.
- **Per-service minimum notice + booking horizon** — a service can require N days' notice
  before its earliest bookable start, and a tenant-wide advance-booking horizon caps how
  far out anyone can book; both are optional (NULL = unlimited) and enforced identically
  at the quote, the calendar grid, and the booking POST. New tenants are stamped with a
  12-month horizon at signup.
- **Species defaults per service** — a newly created service starts from the likely answer
  rather than from nothing: walks and daycare dog-only, check-ins cat-only, boarding and
  house sitting open to every registered type. It is a create-time default intersected with
  the tenant's own pet-type registry, never a constraint — the sitter re-ticks the boxes,
  and existing services are not backfilled.
- **Pet-set rates + a per-service multi-pet mode** — a sitter can set an exact-match rate for
  a specific combination of pets or a species mix (e.g. "two dogs" priced as its own line),
  and those stored rates always win. For a combination with no rate of its own, each service
  carries a stored `PetRateMode`: `'linear'` charges the option rate × the number of pets,
  `'exact'` refuses the booking rather than guessing a price. Services created from here on
  start `'linear'`; every service that existed before the mode shipped stays `'exact'`, and
  nothing is backfilled.
- **Onboarding wizard** — first login walks a new sitter through business profile,
  services, and pricing presets; skippable and re-runnable, always additive.
- **Invite-only signup + owner console** — the platform owner (identified by the
  `OWNER_EMAILS` secret) allowlists sitter emails; sitters self-serve from the login page
  via an emailed single-use setup link. No open signup. The owner console can also disable
  or permanently remove a joined sitter — a disabled tenant's widget goes dark and its
  admin dashboard drops to read-only; removal deletes the tenant and every row it owns.
- **Customer self-cancellation** — a customer can cancel their own pending or confirmed
  booking (including a stay already in progress) from the widget. The fee is computed
  server-side from the service's stored cancellation tiers — the client never names a
  price — and the same number is previewed before confirming and stamped on the row. A
  pending request is always free to withdraw; the sitter is emailed either way. The row is
  never deleted: a fee-free cancellation deletes the Google Calendar event, while a
  fee-bearing one keeps it and retitles it `[CANCELLED]` so money still owed stays visible.
- **Customer self-editing** — `PUT /:slug/bookings/:id` lets a customer change their own
  booking's dates, pet set, arrival and departure times, and intake answers (never the service, never the
  option). Every rule a create runs is re-run by calling the same code, capacity is
  re-checked excluding the booking's own row with a verbatim rollback on refusal, a
  confirmed booking drops back to `pending` for the sitter to re-approve, and no
  cancellation fee is ever assessed — rescheduling is not cancelling. The estimate is
  re-quoted only when something price-relevant moved (the dates or the pet set).
- **Arrival and departure times, and extra-time fees** — on a service whose clock the option
  does not own (boarding, house sitting, daycare) the owner may name an arrival and a
  departure time. Ordering is a single-day rule only: on a stay the departure is a time on
  the end date, so collecting at 08:00 after dropping off at 17:00 is ordinary. A sitter can
  optionally store the hours a service normally runs plus a flat fee for an earlier arrival
  or a later departure; the fee is shown in the quote before booking and then added as a
  separate line on the booking, never folded into the stay price and never multiplied by
  anything.
- **Saved intake answers** — a customer's last answer per
  `(tenant, customer, service, question)` is mirrored into `SavedAnswers` after a booking
  create or edit and re-offered as the pre-fill next time. A reworded, retyped, deleted, or
  narrowed question drops its stale answer instead of pre-filling it, and a blank answer
  deletes the saved row. The pre-fill carries no authority — it is re-validated as an
  ordinary answer on submit.
- **Two auth flows** — passwordless email-code sessions for customers; password + JWT for
  sitter admins (PBKDF2, with timing-safe user-enumeration defenses). Sitter and owner
  passwords must be at least 12 characters and clear a short denylist of keyboard-walks
  and leaked-password filler — one validator in `src/shared/auth/password-policy.ts`,
  mirrored by the setup page for UX and enforced independently by the server.
- **Billing accounts** — co-owned pets collapse into one household billing account (union-
  find over owner↔pet links), so a shared client sees one balance, not one per owner.
- **Venmo CSV import** — upload a Venmo export to preview matched transactions against
  outstanding bookings, then confirm to record payments; idempotent by transaction id.
- **Data export** — `GET /api/:slug/admin/export/:dataset` serves four CSVs (clients, pets,
  bookings, payments) from the Business tab: a sitter's records, not a backup of her account.
  Time off, service/rate settings and per-charge detail are deliberately outside the files, and
  the in-app copy is pinned to that scope by a test. Formula-injection-safe, BOM-prefixed for
  Excel, one-way (nothing reads a file back in).
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
npm run seed:local   # applies sql/schema.sql + sql/seed.sql + sql/seed-demo.sql to the local D1
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
| `npm run seed:local`                                   | Reset the local D1 from `sql/schema.sql` + `sql/seed.sql` + `sql/seed-demo.sql`       |
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
sql/          schema.sql (canonical DDL), seed.sql (base fixture), seed-demo.sql (demo activity + config)
migrations/   New incremental DB changes only, numbered from the 2026-07-27 re-baseline
public/       embed.js loader, demo host script, landing images, CSV import example
```

Two invariants worth knowing before you touch code:

- **Tenancy:** `server/db/repo.ts` is the only module allowed to touch the `PAWSERVATION_DB`
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
  `sql/schema.sql` (+ the demo `sql/seed.sql` and `sql/seed-demo.sql`) directly; there is
  nothing to replay on top.
- **`migrations/` numbering restarts from the 2026-07-27 re-baseline.** The incremental
  history that built the old schema (`0001`–`0025`) was deleted in the re-baseline; it
  lives in git (`git log -- migrations/`), not on disk. See `migrations/README.md` for
  the current files and what each one adds.
- **New schema changes:** add a file to `migrations/` continuing the new numbering
  **and** mirror the change into `sql/schema.sql` in the same branch — the test suite
  only sees what `schema.sql` has. Apply new migration files to the remote DB **by
  hand** before (or with) the deploy that needs them, e.g. `npx wrangler d1 execute
pawservation-db --remote --file ./migrations/NNNN_*.sql` — otherwise the new code 500s on
  missing columns.

Do **not** use `npm run migrate:local` / `migrate:remote` (`wrangler d1 migrations apply`)
against existing DBs — no real DB here has a `d1_migrations` tracking table.

## Deploying

One-time provisioning:

```bash
npx wrangler d1 create pawservation-db                  # put database_id into wrangler.jsonc
npx wrangler kv namespace create PAWSERVATION_CACHE     # put id into wrangler.jsonc
npx wrangler secret put TOKEN_SECRET               # strong random value (openssl rand -base64 32)
npx wrangler secret put OWNER_EMAILS               # comma-separated platform-owner email(s)
npx wrangler secret put RESEND_API_KEY             # from https://resend.com — required for login codes & signup links
npx wrangler secret put RESEND_FROM_NOREPLY        # e.g. "Pawservation <no_reply@pawservation.com>" — account access (login codes, password resets, signup links)
npx wrangler secret put RESEND_FROM_BOOKING        # e.g. "Pawservation <booking@pawservation.com>" — booking mail (invites, confirm/decline/cancel)
npx wrangler secret put BILLING_SHARED_SECRET      # guards POST /api/:slug/admin/billing/events — unset means that endpoint refuses everything
# BILLING_SHARED_SECRET_PREVIOUS exists only DURING a rotation: set it to the outgoing value, switch
# the caller to the new one, then `npx wrangler secret delete BILLING_SHARED_SECRET_PREVIOUS`.
# PREMIUM_ORIGIN is set in wrangler.jsonc as a plain var (not a secret); edit the value there if needed.
# It is published on /config as premium.origin for clients that cannot resolve relative paths (*.workers.dev embeds).
# PLAN_SUBSCRIBE is a plain var too, and is deliberately NOT set: unset means the dashboard offers no
# Subscribe control. See "Plans and billing" below for when to add it.
# PLAN_ENFORCE is the same shape and is also deliberately NOT set: unset means a business holding no
# current plan still has a writable dashboard. Set it to exactly "true" only after the pre-flip check
# in "Plans and billing" returns zero rows.
# Optional — Google Calendar sync:
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

There is no redirect-URI secret. The callback is derived per request from the origin the dashboard
was opened on, so the OAuth login-CSRF cookie (which is host-scoped) and the callback always share
a host. What that costs instead is Google Cloud Console setup: **register every host you serve the
dashboard from as an Authorized redirect URI**, each exactly `https://<host>/oauth/google/callback`
— typically your custom domain and the `*.workers.dev` host. A host that is not registered fails at
Google's own authorize screen with `redirect_uri_mismatch`; that includes rotating
`wrangler versions upload` preview URLs, which cannot be pre-registered and are not sitter-facing.
Callback failures log one `google oauth callback failed { reason, … }` line — `npx wrangler tail`
is the way to see which of its branches fired.

Then:

```bash
npm run deploy       # build + wrangler deploy (worker code only)
npx wrangler d1 execute pawservation-db --remote --file=./sql/schema.sql   # fresh DB only
```

Production **fails closed** without email: customer login and sitter signup return 503
rather than ever leaking a code or link, so `RESEND_API_KEY`/`RESEND_FROM_NOREPLY`/
`RESEND_FROM_BOOKING` are effectively all required in production (email counts as
configured only when all three are set — see `server/lib/email.ts`). The two tenants
embedded on the public `/demo` page (`sunny-paws`, `happy-tails`) are the one deliberate
exception — their seeded end user has no real inbox, so they always get the on-screen code
regardless of email configuration (see `DEMO_TENANT_SLUGS` in `server/routes/auth.ts`).
Merges to `main` auto-deploy via CI.

**Apply a pending migration BEFORE the deploy that needs it, never after.** The worker resolves a
tenant on essentially every request, and that `SELECT` names its columns explicitly
(`TENANT_COLS`, `server/db/repo.ts`) — so a worker shipped against a database that has not had its
migration applied answers `no such column` on the sitter dashboard, the public config read and the
booking widget alike, which is a total outage rather than a missing feature. Applying first costs
nothing: an added column sits unread until the worker that reads it ships. `0017_plan_billing.sql`
is the pending one on this branch, and `migrations/README.md` carries the command and a
reserved-slug check to run before it.

### Staging/preview URLs

`wrangler.jsonc` sets `"preview_urls": true`, so every `npx wrangler versions upload` prints a
shareable `https://<version>-pawservation.<subdomain>.workers.dev` URL for that exact worker version —
useful for reviewing a change before promoting it to the `pawservation.com` route. `workers_dev`
stays `true` too — it's what makes that staging URL work — don't touch it.

## Plans and billing

Every joined sitter is on Solo or Pro; a plan decides what her account can do, not whether she was
allowed to join (see "Provisioning the first sitter" below — signup stays invite-only either way).
`server/lib/premium.ts` holds **three** one-expression predicates over the same handful of columns,
and they answer three different questions:

- **`isPremiumActive`** — does she get the PAID surface? The platform owner's comp (`PremiumUntil`)
  OR a paid Pro plan (`Plan === 'pro'` with a live `BilledUntil`).
- **`isSoloActive`** — does she have a LIVE PAID SUBSCRIPTION? `BilledUntil` in the future, whichever
  tier. Published as `planActive`, and what the Subscribe control hides on.
- **`isPlanCurrent`** — does she hold a CURRENT PLAN at all, by any of the three grants?
  `BilledUntil` OR `CompedUntil` OR `PremiumUntil` in the future. Tier-blind on purpose: the thing
  that lapses is the plan, not a tier. Published as `planCurrent`, and what the lapse gate refuses
  on.

All three refuse a **disabled** business before looking at any date, which is one shared early
return and is what stops the three from drifting on the one condition they agree about. The columns
they read:

- **`PremiumUntil`** — the platform owner's comp of the PAID tier, set and cleared by hand from the
  owner console. Unrelated to billing, and billing never touches it.
- **`CompedUntil`** (0018) — the platform owner's comp of the BASIC plan, set the same way from the
  same console. A second column rather than a hand-set `BilledUntil`: that one carries a 400-day
  ceiling written for a leaked shared secret and is assigned by every billing event, so a comp
  written there would be refused when long and overwritten when short. Billing never touches this
  one either.
- **`Plan` + `BilledUntil`** — a paid plan (`'solo' | 'pro'`), written only by the billing endpoint
  below. `Plan === 'pro'` with `BilledUntil` in the future is the paid route to the same surface the
  comp grants; `Plan === 'solo'` buys this product's own paid tier and is never itself premium.

**A lapsed plan is a read-only dashboard.** `planGate` (`server/lib/middleware.ts`) is one `.use()`
line declared immediately after `adminAuth`, so it covers exactly `adminAuth`'s flattened scope —
every non-GET under `/:slug/admin/*`, including the routes declared in `accounts.ts` and
`tenant-tokens.ts` — and answers **`402 { error: 'plan_lapsed' }`**. 402 rather than 403 because
`isAuthExpired` treats 401 and 403 as an expired session, and a second 403 literal is a second
chance to eject a sitter from the dashboard she is trying to read. **Her booking page is untouched:**
the gate is in `adminRoutes` and not in `tenantMiddleware`, so `POST /:slug/bookings` is outside it
by prefix, and so is `POST /:slug/admin/billing/events`, which is outside by mount order and is how
she un-lapses.

**It ships dark, and that is not caution for its own sake.** `PLAN_ENFORCE` (unset = off, exactly
`"true"` = on) is what the gate reads. Migration 0017 seeded nothing and tenant creation writes no
plan, and there is no free tier left to fall back to — so on the day the gate deploys, every
business in the book reads as holding none. The order is:

1. hand-apply `migrations/0018_plan_comp.sql` to the remote database — **migrate, then deploy**;
2. merge, which is the deploy, **with `PLAN_ENFORCE` unset**. `planCurrent` starts answering, no
   write is refused, and the only visible change is the banner for un-comped businesses;
3. **comp the existing book** from the owner console, in the same sitting;
4. run the pre-flip check, and only then set the var.

**The pre-flip check, and it is the step no test can perform.** Every row it returns is a business
whose dashboard goes read-only the moment the var is set:

```
npx wrangler d1 execute pawservation-db --remote --command \
  "SELECT Slug FROM Tenants WHERE DisabledAt IS NULL
     AND (BilledUntil IS NULL OR BilledUntil <= datetime('now'))
     AND (CompedUntil IS NULL OR CompedUntil <= datetime('now'))
     AND (PremiumUntil IS NULL OR PremiumUntil <= datetime('now'))"
```

**Expect zero rows before flipping.** If it returns any, comp them or do not flip. The same command
is the rollback diagnosis, and the rollback itself is one line — unset `PLAN_ENFORCE`. No data is
written by the flip and none is undone by the unflip.

**One state the runbook cannot fix from here: a disabled business with a live subscription.**
`adminAuth` refuses her credential outright, so she cannot reach a hosted portal to stop a card that
keeps being charged. Cancel it in the Stripe Dashboard by hand. The alternative is this repo holding
a processor secret and a cancel call, which it may not.

`POST /api/:slug/admin/billing/events` records a subscription's outcome against one tenant — a
plan, a paid-through date, and the processor's customer/subscription ids, nothing else. It calls no
payment processor, verifies no signature, and mints no credential; whatever talks to a processor is
on the other end of the shared secret (`BILLING_SHARED_SECRET`, see "Deploying" above), which is
what guards the route instead of a session or an access token. `/config` publishes the current
`pricing` figures (`soloMonthly`, `proMonthly`, `proAnnual`, `trialDays`) for any surface that needs
to state them, but never a tenant's own plan state — that stays behind an authenticated read.

Its `eventType` is a **five-value closed set**, so it can never become a free-text channel. Four are
a processor's own event names; the fifth is **`resync`** — the caller saying "this is what the
processor says right now", after a delivery was lost or a row was frozen against a subscription it
no longer holds. It exists for one route on `premium.origin`, `POST /premium/billing/:slug/resync`;
this repo does not call that route, knows nothing else about it, and gains no control that presses
it. A completed checkout and a `resync` are the **two events that ESTABLISH** which customer and
which subscription a business now is, so those two assign `StripeCustomerId`, while `invoice.paid`
only fills it in when it is missing: an invoice says that a subscription was paid, not which one
this business now holds.

That authenticated read is `GET /api/:slug/admin/settings`, which publishes six plan fields
beside everything else the dashboard loads: `plan`, `billedUntil` (the stored instant, verbatim),
`planActive` (`isSoloActive`'s answer, never a comparison — see below), `hasBillingAccount`, and
`stripeCustomerId`, plus `planCurrent` (`isPlanCurrent`'s answer). `planActive` and `planCurrent`
are two different questions and both are published deliberately: a comped business is
`planCurrent: true` and `planActive: false`, and must still be offered Subscribe. `planCurrent` is
the **tenant's** state and not the gate's answer — whether this deployment enforces the plan is
deliberately not folded in, so between a deploy and the comp sweep the dashboard banner is early
rather than wrong. There is no second route: this one is already authenticated, already scoped to
the slug in its path, and already fetched once per dashboard load. **`stripeCustomerId` goes only
to a password session** and its key is _absent_ — not null — for a `pawsa_` tenant access token, so
a consumer can tell "withheld by policy" from "no customer yet"; the other five are the tenant's
own plan, told to the tenant's own admin. `StripeSubscriptionId` and `LastBillingEventAt` are **off
THIS payload**: neither consumer needs them, and the second is the billing endpoint's own ordering
state. Not off the wire altogether — `POST /api/:slug/admin/billing/events` echoes the subscription
id it replaced as `replaced`, to the shared-secret caller that sent it and to nothing else.

`isPremiumActive`, `isSoloActive` and `isPlanCurrent` (`server/lib/premium.ts`) are the only
expressions that compare `BilledUntil`, `CompedUntil` or `PremiumUntil` to anything, and what keeps
it that way is a scan with a stated reach: `server/__tests__/premium-entitlement.test.ts` walks
every `.ts`/`.tsx` under **`server/` and `app/`** — test files included, `server/lib/premium.ts` alone exempt. Those two trees
are every module that can read a tenant row or render one, which is why they are the two; `src/`,
`test/` and `scripts/` are outside it, so "nowhere in the repo" is a claim about those two trees and
not about every file in the checkout. The scan reads each file through `liveSource`
(`server/__tests__/helpers/live-source.ts`), which strips comments and literals — so the prose in
`repo.ts` and in the suite may quote the comparison while describing it, and a quoted route pattern
can no longer blind the scan to the rest of a file. Anything that needs "is her plan live" calls the
helper and publishes the boolean.

The admin dashboard's Business section (`app/admin/PlanPanel.tsx`) shows three things on three
different conditions.

**Plan status renders unconditionally** — the plan, the paid-through date and live/lapsed, from the
settings read above. An outage of the paid surface, an unset `PREMIUM_ORIGIN`, a deployment that
has stopped selling and a lapsed subscription all still show it: every fact on that line is a
column in this product's own database. It says nothing about entitlement.

**Subscribe** is gated on **two properties of the deployment** plus one fact about her plan, and
never on the tenant's own entitlement — which is false for exactly the sitter the control is for:

- **`premium.origin`** — a checkout worker exists to be reached, and where.
- **`pricing.subscribe`** — selling is switched on. This is the `PLAN_SUBSCRIBE` var
  (`wrangler.jsonc`), where **unset means off** and exactly the string `"true"` means on.
- **`!planActive`** — she has no live plan. Deliberately **not** `!hasBillingAccount`:
  `StripeCustomerId` is written once and never cleared, so a sitter who cancelled keeps a billing
  account for good, and gating on it hid Subscribe from the one sitter who wanted to press it.

**Leave `PLAN_SUBSCRIBE` unset until the billing worker's checkout route is live**, then set it and
deploy. `PREMIUM_ORIGIN` is already set in production, so a panel gated on the origin alone would
put a Subscribe button in front of every sitter that 404s on every press. The flag is the
operator's switch for "we are selling now", and it grants nothing: it decides whether a control
renders, never whether a plan is honoured.

A disabled sitter gets **neither control** — her account cannot take a booking, so asking her for a
card would be worse than showing nothing, and there is nothing she could usefully do in a portal
either. She sees her plan's name and one line saying the account is switched off; no paid-through
date and no live/lapsed word, because neither means anything while the account is off. The
`disabled` flag both gates read comes from the settings payload, the same source as the dashboard's
own disabled banner — it is in hand before the panel paints, so no control flashes on for her while
a `/config` request is in flight.

**Manage plan** is gated on `premium.origin`, `hasBillingAccount` and a tenant that is switched on,
and on neither of the deployment's other two flags: a sitter who already pays must be able to
change her card and cancel after a deployment stops selling, so it is not gated on
`pricing.subscribe`. **It is deliberately NOT gated on `planActive`.** A lapsed plan is very often
a subscription in the processor's dunning — still alive, still retrying — and the hosted portal is
the only place she can put a working card on it, so `planActive` here shut her out of the fix at
the moment she needed it. `hasBillingAccount` is the question that matches the control: is there an
account at the processor to open at all. It `POST`s to
`<premium.origin>/premium/billing/<slug>/portal` with the admin Bearer and no body, and navigates
the top-level window to the `url` it gets back — a `fetch` and never an anchor, because an anchor
carries no `Authorization` header.

**The two controls are not one flag negated**, so which of them a sitter sees falls out of the
pair of questions they ask:

| Her state                                           | Subscribe | Manage plan |
| --------------------------------------------------- | --------- | ----------- |
| Never subscribed — no billing account, no live plan | yes       | no          |
| Live plan                                           | no        | yes         |
| **Lapsed, with a billing account**                  | yes       | **yes**     |
| Cancelled but still in the paid-through window      | no        | yes         |
| Switched off (disabled)                             | no        | no          |

The lapsed-with-an-account row is the only state that shows both, and it shows one extra line
beneath them saying which is which — fix a card or read an invoice under Manage plan, start again
under Subscribe. A paying sitter is still never offered a second subscription (`planActive` is
plain on the Subscribe side and appears in neither Manage condition); that is the UI half of the
double-subscription question, and the other half is a server-side refusal on the checkout route,
because a UI is not a guard.

Where no origin is published, the status line renders alone with one sentence saying plan changes
are unavailable — shown on `configLoaded && hasBillingAccount && origin === null`, so it tracks the
Manage control exactly, minus the origin, and never reaches a sitter who has no billing account to
manage. It waits for the `/config` read to FINISH rather than to succeed: a read that failed is one
of the states the sentence is true for.

The panel states no price, trial length, invoice, cancellation term or refund position of its own:
the figures come from `/config` and the terms belong on the terms page. It knows an **origin** it
was published and two path templates on it, and nothing else about whatever serves them.

`BILLING_SHARED_SECRET` is **one value held identically on two workers**: this one, which checks
it, and the billing worker, which presents it on every event. Rotating it is therefore an ordered
pair of deploys, which is what `BILLING_SHARED_SECRET_PREVIOUS` exists for — set the outgoing value
there, switch the caller to the new one, then delete it. Neither value ever appears in a log line.
Applying `0017` and `0018` before deploying this worker is not optional; see "Deploying" above.

**This half deploys first**, and the requirement is stated as one on the CALLER rather than as a
claim about its internals, which this repo cannot see. Whatever serves the two paths on
`premium.origin` reads those six plan fields from `GET /api/:slug/admin/settings`, so it must not be
deployed before this worker publishes them, and it must fail closed — not guess — on a settings read
that does not carry them. The order is: apply `0017` and `0018`, deploy this worker with
`PLAN_ENFORCE` unset, then that surface, then the comp sweep and the pre-flip check above before the
var is set.

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
