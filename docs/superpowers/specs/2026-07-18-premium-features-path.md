# Premium features path — strategy & architecture

**Date:** 2026-07-18
**Status:** Draft — for discussion
**Branch:** `custom-services`

This is a strategy document, not an implementation spec. Nothing here is
scheduled; the point is to agree on the boundary and the seams _before_ the
first premium feature exists, so we never have to un-ship something from the
public repo.

## Context

Pawbook is MIT-licensed and self-deployable (one Cloudflare Worker + D1 + KV,
three Vite bundles), but the primary intent is the owner's hosted SaaS. The
landing page already promises "hosted signup is on the roadmap." Named premium
candidates: AI integration, an MCP server, invoicing. Today there is no plan
or billing concept anywhere — `Tenants` has no plan column, and tenants are
provisioned by hand in SQL.

## 1. The open-core boundary

**MIT forever — the whole working product.** The OSS repo stays a complete,
self-hostable booking business in a box, never a crippled demo:

- The full booking engine (`src/shared/booking/`, pricing, dates), tenancy,
  both auth systems, the embed widget + admin dashboard + demo page.
- Services/rates/options/capacity, clients & pets, CSV import, booking
  lifecycle, status emails, Google Calendar sync, payments _logging_ and
  earnings analytics (the existing `Payments` table and Earnings section).
- The public JSON API — including everything a third party needs to build
  their own integrations (an MCP server, a Zapier bridge, whatever).

**Premium — additive conveniences, mostly "managed" versions of things a
self-hoster could rig up themselves:** AI drafting/summaries, the hosted MCP
server, invoicing/card payments (Stripe rails), and later candidates like
multi-staff accounts, SMS notifications, white-label/custom domains. The
honest open-core test: _removing a premium feature must leave a product a
solo sitter would still happily run._ Because the core is MIT, anyone may
reimplement any of these in a fork — the moat is hosting + maintenance, not
the license, and we should never pretend otherwise.

## 2. Candidate architectures

The constraint that shapes everything: this is **one worker** with two hard
invariants — `tenantMiddleware` registered exactly once in `server/index.ts`,
and `server/db/repo.ts` as the sole owner of `PAWBOOK_DB`.

### A. Private premium package, compiled in at build time

A closed-source npm package (or git submodule) implementing a stub interface;
the hosted build imports the real thing, the OSS build compiles against a
no-op stub, gated by an env/entitlement check at runtime.

- _Licensing hygiene:_ OK — code lives in a private repo.
- _Build complexity:_ high. Two build flavors of the same worker; CI must
  prove the OSS flavor builds without credentials; `wrangler deploy` stops
  being one command.
- _Drift risk:_ high. The stub interface and the real package version-skew
  silently; OSS tests can never exercise the real code paths.
- _Invariants:_ worst case. Premium code runs inside the worker, one import
  away from `PAWBOOK_DB` and the tenant context — coupling is a constant
  temptation, and a premium bug takes down core booking.

### B. Separate premium Worker(s) via Cloudflare service bindings — **recommended**

Premium features live in one (later maybe more) closed-source Worker in a
private repo. The public worker gains only a thin MIT seam: an _optional_
service binding (`PREMIUM?: Fetcher` in `AppEnv`) plus an entitlement check.
Route handlers that are premium-shaped do: entitled tenant + binding present
→ forward the request (with `tenant.Id` explicitly attached) to the binding;
otherwise → 404 or an upsell payload. The hosted deployment's wrangler config
(which can live in the private repo, importing the public worker as-is)
declares the binding; OSS deployments simply never set it and nothing changes.

- _Licensing hygiene:_ clean — zero premium code, keys, or submodules in the
  public repo; the seam itself is MIT and useless without a binding.
- _Build complexity:_ low. The public repo's build/CI is untouched; the
  premium worker builds, tests, and deploys independently.
- _Drift risk:_ contained. The contract is a small HTTP/RPC surface between
  two workers, versionable and testable from both sides (the premium repo can
  pin the public repo as a dependency for contract tests).
- _Invariants:_ preserved by construction. The premium worker physically
  cannot import `repo.ts` or the D1 binding. It owns its own storage for
  premium-only data (invoice state, AI usage) and writes into core data only
  through the public worker's API with a service token — tenant scoping stays
  where it lives today.
- _Cost:_ one extra worker to operate, and premium requests hop once. Both
  are fine at this scale (service bindings are same-thread, no network hop).

### C. Pure SaaS-side gating (premium only in hosted infra)

No repo changes at all; premium features are separate hosted services on
their own routes/domains. Cleanest licensing, zero build cost — but premium
features can never appear _inside_ the product (no admin section, no settings
payload, no widget touchpoint) without eventually needing the seams from B
anyway. Fine as a starting posture; it converges to B the moment a feature
needs UI.

**Recommendation: B**, adopted lazily — behave like C until the first premium
feature is built, then add the seam. A is rejected outright: it trades the
project's two clearest invariants for build-time cleverness.

## 3. Entitlements model

- **`Tenants.Plan TEXT`** — nullable, `NULL` = free, matching the codebase's
  null-is-default convention (`MaxBoardingPets` etc.). Values like
  `'hosted-pro'` are opaque strings; no CHECK constraint, so adding plans
  never needs a table rebuild. Migration `0013` + the matching `sql/schema.sql`
  edit + `TENANT_COLS` in `repo.ts` + the `Tenant` type.
- **`server/lib/entitlements.ts`** — one pure function,
  `featuresFor(tenant: Tenant): string[]`, mapping plan → feature keys
  (`'ai'`, `'mcp'`, `'invoicing'`). The server is the only thing that ever
  _decides_ entitlement; since `tenantMiddleware` already puts the tenant on
  `c.get('tenant')`, any handler can check without new middleware.
- **Clients are told, never trusted:** the admin session/config payload grows
  a `features: string[]` (and the public `/api/:slug/config` only if a
  feature ever touches the widget). The React apps toggle on that array only.
- **Upsell vs invisible:** the payload also carries
  `premiumAvailable: boolean` — true only when the `PREMIUM` binding exists.
  Self-hosted deployments (`premiumAvailable: false`): premium sections are
  _invisible_ — no nagware in the OSS product. Hosted free tenants: sections
  render as visible upsell cards ("Available on the hosted plan"). Same
  component, two states, decided by two booleans the server sent.
- A `TenantEntitlements` table (per-feature overrides, trials, seat counts)
  is deferred until a real need — the plan column plus a code-side map covers
  everything until billing exists.

## 4. Worked examples (sketch level)

### AI: booking-message drafting & summaries

"Draft a reply to this request" / "summarize this client's history" buttons in
the Bookings/Clients sections. Flow: admin UI → public worker
`/api/:slug/admin/ai/draft` (JWT + entitlement check) → forwards booking/
client context to the premium worker → premium worker calls **Workers AI** (an
`AI` binding on the _premium_ worker — cheap, data stays in Cloudflare) or the
**Anthropic API** (better prose; key is a premium-worker secret). No AI SDK,
key, or prompt ever appears in the public repo. Output is a draft the sitter
edits — never auto-sent, consistent with "nothing books itself."

### MCP server (hosted/managed)

The pattern is already proven in the wild: a customer-facing Pawbook MCP
server exists today (sitters' customers checking availability and booking via
Claude) built against the public API — exactly what the MIT boundary promises
third parties. Premium is the **managed** version: a hosted MCP Worker (Agents
SDK) at `mcp.<hosted-domain>/:slug`, per-tenant, zero setup — it handles
customer auth (reusing the email-code flow) and calls the public booking API
on the customer's behalf, so capacity/conflict rules are enforced by the same
server code as the widget. Self-hosters keep the right and the API surface to
run their own; the premium pitch is "flip a switch, your clients can book from
Claude."

### Invoicing (Stripe)

Premium worker owns all Stripe material: keys, Checkout session creation,
webhook endpoint, invoice state in its _own_ D1. Admin UI gains an "Invoice"
action on a booking (upsell-gated); premium worker generates a Stripe payment
link emailed to the client. On the `checkout.session.completed` webhook it
records the payment **through the public worker's admin API** (service token)
as a `Payments` row — conveniently, `Payments.Method` already allows
`'card'` in its CHECK constraint, so the earnings analytics, outstanding-
balance math, and Payments panel work unchanged. Core keeps its "Pawbook
tracks money, it doesn't take it" story; the hosted plan upgrades it to
"…unless you want it to."

## 5. Licensing & repo mechanics

- **LICENSE:** untouched — stays plain MIT.
- **README / landing copy:** one honest sentence, e.g. "Everything in this
  repo is MIT and always will be — the complete booking product. The hosted
  plan adds optional managed services (AI, invoicing, a managed MCP server)
  that are not part of this codebase." Update the landing FAQ when hosted
  signup ships.
- **Public repo hygiene:** no premium source, submodule pointers, private
  registry references, or secrets — CI must keep passing on a fork with zero
  credentials. The only premium-adjacent code allowed in public is the seam:
  the optional binding type, entitlement helper, and upsell UI states, all
  MIT.
- **CI:** unchanged for the public repo. The private repo gets its own CI and
  can run contract tests against the public worker's API (the existing
  `createTestEnv()` in-memory-SQLite harness makes the public API cheap to
  stand up in tests).
- **Contributions:** because the core is MIT, someone may PR e.g. a Stripe
  integration to the OSS repo. That's the owner's call per-PR — the boundary
  commitment is "the OSS product stays whole," not "OSS never grows." No CLA
  needed while all accepted contributions land under MIT in the public repo;
  revisit only if public code ever needs relicensing (avoid that).

## 6. Migration path — YAGNI-honest

**Now (cheap, non-committal):**

1. Agree on this document — the boundary is the deliverable.
2. Optionally, migration `0013_tenant_plan.sql` (+ `sql/schema.sql`,
   `TENANT_COLS`, `Tenant` type): the nullable `Plan` column. ~10 lines, zero
   behavior change, saves a migration later. Even this can ride along with
   the hosted-signup work instead — there is nothing to gate yet.
3. Nothing else. No `entitlements.ts` until a caller exists.

**Later (when the first premium feature is actually built, in this order):**

1. `server/lib/entitlements.ts` + `features`/`premiumAvailable` in the admin
   session payload + the upsell/invisible section states.
2. The private repo, the premium worker skeleton, the optional `PREMIUM`
   binding + one forwarding route in the public worker.
3. The feature itself. Invoicing is the best first pick: clearest
   willingness-to-pay, smallest contract (one action + one webhook), and the
   `Payments` table is already shaped for it.

**Not yet, explicitly:** no `TenantEntitlements` table, no billing/plan
management UI, no stub premium worker "for structure," no premium repo before
premium code, no feature flags framework, no per-feature usage metering.
Every one of these has an obvious shape when needed; building them now only
creates drift surface.
