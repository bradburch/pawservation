-- Demo seed: two tenants with deliberately different branding, rates, and capacity.
--
-- ⚠️  DEMO DATA ONLY — DO NOT SEED A PRODUCTION DATABASE.
-- The sitter logins below use the publicly-known password "demo1234". Running this against a
-- real deployment installs admin accounts anyone reading this repo can log into. `seed:remote`
-- is intended for a throwaway demo environment; provision real tenants/logins separately.
-- (Hashes are full-strength 600k-iteration PBKDF2 so they are at least not weak-by-iteration.)

-- Tenant rows carry branding + timezone/contact only: capacity and stay-length live on TenantServices.
INSERT OR REPLACE INTO Tenants (Id, Slug, DisplayName, AccentColor) VALUES
  ('tnt_sunnypaws', 'sunny-paws', 'Sunny Paws', '#2563eb'),
  ('tnt_happytails', 'happy-tails', 'Happy Tails', '#d97706'),
  ('tnt_pawsandrelax', 'paws-and-relax', 'Paws & Relax', '#059669');

-- Sitter dashboard logins (DEMO password "demo1234" for both; 100k-iteration PBKDF2 hashes —
-- Cloudflare Workers' production runtime rejects PBKDF2 above 100k iterations).
INSERT OR REPLACE INTO TenantUsers (Id, TenantId, Email, PasswordHash) VALUES
  ('tu_sunny', 'tnt_sunnypaws', 'admin@sunnypaws.example', 'pbkdf2$100000$75ec423211a87b5687e462502235e9f4$6c3625d682942c58d946ede85f64e3370ea83d17aa8e1fa86f360100088ad683'),
  ('tu_dana', 'tnt_happytails', 'dana@happytails.test', 'pbkdf2$100000$0247366df2d9233578630a9a57888573$2c332c6290d673cace58bb9509722dc87ee0929609fafd6ff6d91e2d9c3863ae'),
  ('tu_pawsandrelax', 'tnt_pawsandrelax', 'admin@pawsandrelax.example', 'pbkdf2$100000$5e4234bef7913725b820563128f5bb6b$50a9e479d5e2f7776181822ced273d45cdef3ba067b3afeb9df4505d7d36114f');

-- Which services each tenant offers. Every tenant gets a row per built-in template (rows, not
-- code, are the service list); Enabled mirrors what each demo sitter actually offers. Sunny Paws
-- also has a CUSTOM service ('morning-walk', cloned from the walk template) to demo custom services.
-- Capacity lives on the service rows (0015): Sunny Paws boarding takes 2 pets/day, Happy Tails 4;
-- everything else is unlimited (NULL). Happy Tails' services accept dogs only ('["dog"]' — the
-- post-0015 materialized state of its dogs-only acceptance); NULL elsewhere = accepts every type.
-- A few services carry a short Description (0025) so the demo widget shows that feature; the rest
-- are NULL, which is the normal "no blurb" state.
INSERT OR REPLACE INTO TenantServices
  (TenantId, ServiceType, Enabled, Label, Icon, Shape, RateUnit, HasDuration, CapacityKind, SortOrder, MaxConcurrentPets, AcceptedPetTypes, Description) VALUES
  ('tnt_sunnypaws', 'boarding', 1, 'Boarding', 'bed', 'range', 'night', 0, 'boarding', 0, 2, NULL, 'Your pet stays at our home with a fenced yard and two walks a day.'),
  ('tnt_sunnypaws', 'housesitting', 1, 'House sitting', 'home', 'range', 'night', 0, 'housesit', 1, NULL, NULL, 'We stay overnight at your place so your pet keeps its own routine.'),
  ('tnt_sunnypaws', 'daycare', 1, 'Daycare', 'sun', 'single', 'day', 0, 'none', 2, NULL, NULL, 'Drop off in the morning, pick up by 6pm.'),
  ('tnt_sunnypaws', 'walk', 1, 'Walk', 'paw', 'single', 'walk', 1, 'none', 3, NULL, NULL, NULL),
  ('tnt_sunnypaws', 'checkin', 1, 'Check-in', 'clipboard', 'single', 'visit', 1, 'none', 4, NULL, NULL, NULL),
  ('tnt_sunnypaws', 'morning-walk', 1, 'Morning walk', 'paw', 'single', 'walk', 1, 'none', 5, NULL, NULL, NULL),
  ('tnt_happytails', 'boarding', 1, 'Boarding', 'bed', 'range', 'night', 0, 'boarding', 0, 4, '["dog"]', 'Small-group boarding for dogs only, four dogs max per day.'),
  ('tnt_happytails', 'housesitting', 0, 'House sitting', 'home', 'range', 'night', 0, 'housesit', 1, NULL, '["dog"]', NULL),
  ('tnt_happytails', 'daycare', 1, 'Daycare', 'sun', 'single', 'day', 0, 'none', 2, NULL, '["dog"]', NULL),
  ('tnt_happytails', 'walk', 1, 'Walk', 'paw', 'single', 'walk', 1, 'none', 3, NULL, '["dog"]', 'Neighborhood walks with a photo update when we get back.'),
  ('tnt_happytails', 'checkin', 0, 'Check-in', 'clipboard', 'single', 'visit', 1, 'none', 4, NULL, '["dog"]', NULL),
  ('tnt_pawsandrelax', 'boarding', 1, 'Boarding', 'bed', 'range', 'night', 0, 'boarding', 0, NULL, NULL, NULL),
  ('tnt_pawsandrelax', 'housesitting', 1, 'House sitting', 'home', 'range', 'night', 0, 'housesit', 1, NULL, NULL, NULL),
  ('tnt_pawsandrelax', 'daycare', 0, 'Daycare', 'sun', 'single', 'day', 0, 'none', 2, NULL, NULL, NULL),
  ('tnt_pawsandrelax', 'walk', 1, 'Walk', 'paw', 'single', 'walk', 1, 'none', 3, NULL, NULL, NULL),
  ('tnt_pawsandrelax', 'checkin', 0, 'Check-in', 'clipboard', 'single', 'visit', 1, 'none', 4, NULL, NULL, NULL);

-- Priced options. Non-duration services = single 'standard' option, DurationMinutes NULL.
-- Walks/check-ins = sitter-defined (duration, price) rows; prices are free-typed (note the sitter's
-- 90-min walk priced BELOW his 60-min one — deliberate, proves there is no duration->price formula).
INSERT OR REPLACE INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate) VALUES
  ('opt_sp_board', 'tnt_sunnypaws', 'boarding', 'standard', 'Standard', NULL, 50),
  ('opt_sp_house', 'tnt_sunnypaws', 'housesitting', 'standard', 'Standard', NULL, 70),
  ('opt_sp_day', 'tnt_sunnypaws', 'daycare', 'standard', 'Standard', NULL, 40),
  ('opt_sp_walk30', 'tnt_sunnypaws', 'walk', 'd30', '30 minutes', 30, 20),
  ('opt_sp_walk60', 'tnt_sunnypaws', 'walk', 'd60', '1 hour', 60, 35),
  ('opt_sp_walk90', 'tnt_sunnypaws', 'walk', 'd90', '90 minutes', 90, 30),
  ('opt_sp_chk15', 'tnt_sunnypaws', 'checkin', 'd15', '15 minutes', 15, 12),
  ('opt_sp_chk30', 'tnt_sunnypaws', 'checkin', 'd30', '30 minutes', 30, 18),
  ('opt_ht_board', 'tnt_happytails', 'boarding', 'standard', 'Standard', NULL, 40),
  ('opt_ht_day', 'tnt_happytails', 'daycare', 'standard', 'Standard', NULL, 35),
  ('opt_ht_walk30', 'tnt_happytails', 'walk', 'd30', '30 minutes', 30, 25),
  ('opt_ht_walk60', 'tnt_happytails', 'walk', 'd60', '1 hour', 60, 40),
  ('opt_pr_board', 'tnt_pawsandrelax', 'boarding', 'standard', 'Standard', NULL, 45),
  ('opt_pr_house', 'tnt_pawsandrelax', 'housesitting', 'standard', 'Standard', NULL, 65),
  ('opt_pr_walk30', 'tnt_pawsandrelax', 'walk', 'd30', '30 minutes', 30, 22);

-- One windowed group-slot option (capacity-limited, fixed clock window) to demo time-windowed
-- services on a fresh seed, alongside morning-walk demoing custom services.
INSERT OR REPLACE INTO TenantServiceOptions
  (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, StartTime, EndTime, Capacity) VALUES
  ('opt_ht_group_walk', 'tnt_happytails', 'walk', 'group-8-9', 'Group walk 8:00-9:00am', 60, 18, '08:00', '09:00', 3);

-- Sunny Paws' custom morning walk is weekday-only (WeekdaysOnly=1): the widget greys Sat/Sun
-- and the server rejects weekend bookings. Plausible sitter behavior that keeps the landing
-- page's greyed-weekend calendar screenshot honest and demos the rule on a fresh seed.
INSERT OR REPLACE INTO TenantServiceOptions
  (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, WeekdaysOnly) VALUES
  ('opt_sp_mw30', 'tnt_sunnypaws', 'morning-walk', 'd30', '30 minutes', 30, 18, 1);

-- Pet-type registry: Sunny Paws takes dogs + cats + rabbits (rabbit demos custom types end to
-- end); Happy Tails' cat row stays in the registry but is accepted by NO service (its services
-- carry '["dog"]' above — demos the acceptance chips); Paws & Relax dogs + cats.
INSERT OR REPLACE INTO TenantPetTypes (TenantId, PetType, Label) VALUES
  ('tnt_sunnypaws', 'dog', 'Dog'),
  ('tnt_sunnypaws', 'cat', 'Cat'),
  ('tnt_sunnypaws', 'rabbit', 'Rabbit'),
  ('tnt_happytails', 'dog', 'Dog'),
  ('tnt_happytails', 'cat', 'Cat'),
  ('tnt_pawsandrelax', 'dog', 'Dog'),
  ('tnt_pawsandrelax', 'cat', 'Cat');

-- Demo customers. Invite-only gating means /identify only succeeds for known customers, so the
-- demo widget (and the existing identify/booking tests) need a seeded, already-active customer.
INSERT OR REPLACE INTO EndUsers (Id, TenantId, Email, Name, Phone, Status) VALUES
  ('eu_sp_jess', 'tnt_sunnypaws', 'jess@example.com', 'Jess Demo', '(555) 555-0142', 'active'),
  ('eu_ht_jess', 'tnt_happytails', 'jess@example.com', 'Jess Demo', '(555) 555-0142', 'active'),
  ('eu_pr_jess', 'tnt_pawsandrelax', 'jess@example.com', 'Jess Demo', NULL, 'active');

-- Demo pets (sitter-managed). Jess has two at Sunny Paws (dogs+cats), one at Happy Tails
-- (dogs only), one at Paws & Relax — EVERY seeded customer owns a pet (client-AND-pet invariant).
INSERT OR REPLACE INTO EndUserPets (Id, TenantId, EndUserId, Name, PetType, Notes) VALUES
  ('pet_sp_bella', 'tnt_sunnypaws', 'eu_sp_jess', 'Bella', 'dog', 'Allergic to chicken — no chicken treats. Pulls on the leash near squirrels.'),
  ('pet_sp_mochi', 'tnt_sunnypaws', 'eu_sp_jess', 'Mochi', 'cat', NULL),
  ('pet_ht_otis',  'tnt_happytails', 'eu_ht_jess', 'Otis', 'dog', 'Deaf in one ear; approach from the front.'),
  ('pet_pr_luna',  'tnt_pawsandrelax', 'eu_pr_jess', 'Luna', 'dog', NULL);

-- Ownership edges (0019). EVERY pet needs a PetOwners row: it is the authoritative owner list that
-- /me, the booking-time ownership gate, and invoicing accounts read. A pet without one is invisible
-- to its own owner.
INSERT OR REPLACE INTO PetOwners (TenantId, PetId, EndUserId) VALUES
  ('tnt_sunnypaws', 'pet_sp_bella', 'eu_sp_jess'),
  ('tnt_sunnypaws', 'pet_sp_mochi', 'eu_sp_jess'),
  ('tnt_happytails', 'pet_ht_otis',  'eu_ht_jess'),
  ('tnt_pawsandrelax', 'pet_pr_luna', 'eu_pr_jess');

-- Existing bookings so availability looks real, tied to the demo customer so the admin list
-- never shows an anonymous "Unknown customer" row.
-- Sunny Paws boarding (MaxConcurrentPets=2): June 20-25 already has 1 pet boarding -> 1 slot left.
-- Happy Tails boarding (MaxConcurrentPets=4): June 20-25 has 2 pets boarding -> 2 slots left.
-- Both tenants blocked July 3-5 (exclusive end: blocked days are Jul 3 and Jul 4).
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, EstCost, Status) VALUES
  ('seed_sp_board1', 'tnt_sunnypaws', 'eu_sp_jess', 'boarding', '2028-06-20', '2028-06-25', 1, 250, 'confirmed'),
  ('seed_sp_block1', 'tnt_sunnypaws', NULL, 'blocked', '2028-07-03', '2028-07-05', 1, NULL, 'confirmed'),
  ('seed_ht_board1', 'tnt_happytails', 'eu_ht_jess', 'boarding', '2028-06-20', '2028-06-25', 2, 400, 'confirmed'),
  ('seed_ht_block1', 'tnt_happytails', NULL, 'blocked', '2028-07-03', '2028-07-05', 1, NULL, 'confirmed');

-- Pending requests so the admin "Needs your reply" list has real work in it on a fresh seed.
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, OptionKey, PetCount, StartTime, EstCost, Status) VALUES
  ('seed_sp_pend1', 'tnt_sunnypaws', 'eu_sp_jess', 'walk', '2026-08-10', NULL, 'd30', 1, '09:00', 20, 'pending'),
  ('seed_sp_pend2', 'tnt_sunnypaws', 'eu_sp_jess', 'boarding', '2026-08-20', '2026-08-23', NULL, 1, NULL, 150, 'pending'),
  ('seed_ht_pend1', 'tnt_happytails', 'eu_ht_jess', 'walk', '2026-08-12', NULL, 'd60', 1, '15:00', 40, 'pending');

INSERT OR REPLACE INTO ProviderConnections (Id, TenantId, Capability, Provider, Status) VALUES
  ('seed_sp_cal', 'tnt_sunnypaws', 'calendar', 'google-calendar', 'disconnected'),
  ('seed_ht_cal', 'tnt_happytails', 'calendar', 'google-calendar', 'disconnected');

-- One unclaimed signup-allowlist row so demos/tests can walk the invite-signup
-- flow end to end (owner allowlists → sitter enters email → setup link).
INSERT OR REPLACE INTO AllowedSitters (Email) VALUES ('newsitter@pawservation.test');
