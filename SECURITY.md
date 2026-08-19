# Security Policy

Pawservation handles authentication (signed session tokens, hashed passwords) and multi-tenant data
isolation, so we take security reports seriously.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** to open a private advisory.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (proof of concept if possible).
- Affected version/commit.

We aim to acknowledge reports within a few days and will keep you updated on remediation.

## Scope

Security-relevant areas include:

- Session token signing/verification (`server/lib/token.ts`) and the `TOKEN_SECRET`.
- Password hashing (`server/lib/password.ts`).
- Cross-tenant data isolation (tenant resolution + per-tenant queries).
- The embed loader's `postMessage` handling (`public/embed.js`).
- SQL query construction (`server/db/`).

## Operational guidance for self-hosters

- Always set a strong, unique `TOKEN_SECRET` via `wrangler secret put` — never use the
  development placeholder in production. The Worker refuses to serve (HTTP 503) when
  `TOKEN_SECRET` is unset or left at the known insecure default.
- Rotate `TOKEN_SECRET` if you suspect exposure (note: this invalidates all active sessions).
- Bind only the dedicated D1/KV resources for this app; never bind unrelated production
  resources.

## What we log, and what we never log

Logs go to Cloudflare Workers observability (`wrangler tail`, and the Logs tab in the dashboard).
There is no third-party log sink, so a log line is readable by whoever can reach the Cloudflare
account and by nobody else. Two channels:

- `console.error('<something> failed', …)` — the product broke. Always an event name first, so the
  tail is greppable.
- `console.warn('security', { event, … })` — a credential was refused or a cap was hit
  (`lib/log.ts`). Separate from errors on purpose: these want a different alert, and mixing them
  means the interesting one is buried under calendar-sync noise.

A tripped cap is reported once per window rather than once per refused request: the limiter exists
to make abusive traffic cheap, and a line per refusal hands an unauthenticated caller a dial on how
much log to generate. `email not configured` is the one line worth alerting on outright — it means
the `RESEND_*` secrets are unset on a production deploy, which takes login, password reset and
signup down together while each answers something that reads like a passing outage.

**Never in a log line, in either channel:** a credential or any prefix/suffix/hash of one; an
email address, name, phone, or street address; a request's query string; a rate-limit key (ours
are built from the caller's email and IP, so the key _is_ the PII); or an upstream response body
verbatim. Third-party errors are lifted down to their machine-readable code first — see
`describeTokenError` (Google) and `describeResendError` (Resend), which exist for exactly this.

A request is identified by its Cloudflare ray id (`requestContext` in `lib/log.ts`), never by
anything about the person making it. The ray is also how a log line here is joined to one in the
premium worker, which calls this API on the caller's behalf.

## Known limitations (current release)

These are tracked and slated for upcoming phases. Until then, **do not use this with real
customer data** beyond demos:

- **Customer login codes are returned in the API response, not emailed.** Email delivery
  arrives in Phase 2; until then, end-user email verification provides no real assurance and
  anyone who knows an email can obtain a session for it.
- **No rate limiting / lockout on authentication endpoints.** Admin password login and
  end-user code verification accept unlimited attempts. Add Cloudflare Rate Limiting (or a KV
  attempt counter) before any real-data deployment.
- **Booking confirmation is check-then-insert without a transaction**, so two concurrent
  requests can both pass the availability check and slightly overbook a day. A
  Durable-Object-per-tenant serialization will close this in a later phase.
