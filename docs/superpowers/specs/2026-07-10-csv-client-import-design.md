# CSV client/pet import — design

**Date:** 2026-07-10
**Status:** Approved (pending spec review)
**Branch target:** off `custom-services`

## Problem

Sitters onboarding to Pawbook with an existing client list today can only add
customers and pets one at a time via `ClientsSection.tsx`'s inline forms
(`POST /:slug/admin/customers`, `POST /:slug/admin/customers/:id/pets`,
`server/routes/admin.ts:548-604`). There's no way to bring in a spreadsheet of
existing clients and their pets in one action.

## Goals

1. A sitter can upload a CSV of clients and their pets and have them imported
   in one action.
2. Re-uploading the same file (or an updated version) is safe — it never
   creates duplicate clients or duplicate pets, whether the duplicate is
   within the same file or against data already in the database.
3. A file with some bad rows still imports everything that's valid, and tells
   the sitter exactly which rows were skipped and why.
4. The sitter chooses whether importing sends the same "you're invited"
   email a manual add would trigger — useful when migrating a historical
   list nobody should be emailed about yet.
5. A documented example CSV exists both as a file in the repo and as a
   one-click download from the import UI, so sitters know the exact format
   to follow.

## Non-goals

- Editing or removing existing clients/pets via CSV — this is additive only
  (create-or-reuse), matching `insertInvitedCustomer`'s existing semantics.
  A follow-up CSV _export_ or _update_ flow is out of scope.
- A preview-then-confirm step before committing the import. Because the
  import is already non-destructive and idempotent (Goal 2), there's nothing
  to undo — the sitter gets the full result report (what was created, what
  was skipped and why) immediately after uploading, not before.
- Any field not already on `EndUser`/`EndUserPet` (phone, pet notes/breed,
  etc.). Adding those would need a schema migration unrelated to the import
  mechanism itself; the CSV format only covers `Email`, `Name` (client) and
  `Name`, `Type` (pet) — the same fields the single-add forms already
  collect.
- True `multipart/form-data` upload handling. No route in this codebase
  parses multipart bodies today; adding that machinery buys nothing here
  since CSV files of a sitter's client list are trivially small.

## Alternatives considered

**Client-side CSV parsing**, sending a pre-parsed JSON array of row objects
instead of raw CSV text. Rejected: validation must be authoritative on the
server regardless (client input can't be trusted), so parsing client-side
would mean maintaining the parsing/validation logic in two places for no
benefit — this codebase's only test infrastructure is server-side
(`server/__tests__/*.test.ts`; there is no frontend test setup), so keeping
all of it server-side keeps it testable in the existing way.

**True multipart file upload** (`c.req.formData()`). Rejected: this would be
the first multipart route in the codebase, adding a new request-parsing
pattern for a file that's a few KB of text. Sending the file's text content
as a plain JSON string field reuses the exact `adminApi`/`request<T>()`
convention every other admin mutation already uses
(`app/shared-ui/api.ts:92-97`).

**Chosen: browser reads the file as text via the native `File.text()` API**,
POSTs `{ csv: string, sendInvites: boolean }` as a normal JSON body to a new
route, which does all parsing, validation, dedup, and importing server-side
in one pass.

## Design

### 1. CSV format

Four columns, one row per pet (a client with multiple pets repeats across
multiple rows; a client with no pets yet gets one row with the pet columns
blank):

```
Client Email,Client Name,Pet Name,Pet Type
jess@example.com,Jess Nguyen,Bella,dog
jess@example.com,Jess Nguyen,Mochi,cat
sam@example.com,Sam Diaz,Rex,dog
team@example.com,Team Co,,
```

- `Client Email` — required, validated against the existing `EMAIL_RE`
  (`server/lib/validation.ts:10`).
- `Client Name` — optional, same as the single-add form (blank → `null`).
- `Pet Name` / `Pet Type` — both optional, but only meaningful together:
  either both blank (client-only row) or both present. `Pet Type` must be
  `dog` or `cat` (case-insensitive) **and** enabled for that tenant (same
  two-part check the single-add pet route already applies —
  `isPetType` + `listPetTypes(...).Enabled`, `server/routes/admin.ts:594,
599-602`).

An example file matching this exact format is committed to the repo at
`docs/examples/clients-import-example.csv` and served as a static download
link from the import UI (Section 4).

### 2. CSV parser (`server/lib/csv.ts`, new file)

A small hand-rolled row parser — not a dependency — since the format is four
fixed columns and the only real complexity is RFC4180 quoting (a client name
containing a comma, e.g. `"Doe, Jane"`, exported from Excel/Sheets with
quotes). One function:

```ts
export function parseCsvRows(text: string): string[][];
```

Splits on newlines (tolerating `\r\n`), splits each line on commas outside
quotes, and un-escapes `""` → `"` inside a quoted field. The caller (Section 3) treats row 1 as the header and ignores it (column order is fixed, not
name-matched — matching the fixed 4-column format above; a header with
different labels or order is not supported in this pass).

### 3. Import route (`server/routes/admin.ts`)

New route, alongside the existing customer routes:

`POST /:slug/admin/customers/import` — body `{ csv: string, sendInvites: boolean }`.

For each parsed row (1-indexed against the sitter's actual file, header = row 1):

1. Validate `Client Email`. Invalid/blank → skip the whole row, record
   `{ row, reason: 'Invalid email address' }`.
2. `insertInvitedCustomer(db, tenant.Id, email, name)` — already idempotent
   by `(TenantId, Email)` (`server/db/repo.ts:578-583`), reused as-is. This
   is what makes re-uploading the same file safe for the client half of
   every row.
3. If `Pet Name`/`Pet Type` are both blank, row is done (client-only row).
   If exactly one of the two is present, skip just the pet with a reason
   (`'Pet type given without a pet name'` / `'Pet name given without a pet
type'`) — the client from step 2 is still kept.
4. If both are present: validate `Pet Type` (same two checks as the
   single-add route). Invalid → skip just the pet, record the reason (client
   from step 2 is still kept).
5. **Dedup check**: before inserting, check whether this customer already
   has a pet with this name — an in-memory `Map<endUserId, Set<petNameLower>>`
   for the request, seeded per-customer on first encounter from
   `listAllEndUserPetsByTenant` (already fetched once for the whole tenant,
   `server/db/repo.ts` — reused to build the seed map rather than querying
   per row) and updated as pets are added during this same run. A name
   already in the set → skip, record `{ row, reason: 'Pet already exists for
this client' }`. This one check is what makes both "duplicate row within
   this file" and "re-uploading the same file later" safe — both look
   identical to it.
6. Otherwise `addEndUserPet(db, tenant.Id, endUserId, name, petType)` and add
   the name to the dedup set.

After all rows: if `sendInvites` is true, for every customer whose `Status`
came back `'invited'` from step 2 (freshly created this run — reusing the
same distinction the single-add route already makes), send the invite via
`sendInvite` (`server/lib/email.ts`) with the same `widgetUrl` construction
the single-add route uses (`admin.ts:562-564`). **Best-effort per email** —
unlike the single-add route's `502` on send failure, a bulk import must
never fail the whole request over one bad email address; a failed send is
counted in `invitesFailed`, not surfaced as a skipped row (the customer/pet
records are still created either way).

Response:

```ts
{
  importedCustomers: number, // count of rows whose client was newly created (not reused)
  importedPets: number,
  invitesSent: number,
  invitesFailed: number,
  skippedRows: Array<{ row: number; reason: string }>,
}
```

### 4. Frontend (`app/admin/sections/ClientsSection.tsx`, `app/shared-ui/api.ts`, `app/admin/shared.ts`)

- A file `<input type="file" accept=".csv">`, a "Send invite emails to new
  clients" checkbox (defaulting unchecked — the safer default per Goal 4,
  matching "migrating a historical list" being the more surprising direction
  to get wrong), an "Import" button, and a "Download example CSV" link
  (points at `docs/examples/clients-import-example.csv`, copied into the
  built `dist/` assets the same way other static content is served — see
  Section 5).
- On import, `file.text()` reads the selected file, POSTs to the new
  `adminApi.customers.import(slug, token, csv, sendInvites)` (added to
  `app/shared-ui/api.ts` next to the existing `customers` namespace).
- The result renders as an inline panel within `ClientsSection` (not the
  transient sticky save-bar other mutations use) — showing the counts and,
  when non-empty, the full `skippedRows` list with row numbers and reasons —
  because this result can be multiple lines and the sitter needs time to
  read it, unlike the 4-second transient success messages elsewhere.
- After a successful import, the customer list refreshes the same way
  `addCustomer`/`addPet` already trigger a refresh today (`App.tsx`'s
  `withCustomerRefresh`/`reloadCustomers` pattern).

### 5. Example CSV file

`docs/examples/clients-import-example.csv` — the exact 4-row example shown
in Section 1. Needs to be reachable as a real download from the admin UI;
the simplest option reusing this repo's existing static-serving setup
(Vite build → `ASSETS` binding) is copying it into `public/` (Vite's
convention for files served as-is, unprocessed) rather than `docs/`, so it
ships at a stable URL. Decision: keep the source of truth in
`docs/examples/` (near this spec, easy for a developer to find) and also
place an identical copy in `public/clients-import-example.csv` for the
actual download link — two files, not a build step, since this is a single
static file that changes rarely.

## Error handling

- Malformed CSV (e.g. inconsistent quoting) — the parser's job is to not
  throw; a line that can't be cleanly split is treated as an invalid row
  (all its columns skipped, reason `'Could not parse this row'`) rather than
  aborting the whole import.
- An empty file (header only or fully empty) — returns the same response
  shape with all counts zero, not an error; the sitter sees "0 clients
  imported" rather than a cryptic failure.
- Invite email failures never abort the import or fail the request — counted
  in `invitesFailed`, matching the "email must never affect what it's
  attached to" pattern already established for booking-status emails
  elsewhere in this codebase.

## Testing

`server/__tests__/customers-import.test.ts` (new):

- Parser: quoted fields with embedded commas, `""`-escaped quotes within a
  quoted field, `\r\n` line endings, a trailing blank line.
- Happy path: a multi-row file creating several clients and pets, correct
  `importedCustomers`/`importedPets` counts.
- Skip reasons: invalid email, disabled/unknown pet type, pet name without a
  type and vice versa — each produces the right `reason` string and the
  right row number.
- Dedup: the same client+pet appearing twice in one file only creates one
  pet; re-running the exact same import a second time creates zero new pets
  and zero new clients (client reused via existing idempotency, pet skipped
  via the new dedup check).
- `sendInvites` toggle: `true` sends invites only for freshly-created
  clients (not ones that already existed), `false` sends none; a mocked
  failing send is reflected in `invitesFailed` without failing the request
  or skipping the client/pet records.
