-- Demo seed: two tenants with deliberately different branding, rates, and capacity.
-- Admin keys are printed here on purpose — prototype-grade auth (PRD FR20).

INSERT OR REPLACE INTO Tenants (Id, Slug, DisplayName, AccentColor, MaxBoardingPets) VALUES
  ('tnt_bradpaws', 'brad-paws', 'Brad Paws', '#2563eb', 2),
  ('tnt_happytails', 'happy-tails', 'Happy Tails', '#d97706', 4);

-- Sitter dashboard logins (password is "demo1234" for both; PBKDF2 hashes precomputed).
INSERT OR REPLACE INTO TenantUsers (Id, TenantId, Email, PasswordHash) VALUES
  ('tu_brad', 'tnt_bradpaws', 'brad@bradpaws.test', 'pbkdf2$100000$8b3cbb0570e55502644c341f95aadfb0$06e30230b0fe1d3b68d4917549ab0654522118aaa257e55e99bb7d948ba51f58'),
  ('tu_dana', 'tnt_happytails', 'dana@happytails.test', 'pbkdf2$100000$ce76ce537b15e1bbd75d60957ae39bee$636b72baae9445cbd29c4e8816216e40951faf8181ca7889dfbf0555e5388d73');

-- Which services each tenant offers (on/off only; prices live in TenantServiceOptions).
INSERT OR REPLACE INTO TenantServices (TenantId, ServiceType, Enabled) VALUES
  ('tnt_bradpaws', 'boarding', 1),
  ('tnt_bradpaws', 'housesitting', 1),
  ('tnt_bradpaws', 'daycare', 1),
  ('tnt_bradpaws', 'walk', 1),
  ('tnt_bradpaws', 'checkin', 1),
  ('tnt_happytails', 'boarding', 1),
  ('tnt_happytails', 'daycare', 1),
  ('tnt_happytails', 'walk', 1);

-- Priced options. Non-duration services = single 'standard' option, DurationMinutes NULL.
-- Walks/check-ins = sitter-defined (duration, price) rows; prices are free-typed (note Brad's
-- 90-min walk priced BELOW his 60-min one — deliberate, proves there is no duration->price formula).
INSERT OR REPLACE INTO TenantServiceOptions (Id, TenantId, ServiceType, OptionKey, Label, DurationMinutes, Rate, RateUnit) VALUES
  ('opt_bp_board', 'tnt_bradpaws', 'boarding', 'standard', 'Standard', NULL, 50, 'night'),
  ('opt_bp_house', 'tnt_bradpaws', 'housesitting', 'standard', 'Standard', NULL, 70, 'night'),
  ('opt_bp_day', 'tnt_bradpaws', 'daycare', 'standard', 'Standard', NULL, 40, 'day'),
  ('opt_bp_walk30', 'tnt_bradpaws', 'walk', 'd30', '30 minutes', 30, 20, 'visit'),
  ('opt_bp_walk60', 'tnt_bradpaws', 'walk', 'd60', '1 hour', 60, 35, 'visit'),
  ('opt_bp_walk90', 'tnt_bradpaws', 'walk', 'd90', '90 minutes', 90, 30, 'visit'),
  ('opt_bp_chk15', 'tnt_bradpaws', 'checkin', 'd15', '15 minutes', 15, 12, 'visit'),
  ('opt_bp_chk30', 'tnt_bradpaws', 'checkin', 'd30', '30 minutes', 30, 18, 'visit'),
  ('opt_ht_board', 'tnt_happytails', 'boarding', 'standard', 'Standard', NULL, 40, 'night'),
  ('opt_ht_day', 'tnt_happytails', 'daycare', 'standard', 'Standard', NULL, 35, 'day'),
  ('opt_ht_walk30', 'tnt_happytails', 'walk', 'd30', '30 minutes', 30, 25, 'visit'),
  ('opt_ht_walk60', 'tnt_happytails', 'walk', 'd60', '1 hour', 60, 40, 'visit');

-- Accepted species: Brad Paws takes dogs + cats; Happy Tails dogs only.
INSERT OR REPLACE INTO TenantPetTypes (TenantId, PetType, Enabled) VALUES
  ('tnt_bradpaws', 'dog', 1),
  ('tnt_bradpaws', 'cat', 1),
  ('tnt_happytails', 'dog', 1);

-- Existing bookings so availability looks real.
-- Brad Paws (max 2 pets): June 20-25 already has 1 pet boarding -> 1 slot left.
-- Happy Tails (max 4 pets): June 20-25 has 2 pets boarding -> 2 slots left.
-- Both tenants blocked July 3-5 (exclusive end: blocked days are Jul 3 and Jul 4).
INSERT OR REPLACE INTO BookingRequests (Id, TenantId, EndUserId, ServiceType, StartDate, EndDate, PetCount, EstCost, Status) VALUES
  ('seed_bp_board1', 'tnt_bradpaws', NULL, 'boarding', '2026-06-20', '2026-06-25', 1, 250, 'confirmed'),
  ('seed_bp_block1', 'tnt_bradpaws', NULL, 'blocked', '2026-07-03', '2026-07-05', 1, NULL, 'confirmed'),
  ('seed_ht_board1', 'tnt_happytails', NULL, 'boarding', '2026-06-20', '2026-06-25', 2, 400, 'confirmed'),
  ('seed_ht_block1', 'tnt_happytails', NULL, 'blocked', '2026-07-03', '2026-07-05', 1, NULL, 'confirmed');

INSERT OR REPLACE INTO ProviderConnections (Id, TenantId, Capability, Provider, Status) VALUES
  ('seed_bp_cal', 'tnt_bradpaws', 'calendar', 'google-calendar', 'disconnected'),
  ('seed_bp_crm', 'tnt_bradpaws', 'crm', 'notion', 'disconnected'),
  ('seed_bp_email', 'tnt_bradpaws', 'email', 'gmail', 'disconnected'),
  ('seed_ht_cal', 'tnt_happytails', 'calendar', 'google-calendar', 'disconnected'),
  ('seed_ht_crm', 'tnt_happytails', 'crm', 'notion', 'disconnected'),
  ('seed_ht_email', 'tnt_happytails', 'email', 'gmail', 'disconnected');
