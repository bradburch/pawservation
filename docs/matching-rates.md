# Matching rates: resolved automatically vs. needing the sitter

**Measured:** 2026-08-11, against the live `brad-paws` tenant.

## What this measures, and one correction up front

Three features in this product take messy real-world input and try to place it: the calendar
backfill, the CSV/Venmo payment importers, and payment attribution. Each ends in one of two
outcomes per item:

- **Resolved** — the code determined the answer on its own and the sitter just approves it.
- **Referred** — the code refused to decide and asked the sitter.

**None of these matchers use a model.** They are ordinary deterministic code — string
normalisation, set membership, date arithmetic, union-find over the owner↔pet graph. So the split
is _not_ "code vs. AI"; it is "decided alone" vs. "asked a human". Nothing here is an LLM matching
anything, and no measurement below reflects model behaviour.

That distinction matters for reading these numbers: a referral is not a failure of an AI, and it is
not a bug. Every refusal in this codebase is deliberate — the rule throughout is that ambiguity is
reported, never resolved by picking. `resolveMatchClient` returns `null` on more than one hit; the
backfill flags rather than adopting; `proposeAttribution` refuses a tie it cannot fund.

## Calendar backfill — measured

One month, previewed against the real calendar on 2026-08-11.

| Range                   | Events read | Resolved | Referred | Rate      |
| ----------------------- | ----------- | -------- | -------- | --------- |
| 2026-07-01 → 2026-08-01 | 55          | 53       | 2        | **96.4%** |

The two referrals, and why each is correct:

| Event                      | Reason                                                                                                   | Correct?                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Pedro and Remy (Jul 1)`   | `unknown-service` — no service word in the title, and its description carries `Owner:` but no `Booking:` | Yes. Nothing in the record says what service it was.     |
| `Brad Unavailable (Jul 3)` | `no-pets` — "No pet named Brad Unavailable"                                                              | Yes. It is the sitter's own time off, not a client stay. |

**Caveat: this is a single month, n=55.** It should not be read as a lifetime rate. Earlier history
is likely to refer more often, for two reasons: descriptions may be sparser before the sync worker
began writing them, and pets that have since been renamed or died will not match a title.

### What moved this number

The rate was much worse before two fixes landed on 2026-08-10:

1. **Service labels.** Matching was exact on `nameKey`, so the hint `walk` failed against a service
   labelled **"Pack Walks"** and `house-sit` failed against **"House sitting"**. This tenant's
   calendar is dominated by `X Walk` titles, so most of it referred. Now matched by label prefix and
   label-token prefix, still refusing when two services both match (PR #120).
2. **Event descriptions.** 54 of 55 events carry a structured block — `Owner:`, `Owner ID:`,
   `Cost:`, `Booking:` — which the backfill was not reading at all. It now prefers that record over
   parsing the title (PR #122).

The description also fixed a money error, not just a matching one: `Summer and Chia Walk -
CANCELLED` carries `Cost: 40`, but the rate card had priced it **$80** (two pets × linear rate).

## Payment attribution — measured

Once all 53 July events were adopted, this became computable. Measured against live production data
on 2026-08-11, using the real `proposeAttribution` and `buildAccounts` over an offline copy of the
tenant's payments, bookings and owner↔pet edges. **Read-only: nothing was attributed.** All 821
payments remain account-level.

|                                      |            |
| ------------------------------------ | ---------- |
| Account-level credits                | 821        |
| Households (connected components)    | 53         |
| Households holding an unpaid booking | **13**     |
| Total credit value                   | $92,941    |
| Total booking outstanding            | **$2,640** |

| Outcome              | Count  | Share |
| -------------------- | ------ | ----- |
| `no-unpaid-bookings` | 772    | 94.0% |
| **resolved**         | **47** | 5.7%  |
| `ambiguous`          | 2      | 0.2%  |

**Read the headline rate carefully — 5.7% is not the matcher's accuracy.** 772 of the 821 credits
never faced a decision at all: their household has no unpaid booking, because only one month of a
multi-year history has been adopted. That bucket measures how much calendar remains un-adopted.

The rate that describes the matcher is over the credits that had something to attach to:

**47 of 49 — 95.9% — resolved without asking the sitter.** The two referrals are date ties the
proposer refuses to break, which is the designed behaviour, not a miss.

The 47 resolved credits produced **77 splits**, so a credit covers 1.6 bookings on average. That
ratio is the argument for splitting being mandatory rather than optional: without it, a third of the
placements would have stranded a remainder.

Money: **$2,640 placed against $2,640 outstanding, with $0 over-allocated.** Every dollar a booking
was owed gets funded, and no booking is funded twice. The remaining $90,301 of credit stays as
credit — correctly, since there is nothing yet to attach it to.

### A defect this measurement found

The first run of this measurement reported **430 resolved (52.4%) and $42,430 placed** — against
$2,640 of actual outstanding, a 16× over-allocation. That was not a bad matcher; it was a bug in the
preview route, and the arithmetic not reconciling is what exposed it.

`proposeAttribution` is pure and was correct. But the route built its `unpaidBookings` candidate
list **once**, before looping over a household's credits, and never decremented a booking's
outstanding as earlier credits consumed it. A household with three $40 credits and one $40 unpaid
booking got three proposals, each claiming the full $40. Each individual attribution still conserved
money, and the apply path still verified the booking belonged to the household — so the guards held.
The _plan_ was impossible, and a sitter approving it row by row would have silently overpaid stays.

Every unit test used one credit per household, which is precisely the fixture shape that cannot
expose a cross-credit bug. Fixed by allocating a household's credits sequentially — oldest
`PaidDate` first, tie-broken by payment id — carrying the decrement forward, with the invariant now
asserted directly: **the sum of proposed splits for a household never exceeds that household's
outstanding.** The numbers above are from the fixed code.

### Reproducing it

Run `POST /:slug/admin/payments/attribute/preview` with no `accountId` and count the buckets:
resolved → entries with `ok: true`; referred → `ambiguous` and `no-unpaid-bookings`. Keep those two
apart when reporting — `ambiguous` is the matcher declining a judgement call, `no-unpaid-bookings`
is a fact about the data. The preview is read-only.

## CSV / Venmo payment import — no production run yet

The generic CSV importer shipped on 2026-08-10 (PR #123) and has been exercised end to end against
a seeded tenant, but not against real payment files. Its buckets are already the right shape for
this measurement:

- resolved → `matched`
- referred → `unmatched` (including a payer name matching two clients, which is refused by design)
- neither → `alreadyImported`, `problems`

One prediction worth recording so it can be checked later: **matching on this tenant will refer
heavily.** All 66 imported clients carry synthesized `bp-owner-N@import.invalid` addresses and no
real names from a payment processor, so payer strings on a bank export are unlikely to equal a
stored client name. That is the case the "sitter assigns an unmatched row" control exists for.

## How to reproduce

Calendar backfill: open Earnings → _Adopt past bookings from your calendar_, choose a range, and
press Preview. The heading shows the resolved count; the _Needs a fix first_ section lists referrals
grouped by reason. Nothing is written by a preview.

Attribution and CSV import: run each feature's `/preview` route and count the response buckets as
described above. Both previews are read-only.
