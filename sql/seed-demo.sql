-- Demo ACTIVITY seed: what makes the seeded tenants look like accounts a sitter has been running
-- — more clients, a booking against every enabled service, and deliberate conflicts.
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

-- One pet each (client-AND-pet invariant: no owners without pets). Happy Tails is dogs-only, so
-- every Happy Tails pet is a dog; Sunny Paws' registry also has cats and rabbits.
INSERT OR REPLACE INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType, Notes) VALUES
  ('pet_sp_juno', 'tnt_sunnypaws', 'eu_sp_marco', 'Juno', 'dog', 'Crate-trained; needs the door left open.'),
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
  ('tnt_sunnypaws', 'pet_sp_dash', 'eu_sp_priya'),
  ('tnt_sunnypaws', 'pet_sp_clover', 'eu_sp_ana'),
  ('tnt_happytails', 'pet_ht_scout', 'eu_ht_marco'),
  ('tnt_happytails', 'pet_ht_ziggy', 'eu_ht_devon'),
  ('tnt_happytails', 'pet_ht_pepper', 'eu_ht_kate'),
  ('tnt_happytails', 'pet_ht_maple', 'eu_ht_rosa'),
  ('tnt_pawsandrelax', 'pet_pr_biscuit', 'eu_pr_omar'),
  ('tnt_pawsandrelax', 'pet_pr_sable', 'eu_pr_nina');

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
-- quoted. PetCount is always 1: a set of 2+ pets with no stored pet-set rate is REFUSED at
-- pricing, and an unpriceable booking is a bad demo.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Status) VALUES
  ('seed_sp_board_a', 'tnt_sunnypaws', 'eu_sp_jess', 'boarding', date('now', '+5 days'), date('now', '+12 days'), 'standard', 1, NULL, 350, 'confirmed'),
  ('seed_sp_board_b', 'tnt_sunnypaws', 'eu_sp_marco', 'boarding', date('now', '+7 days'), date('now', '+11 days'), 'standard', 1, '16:00', 200, 'confirmed'),
  ('seed_sp_board_c', 'tnt_sunnypaws', 'eu_sp_priya', 'boarding', date('now', '+8 days'), date('now', '+10 days'), 'standard', 1, NULL, 100, 'pending'),
  ('seed_sp_house_a', 'tnt_sunnypaws', 'eu_sp_ana', 'housesitting', date('now', '+24 days'), date('now', '+29 days'), 'standard', 1, NULL, 350, 'confirmed'),
  ('seed_sp_day_a', 'tnt_sunnypaws', 'eu_sp_marco', 'daycare', date('now', '+3 days'), NULL, 'standard', 1, NULL, 40, 'confirmed'),
  ('seed_sp_day_b', 'tnt_sunnypaws', 'eu_sp_priya', 'daycare', date('now', '+17 days'), NULL, 'standard', 1, NULL, 40, 'pending'),
  ('seed_sp_walk_a', 'tnt_sunnypaws', 'eu_sp_jess', 'walk', date('now', '+2 days'), NULL, 'd60', 1, '08:30', 35, 'confirmed'),
  ('seed_sp_walk_b', 'tnt_sunnypaws', 'eu_sp_marco', 'walk', date('now', '+9 days'), NULL, 'd30', 1, '07:30', 20, 'confirmed'),
  ('seed_sp_chk_a', 'tnt_sunnypaws', 'eu_sp_jess', 'checkin', date('now', '+6 days'), NULL, 'd15', 1, '12:00', 12, 'confirmed'),
  ('seed_sp_chk_b', 'tnt_sunnypaws', 'eu_sp_jess', 'checkin', date('now', '+20 days'), NULL, 'd30', 1, '17:00', 18, 'pending'),
  -- Morning walk is WeekdaysOnly=1, so these use SQLite's `weekday N` modifier (0=Sun..6=Sat) to
  -- land on a real weekday however the seed is re-run: a Wednesday and a Tuesday, never a weekend.
  ('seed_sp_mw_a', 'tnt_sunnypaws', 'eu_sp_marco', 'morning-walk', date('now', '+7 days', 'weekday 3'), NULL, 'd30', 1, '07:00', 18, 'confirmed'),
  ('seed_sp_mw_b', 'tnt_sunnypaws', 'eu_sp_priya', 'morning-walk', date('now', '+14 days', 'weekday 2'), NULL, 'd30', 1, '07:00', 18, 'pending');

-- HAPPY TAILS — boarding (MaxConcurrentPets=4), daycare and walks. House sitting and check-in are
-- disabled for this tenant, so they deliberately carry no bookings.
--
-- THE BOARDING CONFLICT: a week that fills up. Four confirmed stays nest inside each other and a
-- fifth is pending, so now+16..now+18 sits AT or OVER the 4-pet pool (five pets on now+17) and
-- paints `unavailable`, while the shoulder days now+14/+15/+19/+20 paint `partial`.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Status) VALUES
  ('seed_ht_board_a', 'tnt_happytails', 'eu_ht_jess', 'boarding', date('now', '+14 days'), date('now', '+21 days'), 'standard', 1, NULL, 280, 'confirmed'),
  ('seed_ht_board_b', 'tnt_happytails', 'eu_ht_marco', 'boarding', date('now', '+15 days'), date('now', '+20 days'), 'standard', 1, NULL, 200, 'confirmed'),
  ('seed_ht_board_c', 'tnt_happytails', 'eu_ht_devon', 'boarding', date('now', '+16 days'), date('now', '+19 days'), 'standard', 1, '18:00', 120, 'confirmed'),
  ('seed_ht_board_d', 'tnt_happytails', 'eu_ht_kate', 'boarding', date('now', '+17 days'), date('now', '+18 days'), 'standard', 1, NULL, 40, 'confirmed'),
  ('seed_ht_board_e', 'tnt_happytails', 'eu_ht_rosa', 'boarding', date('now', '+16 days'), date('now', '+19 days'), 'standard', 1, NULL, 120, 'pending'),
  ('seed_ht_day_a', 'tnt_happytails', 'eu_ht_marco', 'daycare', date('now', '+4 days'), NULL, 'standard', 1, NULL, 35, 'confirmed'),
  ('seed_ht_day_b', 'tnt_happytails', 'eu_ht_kate', 'daycare', date('now', '+11 days'), NULL, 'standard', 1, NULL, 35, 'pending'),
  ('seed_ht_walk_a', 'tnt_happytails', 'eu_ht_devon', 'walk', date('now', '+3 days'), NULL, 'd30', 1, '16:00', 25, 'confirmed'),
  -- THE SLOT CONFLICT: the 8-9am group walk holds three dogs (TenantServiceOptions.Capacity=3).
  -- Three confirmed bookings on one date fill it, so that date is unavailable for THAT option
  -- while the tenant's other walk options stay open — the per-slot conflict group services hit.
  ('seed_ht_grp_a', 'tnt_happytails', 'eu_ht_marco', 'walk', date('now', '+6 days'), NULL, 'group-8-9', 1, '08:00', 18, 'confirmed'),
  ('seed_ht_grp_b', 'tnt_happytails', 'eu_ht_devon', 'walk', date('now', '+6 days'), NULL, 'group-8-9', 1, '08:00', 18, 'confirmed'),
  ('seed_ht_grp_c', 'tnt_happytails', 'eu_ht_kate', 'walk', date('now', '+6 days'), NULL, 'group-8-9', 1, '08:00', 18, 'confirmed');

-- PAWS & RELAX — boarding, house sitting and walks (daycare and check-in are disabled). Its
-- boarding pool is unlimited (MaxConcurrentPets NULL), so its calendar can only be closed by the
-- blocked row below — the "time off" mechanism on a tenant with no cap.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Status) VALUES
  ('seed_pr_board_a', 'tnt_pawsandrelax', 'eu_pr_jess', 'boarding', date('now', '+9 days'), date('now', '+13 days'), 'standard', 1, NULL, 180, 'confirmed'),
  ('seed_pr_board_b', 'tnt_pawsandrelax', 'eu_pr_omar', 'boarding', date('now', '+10 days'), date('now', '+12 days'), 'standard', 1, '15:30', 90, 'pending'),
  ('seed_pr_house_a', 'tnt_pawsandrelax', 'eu_pr_nina', 'housesitting', date('now', '+19 days'), date('now', '+23 days'), 'standard', 1, NULL, 260, 'confirmed'),
  ('seed_pr_walk_a', 'tnt_pawsandrelax', 'eu_pr_omar', 'walk', date('now', '+2 days'), NULL, 'd30', 1, '17:30', 22, 'confirmed'),
  ('seed_pr_walk_b', 'tnt_pawsandrelax', 'eu_pr_jess', 'walk', date('now', '+8 days'), NULL, 'd30', 1, '11:00', 22, 'pending');

-- THE BLOCKED-DAY CONFLICT: time off (the 'blocked' sentinel; EndDate exclusive). A hard stop for
-- EVERY service on those days — no bookend sharing, no pool math — so each tenant's calendar has
-- a stretch of closed days a prospective sitter can recognise.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, EstCost, Status) VALUES
  ('seed_sp_block2', 'tnt_sunnypaws', NULL, 'blocked', date('now', '+30 days'), date('now', '+33 days'), 1, NULL, 'confirmed'),
  ('seed_ht_block2', 'tnt_happytails', NULL, 'blocked', date('now', '+26 days'), date('now', '+28 days'), 1, NULL, 'confirmed'),
  ('seed_pr_block1', 'tnt_pawsandrelax', NULL, 'blocked', date('now', '+15 days'), date('now', '+17 days'), 1, NULL, 'confirmed');

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
  ('seed_pr_walk_b', 'pet_pr_luna');
