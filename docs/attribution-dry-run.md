# Payment attribution — dry run

**Nothing has been changed.** This is what _Attribute unattached credits_ would propose against
your live account right now, produced by running the real preview route over a read-only copy of
production. Every figure below is the route's own answer, not an estimate.

Whole dollars throughout; nothing is rounded.

## The headline

|                                                          |                                |
| -------------------------------------------------------- | -----------------------------: |
| Unattached credits on the account                        |     **821**, worth **$92,941** |
| Credits that would be placed                             | **34**, across **58** bookings |
| Money that would move onto bookings                      |                     **$2,640** |
| Credits with no stay within 90 days — **yours to place** |     **346**, worth **$42,614** |
| Credits whose household owes nothing — untouched         |     **441**, worth **$45,552** |

**$2,640 is every dollar currently outstanding across the account.** Applying these settles
every unpaid booking; nothing is left owing.

## What changed, and why it matters

An earlier run of this same dry run proposed **47 credits over 77 splits** — also $2,640, also
conserving exactly. It was arithmetically perfect and substantively wrong:

| Gap between payment and stay |                 Before |                 Now |
| ---------------------------- | ---------------------: | ------------------: |
| within a month               |        3 splits / $120 | **8 splits / $540** |
| 2–6 months                   |        3 splits / $120 |  50 splits / $2,100 |
| 6–18 months                  |       19 splits / $505 |                   0 |
| **over 18 months**           | **52 splits / $1,895** |               **0** |

The matcher's only rule is date proximity. With payments going back to 2023 and only July 2026
bookings adopted, every candidate was one to three years away — so proximity carried no signal and
the proposer degenerated into filling the oldest unpaid booking, then the next. One household's
$42 credit was split **$5 onto one walk and $37 onto another**, purely because that is where the
running total happened to sit.

A **90-day floor** now applies: when no stay is within a quarter of the payment, the credit is
refused rather than proposed. It is offered to you to place by hand instead — the automatic guess
is what was removed, not the ability to attribute.

The same $2,640 still lands. The floor did not reduce coverage; it made the proposer skip the 2023
money and use the 2026 money that was always there. The clearest case is Marissa McVittie: seven
$40 credits now map one-to-one onto seven $40 walks, where before they dribbled across boundaries
in $1, $3 and $5 fragments.

## Every proposal

Blank cells continue the row above: one credit splitting across several bookings.

| Household                                  | Credit | Paid       | Goes to                  | Amount | Left as credit |
| ------------------------------------------ | -----: | ---------- | ------------------------ | -----: | -------------: |
| Alana Wang (Argyle)                        |    $40 | 2026-04-23 | Pack walk 2026-07-16     |    $40 |             $0 |
| Alana Wang (Argyle)                        |    $40 | 2026-04-30 | Pack walk 2026-07-23     |    $40 |             $0 |
| Alana Wang (Argyle)                        |    $40 | 2026-05-07 | Pack walk 2026-07-30     |    $40 |             $0 |
| Asja Sever (Sailor, Daisy)                 |   $750 | 2026-04-15 | Pack walk 2026-07-14     |    $40 |           $710 |
| Asja Sever (Sailor, Daisy)                 |   $570 | 2026-04-22 | Pack walk 2026-07-15     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-16     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-16     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-20     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-21     |    $40 |           $370 |
| Asja Sever (Sailor, Daisy)                 |   $450 | 2026-05-08 | Pack walk 2026-07-22     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-23     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-27     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-28     |    $40 |                |
|                                            |        |            | House sitting 2026-07-29 |   $110 |           $180 |
| Brianna Key (Chia, Summer)                 |    $80 | 2026-06-30 | Pack walk 2026-07-13     |    $40 |            $40 |
| Christine Rhee & Mike Starr (Frieda, Theo) |   $220 | 2026-05-02 | House sitting 2026-07-17 |   $110 |                |
|                                            |        |            | House sitting 2026-07-25 |   $110 |             $0 |
| Christine Rhee & Mike Starr (Frieda, Theo) |    $50 | 2026-05-03 | House sitting 2026-07-25 |    $50 |             $0 |
| Christine Rhee & Mike Starr (Frieda, Theo) |   $165 | 2026-07-16 | House sitting 2026-07-25 |   $165 |             $0 |
| Christine Rhee & Mike Starr (Frieda, Theo) |   $170 | 2026-07-27 | House sitting 2026-07-25 |    $75 |            $95 |
| Dwayne Jarrell (Fiddle)                    |   $150 | 2026-05-01 | Pack walk 2026-07-27     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-30     |    $40 |            $30 |
| Emma Annand & Morgan Morrell (Kevin)       |    $60 | 2026-04-15 | Pack walk 2026-07-14     |    $30 |            $30 |
| Emma Annand & Morgan Morrell (Kevin)       |    $60 | 2026-04-22 | Pack walk 2026-07-15     |    $30 |            $30 |
| Emma Annand & Morgan Morrell (Kevin)       |    $60 | 2026-04-30 | Pack walk 2026-07-29     |    $30 |            $30 |
| Emma Annand & Morgan Morrell (Kevin)       |    $60 | 2026-05-27 | Pack walk 2026-07-30     |    $30 |            $30 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $120 | 2026-04-06 | Pack walk 2026-07-01     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-02     |    $40 |            $40 |
| Ian Fisher & Lauren Kotin (Sadie)          |    $80 | 2026-04-20 | Pack walk 2026-07-14     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-15     |    $40 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $120 | 2026-04-25 | Pack walk 2026-07-16     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-20     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-21     |    $40 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |    $80 | 2026-05-04 | Pack walk 2026-07-22     |    $40 |                |
|                                            |        |            | Boarding 2026-07-23      |    $40 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $120 | 2026-05-11 | Boarding 2026-07-23      |    $50 |                |
|                                            |        |            | Pack walk 2026-07-28     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $30 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $160 | 2026-05-16 | Pack walk 2026-07-29     |    $10 |                |
|                                            |        |            | Pack walk 2026-07-30     |    $40 |           $110 |
| Jenna Siflinger (Lola)                     |   $400 | 2026-05-16 | Pack walk 2026-07-20     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-21     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-22     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-23     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-30     |    $30 |           $250 |
| Kelly Snider (Desi)                        |   $280 | 2026-07-20 | Boarding 2026-07-17      |   $100 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $40 |           $140 |
| Liza Avramenko (Luna)                      |    $40 | 2026-07-30 | Pack walk 2026-07-30     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-04-08 | Pack walk 2026-07-02     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-05-07 | Pack walk 2026-07-16     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-05-08 | Pack walk 2026-07-17     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-05-13 | Pack walk 2026-07-23     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-05-14 | Pack walk 2026-07-24     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-05-15 | Pack walk 2026-07-30     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $80 | 2026-05-22 | Pack walk 2026-07-31     |    $40 |            $40 |
| Patrick Haluska (Olive)                    |    $50 | 2026-08-06 | Pack walk 2026-07-22     |    $40 |            $10 |
| Philippe Maman (Cashew)                    |    $40 | 2026-07-29 | Pack walk 2026-07-29     |    $40 |             $0 |

## The 346 credits with no stay within 90 days

These are **not** errors and they are **not** stuck. Each one's household has unpaid stays, but the
nearest is more than a quarter away from the payment date, so the system declines to guess which
stay it paid for. They appear in the panel under _Needs your call — not matched to a stay_, each
with the booking list and the reason, for you to place or leave.

Worth **$42,614** in total. Most will resolve on their own once earlier months are adopted from the
calendar: a 2024 payment has no plausible target today, and an obvious one once 2024's walks exist.

## The 441 credits whose household owes nothing

**$45,552** across households with no unpaid booking at all — nothing to attach to, so they stay as
household credit, visible and untouched. Largest first:

- Emma Burkhardt & Ryan Somerfield (Kira): 44 / $8025
- Cat Ku & Matthew Rosenthal (Cardi): 10 / $4210
- Mckenna Hearn & Olivia Barnhill (Zoe): 60 / $4140
- Asja Sever (Sailor, Daisy): 3 / $3740
- Claire Koory & Thomas Finch (Frankie): 64 / $2460
- Kyle Dillon & Rayven Wray (Prince, Romeo): 11 / $2160
- Ian Fisher & Lauren Kotin (Sadie): 9 / $2060
- Thu Le (Marygold, Jed): 16 / $1982
- Natalia Olazabal (Sancho): 47 / $1410
- Alanna Kueffer (Sunny): 30 / $1227
- Jean Hayden (Isaac): 3 / $1220
- Dwayne Jarrell (Fiddle): 5 / $1075
- Naomi Fuhrmann (Shuki): 21 / $1030
- Ocoee Wilson (Goose): 9 / $995
- Lori Barnhill (Otis): 1 / $800
- Aryele Dube (Coco, Gigi): 8 / $780
- Marissa McVittie (Teddy): 17 / $680
- Jenna Siflinger (Lola): 2 / $620
- Mary Jean Gomes (Ashbury, Cole): 8 / $569
- Pete Tiburzio (Benji): 1 / $540
- Bradley Smith (Cosmos): 3 / $500
- Sarah Holmes (Pepper): 1 / $500
- Robin Kutner & Jeremy Besmer (Winnie, Penny): 6 / $450
- Emma Annand & Morgan Morrell (Kevin): 7 / $450
- Kelsi Buckley & Spencer Sheaff (Pete): 5 / $440
- Theresa Mah (Reggie): 10 / $388
- Alana Wang (Argyle): 9 / $360
- Rowan Baginsky (Emma): 1 / $340
- Becca Wheeler (Ralph): 8 / $340
- KJ Glynn (Rio): 1 / $300
- Jay Van Vliet (Bertram): 2 / $250
- Aainy Zahra (Beamer): 1 / $220
- Mary Thoma (Frankie): 1 / $200
- Elyse Dvorkin (Charlie): 1 / $200
- Elizabeth Flynn (Blue): 4 / $170
- Stephen Le (Bernie): 1 / $160
- Laura Koon & Matthew Goerz (Roxie): 2 / $130
- Garner Kropp (Izzy): 1 / $100
- Jenny Kong & Boris Yanovsky (Pepper): 2 / $91
- Kelly Snider (Desi): 1 / $50
- Kristy Abo (Maple): 1 / $45
- Brooke Bray (Marty): 1 / $45
- Philippe Maman (Cashew): 1 / $40
- Brianna Key (Chia, Summer): 1 / $40
- Laurelly Dale (Gatsby): 1 / $20

## What happens if you apply this

For each credit you approve, the system removes the household-level credit row, writes one payment
against each booking it was split onto (same amount, date, method and note as the original), and
writes back whatever was left over as a smaller household credit. A $0 leftover writes nothing.

Money is conserved exactly at every step, and each attribution is re-checked against live balances
at the moment it is applied — anything settled in the meantime is refused rather than overpaid, with
the reason shown to you. They are sent in small batches automatically; you click Apply once.

**Recovery, honestly:** there is no undo. Reversing an attribution means deleting the payment rows
it created — one per booking — and the leftover credit row, then re-recording the original credit
against the household by hand. Everything needed to do that is preserved, but it is manual and the
new rows have new ids. If you are unsure, apply one household first (Alana Wang's three $40 credits
are the simplest), look at the result, then do the rest.

---

_Produced by running the preview route against a read-only copy of production data loaded into a
local test database. No production data was modified._
