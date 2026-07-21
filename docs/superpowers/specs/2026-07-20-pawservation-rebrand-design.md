# Pawbook → Pawservation full rebrand — design

**Date:** 2026-07-20
**Status:** Proposed
**Branch:** `pawservation-rebrand`

## Problem

The owner has chosen a new product name: **Pawservation** (paw + reservation), a
full rebrand of what is currently "Pawbook". Domains `pawservation.com` /
`pawservation.app` are being registered by the owner. The name is currently woven
through the codebase in ways that range from trivially renameable (marketing
copy) to actively dangerous to touch (HKDF domain-separation labels, the Google
Calendar event marker, embed snippets already pasted into sitters' websites).

This spec inventories every occurrence, splits the rebrand into **Phase 1** (a
code PR on this branch: every _user-visible_ occurrence becomes Pawservation,
with compatibility shims where the old name is a live contract) and **Phase 2**
(an operational runbook the owner executes: domains, Cloudflare, Resend, Google
OAuth, GitHub), and documents exactly which occurrences stay "pawbook" forever —
and why.

## Name footprint inventory

`grep -ri pawbook` (excluding `.git`, `node_modules`, `dist`) → **572 hits**
across ~100 files, categorized:

| Category                                                                                                                                                                                                               | ~Hits                   | Disposition                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `PAWBOOK_DB` / `PAWBOOK_CACHE` bindings + `pawbook-db` D1 name (repo.ts, tests, env types, wrangler.jsonc, package.json scripts, migrations)                                                                           | 415                     | **Keep** — internal (bindings) / Phase 2 decision (names), see exceptions                              |
| Historical specs in `docs/superpowers/specs/`, migration comments                                                                                                                                                      | ~85                     | **Keep** — historical record                                                                           |
| User-visible brand copy: landing (`server/index.ts`, 13), admin UI (~11), signup email (3), README/CONTRIBUTING/SECURITY/docs pages (~15), `.github` issue templates (3)                                               | ~45                     | **Phase 1 rename**                                                                                     |
| Embed integration contract: `data-pawbook-tenant` attribute, `pawbook:resize` / `pawbook:booked` postMessage types + DOM event (embed.js, snippet.ts, landing snippet display, demo.html, EmbedSection, snippet tests) | 20                      | **Phase 1 rename with permanent legacy support**                                                       |
| Client storage keys: `pawbook-admin-token` (localStorage), `pawbook-embed-token:<slug>` (sessionStorage), popup window name `pawbook-gcal`                                                                             | 6                       | **Phase 1 rename with migrate-once fallback**                                                          |
| Crypto/persistence identifiers: HKDF info labels `pawbook-oauth-state`, `pawbook-signup-link`, `pawbook-gcal-token`; cookie `pawbook_gcal_nonce`; Google Calendar event marker `extendedProperties.private.pawbook`    | ~15                     | **Keep forever** — see exceptions                                                                      |
| Demo/test fixtures: `owner@pawbook.test`, `newsitter@pawbook.test` (seed.sql + test helpers), `RESEND_FROM: 'Pawbook <…>'` test fixtures                                                                               | ~25                     | **Phase 1 rename** (fixtures, cheap)                                                                   |
| GitHub repo URLs `github.com/bradburch/pawbook` (README badge, landing footer, HelpSection, SECURITY, issue-template config)                                                                                           | ~10                     | **Keep until Phase 2** repo rename, then sweep                                                         |
| CSS custom-property prefix `--bp-*`, class prefixes `pb-`/`bp-`                                                                                                                                                        | 230+ in admin.css alone | **Keep** — internal, no user impact                                                                    |
| Misc internal: `.claude/skills/running-pawbook`, code comments, `package.json` name                                                                                                                                    | ~20                     | Keep skill dir; comments updated opportunistically; package name renamed (private, unpublished — free) |

### Surprises found during inventory

1. **The embed snippet is a deployed public contract.** `data-pawbook-tenant`
   is in `<script>` tags already pasted into sitters' CMS pages, and
   `pawbook:booked` is a documented DOM event host pages may listen to
   (README). These cannot simply be renamed — legacy support is permanent.
2. **Google Calendar events are tagged `private.pawbook = 'true'`**
   (`server/lib/google-calendar.ts:158`). Reconcile/delete-sync identifies
   our events by this marker. Renaming it orphans every event already written
   to sitters' calendars. It stays, forever, and is invisible to users.
3. **Three HKDF info labels embed the old name** (`pawbook-gcal-token`,
   `pawbook-signup-link`, `pawbook-oauth-state`). Changing `pawbook-gcal-token`
   would make every encrypted Google refresh token at rest undecryptable;
   changing the others voids outstanding signup links / in-flight OAuth states.
   All stay, forever.
4. **The screenshots do not show the name.** All five landing images
   (`public/img/landing/*.webp`) were inspected: widget hero, three step crops,
   admin bookings crop. None renders "Pawbook" — the widget brands as the
   _tenant_ ("How can I help, Jess?"), by design. **No regeneration needed.**
5. **`admin.html` / `embed.html` / `setup.html` titles don't contain the name**
   ("Tenant admin", "Book with us", "Set up your account"). Only the landing
   `<title>` in `server/index.ts` and the two `docs/*.html` pages do.
6. **`.github/workflows/` has zero occurrences** — CI needs no changes.
7. **The email sender display name lives in the `RESEND_FROM` secret**, not in
   code — Phase 2. Only one email template hardcodes the name (signup link,
   `server/lib/email.ts:93–95`); booking-status/invite/login emails brand as
   the tenant's display name already.

## Phase 1 — the code PR (this branch)

Every user-visible "Pawbook" becomes "Pawservation". By surface:

### Plain copy renames (no mechanism needed)

- **Landing** (`server/index.ts`): `<title>`, `<h1 class="brand">`, body copy,
  FAQ, OSS footer text, `mailto:` subjects (`Pawbook%20invite`), hero image
  `alt` text. GitHub _URLs_ stay (Phase 2).
- **Admin UI**: `OwnerConsole.tsx` ("Who can join Pawbook", header comment),
  `AppsSection.tsx`, `ServiceEditor.tsx` (two capacity hints),
  `PaymentsPanel.tsx`, `HelpSection.tsx` (five mentions; the
  `github.com/bradburch/pawbook` link and its literal URL text stay until
  Phase 2 — they are accurate today).
- **Email** (`server/lib/email.ts`): signup-link subject/text/html "Finish
  setting up your Pawbook account" → Pawservation. `env.d.ts` and README
  `RESEND_FROM` examples → `"Pawservation <bookings@pawservation.com>"`.
- **Docs**: README product name + prose (repo URL/badge unchanged until
  Phase 2 — note this inline), `docs/index.md` title + prose,
  `CONTRIBUTING.md`, `SECURITY.md`, `docs/ai-native-ideas.html` +
  `docs/data-model.html` `<title>`/`<h1>`s, `.github/ISSUE_TEMPLATE/*`
  descriptions.
- **Fixtures**: `sql/seed.sql` `newsitter@pawbook.test` →
  `newsitter@pawservation.test`, with `server/__tests__/helpers.ts`
  (`OWNER_EMAIL`, `ALLOWED_EMAIL`), `token.test.ts`, and
  `signup-repo.test.ts` updated in the same commit (tests assert seed
  contents). `RESEND_FROM: 'Pawbook <…>'` test fixtures → Pawservation.
- **`package.json` `"name"`** → `pawservation` (private, never published —
  free). The `pawbook-db` in its scripts is the real D1 database name and
  stays (see exceptions).
- **Popup window name** `'pawbook-gcal'` (`app/admin/App.tsx:492`) →
  `'pawservation-gcal'` — a window handle, no persistence, rename freely.

### Embed integration contract — rename with permanent legacy support

The snippet in sitters' websites and the events host pages listen to are an
API we shipped. New name forward, old name honored indefinitely:

- **Script attribute**: `server/lib/snippet.ts` and the landing's displayed
  snippet emit `data-pawservation-tenant`. `public/embed.js` selects
  `script[data-pawservation-tenant],script[data-pawbook-tenant]` and reads
  whichever is present (new wins). Legacy attribute is supported forever —
  snippets in the wild are never revisited. `demo.html` and
  `EmbedSection.tsx` copy switch to the new attribute.
- **postMessage types**: the widget (`app/embed/App.tsx`, `BookTab.tsx`)
  posts **both** `pawservation:resize`/`pawservation:booked` and the legacy
  `pawbook:*` types — host pages may have an HTTP-cached old `embed.js`, so
  the widget cannot assume the loader understands the new types. The new
  loader listens for both (dedupe `booked` by `requestId` guard is
  unnecessary: the loader reacts to whichever arrives; it must simply not
  double-fire — react to the _new_ type and ignore the legacy one when both
  are its own origin's current loader, i.e. new loader handles
  `pawservation:*` only, legacy loaders handle `pawbook:*` only. Both being
  posted means every loader vintage works, and no loader sees both of "its"
  types).
- **DOM event**: the new loader dispatches **both** `pawservation:booked` and
  legacy `pawbook:booked` CustomEvents on `document` so existing host-page
  listeners keep working. README documents the new event and names the legacy
  one as a compatibility alias. `public/demo-host.js` (our fake-CMS demo)
  switches its listener to the new event — which makes the demo page itself
  the manual proof the new event fires.

### Client storage keys — read-old-migrate-once

Sessions must survive the deploy.

**Admin token** (localStorage, `app/admin/App.tsx` + `app/setup/App.tsx`):

```ts
const TOKEN_KEY = 'pawservation-admin-token';
const LEGACY_TOKEN_KEY = 'pawbook-admin-token'; // pre-rebrand; migrate-once

function getStoredToken(): string | null {
  try {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return t;
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
    if (legacy) {
      localStorage.setItem(TOKEN_KEY, legacy); // migrate once
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    }
    return legacy;
  } catch {
    return null;
  }
}
```

`storeToken(null)` (logout) removes **both** keys. `app/setup/App.tsx`'s
duplicated `TOKEN_KEY` changes to the new name (it only ever writes).

**Customer widget token** (sessionStorage, `app/shared-ui/api.ts`): same
pattern per slug — `getToken` tries `pawservation-embed-token:${slug}`, falls
back to `pawbook-embed-token:${slug}`, migrates and deletes the legacy key on
hit; `setToken` writes only the new key. sessionStorage is per-tab, so this
only preserves tabs open across the deploy — four lines, still worth it.

### Screenshots

Checked (surprise #4): the name does not appear in any of the five captured
crops. **Skip regeneration.** No action.

### Tests

Updated in place alongside the code they pin:

- `landing.test.ts:37` `toContain('Pawbook')` → `'Pawservation'`, plus a new
  `not.toContain('Pawbook')` on the rendered body — valid immediately: after
  Phase 1 the only legacy strings left on the landing are the lowercase
  `github.com/bradburch/pawbook` repo URLs, which a case-sensitive check
  ignores.
- `snippet.test.ts` — assert `data-pawservation-tenant` in emitted snippets.
- Fixture-only updates (RESEND_FROM strings, `@pawservation.test` emails).
- New: loader/back-compat is plain-DOM code with no test harness; verify via
  the demo page manually (one snippet with the legacy attribute, one with the
  new) and note it in the PR.

### Explicitly OUT of Phase 1 (stays "pawbook" by design)

| Occurrence                                                                                                                       | Why it stays                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAWBOOK_DB` / `PAWBOOK_CACHE` bindings (415 hits incl. tests/types)                                                             | Internal binding names; zero user visibility; renaming is a giant diff plus a wrangler config change for no benefit                                                               |
| `pb-` / `bp-` CSS prefixes, `--bp-*` custom properties                                                                           | Internal; 230+ occurrences in admin.css alone; zero user impact; huge diff risk                                                                                                   |
| Wrangler worker `"name": "pawbook"` + `database_name: "pawbook-db"` (and the `pawbook-db` in package.json scripts)               | Operational — Phase 2 decision (recommendation: keep forever, argued below)                                                                                                       |
| HKDF info labels `pawbook-gcal-token`, `pawbook-signup-link`, `pawbook-oauth-state`                                              | Cryptographic domain-separation constants. Changing them invalidates encrypted Google refresh tokens at rest, outstanding signup links, and in-flight OAuth states. Never rename. |
| Google Calendar marker `extendedProperties.private.pawbook`                                                                      | Persisted in events already written to sitters' calendars; reconcile/delete-sync would stop recognizing them. Never rename.                                                       |
| Cookie `pawbook_gcal_nonce`                                                                                                      | 10-minute TTL, path-scoped, invisible; renaming buys nothing and risks breaking an in-flight OAuth handoff at deploy time                                                         |
| Legacy compat identifiers (`data-pawbook-tenant` fallback, `pawbook:*` postMessage/DOM aliases, `pawbook-*` legacy storage keys) | Deliberately retained by this design                                                                                                                                              |
| Repo URLs `github.com/bradburch/pawbook` everywhere                                                                              | Accurate until the Phase 2 repo rename; swept afterward                                                                                                                           |
| `docs/superpowers/specs/*` history, `migrations/*` comments, memory files `pawbook-*.md`, the `.superpowers` ledger              | Historical record; rewriting history creates confusion                                                                                                                            |
| `.claude/skills/running-pawbook`                                                                                                 | Internal tooling; optional rename later, not user-visible                                                                                                                         |

## Phase 2 — operational runbook (owner-executed, after Phase 1 ships)

In order; each step is independently safe.

1. **Register `pawservation.com` / `pawservation.app`** (in progress). Add
   `pawservation.com` as a Cloudflare zone.
2. **Resend**: add and verify the `pawservation.com` sending domain
   (DKIM/SPF), then `npx wrangler secret put RESEND_FROM` →
   `Pawservation <bookings@pawservation.com>`. Independent of the domain
   cutover — the sender domain need not equal the app domain. Old sender
   keeps working until this flips.
3. **Cloudflare custom-domain cutover**: `wrangler.jsonc` currently has **no
   routes** — the only hostname is `workers_dev: true`
   (`pawbook.<account>.workers.dev`). Add a Workers **custom domain** on
   `pawservation.com` (apex or `app.`) for the existing worker.
   **Keep `workers_dev: true` indefinitely** — every embed snippet already
   pasted into a sitter's site loads `embed.js` from the workers.dev
   hostname; disabling it breaks them all. There is no old custom domain to
   redirect. Snippets are origin-derived (`server/lib/snippet.ts`), so admins
   visiting the new domain copy pawservation.com snippets automatically.
4. **Do NOT rename the worker** (recommendation: keep `pawbook`). Renaming
   creates a _new_ worker: (a) the workers.dev hostname changes, breaking
   every deployed embed snippet — the one thing we must not do; (b) all
   secrets (`TOKEN_SECRET`, `RESEND_*`, Google OAuth creds) must be re-put,
   and a mistyped `TOKEN_SECRET` invalidates every session **and** all
   HKDF-derived crypto including encrypted calendar tokens; (c) D1/KV must be
   re-bound and observability history is lost; (d) the old worker must be
   kept alive anyway to serve the old hostname. The name appears nowhere
   users look. Same logic keeps `database_name: pawbook-db`.
5. **Google OAuth**: in the Google Cloud console, add the new origin's
   redirect URI (`https://<new-domain>/oauth/google/callback` — the path is
   origin-derived) and update the consent-screen app name/branding to
   Pawservation. Verify a calendar connect from the new domain.
6. **GitHub repo rename** `bradburch/pawbook` → `bradburch/pawservation`: one
   click; GitHub automatically redirects old web URLs and git remotes (until
   a new repo reuses the old name — don't). Owner chose a full rebrand, so
   the OSS project name changes too; the rename _is_ that action. If GitHub
   Pages serves `docs/`, note the Pages URL changes and old Pages URLs do
   **not** redirect.
7. **Post-rename sweep PR**: README badge + links, landing footer links,
   `HelpSection.tsx` link, `SECURITY.md`, `.github/ISSUE_TEMPLATE/config.yml`,
   `docs/index.md` — everything in the "repo URLs" exception row. Update
   local git remotes.

## Verification — the grep gate

After Phase 1 (and again after the Phase 2 sweep), the plan includes a gate
step: run

```bash
grep -rni pawbook --exclude-dir={.git,node_modules,dist} -I . \
  | grep -vE 'PAWBOOK_DB|PAWBOOK_CACHE|pawbook-db|pawbook-(oauth-state|signup-link|gcal-token)|pawbook_gcal_nonce|\.private\.pawbook|pawbook: .true.|data-pawbook-tenant|pawbook:(resize|booked)|pawbook-(admin|embed)-token|github\.com/bradburch/pawbook|running-pawbook|"name": "pawbook"|docs/superpowers|migrations/|package-lock'
```

and require **zero** remaining hits that are user-visible. Every surviving
match must be attributable to a row in the exceptions table; anything else is
a missed rename and fails the gate. (Code comments that merely say "pawbook"
are updated opportunistically in files Phase 1 already touches; stragglers in
untouched files are allowed but should be listed in the PR description.)

Full suite (`npm test`), `npm run typecheck`, lint/format, and a manual demo
pass (legacy + new snippet attributes side by side; login as sitter before
deploy, still logged in after) complete verification.

## Risks

- **Missed legacy listener double-fire**: the widget posting both message
  types means a hypothetical loader handling both would react twice. Current
  and legacy loaders each handle exactly one family; keep it that way.
- **Session migration edge**: a user with _both_ keys populated (e.g. logged
  in post-deploy, then an old tab writes the legacy key) — new key always
  wins on read; logout clears both. Acceptable.
- **Search/SEO**: the landing page title change is instant; domain-level SEO
  is a Phase 2 concern and the workers.dev URL was never marketed.
