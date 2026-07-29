-- Demo ACTIVITY seed: what makes the seeded tenants look like accounts a sitter has been running
-- — more clients, a booking against every enabled service, and deliberate conflicts — AND what
-- keeps their CONFIGURATION current. The three tenants were authored as literal rows over many
-- months, so sql/seed.sql still describes them with the defaults of the day they were written;
-- everything they would have if they signed up today (a 12-month booking horizon, 'linear'
-- multi-pet pricing, template-shaped species acceptance) plus the per-service features a working
-- sitter would have configured (notice periods, stay ceilings, capacity, cancellation policies,
-- holiday rates, intake questions) is re-stated here rather than there, because sql/seed.sql is
-- the fixture ~120 test files assert against.
--
-- ⚠️  DEMO DATA ONLY — DO NOT SEED A PRODUCTION DATABASE. Applied after sql/seed.sql (which this
-- file depends on for its tenants, services, options and pet-type registry) by `npm run seed:local`
-- / `seed:remote`. Every insert is INSERT OR REPLACE with a stable, explicit id, so re-running the
-- seed is idempotent.
--
-- WHY THIS IS A SEPARATE FILE. The Vitest harness (`server/__tests__/helpers.ts`) executes
-- sql/seed.sql into a real in-memory SQLite, and ~120 test files are written against that fixture:
-- exact ownership-edge lists, exact receivables per tenant, exact pet-type reference counts, and
-- pet deletions that assume no booking references the pet. Folding this activity into seed.sql
-- broke 24 of those assertions and would have meant degrading a dozen exact tenant-isolation
-- proofs into containment checks. So the base fixture stays minimal and deterministic, and the
-- lived-in demo lives here. Tests that WANT it load it through the same harness:
-- `createTestEnv({ demoActivity: true })` — see server/__tests__/seed-demo.test.ts, which proves
-- the conflicts below are real rather than decorative.
--
-- DATES ARE RELATIVE TO NOW. `date('now', '+N days')` yields exactly the 'YYYY-MM-DD' text the app
-- stores and string-compares in BookingRequests.StartDate (verified on both node:sqlite and D1).
-- Hardcoded dates rot: a demo seeded in July is an abandoned account by October. Re-running the
-- seed REPLACES these rows in place, so the whole demo rolls forward to the new "now" — same rows,
-- same shape, new dates. `date('now')` is UTC, so every offset here is >= +2 days to stay
-- comfortably in the future in any tenant timezone.
--
-- Because the window slides, the demo database must contain NO STATIC DATES — a fixed date the
-- window eventually walks over silently changes the conflicts below. sql/seed.sql's seven
-- hardcoded rows are therefore re-stamped relative to `now` near the bottom of this file; see the
-- comment there. That is what makes this seed's conflicts identical for every possible value of
-- "today" rather than only for the day it was written.

-- ============================================================================================
-- WHAT A SITTER WHO SIGNED UP TODAY WOULD ACTUALLY HAVE.
--
-- The three demo tenants were written as literal rows over many months, so they carry defaults
-- from superseded versions of the product. Their whole purpose is to show a prospective sitter
-- what this product IS, so everything below re-states them against the CURRENT create-time rules
-- and turns on the per-service features a working sitter would have configured. sql/seed.sql
-- stays the minimal, deterministic base fixture (~120 test files assert its exact contents) —
-- every "what a sitter gets today" write lives here, in the demo layer, which `seed:local` /
-- `seed:remote` apply straight after it.
--
-- EVERY STATEMENT IS TenantId-SCOPED, explicitly, to exactly the three seeded demo tenants —
-- the same discipline every INSERT in this file already follows by naming a TenantId on each row.
-- This file is chained onto `seed:remote` (package.json), so an unscoped UPDATE here would not be
-- a demo wart: applied against a real database it would rewrite every real sitter's pricing,
-- capacity, notice periods and cancellation policy. `server/__tests__/seed-demo.test.ts` guards
-- it — a fourth, unrelated tenant is seeded with a different value in every column this file
-- touches, and asserted unchanged afterwards.
-- ============================================================================================

-- THE BOOKING HORIZON (0004). `createTenantFromSignup` gives a NEW tenant MaxAdvanceMonths = 12;
-- the seeded three predate that default and were NULL (= no horizon at all), so their widgets
-- offered a customer any month into the 2030s. Sunny Paws and Paws & Relax take the signup
-- default; Happy Tails is a walk/drop-in business whose clients book weeks out, not years, so it
-- carries a deliberately tighter 6 — the knob is per-business, and a demo that shows one value
-- three times does not show a knob at all.
UPDATE Tenants SET MaxAdvanceMonths = 12 WHERE Id IN ('tnt_sunnypaws', 'tnt_pawsandrelax');
UPDATE Tenants SET MaxAdvanceMonths = 6 WHERE Id = 'tnt_happytails';

-- PET-SET PRICING MODE (0005). sql/seed.sql's services predate PetRateMode and default to
-- 'exact' — refuse a priced quote for any 2+-pet set with no stored group/mix rate. That is the
-- right behaviour for a legacy row, and it is also what `POST /:slug/admin/services` STOPPED
-- doing: a service created from here on is stamped 'linear' (owner directive, 2026-07-28), so a
-- two-dog household can book the moment the sitter types one price. A demo account must look
-- like an account someone could be running TODAY, so all three tenants' services carry the
-- current create-time default rather than the pre-0005 one.
--
-- It matters most on the widget's first screen: the embed pre-selects ALL of a customer's
-- accepted pets, and Jess owns two at Sunny Paws (Bella the dog + Mochi the cat), so on house
-- sitting — the one demo service that accepts both species — 'exact' put her straight into the
-- "ask your sitter for a rate" dead end. Walks and check-ins are included too, and deliberately:
-- they are created 'linear' by the same route, and now that the demo's walks are dog-only (see
-- the acceptance block below) the 'exact' refusal path was no longer reachable from any seeded
-- client's own roster anyway — keeping it there bought no demo value, only drift.
--
-- 'exact' is NOT untested by this: it remains the column default, sql/seed.sql leaves every base
-- fixture service on it, and the refused-not-tripled pricing lock in availability.test.ts is
-- written against it. A plain UPDATE is idempotent by construction — there is no row identity to
-- restate, so re-running this file changes nothing on a second pass.
UPDATE TenantServices SET PetRateMode = 'linear'
 WHERE TenantId IN ('tnt_sunnypaws', 'tnt_happytails', 'tnt_pawsandrelax');

-- WHICH SPECIES EACH DEMO SERVICE ACCEPTS.
--
-- `defaultAcceptedPetTypes` in src/shared/service-templates.ts is what a service created from a
-- template STARTS accepting — walks and daycare are for dogs, drop-in check-ins are usually the
-- cat's — but it only fires at create time, so the seeded tenants (which predate it, and are
-- written as literal rows rather than created through the route) never got it. A demo account
-- that contradicts the product's own default is a bad demo, so the same rule is materialized
-- here: dog-only walks/daycare/boarding, cat-only check-ins.
--
-- BOARDING is dog-only by choice, matching the demo narrative (Sunny Paws' own blurb is "a fenced
-- yard and two walks a day"; Happy Tails already carried '["dog"]'). It is NOT the template
-- default — a real sitter may board anything — but a seeded demo has to pick something, and
-- dog-only is what the sitters here are described as running.
--
-- HOUSE SITTING stays OPEN (NULL = every registry type), which is both the template default and
-- the honest answer: the sitter is in the CLIENT'S home, so which animals are there is the
-- client's call, not the sitter's. It is also what keeps the demo whole — Ana's rabbit Clover and
-- Nina's cat Sable are seeded onto house sits below, and it is the one service where Jess's
-- dog+cat pair are both accepted, which is what the 'linear' mode above exists to price.
--
-- SUBSET RULE: AcceptedPetTypes must be a subset of the tenant's own TenantPetTypes registry, and
-- an ENABLED service may not end up with an empty list (server/routes/admin.ts rejects that on
-- the next settings PUT). All three demo tenants register both 'dog' and 'cat' (sql/seed.sql), so
-- every value below is in range. Happy Tails' cat is still accepted by no ENABLED service — its
-- check-in row is Enabled=0 — which keeps the base fixture's "dogs only, and the widget shows it"
-- story intact.
--
-- TenantId-SCOPED for the same reason the UPDATE above is: this file is chained onto
-- `seed:remote`, and an unscoped write here would silently narrow every real sitter's services to
-- one species — cancelling bookings nobody asked to cancel. server/__tests__/seed-demo.test.ts
-- seeds an unrelated fourth tenant and asserts these statements leave its acceptance untouched.
UPDATE TenantServices SET AcceptedPetTypes = '["dog"]'
 WHERE TenantId IN ('tnt_sunnypaws', 'tnt_happytails', 'tnt_pawsandrelax')
   AND ServiceType IN ('boarding', 'daycare', 'walk', 'morning-walk');

UPDATE TenantServices SET AcceptedPetTypes = '["cat"]'
 WHERE TenantId IN ('tnt_sunnypaws', 'tnt_happytails', 'tnt_pawsandrelax')
   AND ServiceType = 'checkin';

UPDATE TenantServices SET AcceptedPetTypes = NULL
 WHERE TenantId IN ('tnt_sunnypaws', 'tnt_happytails', 'tnt_pawsandrelax')
   AND ServiceType = 'housesitting';

-- ============================================================================================
-- PER-SERVICE CONFIGURATION — the knobs a working sitter would have set, one UPDATE per
-- (tenant, service) so every statement names its TenantId and is auditable on its own line.
--
-- The seeded rows carried NULL for every one of these, which reads as "this product has no
-- notice period, no maximum stay, no cancellation policy, no holiday pricing and no intake
-- questions." The three tenants deliberately do NOT all show the same features — three tenants
-- is three shapes:
--
--   * Sunny Paws     — the strict, boarding-heavy business: real notice periods, a stay length
--                      cap, a two-tier cancellation policy, and the longest intake forms.
--   * Happy Tails    — the walk/drop-in business: short notice, a same-day-ish cancellation
--                      rule on walks, a holiday rate on boarding, small forms.
--   * Paws & Relax   — the relaxed one: no cancellation fees at all, no maximum stay, same-day
--                      walks welcome. NULL is a real configuration and one tenant should show it.
--
-- MaxConcurrentPets is only legal on a 'boarding'/'housesit' CapacityKind row (the admin PUT
-- rejects it elsewhere) and may never be lower than the same service's MaxPetCount — a pool that
-- could not seat one booking. Both rules are respected below.
--
-- HOLIDAY RATES and stamped EstCost. A HolidayRate is an explicit stored rate for billed units
-- landing on a listed US holiday (src/shared/util/us-holidays.ts). The demo's dates slide daily,
-- so a seeded stay WILL sometimes straddle a holiday while its stored EstCost was written at the
-- base rate — which is not a contradiction: EstCost is stamped once at booking time and never
-- updated, so those rows read exactly like bookings taken before the sitter added the rate.
-- Sunny Paws' boarding and house sitting are deliberately left holiday-free: seed-demo.test.ts
-- pins their quoted cost to an exact dollar figure, and a rate that fires on ~3% of possible
-- "todays" would make those assertions flake on dates nobody ran the suite on. Put a new holiday
-- rate on a service no test pins, or make the test choose a holiday-free window first.
-- ============================================================================================

-- SUNNY PAWS. Two nights of notice on boarding, three on a house sit (she has to collect keys),
-- a 21-night ceiling, and the fullest intake forms in the demo.
UPDATE TenantServices
   SET MinLeadDays = 2, MaxNights = 21, MaxPetCount = 2,
       CancellationTiers = '[{"withinDays":3,"percent":100},{"withinDays":7,"percent":50}]',
       Questions = '[{"id":"vaccines","label":"Are vaccinations up to date?","type":"yesno","required":true},{"id":"feeding","label":"Feeding routine (times and amounts)","type":"text","required":true},{"id":"vet","label":"Emergency vet phone number","type":"text","required":false}]'
 WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'boarding';

UPDATE TenantServices
   SET MinLeadDays = 3, MaxNights = 14, MaxPetCount = 3,
       CancellationTiers = '[{"withinDays":7,"percent":50},{"withinDays":14,"percent":25}]',
       Questions = '[{"id":"entry","label":"How will we get in?","type":"select","required":true,"options":["Lockbox","Hidden key","Hand off in person"]},{"id":"plants","label":"Plants to water?","type":"yesno","required":false},{"id":"mail","label":"Bring in the mail?","type":"yesno","required":false}]'
 WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'housesitting';

-- Daycare carries the demo's holiday rate for a 'day'-unit service ($40 base -> $55).
UPDATE TenantServices
   SET MinLeadDays = 1, MaxPetCount = 2, HolidayRate = 55,
       Questions = '[{"id":"pickup","label":"Usual pick-up time","type":"text","required":false}]'
 WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'daycare';

UPDATE TenantServices
   SET MinLeadDays = 1, MaxPetCount = 2,
       Questions = '[{"id":"leash","label":"Where is the leash kept?","type":"text","required":false}]'
 WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'walk';

UPDATE TenantServices
   SET MinLeadDays = 1, MaxPetCount = 3,
       Questions = '[{"id":"litter","label":"Scoop the litter box?","type":"yesno","required":false}]'
 WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'checkin';

-- The custom weekday-only walk stays deliberately bare: a service a sitter just added, with the
-- one option rule (WeekdaysOnly) and nothing else configured yet.
UPDATE TenantServices
   SET MinLeadDays = 1, MaxPetCount = 1
 WHERE TenantId = 'tnt_sunnypaws' AND ServiceType = 'morning-walk';

-- HAPPY TAILS. A walk business: one night of notice on boarding, none worth speaking of on
-- walks, and the demo's only "cancel the day before and you owe the whole walk" rule. Its
-- boarding carries the 'night'-unit holiday rate ($40 base -> $55).
UPDATE TenantServices
   SET MinLeadDays = 2, MaxNights = 14, MaxPetCount = 3, HolidayRate = 55,
       CancellationTiers = '[{"withinDays":2,"percent":50}]',
       Questions = '[{"id":"vaccines","label":"Are vaccinations up to date?","type":"yesno","required":true},{"id":"crate","label":"Crate trained?","type":"yesno","required":false},{"id":"dogs","label":"Gets along with other dogs?","type":"yesno","required":true}]'
 WHERE TenantId = 'tnt_happytails' AND ServiceType = 'boarding';

UPDATE TenantServices
   SET MinLeadDays = 1, MaxPetCount = 2
 WHERE TenantId = 'tnt_happytails' AND ServiceType = 'daycare';

UPDATE TenantServices
   SET MinLeadDays = 1, MaxPetCount = 2,
       CancellationTiers = '[{"withinDays":1,"percent":100}]',
       Questions = '[{"id":"gate","label":"Gate or door code","type":"text","required":false},{"id":"treats","label":"Treats allowed?","type":"yesno","required":false}]'
 WHERE TenantId = 'tnt_happytails' AND ServiceType = 'walk';

-- PAWS & RELAX. No cancellation fees anywhere, no stay ceiling, same-day walks welcome
-- (MinLeadDays stays NULL on the walk row) — the tenant that shows what "unset" looks like. Its
-- boarding pool gains a real cap of 3 so the widget prints a used/max the seeded rows never
-- reach: time off (the blocked row below) stays the only thing that closes its calendar.
UPDATE TenantServices
   SET MinLeadDays = 1, MaxPetCount = 3, MaxConcurrentPets = 3,
       Questions = '[{"id":"weight","label":"Pet weight in pounds","type":"number","required":true,"min":1,"max":200},{"id":"vaccines","label":"Are vaccinations up to date?","type":"yesno","required":true}]'
 WHERE TenantId = 'tnt_pawsandrelax' AND ServiceType = 'boarding';

-- The 'night'-unit holiday rate on the third tenant ($65 base -> $85).
UPDATE TenantServices
   SET MinLeadDays = 2, MaxPetCount = 4, HolidayRate = 85,
       Questions = '[{"id":"entry","label":"How will we get in?","type":"select","required":true,"options":["Lockbox","Hidden key","Hand off in person"]}]'
 WHERE TenantId = 'tnt_pawsandrelax' AND ServiceType = 'housesitting';

UPDATE TenantServices
   SET MaxPetCount = 2
 WHERE TenantId = 'tnt_pawsandrelax' AND ServiceType = 'walk';

-- More clients, so a busy day is several DIFFERENT families rather than one customer booked
-- against herself. Every one is active (invite-only /identify) and every one owns a pet below.
INSERT OR REPLACE INTO EndUsers (Id, TenantId, Email, Name, Phone, Status) VALUES
  ('eu_sp_marco', 'tnt_sunnypaws', 'marco@example.com', 'Marco Reyes', '(555) 555-0188', 'active'),
  ('eu_sp_priya', 'tnt_sunnypaws', 'priya@example.com', 'Priya Shah', '(555) 555-0117', 'active'),
  ('eu_sp_ana', 'tnt_sunnypaws', 'ana@example.com', 'Ana Whitfield', NULL, 'active'),
  ('eu_ht_marco', 'tnt_happytails', 'marco@example.com', 'Marco Reyes', '(555) 555-0188', 'active'),
  ('eu_ht_devon', 'tnt_happytails', 'devon@example.com', 'Devon Alvarez', '(555) 555-0163', 'active'),
  ('eu_ht_kate', 'tnt_happytails', 'kate@example.com', 'Kate Lindqvist', NULL, 'active'),
  ('eu_ht_rosa', 'tnt_happytails', 'rosa@example.com', 'Rosa Bright', NULL, 'active'),
  ('eu_pr_omar', 'tnt_pawsandrelax', 'omar@example.com', 'Omar Haddad', '(555) 555-0104', 'active'),
  ('eu_pr_nina', 'tnt_pawsandrelax', 'nina@example.com', 'Nina Castellanos', NULL, 'active');

-- One pet each (client-AND-pet invariant: no owners without pets), except Marco, who has TWO
-- dogs at Sunny Paws on purpose: boarding is dog-only there, so his household is the demo's one
-- multi-pet set on a capacity-bearing service — which is what makes the stored two-dog rate
-- below visible, and what shows a prospective sitter the pet-set pricing feature at all. Happy
-- Tails is dogs-only, so every Happy Tails pet is a dog; Sunny Paws' registry also has rabbits.
INSERT OR REPLACE INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType, Notes) VALUES
  ('pet_sp_juno', 'tnt_sunnypaws', 'eu_sp_marco', 'Juno', 'dog', 'Crate-trained; needs the door left open.'),
  ('pet_sp_ollie', 'tnt_sunnypaws', 'eu_sp_marco', 'Ollie', 'dog', 'Junos littermate — they board together.'),
  ('pet_sp_dash', 'tnt_sunnypaws', 'eu_sp_priya', 'Dash', 'dog', NULL),
  ('pet_sp_clover', 'tnt_sunnypaws', 'eu_sp_ana', 'Clover', 'rabbit', 'Timothy hay only — no pellets.'),
  ('pet_ht_scout', 'tnt_happytails', 'eu_ht_marco', 'Scout', 'dog', NULL),
  ('pet_ht_ziggy', 'tnt_happytails', 'eu_ht_devon', 'Ziggy', 'dog', 'Barks at skateboards.'),
  ('pet_ht_pepper', 'tnt_happytails', 'eu_ht_kate', 'Pepper', 'dog', NULL),
  ('pet_ht_maple', 'tnt_happytails', 'eu_ht_rosa', 'Maple', 'dog', NULL),
  ('pet_pr_biscuit', 'tnt_pawsandrelax', 'eu_pr_omar', 'Biscuit', 'dog', NULL),
  ('pet_pr_sable', 'tnt_pawsandrelax', 'eu_pr_nina', 'Sable', 'cat', 'Hides under the bed for the first hour.');

-- The authoritative owner edges. A pet without one is invisible to its own owner.
INSERT OR REPLACE INTO PetOwners (TenantId, PetId, EndUserId) VALUES
  ('tnt_sunnypaws', 'pet_sp_juno', 'eu_sp_marco'),
  ('tnt_sunnypaws', 'pet_sp_ollie', 'eu_sp_marco'),
  ('tnt_sunnypaws', 'pet_sp_dash', 'eu_sp_priya'),
  ('tnt_sunnypaws', 'pet_sp_clover', 'eu_sp_ana'),
  ('tnt_happytails', 'pet_ht_scout', 'eu_ht_marco'),
  ('tnt_happytails', 'pet_ht_ziggy', 'eu_ht_devon'),
  ('tnt_happytails', 'pet_ht_pepper', 'eu_ht_kate'),
  ('tnt_happytails', 'pet_ht_maple', 'eu_ht_rosa'),
  ('tnt_pawsandrelax', 'pet_pr_biscuit', 'eu_pr_omar'),
  ('tnt_pawsandrelax', 'pet_pr_sable', 'eu_pr_nina');

-- A STORED SPECIES-COUNT RATE. Marco's two dogs board together, and Sunny Paws priced that set
-- explicitly: $85/night for any two dogs, not the $100 the 'linear' multiplier would produce
-- from her one-dog rate. This is the demo of the rule that makes PetRateMode safe — a stored
-- pet-set rate ALWAYS beats the multiplier, because it is the number the sitter actually typed.
-- MixKey is species-sorted `slug:count` joined by '|' (buildMixKey, src/shared/pricing/
-- pet-set-rates.ts) and is keyed per OPTION, so it prices boarding's 'standard' option only.
INSERT OR REPLACE INTO TenantServicePetRates (TenantId, ServiceType, OptionKey, MixKey, Rate) VALUES
  ('tnt_sunnypaws', 'boarding', 'standard', 'dog:2', 85);

-- SUNNY PAWS — boarding (MaxConcurrentPets=2), house sitting, daycare, walk, check-in and the
-- custom weekday-only morning walk all carry work.
--
-- THE BOARDING CONFLICT: two confirmed 1-pet stays overlap on now+7..now+10, filling the 2-pet
-- pool (those days paint `unavailable`, the shoulder days now+5/+6/+11 paint `partial`), and a
-- third request is still PENDING across now+8..now+9 — a decision the sitter cannot simply
-- accept, because confirming it would put three pets in a two-pet pool.
--
-- Every EstCost is nights x the option's stored Rate (boarding $50, house sitting $70, and the
-- flat option rate for single-day services), so nothing here is a price the server would not have
-- quoted. PetCount is always 1 in every seeded booking below, on purpose, so each EstCost is
-- unambiguous regardless of a service's PetRateMode — the 'linear' multiplier above only ever
-- fires for a pet SET (2+ distinct pets) a customer selects live in the widget, never for a
-- seeded row.
--
-- ANSWERS. The admin bookings list renders each row's stored Answers JSON against its service's
-- Questions inline in the expanded row, so a service that asks a REQUIRED question and a booking
-- that answers nothing is a booking the POST would itself have rejected — the same class of
-- self-contradiction as a seeded stay the capacity engine would refuse. Every answer below is
-- keyed by its question's `id` and valid for its type (yesno = 'yes'/'no', select = one of the
-- stored options, number = a numeric string); seed-demo.test.ts re-checks them through the real
-- `validateAnswers`. '{}' appears only where a service asks nothing, or asks only optional
-- questions the customer skipped — which is a real state and worth showing too.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Answers, Status) VALUES
  ('seed_sp_board_a', 'tnt_sunnypaws', 'eu_sp_jess', 'boarding', date('now', '+5 days'), date('now', '+12 days'), 'standard', 1, NULL, 350, '{"vaccines":"yes","feeding":"Two cups at 7am and 6pm. No chicken.","vet":"(555) 555-0190"}', 'confirmed'),
  ('seed_sp_board_b', 'tnt_sunnypaws', 'eu_sp_marco', 'boarding', date('now', '+7 days'), date('now', '+11 days'), 'standard', 1, '16:00', 200, '{"vaccines":"yes","feeding":"One scoop at 8am, one at 7pm.","vet":"(555) 555-0177"}', 'confirmed'),
  ('seed_sp_board_c', 'tnt_sunnypaws', 'eu_sp_priya', 'boarding', date('now', '+8 days'), date('now', '+10 days'), 'standard', 1, NULL, 100, '{"vaccines":"yes","feeding":"Half a cup three times a day."}', 'pending'),
  ('seed_sp_house_a', 'tnt_sunnypaws', 'eu_sp_ana', 'housesitting', date('now', '+24 days'), date('now', '+29 days'), 'standard', 1, NULL, 350, '{"entry":"Lockbox","plants":"yes","mail":"yes"}', 'confirmed'),
  ('seed_sp_day_a', 'tnt_sunnypaws', 'eu_sp_marco', 'daycare', date('now', '+3 days'), NULL, 'standard', 1, NULL, 40, '{"pickup":"5:30pm"}', 'confirmed'),
  ('seed_sp_day_b', 'tnt_sunnypaws', 'eu_sp_priya', 'daycare', date('now', '+17 days'), NULL, 'standard', 1, NULL, 40, '{"pickup":"6pm"}', 'pending'),
  ('seed_sp_walk_a', 'tnt_sunnypaws', 'eu_sp_jess', 'walk', date('now', '+2 days'), NULL, 'd60', 1, '08:30', 35, '{"leash":"Hook by the front door."}', 'confirmed'),
  ('seed_sp_walk_b', 'tnt_sunnypaws', 'eu_sp_marco', 'walk', date('now', '+9 days'), NULL, 'd30', 1, '07:30', 20, '{}', 'confirmed'),
  ('seed_sp_chk_a', 'tnt_sunnypaws', 'eu_sp_jess', 'checkin', date('now', '+6 days'), NULL, 'd15', 1, '12:00', 12, '{"litter":"yes"}', 'confirmed'),
  ('seed_sp_chk_b', 'tnt_sunnypaws', 'eu_sp_jess', 'checkin', date('now', '+20 days'), NULL, 'd30', 1, '17:00', 18, '{"litter":"yes"}', 'pending'),
  -- Morning walk is WeekdaysOnly=1, so these use SQLite's `weekday N` modifier (0=Sun..6=Sat) to
  -- land on a real weekday however the seed is re-run: a Wednesday and a Tuesday, never a weekend.
  ('seed_sp_mw_a', 'tnt_sunnypaws', 'eu_sp_marco', 'morning-walk', date('now', '+7 days', 'weekday 3'), NULL, 'd30', 1, '07:00', 18, '{}', 'confirmed'),
  ('seed_sp_mw_b', 'tnt_sunnypaws', 'eu_sp_priya', 'morning-walk', date('now', '+14 days', 'weekday 2'), NULL, 'd30', 1, '07:00', 18, '{}', 'pending');

-- HAPPY TAILS — boarding (MaxConcurrentPets=4), daycare and walks. House sitting and check-in are
-- disabled for this tenant, so they deliberately carry no bookings.
--
-- THE BOARDING CONFLICT: a week that fills up. Four confirmed stays nest inside each other and a
-- fifth is pending, so now+16..now+18 sits AT or OVER the 4-pet pool (five pets on now+17) and
-- paints `unavailable`, while the shoulder days now+14/+15/+19/+20 paint `partial`.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Answers, Status) VALUES
  ('seed_ht_board_a', 'tnt_happytails', 'eu_ht_jess', 'boarding', date('now', '+14 days'), date('now', '+21 days'), 'standard', 1, NULL, 280, '{"vaccines":"yes","crate":"no","dogs":"yes"}', 'confirmed'),
  ('seed_ht_board_b', 'tnt_happytails', 'eu_ht_marco', 'boarding', date('now', '+15 days'), date('now', '+20 days'), 'standard', 1, NULL, 200, '{"vaccines":"yes","crate":"yes","dogs":"yes"}', 'confirmed'),
  ('seed_ht_board_c', 'tnt_happytails', 'eu_ht_devon', 'boarding', date('now', '+16 days'), date('now', '+19 days'), 'standard', 1, '18:00', 120, '{"vaccines":"yes","crate":"no","dogs":"yes"}', 'confirmed'),
  ('seed_ht_board_d', 'tnt_happytails', 'eu_ht_kate', 'boarding', date('now', '+17 days'), date('now', '+18 days'), 'standard', 1, NULL, 40, '{"vaccines":"yes","dogs":"yes"}', 'confirmed'),
  ('seed_ht_board_e', 'tnt_happytails', 'eu_ht_rosa', 'boarding', date('now', '+16 days'), date('now', '+19 days'), 'standard', 1, NULL, 120, '{"vaccines":"yes","crate":"yes","dogs":"no"}', 'pending'),
  ('seed_ht_day_a', 'tnt_happytails', 'eu_ht_marco', 'daycare', date('now', '+4 days'), NULL, 'standard', 1, NULL, 35, '{}', 'confirmed'),
  ('seed_ht_day_b', 'tnt_happytails', 'eu_ht_kate', 'daycare', date('now', '+11 days'), NULL, 'standard', 1, NULL, 35, '{}', 'pending'),
  ('seed_ht_walk_a', 'tnt_happytails', 'eu_ht_devon', 'walk', date('now', '+3 days'), NULL, 'd30', 1, '16:00', 25, '{"gate":"1932","treats":"yes"}', 'confirmed'),
  -- THE SLOT CONFLICT: the 8-9am group walk holds three dogs (TenantServiceOptions.Capacity=3).
  -- Three confirmed bookings on one date fill it, so that date is unavailable for THAT option
  -- while the tenant's other walk options stay open — the per-slot conflict group services hit.
  ('seed_ht_grp_a', 'tnt_happytails', 'eu_ht_marco', 'walk', date('now', '+6 days'), NULL, 'group-8-9', 1, '08:00', 18, '{"treats":"yes"}', 'confirmed'),
  ('seed_ht_grp_b', 'tnt_happytails', 'eu_ht_devon', 'walk', date('now', '+6 days'), NULL, 'group-8-9', 1, '08:00', 18, '{"treats":"no"}', 'confirmed'),
  ('seed_ht_grp_c', 'tnt_happytails', 'eu_ht_kate', 'walk', date('now', '+6 days'), NULL, 'group-8-9', 1, '08:00', 18, '{}', 'confirmed');

-- PAWS & RELAX — boarding, house sitting and walks (daycare and check-in are disabled). Its
-- boarding pool is capped at 3 pets/day but the seeded stays never reach it, so its calendar is
-- still closed only by the blocked row below — the "time off" mechanism, shown on a tenant whose
-- pool never fills.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Answers, Status) VALUES
  ('seed_pr_board_a', 'tnt_pawsandrelax', 'eu_pr_jess', 'boarding', date('now', '+9 days'), date('now', '+13 days'), 'standard', 1, NULL, 180, '{"weight":"45","vaccines":"yes"}', 'confirmed'),
  ('seed_pr_board_b', 'tnt_pawsandrelax', 'eu_pr_omar', 'boarding', date('now', '+10 days'), date('now', '+12 days'), 'standard', 1, '15:30', 90, '{"weight":"22","vaccines":"yes"}', 'pending'),
  ('seed_pr_house_a', 'tnt_pawsandrelax', 'eu_pr_nina', 'housesitting', date('now', '+19 days'), date('now', '+23 days'), 'standard', 1, NULL, 260, '{"entry":"Hidden key"}', 'confirmed'),
  ('seed_pr_walk_a', 'tnt_pawsandrelax', 'eu_pr_omar', 'walk', date('now', '+2 days'), NULL, 'd30', 1, '17:30', 22, '{}', 'confirmed'),
  ('seed_pr_walk_b', 'tnt_pawsandrelax', 'eu_pr_jess', 'walk', date('now', '+8 days'), NULL, 'd30', 1, '11:00', 22, '{}', 'pending');

-- REBASING THE BASE FIXTURE'S SEVEN HARDCODED ROWS.
--
-- sql/seed.sql dates its own bookings statically (2026-08-10/20, 2028-06-20, 2028-07-03) because
-- ~120 tests assert those literals. Left alone in the DEMO database they are a time bomb: this
-- file's window slides forward every day, and `listCapacityRows` counts pending and confirmed
-- alike, so sooner or later a static row drifts into a day this file's conflicts are built on --
-- silently changing an `available` day to `partial`, or a 1-pet shoulder to a full one. (Sweeping
-- the next 900 days found 35 such days: 2026-08-08..08-17 and most of 2028-06.) It also produced a
-- real data defect: on 2026-07-28 the house sit below overlapped seed_sp_pend2's boarding nights
-- by two days, which `rangeHasConflict`'s tenant-wide house-sit rule (at most ONE day of overlap)
-- would have refused -- a confirmed booking the server itself would not have accepted.
--
-- So the demo database contains NO static dates at all: the seven rows are re-stamped here,
-- relative to the same `now`, parked at +38..+62 where they are clear of every day this file's
-- conflicts assert on (which reach +33). Same ids, so the base fixture is unchanged for every test
-- that does not opt into the demo, and re-running the seed is still idempotent. If you add a
-- statically-dated booking to seed.sql, re-stamp it here too -- server/__tests__/seed-demo.test.ts
-- fails if any demo-database booking sits outside the relative window.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Answers, Status) VALUES
  ('seed_sp_pend1', 'tnt_sunnypaws', 'eu_sp_jess', 'walk', date('now', '+38 days'), NULL, 'd30', 1, '09:00', 20, '{"leash":"Hook by the front door."}', 'pending'),
  ('seed_ht_pend1', 'tnt_happytails', 'eu_ht_jess', 'walk', date('now', '+39 days'), NULL, 'd60', 1, '15:00', 40, '{"gate":"4410","treats":"no"}', 'pending'),
  ('seed_sp_pend2', 'tnt_sunnypaws', 'eu_sp_jess', 'boarding', date('now', '+40 days'), date('now', '+43 days'), 'standard', 1, NULL, 150, '{"vaccines":"yes","feeding":"Two cups at 7am and 6pm. No chicken."}', 'pending'),
  ('seed_sp_board1', 'tnt_sunnypaws', 'eu_sp_jess', 'boarding', date('now', '+50 days'), date('now', '+55 days'), 'standard', 1, NULL, 250, '{"vaccines":"yes","feeding":"Two cups at 7am and 6pm. No chicken.","vet":"(555) 555-0190"}', 'confirmed'),
  -- The base row books two pets for $400. In the DEMO database it becomes a 1-pet stay at 5 x $40,
  -- for the same reason nothing else here books a set: every seeded booking keeps PetCount at 1
  -- so its EstCost stays unambiguous (see the PetRateMode note above).
  ('seed_ht_board1', 'tnt_happytails', 'eu_ht_jess', 'boarding', date('now', '+50 days'), date('now', '+55 days'), 'standard', 1, NULL, 200, '{"vaccines":"yes","crate":"no","dogs":"yes"}', 'confirmed');

-- THE BLOCKED-DAY CONFLICT: time off (the 'blocked' sentinel; EndDate exclusive). A hard stop for
-- EVERY service on those days — no bookend sharing, no pool math — so each tenant's calendar has
-- a stretch of closed days a prospective sitter can recognise.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, EstCost, Status) VALUES
  ('seed_sp_block2', 'tnt_sunnypaws', NULL, 'blocked', date('now', '+30 days'), date('now', '+33 days'), 1, NULL, 'confirmed'),
  ('seed_ht_block2', 'tnt_happytails', NULL, 'blocked', date('now', '+26 days'), date('now', '+28 days'), 1, NULL, 'confirmed'),
  ('seed_pr_block1', 'tnt_pawsandrelax', NULL, 'blocked', date('now', '+15 days'), date('now', '+17 days'), 1, NULL, 'confirmed'),
  -- The base fixture's two static blocked ranges, re-stamped out past everything else (see above).
  ('seed_sp_block1', 'tnt_sunnypaws', NULL, 'blocked', date('now', '+60 days'), date('now', '+62 days'), 1, NULL, 'confirmed'),
  ('seed_ht_block1', 'tnt_happytails', NULL, 'blocked', date('now', '+60 days'), date('now', '+62 days'), 1, NULL, 'confirmed');

-- Which pet each booking is for. BookingRequests carries no PetType column: pet references flow
-- through BookingRequestPets -> EndUserPets, so a booking with no row here shows no pet name.
INSERT OR REPLACE INTO BookingRequestPets (BookingRequestId, PetId) VALUES
  ('seed_sp_board_a', 'pet_sp_bella'),
  ('seed_sp_board_b', 'pet_sp_juno'),
  ('seed_sp_board_c', 'pet_sp_dash'),
  ('seed_sp_house_a', 'pet_sp_clover'),
  ('seed_sp_day_a', 'pet_sp_juno'),
  ('seed_sp_day_b', 'pet_sp_dash'),
  ('seed_sp_walk_a', 'pet_sp_bella'),
  ('seed_sp_walk_b', 'pet_sp_juno'),
  ('seed_sp_chk_a', 'pet_sp_mochi'),
  ('seed_sp_chk_b', 'pet_sp_mochi'),
  ('seed_sp_mw_a', 'pet_sp_juno'),
  ('seed_sp_mw_b', 'pet_sp_dash'),
  ('seed_ht_board_a', 'pet_ht_otis'),
  ('seed_ht_board_b', 'pet_ht_scout'),
  ('seed_ht_board_c', 'pet_ht_ziggy'),
  ('seed_ht_board_d', 'pet_ht_pepper'),
  ('seed_ht_board_e', 'pet_ht_maple'),
  ('seed_ht_day_a', 'pet_ht_scout'),
  ('seed_ht_day_b', 'pet_ht_pepper'),
  ('seed_ht_walk_a', 'pet_ht_ziggy'),
  ('seed_ht_grp_a', 'pet_ht_scout'),
  ('seed_ht_grp_b', 'pet_ht_ziggy'),
  ('seed_ht_grp_c', 'pet_ht_pepper'),
  ('seed_pr_board_a', 'pet_pr_luna'),
  ('seed_pr_board_b', 'pet_pr_biscuit'),
  ('seed_pr_house_a', 'pet_pr_sable'),
  ('seed_pr_walk_a', 'pet_pr_biscuit'),
  ('seed_pr_walk_b', 'pet_pr_luna'),
  -- The re-stamped base rows get their pet links too, so no booking in the demo database shows a
  -- blank pet column. (The base fixture deliberately still has none — tests assert on that.)
  ('seed_sp_pend1', 'pet_sp_bella'),
  ('seed_sp_pend2', 'pet_sp_bella'),
  ('seed_sp_board1', 'pet_sp_bella'),
  ('seed_ht_pend1', 'pet_ht_otis'),
  ('seed_ht_board1', 'pet_ht_otis');
