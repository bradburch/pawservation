# Invite-only sitter signup + owner console — design

**Date:** 2026-07-18
**Status:** Approved — amended (security behavior differs from ship), see below
**Branch:** `custom-services`

> **Amended 2026-07-20:** Two security-relevant descriptions here do not match the code that
> shipped. Read the code (`server/routes/signup.ts`, `server/db/repo.ts`) as authoritative:
>
> - **Rate limiting is a TRUE fixed window, not a TTL-refresh counter.** This spec describes the
>   limiter as "incremented with `expirationTtl: 3600`" — which alone is a rolling lockout where
>   every retry (including over-cap ones) pushes the expiry out, so a capped user never ages out.
>   The shipped `checkAndBumpRateLimit` stores `windowStart` **inside** the KV value and resets
>   only when `now - windowStart >= TTL`; `expirationTtl` is pure garbage collection, not the
>   window boundary.
> - **Provisioning is atomic-plus-compensation, not purely atomic.** The `db.batch()` aborts on
>   the `TenantUsers.Email UNIQUE` replay path (as described), but the claim `UPDATE ... WHERE
ClaimedAt IS NULL` can match **zero rows** (invite revoked mid-flight) without aborting the
>   batch — the Tenants/TenantUsers rows land regardless. `createTenantFromSignup` returns
>   `false` in that case and the route calls `rollbackUnclaimedTenant` to delete the orphaned
>   tenant (`repo.ts` + `signup.ts`). "No orphan tenant" holds only because of that rollback.

## Problem

There is no way to become a Pawbook sitter without the operator hand-writing SQL
(`Tenants` + `TenantUsers` rows with a pre-hashed password). The landing page
already says "invite-only — sign in if you have an account" (`df4f9f2`), but
nothing backs that up: no invite list, no signup flow, and no surface for the
platform owner to manage who may join. This design adds the smallest hosted
signup that keeps the platform gated: an owner-managed email allowlist, an
emailed one-time setup link, a create-password page that provisions the tenant,
and an owner console inside the existing admin app.

### Decisions locked

- **Allowlist-gated, not open signup.** Only emails the platform owner has
  added can create accounts.
- **Owner identity = `OWNER_EMAILS` secret** (comma-separated). Owners use the
  same login form; an owner email routes to the owner console. Owner passwords
  live in a new instance-level `OwnerUsers` table and are set via the same
  emailed-link flow (gated on `OWNER_EMAILS` membership instead of the
  allowlist).
- **Allowlist stores email only** (`AllowedSitters`). The tenant is created at
  claim time, not at allowlist time.
- **An invite is not pushed** — the sitter starts it: the owner allowlists the
  email out-of-band, the sitter enters their email on the login page, and the
  setup link is emailed. Post-feature journey: owner allowlists → sitter enters
  email → emailed link → business name + password → dashboard → onboarding
  wizard auto-opens (existing zero-enabled-services behavior).

## Data model

Migration `migrations/0013_invite_signup_owner_console.sql`, with
`sql/schema.sql` updated in lockstep (fresh installs come from `schema.sql`;
already-provisioned DBs get `0013` applied by hand, per `migrations/README.md`).

Both tables are **instance-level — a deliberate, documented exception** to the
"TenantId on every table" invariant: they exist to gate entry into the tenancy
model, so they cannot themselves be tenant rows. A schema comment says so.

```sql
-- Platform-owner accounts (instance-level, deliberately NOT tenant-scoped).
-- Membership is governed by the OWNER_EMAILS secret; this table only stores
-- the password hash for emails that secret already names.
CREATE TABLE IF NOT EXISTS OwnerUsers (
  Id TEXT PRIMARY KEY,
  Email TEXT NOT NULL UNIQUE,
  PasswordHash TEXT NOT NULL,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner-managed signup allowlist (instance-level, deliberately NOT tenant-
-- scoped). TenantId/ClaimedAt stay NULL until the sitter completes setup.
CREATE TABLE IF NOT EXISTS AllowedSitters (
  Email TEXT PRIMARY KEY,
  AddedAt TEXT NOT NULL DEFAULT (datetime('now')),
  ClaimedAt TEXT,
  TenantId TEXT REFERENCES Tenants(Id)
);
```

Emails are normalized (trim + lowercase, `EMAIL_RE`) before every read/write of
either table, matching the login-route normalization.

## Config

- **`OWNER_EMAILS`** — new secret (`wrangler secret put OWNER_EMAILS`, plus
  `.dev.vars` for local; `npm run typecheck` regenerates the `Env` type).
  Parsed as comma-separated, each entry trimmed + lowercased. Unset/empty ⇒ no
  owners ⇒ owner console unreachable (safe default; sitter flows unaffected).
- An email in `OWNER_EMAILS` is an owner, full stop — at login it always routes
  to the owner console, so owner emails must not double as sitter logins.
  `POST /api/owner/allowlist` rejects `OWNER_EMAILS` members (400) to keep the
  two populations disjoint.

## Signup link (signed, single-use, expiring)

New `server/lib/signup-link.ts`, mirroring `server/lib/oauth-state.ts` exactly
(same base64url + HMAC-SHA256 shape, constant-time compare) with its own HKDF
info label `pawbook-signup-link` for domain separation — a signup link can
never verify as an OAuth state or vice versa.

- Payload: `{ email, kind: 'sitter' | 'owner', nonce, exp }`; TTL **30 min**.
- **Single-use:** at issue, `signup:nonce:{nonce}` is written to
  `PAWBOOK_CACHE` with a matching `expirationTtl`; at completion the nonce is
  read (missing ⇒ expired/used ⇒ reject) and deleted before provisioning —
  the same consume-on-use pattern as the OAuth callback.
- Link URL: `{origin}/setup?t={token}` (origin from the request URL, like the
  invite email's widget URL).

## Routes

All new routes are non-slug-scoped, so `'signup'` and `'owner'` join `'admin'`
in `RESERVED_SLUGS` (`server/lib/middleware.ts`) — `tenantMiddleware` passes
them through, and no tenant can ever claim those slugs (enforced again at slug
generation, below).

### `POST /api/signup/start` — public (new `server/routes/signup.ts`)

Body `{ email }` (valibot, `EMAIL_RE` pipe per the `routes/auth.ts` reference
pattern). **Always returns the same `200 { ok: true }` body** regardless of
allowlist state — no user enumeration. Timing is neutralized structurally: the
response is sent immediately and all email-dependent work runs in
`c.executionCtx.waitUntil(...)` (the calendar-sync precedent), so response time
cannot depend on whether the email is invited. Inside the deferred work:

1. If email ∈ `OWNER_EMAILS` and no `OwnerUsers` row exists → mint an
   `'owner'` link and send it.
2. Else if email is an **unclaimed** `AllowedSitters` row → mint a `'sitter'`
   link and send it.
3. Else do nothing. Send failures are logged and swallowed (the 200 already
   went out; the invitee simply retries).

**Local-dev degrade** (mirrors `routes/auth.ts`): when email is unconfigured
and `ENVIRONMENT === 'development'`, the check runs inline and the response
includes `prototypeLink` for eligible emails so demos work with a blanked
`RESEND_API_KEY`. When email is unconfigured outside development → `503`
(fail closed, same posture as `/identify`; reveals nothing per-email).

**Rate limiting** — no existing pattern in the repo (checked: `PAWBOOK_CACHE`
is used only for tenant cache, OAuth nonces, and calendar-sync throttling), so
per the simple-KV-counter decision: key `signup:rl:{email}:{ip}` (IP from
`CF-Connecting-IP`), incremented with `expirationTtl: 3600`, cap **5/hour**.
Over the cap → the same neutral `200` with the send skipped, so the limiter
itself is not an oracle. KV increments are not atomic; fine for a soft limit.

### `POST /api/signup/complete` — public

Body `{ token, password, businessName? }`. Verify HMAC + `exp`, consume the KV
nonce, then branch on `kind`:

**Sitter** (`businessName` required):

1. Slug = `slugifyServiceLabel(businessName)` (the existing generic slugifier
   in `server/lib/services.ts`). Empty result → 400 ("name needs letters or
   numbers"). If the slug is in `RESERVED_SLUGS` or taken
   (`getTenantBySlug`), append `-2`, `-3`, … until free.
2. **Atomic provisioning via one `db.batch()`** (the `deleteService`
   precedent; the test shim's batch is transactional):
   `INSERT Tenants` → `INSERT TenantUsers` (PBKDF2 via `hashPassword`) →
   `UPDATE AllowedSitters SET ClaimedAt = ?, TenantId = ? WHERE Email = ? AND
ClaimedAt IS NULL`. A replay that beat the nonce race dies on
   `TenantUsers.Email UNIQUE`, aborting the whole batch → `409` ("already set
   up — sign in instead"). New tenants get `DisplayName = businessName` and
   all-NULL limits (null = unlimited/instance-default, per invariant); no
   services are seeded — the onboarding wizard owns that.
3. Mint an admin token (`mintAdminToken`) and return
   `{ token, role: 'admin', slug, displayName }`.

**Owner** (no `businessName`): re-check email ∈ `OWNER_EMAILS` (the secret may
have changed since issue) and no existing `OwnerUsers` row (`Email UNIQUE`
guards the race) → insert the row → mint an owner token → return
`{ token, role: 'owner', email }`.

**Password floor:** no rule exists today (sitters were SQL-provisioned with
pre-hashed passwords), so this introduces the minimal one: **≥ 8 characters**,
enforced server-side here and mirrored client-side (confirm field is
client-only UX).

### Login + session (`server/routes/admin-auth.ts`)

- `POST /api/admin/login`: normalize email; if it ∈ `OWNER_EMAILS`, look up
  `OwnerUsers` and verify against the row's hash **or `DUMMY_PASSWORD_HASH`**
  when absent — exactly one PBKDF2 derive on every path, preserving the
  constant-time posture — then mint an owner token and return
  `{ token, role: 'owner', email }`. Otherwise the existing sitter path runs
  unchanged, its response gaining only `role: 'admin'` (additive).
- `GET /api/admin/session`: try `verifyAdminToken` first (existing response +
  `role: 'admin'`); else try `verifyOwnerToken` → `{ role: 'owner', email }`;
  else 401.

### Owner console API (new `server/routes/owner.ts`, owner-token-gated)

New `ownerAuth` middleware in `server/lib/middleware.ts` (Bearer +
`verifyOwnerToken`).

- `GET /api/owner/allowlist` →
  `{ entries: [{ email, addedAt, claimedAt, tenantSlug }] }` (LEFT JOIN
  `Tenants` for the slug; `tenantSlug` null until claimed).
- `POST /api/owner/allowlist` `{ email }` → validate; reject `OWNER_EMAILS`
  members (400); idempotent — re-adding returns the existing row (the
  customer-invite precedent). No email is sent: the sitter initiates from the
  login page.
- `DELETE /api/owner/allowlist/:email` → **unclaimed rows only**; claimed →
  `409` ("already has an account"). Tenant deletion is out of scope.

## Tokens (`server/lib/token.ts`)

New `OwnerClaims = { sub, role: 'owner', exp }` (no `tid` — owners are
instance-level) with `mintOwnerToken` / `verifyOwnerToken`, reusing
`ADMIN_TOKEN_TTL_SECONDS` (8 h). Cross-audience safety holds by construction:
`verifyToken` rejects any `role`, `verifyAdminToken` requires `role: 'admin'`,
`verifyOwnerToken` requires `role: 'owner'` — and owner tokens carry no `tid`,
so `adminAuth`'s tenant match can never pass either.

## Create-password page: fourth small Vite bundle

**Decision: a fourth Vite bundle (`setup.html` + `app/setup/`), not a
server-rendered form** — completing setup must put the admin token into
`localStorage` (`pawbook-admin-token`) for the dashboard handoff, which a
script-free page can only do by leaking the token through a URL, and the repo
already has the exact multi-input Vite pattern to extend. `LOCKED_CSP` allows
same-origin bundles (the admin app already runs under it); only _inline_
script is barred, so the landing-page "script-free" rule does not apply here.

Wiring: `vite.config.ts` input `setup`, `app.get('/setup', page('setup.html'))`
in `server/index.ts`, `"/setup"` added to `run_worker_first` in
`wrangler.jsonc`.

The page reads `t` from the query string and **decodes (without verifying) the
payload** purely to pick the variant and display the email — the server is the
only verifier:

- **Sitter:** business name + password + confirm → `POST /api/signup/complete`
  → store token → `location.href = '/admin'` (dashboard loads, wizard
  auto-opens on zero enabled services — no wizard changes needed).
- **Owner:** password + confirm only → same, landing on the owner console.
- Missing/expired/used token → friendly copy: "This link has expired or was
  already used — enter your email on the sign-in page to get a fresh one",
  linking `/admin`.

## Admin app (`app/admin/App.tsx`, existing bundle)

- `Session` gains `role: 'admin' | 'owner'` (owner sessions have no slug);
  login and session-restore branch on it: `role === 'owner'` renders a new
  `OwnerConsole` component instead of `Dashboard`.
- **OwnerConsole** (non-technical copy): heading "Who can join Pawbook"; add
  form ("Add a sitter's email — then tell them to go to the sign-in page and
  enter it"); table of entries with a status chip — "Waiting to join" /
  "Joined → {tenantSlug}" — and a Remove button on unclaimed rows only.
- **Login page** gains "New here? Enter your email to get set up" → inline
  email field → `POST /api/signup/start` → always the neutral "Check your
  email — if you've been invited, a setup link is on its way." (dev: renders
  `prototypeLink` when present, mirroring the widget's `prototypeCode`).

## Email (`server/lib/email.ts`)

`sendSignupLink(env, to, url)` mirroring `sendLoginCode`: subject "Finish
setting up your Pawbook account", body = one link + "expires in 30 minutes; if
you didn't request this, ignore it". URL is server-built; HTML-escaped anyway
(defense-in-depth, per `sendInvite`).

## Repo layer (`server/db/repo.ts`)

New functions in a **clearly-marked owner-scope section** at the bottom of the
file, headed by a comment stating these are the only functions exempt from the
tenantId-first rule (instance-level tables) and why; D1 access still lives
only in `repo.ts`:

- `getOwnerUserByEmail(db, email)`, `insertOwnerUser(db, id, email, hash)`
- `getAllowedSitter(db, email)`, `listAllowedSitters(db)` (with tenant-slug
  join), `addAllowedSitter(db, email)`,
  `deleteUnclaimedAllowedSitter(db, email)` (guarded `WHERE ClaimedAt IS NULL`)
- `createTenantFromSignup(db, { tenantId, slug, displayName, userId, email,
passwordHash })` — the three-statement atomic batch above.

## Security summary

- **Enumeration-neutral:** `signup/start` returns one body for every input and
  defers all divergent work behind the response; login keeps the existing
  single-PBKDF2 constant-time discipline on both sitter and owner paths
  (`DUMMY_PASSWORD_HASH` on every miss).
- **Links:** HMAC-signed (HKDF-separated key), 30-min expiry, single-use via
  KV consume — the OAuth-state design, reapplied.
- **Passwords:** PBKDF2 via the existing `hashPassword` (600k iterations).
- **Role gating:** `role: 'owner'` claims verified by a dedicated middleware;
  owner/admin/widget tokens are mutually unacceptable by claim shape.
- **Rate limiting:** KV counter per email+IP on `signup/start` (no prior
  pattern existed), neutral over-cap behavior.
- **Reserved slugs** extended so signup/owner routes and generated tenant
  slugs can never collide.

## Testing (Vitest, real schema via `createTestEnv`)

`createTestEnv` gains `OWNER_EMAILS` (e.g. `'owner@pawbook.test'`); the KV shim
ignores TTLs, so expiry tests inject `now` (the `verifyState` precedent).
Seed `sql/seed.sql` with one unclaimed `AllowedSitters` row for demos/tests.

- **`signup.test.ts`** — enumeration-neutrality: identical status+body for
  allowlisted, claimed, unknown, and owner emails; dev `prototypeLink` only
  for eligible emails; rate-limit cap returns the neutral body and skips the
  send; expired link rejected (injected now); nonce consumed — second
  `complete` with the same link → 409/reject; tampered HMAC rejected.
- **Atomic provisioning** — `complete` creates Tenant + TenantUser + claims
  the allowlist row in one batch; slug collision yields `-2` suffix; reserved
  slug ("Admin") skipped; duplicate replay aborts the whole batch (no orphan
  tenant — assert row counts); new sitter can immediately log in via the real
  `/api/admin/login`.
- **Owner flow** — owner `start`→`complete` creates `OwnerUsers`; owner login
  returns `role: 'owner'`; owner token passes `ownerAuth` but is rejected by
  `adminAuth` and `endUserAuth` (and vice versa for admin/widget tokens);
  `/admin/session` reports the right role for both token kinds.
- **Allowlist CRUD** — add is idempotent; add rejects `OWNER_EMAILS` members;
  remove deletes unclaimed, 409s claimed; list shows claimed status +
  tenant slug; all endpoints 401 without an owner token.

## Out of scope (fast-follows noted)

- Open (un-gated) signup, billing/plans, tenant deletion, email change.
- **Password reset for existing users** — explicitly a fast-follow: the same
  signed-link mechanism with a `kind: 'reset'` payload covers it.
- Courtesy email on allowlist add (the sitter initiates; revisit if sitters
  stall at the "enter your email" step).
- Owner management of tenants beyond the allowlist (rename/suspend/delete).
- Landing-page copy — already shipped in `df4f9f2`; unchanged here.
