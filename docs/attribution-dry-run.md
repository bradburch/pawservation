# Payment attribution — dry run

**Nothing has been changed.** This is what _Attribute unattached credits_ would propose against
your live account right now, produced by running the real preview route over a read-only copy of
production. Every figure below is the route's own answer, not an estimate.

Whole dollars throughout; nothing is rounded.

## The headline

|                                                        |                                |
| ------------------------------------------------------ | -----------------------------: |
| Unattached credits on the account                      |     **821**, worth **$92,941** |
| Credits that would be placed                           | **27**, across **55** bookings |
| Money that would move onto bookings                    |                     **$2,435** |
| Credits with no stay close enough — **yours to place** |     **393**, worth **$49,984** |
| Credits whose household owes nothing — untouched       |     **401**, worth **$39,127** |

## How a payment finds a stay

A payment settles work that has **already happened**, so proximity is read with a direction:

- a stay **on or before** the payment date is a candidate up to **90 days** back — settling weeks
  late, or bundling several weeks into one transfer, is ordinary;
- a stay **after** the payment date is a candidate only **30 days** forward — prepayment happens for
  something coming up soon, not for a walk three months out;
- **the past wins ties.** A stay 7 days ago and one 7 days ahead are no longer equally likely; the
  one already delivered is taken first.

The bundled-payment case falls straight out of that, and it is all over your real data:

| Payment                             | Covers                                                |
| ----------------------------------- | ----------------------------------------------------- |
| Dwayne Jarrell, $175 on 2026-08-01  | walks on 07-27, 07-29, 07-30 — 2 to 5 days after each |
| Jenna Siflinger, $120 on 2026-07-30 | walks on 07-21, 07-22, 07-23 and the same-day 07-30   |
| Asja Sever, $1,340 on 2026-07-23    | eleven stays, from 9 days before to 6 days after      |

## What this replaced

The first run of this dry run proposed 47 credits over 77 splits — also conserving exactly, and
substantively wrong. With payments going back to 2023 and only July 2026 adopted, **52 of 77 splits
paired a payment with a stay more than 18 months away**, and one household's $42 credit was split
$5 onto one walk and $37 onto another purely because that is where the running total sat.

| Gap between payment and stay |          First run |                  Now |
| ---------------------------- | -----------------: | -------------------: |
| over 18 months               | 52 splits / $1,895 |                **0** |
| 6–18 months                  |   19 splits / $505 |                **0** |
| within a month of the stay   |    3 splits / $120 | **20 splits / $950** |

## Every proposal

Blank cells continue the row above: one credit splitting across several bookings.

| Household                                  | Credit | Paid       | Goes to                  | Amount | Left as credit |
| ------------------------------------------ | -----: | ---------- | ------------------------ | -----: | -------------: |
| Alana Wang (Argyle)                        |    $40 | 2026-06-18 | Pack walk 2026-07-16     |    $40 |             $0 |
| Alana Wang (Argyle)                        |    $40 | 2026-06-25 | Pack walk 2026-07-23     |    $40 |             $0 |
| Alana Wang (Argyle)                        |    $40 | 2026-07-17 | Pack walk 2026-07-30     |    $40 |             $0 |
| Asja Sever (Sailor, Daisy)                 |  $1340 | 2026-07-23 | Pack walk 2026-07-23     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-22     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-21     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-20     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-16     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-16     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-15     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-14     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-27     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-28     |    $40 |                |
|                                            |        |            | House sitting 2026-07-29 |   $110 |           $830 |
| Brianna Key (Chia, Summer)                 |    $80 | 2026-06-30 | Pack walk 2026-07-13     |    $40 |            $40 |
| Christine Rhee & Mike Starr (Frieda, Theo) |   $165 | 2026-07-16 | House sitting 2026-07-17 |   $110 |                |
|                                            |        |            | House sitting 2026-07-25 |    $55 |             $0 |
| Christine Rhee & Mike Starr (Frieda, Theo) |   $170 | 2026-07-27 | House sitting 2026-07-25 |   $170 |             $0 |
| Dwayne Jarrell (Fiddle)                    |   $175 | 2026-08-01 | Pack walk 2026-07-30     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-27     |    $40 |            $55 |
| Emma Annand & Morgan Morrell (Kevin)       |    $60 | 2026-06-20 | Pack walk 2026-07-14     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-15     |    $30 |             $0 |
| Emma Annand & Morgan Morrell (Kevin)       |    $60 | 2026-07-01 | Pack walk 2026-07-29     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-30     |    $30 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $160 | 2026-06-08 | Pack walk 2026-07-01     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-02     |    $40 |            $80 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $160 | 2026-06-19 | Pack walk 2026-07-14     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-15     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-16     |    $40 |            $40 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $160 | 2026-06-29 | Pack walk 2026-07-20     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-21     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-22     |    $40 |                |
|                                            |        |            | Boarding 2026-07-23      |    $40 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $120 | 2026-07-18 | Boarding 2026-07-23      |    $50 |                |
|                                            |        |            | Pack walk 2026-07-28     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $30 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $250 | 2026-07-25 | Pack walk 2026-07-29     |    $10 |                |
|                                            |        |            | Pack walk 2026-07-30     |    $40 |           $200 |
| Jenna Siflinger (Lola)                     |   $120 | 2026-07-30 | Pack walk 2026-07-30     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-23     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-22     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-21     |    $30 |             $0 |
| Kelly Snider (Desi)                        |   $280 | 2026-07-20 | Boarding 2026-07-17      |   $100 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $40 |           $140 |
| Liza Avramenko (Luna)                      |    $40 | 2026-07-30 | Pack walk 2026-07-30     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-06-04 | Pack walk 2026-07-02     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-06-18 | Pack walk 2026-07-16     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-06-19 | Pack walk 2026-07-17     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-06-26 | Pack walk 2026-07-23     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-02 | Pack walk 2026-07-24     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-16 | Pack walk 2026-07-30     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-17 | Pack walk 2026-07-31     |    $40 |             $0 |
| Patrick Haluska (Olive)                    |    $50 | 2026-08-06 | Pack walk 2026-07-22     |    $40 |            $10 |
| Philippe Maman (Cashew)                    |    $40 | 2026-07-29 | Pack walk 2026-07-29     |    $40 |             $0 |

## The 393 credits with no stay close enough

**Not** errors, and **not** stuck. Each one's household has unpaid stays, but none falls inside the
windows above, so the system declines to guess. They appear in the panel under _Needs your call —
not matched to a stay_, with the booking list and the reason, for you to place or leave.

Worth **$49,984**. Most should resolve on their own once earlier months are adopted from the
calendar: a 2024 payment has no plausible target today and an obvious one once 2024's walks exist.

## The 401 credits whose household owes nothing

**$39,127** across households with no unpaid booking at all. Largest first:

- Emma Burkhardt & Ryan Somerfield (Kira): 44 / $8025
- Cat Ku & Matthew Rosenthal (Cardi): 10 / $4210
- Mckenna Hearn & Olivia Barnhill (Zoe): 60 / $4140
- Claire Koory & Thomas Finch (Frankie): 64 / $2460
- Kyle Dillon & Rayven Wray (Prince, Romeo): 11 / $2160
- Asja Sever (Sailor, Daisy): 1 / $2000
- Thu Le (Marygold, Jed): 16 / $1982
- Natalia Olazabal (Sancho): 47 / $1410
- Alanna Kueffer (Sunny): 30 / $1227
- Jean Hayden (Isaac): 3 / $1220
- Naomi Fuhrmann (Shuki): 21 / $1030
- Ocoee Wilson (Goose): 9 / $995
- Lori Barnhill (Otis): 1 / $800
- Aryele Dube (Coco, Gigi): 8 / $780
- Mary Jean Gomes (Ashbury, Cole): 8 / $569
- Pete Tiburzio (Benji): 1 / $540
- Bradley Smith (Cosmos): 3 / $500
- Sarah Holmes (Pepper): 1 / $500
- Robin Kutner & Jeremy Besmer (Winnie, Penny): 6 / $450
- Kelsi Buckley & Spencer Sheaff (Pete): 5 / $440
- Theresa Mah (Reggie): 10 / $388
- Rowan Baginsky (Emma): 1 / $340
- Becca Wheeler (Ralph): 8 / $340
- KJ Glynn (Rio): 1 / $300
- Jay Van Vliet (Bertram): 2 / $250
- Marissa McVittie (Teddy): 6 / $240
- Aainy Zahra (Beamer): 1 / $220
- Mary Thoma (Frankie): 1 / $200
- Elyse Dvorkin (Charlie): 1 / $200
- Elizabeth Flynn (Blue): 4 / $170
- Stephen Le (Bernie): 1 / $160
- Laura Koon & Matthew Goerz (Roxie): 2 / $130
- Emma Annand & Morgan Morrell (Kevin): 2 / $120
- Ian Fisher & Lauren Kotin (Sadie): 1 / $120
- Garner Kropp (Izzy): 1 / $100
- Jenny Kong & Boris Yanovsky (Pepper): 2 / $91
- Alana Wang (Argyle): 2 / $80
- Kelly Snider (Desi): 1 / $50
- Kristy Abo (Maple): 1 / $45
- Brooke Bray (Marty): 1 / $45
- Philippe Maman (Cashew): 1 / $40
- Brianna Key (Chia, Summer): 1 / $40
- Laurelly Dale (Gatsby): 1 / $20

## Verifying before you apply

`docs/attribution-review.csv` is one row per pairing, with `paid_when` spelling out the direction
("9 days after the stay", "same day", "28 days before the stay"). `docs/attribution-bookings.csv`
lists every booking with the same short refs, for redirecting one.

Fill in `ok?` with `y`/`n`; use `change_to_booking` and `change_amount` where a pairing is wrong,
and `notes` for anything worth recording — including "this was for a stay not in the system yet",
which is the honest answer for a payment whose real target hasn't been adopted. Blank rows stand as
proposed. Nothing is applied by editing the file.

Sort by `paid_when` and read the prepayments first: a stay settled days after it happened is almost
certainly right, whereas one prepaid four weeks ahead is where a wrong pairing would hide.

## What happens if you apply this

For each credit you approve, the system removes the household-level credit row, writes one payment
against each booking it was split onto (same amount, date, method and note as the original), and
writes back whatever was left over as a smaller household credit. Money is conserved exactly, and
each attribution is re-checked against live balances as it is applied — anything settled in the
meantime is refused rather than overpaid, with the reason shown.

**Recovery, honestly:** there is no undo. Reversing one means deleting the payment rows it created
and the leftover credit row, then re-recording the original by hand. If unsure, apply one household
first, look at the result, then do the rest.

---

_Produced by running the preview route against a read-only copy of production data loaded into a
local test database. No production data was modified._
