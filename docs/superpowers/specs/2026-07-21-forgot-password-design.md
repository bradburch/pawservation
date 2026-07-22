# Forgot-password flow — design spec

Date: 2026-07-21

## Problem

Neither auth system (owner console, sitter dashboard) has a password-recovery path. A locked-out
owner or sitter has no way back in short of a manual DB write. This surfaced when an owner-signup
attempt failed with "This email is already set up — sign in instead." — investigation (see
Appendix) ruled out a duplicate account, a missing migration, and schema drift, but the error path
that produced the message swallows the real D1 error with no logging, so the true cause of that
specific failure is not recoverable after the fact. Regardless of that root cause, the missing
recovery path is a real gap and is what this spec addresses.

## Approach: extend the existing invite-signup machinery

`server/routes/signup.ts` + `server/lib/signup-link.ts` already implement almost exactly what
password reset needs: a signed, single-use, TTL-bound email link, enumeration-neutral request
endpoint, and a "finish on this page" completion screen. Rather than building a parallel system,
reset reuses this machinery:

- **`lib/signed-link.ts`** (new): the generic sign/verify plumbing (base64url payload + HMAC-SHA256
  signature, HKDF-derived key from `TOKEN_SECRET`, parameterized by an HKDF info label) extracted
  out of `signup-link.ts`. `signup-link.ts` becomes a thin wrapper calling this with label
  `'pawbook-signup-link'`; a new `reset-link.ts` wraps it with label `'pawbook-reset-link'`. Domain
  separation is load-bearing, not cosmetic: a leaked reset link must never verify as a signup link
  or vice versa, matching the security property `signup-link.ts` already documents relative to
  `oauth-state.ts`.
- **`lib/rate-limit.ts`** (new): `checkAndBumpRateLimit` lifted out of `signup.ts` unchanged — it's
  already generic (KV fixed-window counter, not signup-specific) and the reset endpoints need the
  identical per-email+IP soft cap.
- **`server/routes/password-reset.ts`** (new): two endpoints mirroring `signup/start` +
  `signup/complete`.
- **`app/setup/App.tsx`**: extended, not replaced. Reset links are a structurally distinct
  signed-link type (`server/lib/reset-link.ts`, its own HKDF label `'pawbook-reset-link'`) rather
  than a variant of the signup payload; `/setup` tells the two apart via a plain `?reset=1` URL
  marker the server appends when minting the link (not part of the signed payload — the server
  fully controls it, so it carries no additional trust requirement). When the marker is present
  the page skips the business-name field and posts to the reset-complete endpoint instead of
  signup-complete.
- **`app/admin/App.tsx`**: `Login` gets a "Forgot password?" toggle, structurally identical to the
  existing "New here?" signup toggle.

## Data flow & endpoints

### `POST /api/password-reset/start`

Body: `{ email }`.

Mirrors `signup/start` exactly:

1. Normalize email (trim + lowercase).
2. Soft rate limit via `checkAndBumpRateLimit`, keyed `pwreset:rl:{email}:{ip}` (separate counter
   namespace from signup's `signup:rl:*`, so the two flows don't share a budget).
3. Respond `{ ok: true }` **immediately** — enumeration neutrality is structural, not
   best-effort: the response fires before the account lookup, exactly like `signup/start`'s
   `waitUntil` pattern. No branch on this endpoint may make response timing or shape depend on
   whether the email has an account.
4. After the response: look up `OwnerUsers` first (an owner email never doubles as a sitter
   login, matching `eligibleKind`'s existing precedence), else `TenantUsers`. If either matches,
   mint a reset link (`kind: 'owner' | 'sitter'` per which table matched, signed via
   `reset-link.ts`'s distinct HKDF label with a `?reset=1` URL marker appended) and email it via a
   new `sendResetLink` in `lib/email.ts`. No match → do nothing.
5. Local-dev (no email provider configured): same inline/`prototypeLink` degrade as
   `signup/start`, so `npm run dev` demos keep working without real email.

### `POST /api/password-reset/complete`

Body: `{ token, password }`.

1. Enforce `MIN_PASSWORD_LENGTH` (imported from `signup.ts`, not duplicated) before touching the
   token, same ordering rationale as signup-complete (a policy rejection must not burn the
   single-use link).
2. Verify the link (`reset-link.ts`); reject expired/invalid with the same `EXPIRED_ERROR` copy
   signup uses.
3. Consume the KV nonce (`pwreset:nonce:{nonce}`, separate namespace from signup's
   `signup:nonce:*`) before writing — single-use, consume-before-provision, matching signup's
   OAuth-callback-style pattern.
4. Hash the new password, then update the matching row: `updateOwnerPasswordHash` or
   `updateTenantUserPasswordHash` depending on `payload.kind`.
5. If zero rows changed (account was deleted between link-send and completion), return
   `EXPIRED_ERROR` — same handling as signup-complete's `rollbackUnclaimedTenant` "invite vanished
   mid-flight" case.
6. On success, mint a session token (`mintOwnerToken` / `mintAdminToken`) and return it directly —
   the user is logged in immediately, no separate "now sign in" step, matching signup-complete's
   UX.

### Repo layer (`server/db/repo.ts`)

Two new functions, same shape as the existing owner-scope functions (`insertOwnerUser` et al.):

```
updateOwnerPasswordHash(db, email, passwordHash): Promise<boolean>   // true = a row changed
updateTenantUserPasswordHash(db, email, passwordHash): Promise<boolean>
```

`UPDATE ... SET PasswordHash = ? WHERE Email = ?`, returning whether `meta.changes > 0`.

### Routing

- Mount `passwordResetRoutes` at `/api` in `server/index.ts`, next to `signupRoutes`.
- Add `'password-reset'` to `RESERVED_SLUGS` in `server/lib/middleware.ts` so
  `tenantMiddleware` passes `/api/password-reset/*` through un-scoped (same treatment as
  `'signup'`).

## UI changes

### `app/admin/App.tsx` (`Login`)

A "Forgot password?" toggle next to the existing "New here?" toggle, same interaction shape:
click reveals an email field + "Send reset link" button → `POST /api/password-reset/start` →
neutral copy ("If that email has an account, a reset link is on its way") + the same
`prototypeLink` dev-mode escape hatch the signup toggle already renders.

### `app/setup/App.tsx`

Extended, not duplicated. Reset links are a structurally distinct signed-link type
(`server/lib/reset-link.ts`, its own HKDF label `'pawbook-reset-link'`) rather than a variant of
`SignupPayload`. `/setup` distinguishes signup vs. reset via a plain `?reset=1` URL marker the
server appends when minting the link — it is not part of the signed payload, so the server fully
controls it and it carries no additional trust requirement. When the marker is present:

- Business-name field is skipped regardless of `kind` (sitter or owner).
- Heading reads "Reset your password".
- Submit posts to `/api/password-reset/complete` instead of `/api/signup/complete`.

Everything else — expired-link handling, password/confirm fields + client-side min-length check,
token-in-localStorage-then-redirect-to-`/admin` — is unchanged.

## Security posture

- **Enumeration neutrality**: non-negotiable on `/password-reset/start`, per the codebase's
  established posture for every identity-adjacent endpoint (`/signup/start`, customer
  `/identify`).
- **Domain separation**: reset links carry a distinct HKDF label from signup links (and from
  `oauth-state.ts`), so token types can never be replayed across flows.
- **Rate limiting**: same soft per-email+IP cap as signup, separate KV counter namespace.
- **Single-use + TTL**: same nonce-consume-before-write pattern, same 30-minute TTL as signup — no
  reason to diverge.
- **No session revocation**: explicitly out of scope. The codebase has no server-side session
  revocation anywhere today (admin/owner tokens expire on their own TTL only); a password reset
  does not invalidate other active sessions on that account. This is a deliberate omission, not an
  oversight — building revocation infrastructure for this one feature would be scope creep.

## Incidental fix (same code path, folded into this work)

Both `catch` blocks in `signup.ts` that map a DB error to `ALREADY_SET_UP_ERROR` (owner insert and
sitter `createTenantFromSignup`) currently discard the real error with no logging. Add
`console.error` in both, so a future occurrence of "already set up" leaves a diagnostic trail in
Worker logs instead of vanishing. This does not change response behavior, only observability.

## Testing

Mirrors the existing `signup.test.ts` / `signup-link.test.ts` coverage shape, against the real
in-memory SQLite harness (`server/__tests__/helpers.ts`):

- `/password-reset/start` is enumeration-neutral for both a known and an unknown email (identical
  response shape/timing-relevant code path).
- `/password-reset/complete` rejects an expired token, a reused (already-consumed) token, and a
  token whose account no longer exists (zero rows changed).
- `/password-reset/complete` actually updates `PasswordHash` on the correct table for both
  `kind: 'owner'` and `kind: 'sitter'`, and the new hash verifies via `verifyPassword`.
- Reset links and signup links are not interchangeable (a signup-link token fails
  `reset-link.ts` verification and vice versa).
- Rate limit trips after `RATE_LIMIT_MAX` attempts for the same email+IP.

## Out of scope

- Session revocation on reset (see above).
- Rate-limiting or throttling password-reset _attempts_ beyond the existing link TTL + single-use
  (i.e., no separate lockout on repeated wrong passwords — that's the existing login endpoint's
  concern, unchanged by this work).
- Any change to the customer-facing (widget) login, which already uses a different mechanism
  (email code, not password).

## Appendix: investigation of the triggering incident

Before landing on this design, the reported "already set up" error was investigated against
production:

1. `SELECT ... FROM OwnerUsers WHERE Email = 'bradburch@duck.com'` → no row. Not a duplicate
   account.
2. `SELECT name FROM sqlite_master WHERE type='table' AND name='OwnerUsers'` → table exists. Not a
   missing migration.
3. `PRAGMA table_info(OwnerUsers)` → columns match `sql/schema.sql` exactly. Not schema drift.
4. `wrangler.jsonc` has a single environment with one D1 binding — no environment/database
   mismatch between the CLI and the deployed Worker.

The literal cause remains unknown because the code path that produced the error
(`insertOwnerUser`'s caller in `signup.ts`) discards the underlying exception with no logging — see
"Incidental fix" above. This spec's forgot-password flow gives the user (and any future locked-out
account) a recovery path independent of ever root-causing that specific incident.
