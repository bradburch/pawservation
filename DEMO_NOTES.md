# bradpaws-embed-proto — Demo Notes

Sandboxed multitenancy prototype. Everything here is disposable: deleting this directory plus
the worker, D1 `embed-proto-db`, and KV `embed-proto-cache` removes every trace (NFR2).

## Play with it (deployed)

| What                                      | URL                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Fake-CMS demo (both tenants side by side) | https://bradpaws-embed-proto.bradburch.workers.dev/demo              |
| Brad Paws widget                          | https://bradpaws-embed-proto.bradburch.workers.dev/embed/brad-paws   |
| Happy Tails widget                        | https://bradpaws-embed-proto.bradburch.workers.dev/embed/happy-tails |
| Sitter dashboard (login)                  | https://bradpaws-embed-proto.bradburch.workers.dev/admin             |

**Sitter dashboard logins** (email + password — the dashboard learns its own tenant from the login):

| Business    | Email                  | Password   |
| ----------- | ---------------------- | ---------- |
| Brad Paws   | `brad@bradpaws.test`   | `demo1234` |
| Happy Tails | `dana@happytails.test` | `demo1234` |

Each sitter sees and edits ONLY their own configs (rates, boarding capacity, branding, services,
blocked days, provider stubs); changes never affect the other tenant. Passwords are PBKDF2 hashes
(`lib/password.ts`); the session is an `role:'admin'` JWT held in the dashboard's localStorage.

The identify "magic link" code is displayed on screen instead of emailed. Seeded state:
Jun 20–25 2026 has 1 boarding pet at Brad Paws (max 2) and 2 at Happy Tails (max 4);
Jul 3–4 2026 is blocked for both.

## Configurable services & pet types

Each sitter controls which species they accept (dogs, cats, or both); the widget only surfaces those
species and the customer selects their pet type when booking (recorded on the booking row — no effect
on price or capacity).

Sitters also enable any combination of the five supported services (boarding, house sitting, day care,
walks, drop-in check-ins) and, for the duration-based services (walks and check-ins), enter a
free-typed list of duration/price pairs:

- Label and price are plain text — there is no formula mapping duration to price.
- Brad Paws is seeded with a 90-min walk at $30 and a 60-min walk at $35 to prove the point: the
  shorter option is more expensive, and the system accepts it without complaint.

The widget reflects all of this live: the service dropdown lists only enabled services; selecting
walks or check-ins surfaces a duration dropdown (populated from the sitter's list) with its
associated price; the date input switches between a date-range picker (boarding / house sitting) and a
single-date picker (day care / walks / check-ins); and the species picker shows only accepted species.

## Embed on a real CMS (story 3.4 — human verification pending)

Each tenant's admin page has copy-paste snippets. Platform notes from research:

- **Squarespace:** Code Block → paste the `<script>` snippet. JS/iframe embeds require the
  **Core plan or higher** (trial works). Auto-resize works (no sandbox between page and script).
- **Wix:** "Embed a site" element → paste the widget URL (or the iframe snippet). Wix wraps
  embeds in its own sandboxed fixed-height frame — no auto-resize; the widget scrolls
  internally. Storage may be denied in the Wix sandbox: the widget then runs
  stateless-per-load (re-identify each visit), by design.
- Verify in Chrome, Safari, and Firefox (NFR3); record findings here.

## Local dev

```bash
npm run seed:local -w apps/bradpaws-embed-proto   # once
npm run dev -w apps/bradpaws-embed-proto          # builds widget, runs wrangler dev
# open http://localhost:8787/demo
```

## Verified locally (2026-06-12, Playwright)

- UJ-1 end to end in the embedded widget: identify (on-screen code) → availability →
  booking ($250 = 5 nights × $50; $200 = 5 × $40 at the other tenant) → My bookings.
- Capacity isolation: same dates/pets rejected at Brad Paws (max 2), accepted at Happy
  Tails (max 4). Submit-time re-validation returns 409.
- Admin: rate edit ($50→$65) visible in the widget on next load; provider stubs flip status;
  blocked ranges add/remove; snippets render with correct origin/slug.
- Host-page toast fires from the `bradpaws:booked` CustomEvent re-dispatch.
- **Bug found & fixed during verification:** same-origin widgets shared one sessionStorage
  token; second widget got 403 "Wrong tenant." → tokens now per-slug, 403 re-identifies.

## Graduation notes (for the real multitenancy migration)

- Add an optional `maxPets` param to shared `dayBlocksRequest`/`rangeHasConflict`/`findOpenings`
  instead of this app's local port (`server/lib/availability.ts`, parity-pinned by test).
- Swap slug→tenant resolution to hostname inside `server/lib/tenant-resolve.ts` (single seam).
- Replace on-screen codes with real email delivery; replace `AdminKey` with real tenant auth;
  rotate `TOKEN_SECRET` to a real secret (`wrangler secret put TOKEN_SECRET`).
- Provider registry is shaped like shelved Plan 4; real OAuth = per-tenant AES-GCM credentials
  (shelved Plan 5).

## Teardown

```bash
npx wrangler delete --name bradpaws-embed-proto
npx wrangler d1 delete embed-proto-db
npx wrangler kv namespace delete --namespace-id ebe8b379ffb74e5bbb70a8b87d12f92e
git rm -r apps/bradpaws-embed-proto && # remove root tsconfig reference
```
