-- Calendar description cost basis (per-tenant, 2026-08-15):
--   Tenants.CalendarCostBasis — how the calendar backfill reads a description `Cost:` line on a
--   RANGE-shaped service (boarding, house sitting), where a stay has nights to bill.
--
--     'total'     = the figure is the whole charge for the stay. THE DEFAULT.
--     'per-night' = the figure is a nightly rate; the backfill multiplies it by the stay's nights.
--
-- A SINGLE-shaped service (a walk, a drop-in) has no nights, so its `Cost:` is the whole charge
-- under BOTH values and this setting never reaches that path.
--
-- WHY THE DEFAULT IS 'total', which is a safety choice and not just a compatibility one: the two
-- ways of being wrong are not symmetric. Reading a total AS a per-night rate triples a three-night
-- stay and OVERCHARGES A REAL CLIENT — money taken from someone who never agreed to it, and the
-- sitter finds out from the client. Reading a per-night rate as a total undercharges the sitter,
-- which is her own revenue to forgo and her own setting to correct. When the stored value is wrong
-- the harm must land on the party who owns the setting, so the default is the one that can only
-- ever cost the sitter. It is also exactly the behaviour every tenant had before per-night
-- multiplication existed, so applying this migration moves nobody's money until someone chooses
-- otherwise in the admin.
--
-- Additive and backward-compatible, the same shape as 0005's PetRateMode: `NOT NULL DEFAULT
-- 'total'` makes SQLite stamp every existing row with today's behaviour, and every future signup
-- inherits it without `createTenantFromSignup` naming the column. The CHECK is the last line of
-- defence behind the admin PUT's own validation — a value outside the union would be read as
-- "not per-night" and silently behave as a total, so it must not be storable at all.
--
-- This IS a `Tenants` column the request path reads (the backfill preview/import routes classify
-- against the cached tenant row), so `tenantCacheKey` is bumped v3 -> v4 in the same commit.

ALTER TABLE Tenants
  ADD COLUMN CalendarCostBasis TEXT NOT NULL DEFAULT 'total'
  CHECK (CalendarCostBasis IN ('total', 'per-night'));
