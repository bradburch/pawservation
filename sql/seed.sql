-- Demo seed: two tenants with deliberately different branding, rates, and capacity.
--
-- ⚠️  DEMO DATA ONLY — DO NOT SEED A PRODUCTION DATABASE.
-- The sitter logins below use the publicly-known password "demo1234". Running this against a
-- real deployment installs admin accounts anyone reading this repo can log into. `seed:remote`
-- is intended for a throwaway demo environment; provision real tenants/logins separately.
-- (Hashes are full-strength 600k-iteration PBKDF2 so they are at least not weak-by-iteration.)

INSERT OR REPLACE INTO Tenants (Id, Slug, DisplayName, AccentColor, MaxBoardingPets) VALUES
  ('tnt_sunnypaws', 'sunny-paws', 'Sunny Paws', '#2563eb', 2),
  ('tnt_happytails', 'happy-tails', 'Happy Tails', '#d97706', 4);

-- Sitter dashboard logins (DEMO password "demo1234" for both; 600k-iteration PBKDF2 hashes).
INSERT OR REPLACE INTO TenantUsers (Id, TenantId, Email, PasswordHash) VALUES
  ('tu_sunny', 'tnt_sunnypaws', 'admin@sunnypaws.example', 'pbkdf2$600000$4f4aa1b2f29635a386a62fbce18336ae$8eaa4c479048f11664af6dd8a6118996921474eb6c72ba6c4b6caf66155fc6ae'),
  ('tu_dana', 'tnt_happytails', 'dana@happytails.test', 'pbkdf2$600000$03503c998c342f5f3704921e532a3e35$deac9874ed916391151ee6ce3b3aecb3a55c44123349729ae220d4762e911d07');

-- Which services each tenant offers (on/off only; prices live in TenantServiceOptions).
INSERT OR REPLACE INTO TenantServices (TenantId, ServiceType, Enabled) VALUES
  ('tnt_sunnypaws', 'boarding', 1),
  ('tnt_sunnypaws', 'housesitting', 1),
  ('tnt_sunnypaws', 'daycare', 1),
  ('tnt_sunnypaws', 'walk', 1),
  ('tnt_sunnypaws', 'checkin', 1),
  ('tnt_happytails', 'boarding', 1),
  ('tnt_happytails', 'daycare', 1),
  ('tnt_happytails', 'walk', 1);

-- Priced options. Non-duration services = single 'standard' option, DurationMinutes NULL.
-- Walks/check-ins = sitter-defined (duration, price) rows; prices are free-typed (note the sitter's
-- 90-min walk priced BELOW his 60-min one — deliberate, proves there is no duration->price formula).
INSERT OR REPLACE INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit) VALUES
  ('opt_sp_board', 'tnt_sunnypaws', 'boarding', 'standard', 'Standard', NULL, 50, 'night'),
  ('opt_sp_house', 'tnt_sunnypaws', 'housesitting', 'standard', 'Standard', NULL, 70, 'night'),
  ('opt_sp_day', 'tnt_sunnypaws', 'daycare', 'standard', 'Standard', NULL, 40, 'day'),
  ('opt_sp_walk30', 'tnt_sunnypaws', 'walk', 'd30', '30 minutes', 30, 20, 'visit'),
  ('opt_sp_walk60', 'tnt_sunnypaws', 'walk', 'd60', '1 hour', 60, 35, 'visit'),
  ('opt_sp_walk90', 'tnt_sunnypaws', 'walk', 'd90', '90 minutes', 90, 30, 'visit'),
  ('opt_sp_chk15', 'tnt_sunnypaws', 'checkin', 'd15', '15 minutes', 15, 12, 'visit'),
  ('opt_sp_chk30', 'tnt_sunnypaws', 'checkin', 'd30', '30 minutes', 30, 18, 'visit'),
  ('opt_ht_board', 'tnt_happytails', 'boarding', 'standard', 'Standard', NULL, 40, 'night'),
  ('opt_ht_day', 'tnt_happytails', 'daycare', 'standard', 'Standard', NULL, 35, 'day'),
  ('opt_ht_walk30', 'tnt_happytails', 'walk', 'd30', '30 minutes', 30, 25, 'visit'),
  ('opt_ht_walk60', 'tnt_happytails', 'walk', 'd60', '1 hour', 60, 40, 'visit');

-- Accepted species: Sunny Paws takes dogs + cats; Happy Tails dogs only.
INSERT OR REPLACE INTO TenantPetTypes (TenantId, PetType, Enabled) VALUES
  ('tnt_sunnypaws', 'dog', 1),
  ('tnt_sunnypaws', 'cat', 1),
  ('tnt_happytails', 'dog', 1);

-- Existing bookings so availability looks real.
-- Sunny Paws (max 2 pets): June 20-25 already has 1 pet boarding -> 1 slot left.
-- Happy Tails (max 4 pets): June 20-25 has 2 pets boarding -> 2 slots left.
-- Both tenants blocked July 3-5 (exclusive end: blocked days are Jul 3 and Jul 4).
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, EstCost, Status) VALUES
  ('seed_sp_board1', 'tnt_sunnypaws', NULL, 'boarding', '2028-06-20', '2028-06-25', 1, 250, 'confirmed'),
  ('seed_sp_block1', 'tnt_sunnypaws', NULL, 'blocked', '2028-07-03', '2028-07-05', 1, NULL, 'confirmed'),
  ('seed_ht_board1', 'tnt_happytails', NULL, 'boarding', '2028-06-20', '2028-06-25', 2, 400, 'confirmed'),
  ('seed_ht_block1', 'tnt_happytails', NULL, 'blocked', '2028-07-03', '2028-07-05', 1, NULL, 'confirmed');

INSERT OR REPLACE INTO ProviderConnections (Id, TenantId, Capability, Provider, Status) VALUES
  ('seed_sp_cal', 'tnt_sunnypaws', 'calendar', 'google-calendar', 'disconnected'),
  ('seed_sp_crm', 'tnt_sunnypaws', 'crm', 'notion', 'disconnected'),
  ('seed_sp_email', 'tnt_sunnypaws', 'email', 'gmail', 'disconnected'),
  ('seed_ht_cal', 'tnt_happytails', 'calendar', 'google-calendar', 'disconnected'),
  ('seed_ht_crm', 'tnt_happytails', 'crm', 'notion', 'disconnected'),
  ('seed_ht_email', 'tnt_happytails', 'email', 'gmail', 'disconnected');
