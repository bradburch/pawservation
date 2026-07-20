# OSS vs proprietary split — end-of-branch analysis

**Date:** 2026-07-19
**Status:** Analysis — companion to `2026-07-18-premium-features-path.md`
**Branch:** `custom-services`

The premium-features path doc set the boundary before any premium feature
existed. This doc applies that boundary to what the branch _actually built_
(~70 commits, `ac05809..HEAD`) and answers: does anything built here belong
behind the proprietary line, now or later?

## Framework (recap)

From the premium doc, the open-core test: **removing a premium feature must
leave a product a solo sitter would still happily run.** Architecture when
premium code exists: a closed-source premium Worker behind an _optional_
service binding; entitlements via a nullable `Tenants.Plan`; the moat is
hosting + maintenance, not the license.

This analysis adds a third class the premium doc didn't need yet:

- **OSS-core** — MIT, a self-deployer needs it; removing it fails the test.
- **Hosted-operational** — MIT code that mainly matters when you _operate_ an
  instance for other people. Not premium (it gates entry to tenancy, it isn't
  a per-tenant convenience), and not crippleware (the product is whole
  without it).
- **Premium-candidate** — could move behind the service-binding seam later.

## Classification

| Feature (this branch)                                                  | Class              |
| ---------------------------------------------------------------------- | ------------------ |
| Onboarding wizard v1 + v2 (presets, profile step, customization)       | OSS-core           |
| Weekday-only service options (migration 0012, shared `isWeekend`)      | OSS-core           |
| Services & rates card redesign (`ServiceEditor`, summary grid)         | OSS-core           |
| Admin scheduling calendar + GCal status sync (cancel deletes event)    | OSS-core           |
| Animal types registry + per-service acceptance (migration 0014)        | OSS-core           |
| Service-level capacity attributes (migration 0015, engine changes)     | OSS-core           |
| In-app help/hints (Hint toggletip, section explainers, Help section)   | OSS-core           |
| Invite-only signup + owner console (0013, `/api/signup`, `/api/owner`) | Hosted-operational |
| Sitter-facing marketing landing (`LANDING_HTML`, real screenshots)     | Hosted-operational |
| Premium-path doc + this analysis                                       | Docs (MIT)         |

## Reasoning per feature

**Onboarding wizard, services redesign, help/hints.** All three are the
admin dashboard getting easier to use. A solo self-deployer runs this exact
UI; stripping any of it degrades the OSS product directly. No managed-service
component, no per-tenant billing angle. OSS-core, no argument.

**Weekday-only options, animal types, service-level capacity.** These extend
the pure booking core (`src/shared/booking/`, `service-rules.ts`,
`capacity.ts`) and its enforcement — the premium doc names the booking engine
as the first thing that is "MIT forever." Splitting engine rules by license
would also break the core's central property: server and widget enforce the
_same_ shared code. OSS-core by construction.

**Admin calendar + GCal sync.** The premium doc's MIT list already includes
Google Calendar sync; this branch only completed its lifecycle (delete on
cancel/decline) and added a first-party calendar view. A calendar is table
stakes for a booking product, not an additive convenience. OSS-core.

**Invite-only signup + owner console — the interesting one.** Superficially
this smells hosted-only: `OWNER_EMAILS` is the hosted operator's secret,
`AllowedSitters`/`OwnerUsers` (migration 0013) exist to gate _other people_
into your instance, and a solo self-deployer IS the owner — they don't need
an allowlist to invite themselves. But it earns its MIT place twice over:

1. _It is useful self-hosted._ A self-hoster is not necessarily solo: a
   sitting agency, a co-op of sitters, or anyone running the widget for
   friends is a multi-tenant operator, and before this branch their only
   provisioning path was hand-written SQL with pre-hashed passwords. Even a
   solo deployer gets a real onboarding path (allowlist self, click link, set
   password) instead of a SQL ritual. The owner console is the missing
   admin-of-admins surface for exactly the multi-tenancy the OSS schema
   already ships.
2. _It degrades gracefully when unused._ With `OWNER_EMAILS` unset the
   console is simply unreachable — the same "invisible, not nagware" posture
   the premium doc prescribes for absent premium bindings. No upsell, no
   stub.

So: hosted-operational, stays MIT. Moving it behind the premium seam would be
worse than pointless — it _creates_ tenants, so it sits upstream of any
entitlement check and cannot depend on one.

**Marketing landing.** Sells the operator's instance ("invite-only — sign in
if you have an account"), served script-free under `LOCKED_CSP` at `/` with
screenshot assets in `public/`. A self-hoster inherits a decent front door or
replaces one HTML constant. Zero premium logic; the footer's OSS claim was
already corrected (`1f51ca4`). Hosted-operational, trivially MIT.

## Premium candidates — unchanged, all future work

Nothing on this branch is a premium candidate. The real candidates remain the
premium doc's three, all _additive_ and all **not yet in this repo**:

- **Managed MCP server** — a separate hosted Worker against the public API.
  Going premium moves _nothing_: no route, table, or UI here belongs to it.
  (The third-party MCP server that already exists in the wild proves the
  public-API path works, which is the MIT promise.)
- **AI drafting/summaries** — would add a forwarding route
  (`/api/:slug/admin/ai/*`) + upsell card; no existing code moves.
- **Stripe invoicing** — premium worker owns Stripe; it writes results back
  through the existing admin API into the existing `Payments` table
  (`Method='card'` already passes the CHECK). Seam is one gated admin action
  plus one upsell state; `Payments`, earnings analytics, and the balance math
  stay MIT untouched.

**Seam confirmation:** none of this branch's routes (`signup.ts`, `owner.ts`,
calendar/pet-type/capacity endpoints in `admin.ts`), tables (0012–0015), or
UI would move or gate under any of the three candidates. Nothing needs to
move now; nothing built here is crippleware-risk if it stays.

## Did this branch change the premium calculus?

One thing: **"hosted signup" is no longer deferred — invite-only signup IS
it.** The premium doc assumed the `Tenants.Plan` column "can ride along with
the hosted-signup work." That work has now shipped _without_ Plan, so the
ride-along moment passed. Assessment: still fine. Every tenant today is
`NULL` (= free); adding a nullable column later is the same ~10-line
migration it always was, and `POST /api/signup/complete` is now the obvious
single call site where a plan would first be assigned — the seam got
_easier_ to find, not harder. Two bookkeeping corrections to carry forward:

- The premium doc's migration numbers are stale: it reserved `0013` for
  Plan, but 0013–0015 are now spent. Plan becomes `0016_tenant_plan.sql` (or
  whatever is next free) when it happens.
- The doc's "update the landing FAQ when hosted signup ships" trigger has
  fired; the rebuilt landing already reflects invite-only signup and the
  corrected OSS footer, so no action remains.

## Recommended actions now

1. **None beyond the premium doc's existing now-list.** No code moves, no
   license change, no `entitlements.ts`, no premium repo — everything built
   on this branch stays MIT in this repo.
2. **Keep the `Plan` column deferred** until the first premium feature (or
   billing) exists; note the migration number drift (`0016`, not `0013`)
   when writing it.
3. **Preserve the two instance-level tables' documented-exception status**:
   `OwnerUsers`/`AllowedSitters` are the only non-tenant-scoped tables;
   any future premium worker must not grow a third exception — premium
   state lives in the premium worker's own storage, per the architecture doc.
