-- Migration 0009. The EXTRA-TIME SURCHARGE.
--
-- The sitter stores the hours a stay NORMALLY starts and ends, plus two independent FLAT
-- whole-dollar fees. An owner-set arrival before `StandardArrivalTime` costs `EarlyArrivalFee`; an
-- owner-set departure after `StandardDepartureTime` costs `LateDepartureFee`. Each side needs BOTH
-- its time and its fee to do anything, so NULL anywhere is the feature switched off — the
-- `HolidayRate` convention, and byte-identical to pre-migration behaviour for every existing row.
--
-- WHERE THE MONEY GOES, and why. `estimateCost`'s docblock states that the only arithmetic
-- permitted there is units of time × a stored rate (× the distinct pet count where the sitter stored
-- `PetRateMode = 'linear'`), and that nothing may be "multiplied, scaled, or SURCHARGED". So the fee
-- is NOT part of `EstCost`. It lands as a `BookingCharges` row, which is not merely deference:
-- inside `estimateCost` the `'linear'` multiplier is applied to the composed total, so a $20 early
-- arrival would silently become $60 for three dogs — a per-pet fee nobody typed, which is exactly
-- the defect the no-inferred-pricing invariant exists to prevent. As a charge it costs nothing:
-- `EstCost` keeps meaning "the price of the stay" and `total due = EstCost + SUM(charges)` picks the
-- fee up at every read site that already derives it that way.
--
-- FLAT and PER STAY, deliberately. An hourly fee needs a rounding rule, and a rounding rule is a
-- price the sitter did not type. A per-DAY fee would bill a multi-night stay repeatedly for a single
-- early drop-off, inventing an event that never happened. A stay has exactly one arrival and one
-- departure, so there are at most two charges and the feature performs no multiplication at all.
--
-- `BookingCharges.Origin` is the provenance that makes an EDIT safe. NULL = the sitter typed the
-- charge herself, which is every row that exists today and every row the admin Charges panel
-- writes. The two 'extra_time_*' values mark a charge DERIVED from the booking's times, so an edit
-- that MOVES those times re-derives exactly those rows and leaves hers untouched — and an edit that
-- moves nothing re-derives nothing, which is what lets a fee she deliberately deleted stay deleted.
--
-- No `Tenants` column, so the KV tenant-config cache key (`tenant:<slug>:config:v2`) needs NO bump:
-- that cache holds the `Tenants` row only, and these live on `TenantServices`, which the request
-- path reads fresh via `listServices`.
--
-- CHECK constraints on ALTER TABLE ADD COLUMN are supported by SQLite (see 0002, which did the same
-- for HolidayRate), so the DB enforces the same domains the API layer validates.
ALTER TABLE TenantServices ADD COLUMN StandardArrivalTime TEXT;
ALTER TABLE TenantServices ADD COLUMN StandardDepartureTime TEXT;
ALTER TABLE TenantServices ADD COLUMN EarlyArrivalFee INTEGER CHECK (EarlyArrivalFee IS NULL OR EarlyArrivalFee >= 1);
ALTER TABLE TenantServices ADD COLUMN LateDepartureFee INTEGER CHECK (LateDepartureFee IS NULL OR LateDepartureFee >= 1);

ALTER TABLE BookingCharges ADD COLUMN Origin TEXT CHECK (Origin IS NULL OR Origin IN ('extra_time_early', 'extra_time_late'));
