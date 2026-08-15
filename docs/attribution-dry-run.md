# Payment attribution — dry run

**Nothing has been changed.** This is what _Attribute unattached credits_ would propose against your
live account right now, produced by running the real preview route over a read-only copy of
production. Every figure below is the route's own answer, not an estimate.

Whole dollars throughout; nothing is rounded.

## The headline

|                                                        |                                |
| ------------------------------------------------------ | -----------------------------: |
| Unattached credits on the account                      |     **821**, worth **$92,941** |
| Credits that would be placed                           | **26**, across **54** bookings |
| Money that would move onto bookings                    |                     **$2,435** |
| Credits with no stay close enough — **yours to place** |       **29**, worth **$7,326** |
| Credits whose household owes nothing — untouched       |     **766**, worth **$82,095** |

## How close the matches are

| Gap between payment and stay | Splits |
| ---------------------------- | -----: |
| same day                     |     15 |
| within 3 days                |     19 |
| within a week                |     11 |
| within 2 weeks               |      6 |
| over 2 weeks                 |      3 |

**34 of 54 land within three days of the stay.**

## How a payment finds a stay

Three rules, in this order:

1. **Closest pair first.** Within a household, the payment whose nearest unpaid stay is closest is
   placed first, then the next, and so on. Not oldest-payment-first — that let a payment 28 days
   away consume a stay before the same-day payment sitting right there could reach it.
2. **Direction matters.** A payment settles work already done, so a stay on or before the payment
   is a candidate up to 90 days back, while a stay after it is a candidate only 30 days forward.
   The past wins ties.
3. **Nothing close enough is refused, not guessed** — reported as _no stay close enough_ and handed
   to you to place.

Both real-world shapes fall out of this:

|                            | Example from your data                                                    |
| -------------------------- | ------------------------------------------------------------------------- |
| One payment, several stays | Dwayne Jarrell, $175 on 08-01 → walks on 07-27, 07-29, 07-30              |
| Several payments, one stay | three bookings here are funded by more than one payment                   |
| Pays same day              | Alana Wang's three walks → 07-17 (+1), 07-23 (same day), 07-30 (same day) |

## What this replaced

The first run of this dry run proposed 47 credits over 77 splits — conserving exactly, and
substantively wrong. **52 of 77 splits paired a payment with a stay more than 18 months away**, and
one household's $42 credit was split $5 onto one walk and $37 onto another purely because that is
where the running total sat.

|                           | First run |           Now |
| ------------------------- | --------: | ------------: |
| over 18 months apart      | 52 splits |         **0** |
| within 3 days of the stay |  2 splits | **34 splits** |

## Every proposal

Blank cells continue the row above: one credit splitting across several bookings.

| Household                                  | Credit | Paid       | Goes to                  | Amount | Left as credit |
| ------------------------------------------ | -----: | ---------- | ------------------------ | -----: | -------------: |
| Alana Wang (Argyle)                        |    $40 | 2026-07-17 | Pack walk 2026-07-16     |    $40 |             $0 |
| Alana Wang (Argyle)                        |    $40 | 2026-07-23 | Pack walk 2026-07-23     |    $40 |             $0 |
| Alana Wang (Argyle)                        |    $40 | 2026-07-30 | Pack walk 2026-07-30     |    $40 |             $0 |
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
| Brianna Key (Chia, Summer)                 |    $40 | 2026-07-13 | Pack walk 2026-07-13     |    $40 |             $0 |
| Christine Rhee & Mike Starr (Frieda, Theo) |   $165 | 2026-07-16 | House sitting 2026-07-17 |   $110 |                |
|                                            |        |            | House sitting 2026-07-25 |    $55 |             $0 |
| Christine Rhee & Mike Starr (Frieda, Theo) |   $170 | 2026-07-27 | House sitting 2026-07-25 |   $170 |             $0 |
| Dwayne Jarrell (Fiddle)                    |   $175 | 2026-08-01 | Pack walk 2026-07-30     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-27     |    $40 |            $55 |
| Emma Annand & Morgan Morrell (Kevin)       |    $60 | 2026-07-15 | Pack walk 2026-07-15     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-14     |    $30 |             $0 |
| Emma Annand & Morgan Morrell (Kevin)       |    $60 | 2026-08-04 | Pack walk 2026-07-30     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $30 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $160 | 2026-06-29 | Pack walk 2026-07-01     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-02     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-14     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-15     |    $40 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $120 | 2026-07-18 | Pack walk 2026-07-16     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-20     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-21     |    $40 |             $0 |
| Ian Fisher & Lauren Kotin (Sadie)          |   $250 | 2026-07-25 | Boarding 2026-07-23      |    $90 |                |
|                                            |        |            | Pack walk 2026-07-22     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-28     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-29     |    $40 |                |
|                                            |        |            | Pack walk 2026-07-30     |    $40 |             $0 |
| Jenna Siflinger (Lola)                     |   $120 | 2026-07-30 | Pack walk 2026-07-30     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-23     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-22     |    $30 |                |
|                                            |        |            | Pack walk 2026-07-21     |    $30 |             $0 |
| Kelly Snider (Desi)                        |   $280 | 2026-07-20 | Boarding 2026-07-17      |    $90 |           $190 |
| Kelly Snider (Desi)                        |    $50 | 2026-07-29 | Pack walk 2026-07-29     |    $40 |                |
|                                            |        |            | Boarding 2026-07-17      |    $10 |             $0 |
| Liza Avramenko (Luna)                      |    $40 | 2026-07-30 | Pack walk 2026-07-30     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-02 | Pack walk 2026-07-02     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-16 | Pack walk 2026-07-16     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-17 | Pack walk 2026-07-17     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-23 | Pack walk 2026-07-23     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-24 | Pack walk 2026-07-24     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-31 | Pack walk 2026-07-31     |    $40 |             $0 |
| Marissa McVittie (Teddy)                   |    $40 | 2026-07-31 | Pack walk 2026-07-30     |    $40 |             $0 |
| Patrick Haluska (Olive)                    |    $50 | 2026-08-06 | Pack walk 2026-07-22     |    $40 |            $10 |
| Philippe Maman (Cashew)                    |    $40 | 2026-07-29 | Pack walk 2026-07-29     |    $40 |             $0 |

## The 29 credits with no stay close enough

**Not** errors, and **not** stuck. Each one's household has unpaid stays, but none is close enough,
so the system declines to guess. They appear in the panel under _Needs your call — not matched to a
stay_, for you to place or leave. Worth **$7,326**.

Most should resolve once earlier months are adopted from the calendar: a 2024 payment has no
plausible target today and an obvious one once 2024's walks exist.

## The 766 credits whose household owes nothing

**$82,095** across households with no unpaid booking at all. Largest first:

- Dwayne Jarrell (Fiddle): 102 / $15154
- Asja Sever (Sailor, Daisy): 63 / $14205
- Ian Fisher & Lauren Kotin (Sadie): 86 / $9865
- Emma Burkhardt & Ryan Somerfield (Kira): 44 / $8025
- Cat Ku & Matthew Rosenthal (Cardi): 10 / $4210
- Mckenna Hearn & Olivia Barnhill (Zoe): 60 / $4140
- Emma Annand & Morgan Morrell (Kevin): 46 / $2525
- Claire Koory & Thomas Finch (Frankie): 64 / $2460
- Kyle Dillon & Rayven Wray (Prince, Romeo): 11 / $2160
- Thu Le (Marygold, Jed): 16 / $1982
- Marissa McVittie (Teddy): 41 / $1799
- Natalia Olazabal (Sancho): 47 / $1410
- Alanna Kueffer (Sunny): 30 / $1227
- Jean Hayden (Isaac): 3 / $1220
- Naomi Fuhrmann (Shuki): 21 / $1030
- Ocoee Wilson (Goose): 9 / $995
- Patrick Haluska (Olive): 8 / $930
- Lori Barnhill (Otis): 1 / $800
- Aryele Dube (Coco, Gigi): 8 / $780
- Mary Jean Gomes (Ashbury, Cole): 8 / $569
- Alana Wang (Argyle): 14 / $560
- Pete Tiburzio (Benji): 1 / $540
- Bradley Smith (Cosmos): 3 / $500
- Kelly Snider (Desi): 18 / $500
- Sarah Holmes (Pepper): 1 / $500
- Robin Kutner & Jeremy Besmer (Winnie, Penny): 6 / $450
- Kelsi Buckley & Spencer Sheaff (Pete): 5 / $440
- Theresa Mah (Reggie): 10 / $388
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
- Brianna Key (Chia, Summer): 1 / $80
- Kristy Abo (Maple): 1 / $45
- Brooke Bray (Marty): 1 / $45
- Philippe Maman (Cashew): 1 / $40
- Laurelly Dale (Gatsby): 1 / $20

## Verifying before you apply

`docs/attribution-review.csv` is one row per pairing, with `paid_when` in words ("same day", "1 day
after the stay", "12 days before the stay"). `docs/attribution-bookings.csv` lists every booking
with the same short refs, for redirecting one.

**Tips.** A payment can be more than the stay cost because the client tipped. Today any excess
becomes `leftover` — which tells you the client is owed money when in fact they were thanking
you. Put the tip amount in the `tip` column on the row it belongs to and it stops being credit: it
is recorded as a charge on that stay, so the stay expects the larger figure and the payment settles
it exactly.

Two things to look for: a small leftover on a payment that closely matches one stay (Kelly Snider's
$50 on 07-29 covers a $40 same-day walk and spills $10 onto a boarding twelve days earlier — that
$10 is much more likely a tip), and a large `leftover` on a payment made just after a stay.

Fill in `ok?` with `y`/`n`; use `change_to_booking` and `change_amount` where a pairing is wrong,
and `notes` for anything worth recording — including "this was for a stay not in the system yet",
which is the honest answer for a payment whose real target hasn't been adopted. Blank rows stand as
proposed. Nothing is applied by editing the file.

Read the prepayments first. A stay settled on the day or a day or two later is almost certainly
right; a stay prepaid two weeks ahead is where a wrong pairing would hide.

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
