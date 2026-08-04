PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE Tenants (
  Id TEXT PRIMARY KEY,
  Slug TEXT NOT NULL UNIQUE,
  DisplayName TEXT NOT NULL,
  AccentColor TEXT NOT NULL DEFAULT '#4f46e5',
  -- NULL = instance default (DEFAULT_TIMEZONE).
  Timezone TEXT,
  -- Optional contact details shown to clients in the booking widget.
  ContactEmail TEXT,
  ContactPhone TEXT,
  -- NULL = active; timestamp = disabled by the owner (widget dark + admin read-only).
  DisabledAt TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
, MaxAdvanceMonths INTEGER, HousesitBoardingOverlapDays INTEGER DEFAULT 1);
INSERT INTO "Tenants" ("Id","Slug","DisplayName","AccentColor","Timezone","ContactEmail","ContactPhone","DisabledAt","CreatedAt","MaxAdvanceMonths","HousesitBoardingOverlapDays") VALUES('tnt_sunnypaws','sunny-paws','Sunny Paws','#2563eb',NULL,NULL,NULL,NULL,'2026-07-29 16:11:18',12,1);
INSERT INTO "Tenants" ("Id","Slug","DisplayName","AccentColor","Timezone","ContactEmail","ContactPhone","DisabledAt","CreatedAt","MaxAdvanceMonths","HousesitBoardingOverlapDays") VALUES('tnt_happytails','happy-tails','Happy Tails','#d97706',NULL,NULL,NULL,NULL,'2026-07-29 16:11:18',6,1);
INSERT INTO "Tenants" ("Id","Slug","DisplayName","AccentColor","Timezone","ContactEmail","ContactPhone","DisabledAt","CreatedAt","MaxAdvanceMonths","HousesitBoardingOverlapDays") VALUES('tnt_pawsandrelax','paws-and-relax','Paws & Relax','#059669',NULL,NULL,NULL,NULL,'2026-07-29 16:11:18',12,1);
INSERT INTO "Tenants" ("Id","Slug","DisplayName","AccentColor","Timezone","ContactEmail","ContactPhone","DisabledAt","CreatedAt","MaxAdvanceMonths","HousesitBoardingOverlapDays") VALUES('e66f579d-e056-4b94-9cc7-bfa096b4ebb7','brad-paws','Brad Paws','#4f46e5',NULL,'hello@bradpaws.com',NULL,NULL,'2026-08-02 02:24:55',8,1);
CREATE TABLE TenantUsers (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Email TEXT NOT NULL UNIQUE,
  PasswordHash TEXT NOT NULL,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "TenantUsers" ("Id","TenantId","Email","PasswordHash","CreatedAt") VALUES('87c85f93-fe24-414c-b458-70cd82e91f7c','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','hello@bradpaws.com','pbkdf2$100000$d20e55abcf5fb018e171025450e526bd$87851642047e321196003c343da53a04391de1bcf5f58eea20b3695a687192ba','2026-08-02 02:24:55');
CREATE TABLE TenantServices (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  Enabled INTEGER NOT NULL DEFAULT 1,
  Label TEXT NOT NULL,
  Icon TEXT NOT NULL DEFAULT 'paw', -- widget icon key: bed|home|sun|paw|clipboard
  -- Optional SHORT blurb the sitter writes, shown to pet owners under the service name in the
  -- embed widget (0025). Plain text, capped at 200 chars by the admin PUT. NULL = absent.
  Description TEXT,
  Shape TEXT NOT NULL CHECK (Shape IN ('range', 'single')),
  -- 'walk' added by 0024: walks are priced per WALK, not per visit. The unit is printed straight
  -- from this column, so a new noun needs a new allowed value, not a display-time substitution.
  RateUnit TEXT NOT NULL CHECK (RateUnit IN ('night', 'day', 'visit', 'walk')),
  HasDuration INTEGER NOT NULL DEFAULT 0, -- options priced per duration (walk/check-in style)?
  -- Which capacity RULE the service uses (not the service's name): 'boarding' and 'housesit' both
  -- count PETS against their own MaxConcurrentPets; 'none' = unlimited (blocked days only).
  CapacityKind TEXT NOT NULL DEFAULT 'none' CHECK (CapacityKind IN ('boarding', 'housesit', 'none')),
  SortOrder INTEGER NOT NULL DEFAULT 0,
  -- Per-service intake questions (JSON array of ServiceQuestion, see src/shared/booking/service-rules.ts)
  -- + optional booking-level limits. NULL limit = unlimited. There is deliberately NO MinNights
  -- and NO MinPetCount: the minimum stay is structurally 1 night and services have only a
  -- max-pets limit — a settings PUT that still sends either is rejected, not silently dropped.
  Questions TEXT NOT NULL DEFAULT '[]',
  MaxNights INTEGER,
  MaxPetCount INTEGER,
  -- JSON array of pet-type slugs this service accepts; NULL = accepts every registry type
  -- (null-is-unlimited convention). An empty array is invalid for an ENABLED service.
  AcceptedPetTypes TEXT,
  -- Per-service capacity (NULL = unlimited). MaxConcurrentPets is the pets-per-day cap for BOTH
  -- pool kinds: CapacityKind='boarding' and 'housesit' both read it — a booking with three pets
  -- uses three slots. A cap on a 'none'-kind service is rejected on PUT.
  MaxConcurrentPets INTEGER,
  -- Tiered cancellation policy (added by 0016); JSON array like
  -- [{"withinDays":2,"percent":100},{"withinDays":7,"percent":50}]. NULL = no fee.
  CancellationTiers TEXT, HolidayRate INTEGER CHECK (HolidayRate IS NULL OR HolidayRate >= 1), MinLeadDays INTEGER, PetRateMode TEXT NOT NULL DEFAULT 'exact'
  CHECK (PetRateMode IN ('exact', 'linear')), StandardArrivalTime TEXT, StandardDepartureTime TEXT, EarlyArrivalFee INTEGER CHECK (EarlyArrivalFee IS NULL OR EarlyArrivalFee >= 1), LateDepartureFee INTEGER CHECK (LateDepartureFee IS NULL OR LateDepartureFee >= 1),
  UNIQUE (TenantId, ServiceType)
);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_sunnypaws','boarding',1,'Boarding','bed','Your pet stays at our home with a fenced yard and two walks a day.','range','night',0,'boarding',0,'[{"id":"vaccines","label":"Are vaccinations up to date?","type":"yesno","required":true},{"id":"feeding","label":"Feeding routine (times and amounts)","type":"text","required":true},{"id":"vet","label":"Emergency vet phone number","type":"text","required":false}]',21,2,'["dog"]',2,'[{"withinDays":3,"percent":100},{"withinDays":7,"percent":50}]',NULL,2,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_sunnypaws','housesitting',1,'House sitting','home','We stay overnight at your place so your pet keeps its own routine.','range','night',0,'housesit',1,'[{"id":"entry","label":"How will we get in?","type":"select","required":true,"options":["Lockbox","Hidden key","Hand off in person"]},{"id":"plants","label":"Plants to water?","type":"yesno","required":false},{"id":"mail","label":"Bring in the mail?","type":"yesno","required":false}]',14,3,NULL,NULL,'[{"withinDays":7,"percent":50},{"withinDays":14,"percent":25}]',NULL,3,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_sunnypaws','daycare',1,'Daycare','sun','Drop off in the morning, pick up by 6pm.','single','day',0,'none',2,'[{"id":"pickup","label":"Usual pick-up time","type":"text","required":false}]',NULL,2,'["dog"]',NULL,NULL,55,1,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_sunnypaws','walk',1,'Walk','paw',NULL,'single','walk',1,'none',3,'[{"id":"leash","label":"Where is the leash kept?","type":"text","required":false}]',NULL,2,'["dog"]',NULL,NULL,NULL,1,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_sunnypaws','checkin',1,'Check-in','clipboard',NULL,'single','visit',1,'none',4,'[{"id":"litter","label":"Scoop the litter box?","type":"yesno","required":false}]',NULL,3,'["cat"]',NULL,NULL,NULL,1,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_sunnypaws','morning-walk',1,'Morning walk','paw',NULL,'single','walk',1,'none',5,'[]',NULL,1,'["dog"]',NULL,NULL,NULL,1,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_happytails','boarding',1,'Boarding','bed','Small-group boarding for dogs only, four dogs max per day.','range','night',0,'boarding',0,'[{"id":"vaccines","label":"Are vaccinations up to date?","type":"yesno","required":true},{"id":"crate","label":"Crate trained?","type":"yesno","required":false},{"id":"dogs","label":"Gets along with other dogs?","type":"yesno","required":true}]',14,3,'["dog"]',4,'[{"withinDays":2,"percent":50}]',55,2,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_happytails','housesitting',0,'House sitting','home',NULL,'range','night',0,'housesit',1,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_happytails','daycare',1,'Daycare','sun',NULL,'single','day',0,'none',2,'[]',NULL,2,'["dog"]',NULL,NULL,NULL,1,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_happytails','walk',1,'Walk','paw','Neighborhood walks with a photo update when we get back.','single','walk',1,'none',3,'[{"id":"gate","label":"Gate or door code","type":"text","required":false},{"id":"treats","label":"Treats allowed?","type":"yesno","required":false}]',NULL,2,'["dog"]',NULL,'[{"withinDays":1,"percent":100}]',NULL,1,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_happytails','checkin',0,'Check-in','clipboard',NULL,'single','visit',1,'none',4,'[]',NULL,NULL,'["cat"]',NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_pawsandrelax','boarding',1,'Boarding','bed',NULL,'range','night',0,'boarding',0,'[{"id":"weight","label":"Pet weight in pounds","type":"number","required":true,"min":1,"max":200},{"id":"vaccines","label":"Are vaccinations up to date?","type":"yesno","required":true}]',NULL,3,'["dog"]',3,NULL,NULL,1,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_pawsandrelax','housesitting',1,'House sitting','home',NULL,'range','night',0,'housesit',1,'[{"id":"entry","label":"How will we get in?","type":"select","required":true,"options":["Lockbox","Hidden key","Hand off in person"]}]',NULL,4,NULL,NULL,NULL,85,2,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_pawsandrelax','daycare',0,'Daycare','sun',NULL,'single','day',0,'none',2,'[]',NULL,NULL,'["dog"]',NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_pawsandrelax','walk',1,'Walk','paw',NULL,'single','walk',1,'none',3,'[]',NULL,2,'["dog"]',NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('tnt_pawsandrelax','checkin',0,'Check-in','clipboard',NULL,'single','visit',1,'none',4,'[]',NULL,NULL,'["cat"]',NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('e66f579d-e056-4b94-9cc7-bfa096b4ebb7','pack-walks',1,'Pack Walks','paw',NULL,'single','walk',1,'none',1,'[]',NULL,NULL,'["dog"]',NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('e66f579d-e056-4b94-9cc7-bfa096b4ebb7','check-in',1,'Check-in','clipboard',NULL,'single','visit',1,'none',1,'[]',NULL,NULL,'["cat"]',NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('e66f579d-e056-4b94-9cc7-bfa096b4ebb7','house-sitting',1,'House sitting','home',NULL,'range','night',0,'housesit',1,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
INSERT INTO "TenantServices" ("TenantId","ServiceType","Enabled","Label","Icon","Description","Shape","RateUnit","HasDuration","CapacityKind","SortOrder","Questions","MaxNights","MaxPetCount","AcceptedPetTypes","MaxConcurrentPets","CancellationTiers","HolidayRate","MinLeadDays","PetRateMode","StandardArrivalTime","StandardDepartureTime","EarlyArrivalFee","LateDepartureFee") VALUES('e66f579d-e056-4b94-9cc7-bfa096b4ebb7','boarding',1,'Boarding','bed',NULL,'range','night',0,'boarding',2,'[]',NULL,NULL,NULL,NULL,NULL,NULL,NULL,'linear',NULL,NULL,NULL,NULL);
CREATE TABLE TenantServiceOptions (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  Label TEXT NOT NULL,
  DurationMinutes INTEGER,
  Rate INTEGER NOT NULL,
  -- The billing unit is TenantServices.RateUnit — options deliberately carry no copy of it.
  -- A fixed clock window (both set together, or both NULL). Windowed options derive
  -- DurationMinutes from this window server-side (see server/routes/admin.ts); Capacity caps
  -- concurrent bookings against this option on one date. NULL = unlimited, matching the
  -- null-is-unlimited convention used throughout this schema.
  StartTime TEXT,
  EndTime TEXT,
  Capacity INTEGER,
  -- Int-bool: 1 = this option is bookable Mon-Fri only (server rejects Sat/Sun at booking
  -- validation; the embed widget greys weekends). 0 = any day.
  WeekdaysOnly INTEGER NOT NULL DEFAULT 0,
  UNIQUE (TenantId, ServiceType, OptionKey)
);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_board','tnt_sunnypaws','boarding','standard','Standard',NULL,50,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_house','tnt_sunnypaws','housesitting','standard','Standard',NULL,70,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_day','tnt_sunnypaws','daycare','standard','Standard',NULL,40,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_walk30','tnt_sunnypaws','walk','d30','30 minutes',30,20,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_walk60','tnt_sunnypaws','walk','d60','1 hour',60,35,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_walk90','tnt_sunnypaws','walk','d90','90 minutes',90,30,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_chk15','tnt_sunnypaws','checkin','d15','15 minutes',15,12,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_chk30','tnt_sunnypaws','checkin','d30','30 minutes',30,18,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_ht_board','tnt_happytails','boarding','standard','Standard',NULL,40,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_ht_day','tnt_happytails','daycare','standard','Standard',NULL,35,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_ht_walk30','tnt_happytails','walk','d30','30 minutes',30,25,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_ht_walk60','tnt_happytails','walk','d60','1 hour',60,40,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_pr_board','tnt_pawsandrelax','boarding','standard','Standard',NULL,45,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_pr_house','tnt_pawsandrelax','housesitting','standard','Standard',NULL,65,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_pr_walk30','tnt_pawsandrelax','walk','d30','30 minutes',30,22,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_ht_group_walk','tnt_happytails','walk','group-8-9','Group walk 8:00-9:00am',60,18,'08:00','09:00',3,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('opt_sp_mw30','tnt_sunnypaws','morning-walk','d30','30 minutes',30,18,NULL,NULL,NULL,1);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('3bbb47b4-7c7d-40c9-87d3-e7e617b6b46c','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','pack-walks','pack-walk','Pack walk',240,32,'10:00','14:00',8,1);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('f5976652-4538-452f-b292-87b0e455e2ff','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','boarding','standard','Standard',NULL,103,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('f47f61c9-01cb-4da1-930f-4876c19faf66','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','house-sitting','standard','Standard',NULL,103,NULL,NULL,NULL,0);
INSERT INTO "TenantServiceOptions" ("Id","TenantId","ServiceType","OptionKey","Label","DurationMinutes","Rate","StartTime","EndTime","Capacity","WeekdaysOnly") VALUES('abfd12c7-2b6f-447a-b6d9-b28e70112983','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','check-in','d30','30 min',30,100,NULL,NULL,NULL,0);
CREATE TABLE PetGroupPricing (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  GroupKey TEXT NOT NULL,
  Rate INTEGER NOT NULL CHECK (Rate > 0),
  UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (TenantId, ServiceType, OptionKey, GroupKey)
);
CREATE TABLE TenantServicePetRates (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  ServiceType TEXT NOT NULL,
  OptionKey TEXT NOT NULL,
  MixKey TEXT NOT NULL,
  Rate INTEGER NOT NULL CHECK (Rate > 0),
  UNIQUE (TenantId, ServiceType, OptionKey, MixKey)
);
INSERT INTO "TenantServicePetRates" ("TenantId","ServiceType","OptionKey","MixKey","Rate") VALUES('tnt_sunnypaws','boarding','standard','dog:2',85);
CREATE TABLE TenantPetTypes (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  PetType TEXT NOT NULL,            -- per-tenant slug ('dog', 'rabbit', ...), immutable
  Label TEXT NOT NULL,              -- display name ('Dogs', 'Rabbits'), renamable
  UNIQUE (TenantId, PetType)
);
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('tnt_sunnypaws','dog','Dog');
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('tnt_sunnypaws','cat','Cat');
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('tnt_sunnypaws','rabbit','Rabbit');
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('tnt_happytails','dog','Dog');
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('tnt_happytails','cat','Cat');
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('tnt_pawsandrelax','dog','Dog');
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('tnt_pawsandrelax','cat','Cat');
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('e66f579d-e056-4b94-9cc7-bfa096b4ebb7','dog','Dog');
INSERT INTO "TenantPetTypes" ("TenantId","PetType","Label") VALUES('e66f579d-e056-4b94-9cc7-bfa096b4ebb7','cat','Cat');
CREATE TABLE EndUsers (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Email TEXT NOT NULL,
  Name TEXT,
  Phone TEXT,
  InvitedAt TEXT,
  Status TEXT NOT NULL DEFAULT 'active' CHECK (Status IN ('invited', 'active')),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')), VenmoUsername TEXT,
  UNIQUE (TenantId, Email)
);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_sp_jess','tnt_sunnypaws','jess@example.com','Jess Demo','(555) 555-0142',NULL,'active','2026-07-29 16:11:18',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_ht_jess','tnt_happytails','jess@example.com','Jess Demo','(555) 555-0142',NULL,'active','2026-07-29 16:11:18',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_pr_jess','tnt_pawsandrelax','jess@example.com','Jess Demo',NULL,NULL,'active','2026-07-29 16:11:18',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_sp_marco','tnt_sunnypaws','marco@example.com','Marco Reyes','(555) 555-0188',NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_sp_priya','tnt_sunnypaws','priya@example.com','Priya Shah','(555) 555-0117',NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_sp_ana','tnt_sunnypaws','ana@example.com','Ana Whitfield',NULL,NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_ht_marco','tnt_happytails','marco@example.com','Marco Reyes','(555) 555-0188',NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_ht_devon','tnt_happytails','devon@example.com','Devon Alvarez','(555) 555-0163',NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_ht_kate','tnt_happytails','kate@example.com','Kate Lindqvist',NULL,NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_ht_rosa','tnt_happytails','rosa@example.com','Rosa Bright',NULL,NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_pr_omar','tnt_pawsandrelax','omar@example.com','Omar Haddad','(555) 555-0104',NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('eu_pr_nina','tnt_pawsandrelax','nina@example.com','Nina Castellanos',NULL,NULL,'active','2026-07-29 16:11:20',NULL);
INSERT INTO "EndUsers" ("Id","TenantId","Email","Name","Phone","InvitedAt","Status","CreatedAt","VenmoUsername") VALUES('dbbeedcd-7118-4525-8138-8446d8f0ef56','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','bradburch@duck.com','Brad',NULL,'2026-08-02T03:45:12.227Z','active','2026-08-02 03:45:12',NULL);
CREATE TABLE LoginCodes (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Code TEXT NOT NULL,
  ExpiresAt TEXT NOT NULL,
  UsedAt TEXT,
  -- Failed verify attempts; capped in consumeLoginCode so a 6-digit code can't be brute-forced.
  Attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "LoginCodes" ("Id","TenantId","EndUserId","Code","ExpiresAt","UsedAt","Attempts") VALUES('597dafad-a909-4c34-90fb-8387fcf181db','tnt_happytails','eu_ht_jess','745216','2026-07-29T01:59:17.413Z','2026-07-29T01:49:25.799Z',1);
INSERT INTO "LoginCodes" ("Id","TenantId","EndUserId","Code","ExpiresAt","UsedAt","Attempts") VALUES('6fa93593-874c-44ec-a863-fda547e241e6','tnt_sunnypaws','eu_sp_jess','061557','2026-08-02T03:21:06.232Z','2026-08-02T03:11:13.812Z',1);
INSERT INTO "LoginCodes" ("Id","TenantId","EndUserId","Code","ExpiresAt","UsedAt","Attempts") VALUES('c2f1d8ec-76b9-40fb-8934-8a4b52398e00','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','dbbeedcd-7118-4525-8138-8446d8f0ef56','171645','2026-08-02T03:55:25.820Z','2026-08-02T03:45:39.053Z',1);
CREATE TABLE BookingRequests (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL, -- tenant service slug, or the reserved 'blocked'
  StartDate TEXT NOT NULL,
  EndDate TEXT, -- exclusive checkout for boarding/blocked ranges; NULL for single-day walks
  OptionKey TEXT, -- which TenantServiceOptions row the customer picked; NULL for blocked
  PetCount INTEGER NOT NULL DEFAULT 1 CHECK (PetCount >= 1),
  -- 'HH:MM' wall-clock. Timed services (walk/check-in): the option's slot time. Range services:
  -- the customer's optional arrival time. NULL = all-day / not given.
  StartTime TEXT,
  GCalEventId TEXT, -- Google Calendar event id created for this booking; NULL if none/unsynced
  EstCost INTEGER,
  -- Fee assessed at cancel time, whole dollars, matches EstCost (added by 0016). NULL = none assessed.
  CancellationFee INTEGER,
  Answers TEXT NOT NULL DEFAULT '{}', -- JSON {questionId: answer}; questions defined on TenantServices
  -- 'declined' is the sitter's "no" to a still-pending request; a confirmed booking is
  -- cancelled, never declined. Both are terminal.
  Status TEXT NOT NULL DEFAULT 'pending' CHECK (Status IN ('pending', 'confirmed', 'cancelled', 'declined')),
  Source TEXT, -- attribution channel: 'mcp', 'voice', etc.; NULL = embed widget (0022)
  IdempotencyKey TEXT, -- replay-protection key, unique per (TenantId, EndUserId) (0023)
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
, SyncPending INTEGER NOT NULL DEFAULT 0, ExternalSummary TEXT, DepartureTime TEXT);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_board_a','tnt_sunnypaws','eu_sp_jess','boarding','2026-08-03','2026-08-10','standard',1,NULL,NULL,350,NULL,'{"vaccines":"yes","feeding":"Two cups at 7am and 6pm. No chicken.","vet":"(555) 555-0190"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_board_b','tnt_sunnypaws','eu_sp_marco','boarding','2026-08-05','2026-08-09','standard',1,'16:00',NULL,200,NULL,'{"vaccines":"yes","feeding":"One scoop at 8am, one at 7pm.","vet":"(555) 555-0177"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_board_c','tnt_sunnypaws','eu_sp_priya','boarding','2026-08-06','2026-08-08','standard',1,NULL,NULL,100,NULL,'{"vaccines":"yes","feeding":"Half a cup three times a day."}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_house_a','tnt_sunnypaws','eu_sp_ana','housesitting','2026-08-22','2026-08-27','standard',1,NULL,NULL,350,NULL,'{"entry":"Lockbox","plants":"yes","mail":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_day_a','tnt_sunnypaws','eu_sp_marco','daycare','2026-08-01',NULL,'standard',1,NULL,NULL,40,NULL,'{"pickup":"5:30pm"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_day_b','tnt_sunnypaws','eu_sp_priya','daycare','2026-08-15',NULL,'standard',1,NULL,NULL,40,NULL,'{"pickup":"6pm"}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_walk_a','tnt_sunnypaws','eu_sp_jess','walk','2026-07-31',NULL,'d60',1,'08:30',NULL,35,NULL,'{"leash":"Hook by the front door."}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_walk_b','tnt_sunnypaws','eu_sp_marco','walk','2026-08-07',NULL,'d30',1,'07:30',NULL,20,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_chk_a','tnt_sunnypaws','eu_sp_jess','checkin','2026-08-04',NULL,'d15',1,'12:00',NULL,12,NULL,'{"litter":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_chk_b','tnt_sunnypaws','eu_sp_jess','checkin','2026-08-18',NULL,'d30',1,'17:00',NULL,18,NULL,'{"litter":"yes"}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_mw_a','tnt_sunnypaws','eu_sp_marco','morning-walk','2026-08-05',NULL,'d30',1,'07:00',NULL,18,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_mw_b','tnt_sunnypaws','eu_sp_priya','morning-walk','2026-08-18',NULL,'d30',1,'07:00',NULL,18,NULL,'{}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_board_a','tnt_happytails','eu_ht_jess','boarding','2026-08-12','2026-08-19','standard',1,NULL,NULL,280,NULL,'{"vaccines":"yes","crate":"no","dogs":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_board_b','tnt_happytails','eu_ht_marco','boarding','2026-08-13','2026-08-18','standard',1,NULL,NULL,200,NULL,'{"vaccines":"yes","crate":"yes","dogs":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_board_c','tnt_happytails','eu_ht_devon','boarding','2026-08-14','2026-08-17','standard',1,'18:00',NULL,120,NULL,'{"vaccines":"yes","crate":"no","dogs":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_board_d','tnt_happytails','eu_ht_kate','boarding','2026-08-15','2026-08-16','standard',1,NULL,NULL,40,NULL,'{"vaccines":"yes","dogs":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_board_e','tnt_happytails','eu_ht_rosa','boarding','2026-08-14','2026-08-17','standard',1,NULL,NULL,120,NULL,'{"vaccines":"yes","crate":"yes","dogs":"no"}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_day_a','tnt_happytails','eu_ht_marco','daycare','2026-08-02',NULL,'standard',1,NULL,NULL,35,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_day_b','tnt_happytails','eu_ht_kate','daycare','2026-08-09',NULL,'standard',1,NULL,NULL,35,NULL,'{}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_walk_a','tnt_happytails','eu_ht_devon','walk','2026-08-01',NULL,'d30',1,'16:00',NULL,25,NULL,'{"gate":"1932","treats":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_grp_a','tnt_happytails','eu_ht_marco','walk','2026-08-04',NULL,'group-8-9',1,'08:00',NULL,18,NULL,'{"treats":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_grp_b','tnt_happytails','eu_ht_devon','walk','2026-08-04',NULL,'group-8-9',1,'08:00',NULL,18,NULL,'{"treats":"no"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_grp_c','tnt_happytails','eu_ht_kate','walk','2026-08-04',NULL,'group-8-9',1,'08:00',NULL,18,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_pr_board_a','tnt_pawsandrelax','eu_pr_jess','boarding','2026-08-07','2026-08-11','standard',1,NULL,NULL,180,NULL,'{"weight":"45","vaccines":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_pr_board_b','tnt_pawsandrelax','eu_pr_omar','boarding','2026-08-08','2026-08-10','standard',1,'15:30',NULL,90,NULL,'{"weight":"22","vaccines":"yes"}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_pr_house_a','tnt_pawsandrelax','eu_pr_nina','housesitting','2026-08-17','2026-08-21','standard',1,NULL,NULL,260,NULL,'{"entry":"Hidden key"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_pr_walk_a','tnt_pawsandrelax','eu_pr_omar','walk','2026-07-31',NULL,'d30',1,'17:30',NULL,22,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_pr_walk_b','tnt_pawsandrelax','eu_pr_jess','walk','2026-08-06',NULL,'d30',1,'11:00',NULL,22,NULL,'{}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_pend1','tnt_sunnypaws','eu_sp_jess','walk','2026-09-05',NULL,'d30',1,'09:00',NULL,20,NULL,'{"leash":"Hook by the front door."}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_pend1','tnt_happytails','eu_ht_jess','walk','2026-09-06',NULL,'d60',1,'15:00',NULL,40,NULL,'{"gate":"4410","treats":"no"}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_pend2','tnt_sunnypaws','eu_sp_jess','boarding','2026-09-07','2026-09-10','standard',1,NULL,NULL,150,NULL,'{"vaccines":"yes","feeding":"Two cups at 7am and 6pm. No chicken."}','pending',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_board1','tnt_sunnypaws','eu_sp_jess','boarding','2026-09-17','2026-09-22','standard',1,NULL,NULL,250,NULL,'{"vaccines":"yes","feeding":"Two cups at 7am and 6pm. No chicken.","vet":"(555) 555-0190"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_board1','tnt_happytails','eu_ht_jess','boarding','2026-09-17','2026-09-22','standard',1,NULL,NULL,200,NULL,'{"vaccines":"yes","crate":"no","dogs":"yes"}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_block2','tnt_sunnypaws',NULL,'blocked','2026-08-28','2026-08-31',NULL,1,NULL,NULL,NULL,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_block2','tnt_happytails',NULL,'blocked','2026-08-24','2026-08-26',NULL,1,NULL,NULL,NULL,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_pr_block1','tnt_pawsandrelax',NULL,'blocked','2026-08-13','2026-08-15',NULL,1,NULL,NULL,NULL,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_sp_block1','tnt_sunnypaws',NULL,'blocked','2026-09-27','2026-09-29',NULL,1,NULL,NULL,NULL,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('seed_ht_block1','tnt_happytails',NULL,'blocked','2026-09-27','2026-09-29',NULL,1,NULL,NULL,NULL,NULL,'{}','confirmed',NULL,NULL,'2026-07-29 16:11:20',0,NULL,NULL);
INSERT INTO "BookingRequests" ("Id","TenantId","EndUserId","ServiceType","StartDate","EndDate","OptionKey","PetCount","StartTime","GCalEventId","EstCost","CancellationFee","Answers","Status","Source","IdempotencyKey","CreatedAt","SyncPending","ExternalSummary","DepartureTime") VALUES('c671dc89-e902-4fb4-889d-90f9e07a4c09','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','dbbeedcd-7118-4525-8138-8446d8f0ef56','boarding','2026-08-10','2026-08-21','standard',1,NULL,NULL,1133,NULL,'{}','confirmed',NULL,'21412ecd-db23-4c58-ad39-52b0b43c8777','2026-08-02 03:47:43',1,NULL,NULL);
CREATE TABLE EndUserPets (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  Name TEXT NOT NULL,
  PetType TEXT NOT NULL, -- tenant pet-type slug
  Notes TEXT, -- care notes the sitter keeps (feeding, meds, temperament)
  -- NULL = alive; timestamp = deceased (0019). Excluded from every bookable/quotable pet list.
  DeceasedAt TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_sp_bella','tnt_sunnypaws','eu_sp_jess','Bella','dog','Allergic to chicken — no chicken treats. Pulls on the leash near squirrels.',NULL,'2026-07-29 16:11:18');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_sp_mochi','tnt_sunnypaws','eu_sp_jess','Mochi','cat',NULL,NULL,'2026-07-29 16:11:18');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_ht_otis','tnt_happytails','eu_ht_jess','Otis','dog','Deaf in one ear; approach from the front.',NULL,'2026-07-29 16:11:18');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_pr_luna','tnt_pawsandrelax','eu_pr_jess','Luna','dog',NULL,NULL,'2026-07-29 16:11:18');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_sp_juno','tnt_sunnypaws','eu_sp_marco','Juno','dog','Crate-trained; needs the door left open.',NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_sp_ollie','tnt_sunnypaws','eu_sp_marco','Ollie','dog','Junos littermate — they board together.',NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_sp_dash','tnt_sunnypaws','eu_sp_priya','Dash','dog',NULL,NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_sp_clover','tnt_sunnypaws','eu_sp_ana','Clover','rabbit','Timothy hay only — no pellets.',NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_ht_scout','tnt_happytails','eu_ht_marco','Scout','dog',NULL,NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_ht_ziggy','tnt_happytails','eu_ht_devon','Ziggy','dog','Barks at skateboards.',NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_ht_pepper','tnt_happytails','eu_ht_kate','Pepper','dog',NULL,NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_ht_maple','tnt_happytails','eu_ht_rosa','Maple','dog',NULL,NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_pr_biscuit','tnt_pawsandrelax','eu_pr_omar','Biscuit','dog',NULL,NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('pet_pr_sable','tnt_pawsandrelax','eu_pr_nina','Sable','cat','Hides under the bed for the first hour.',NULL,'2026-07-29 16:11:20');
INSERT INTO "EndUserPets" ("Id","TenantId","EndUserId","Name","PetType","Notes","DeceasedAt","CreatedAt") VALUES('9f9ca4bf-1b8b-4214-b39b-a1b4b99dca7a','e66f579d-e056-4b94-9cc7-bfa096b4ebb7','dbbeedcd-7118-4525-8138-8446d8f0ef56','Fido','dog',NULL,NULL,'2026-08-02 03:45:12');
CREATE TABLE BookingRequestPets (
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  PetId TEXT NOT NULL REFERENCES EndUserPets(Id),
  PRIMARY KEY (BookingRequestId, PetId)
);
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_board_a','pet_sp_bella');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_board_b','pet_sp_juno');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_board_c','pet_sp_dash');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_house_a','pet_sp_clover');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_day_a','pet_sp_juno');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_day_b','pet_sp_dash');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_walk_a','pet_sp_bella');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_walk_b','pet_sp_juno');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_chk_a','pet_sp_mochi');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_chk_b','pet_sp_mochi');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_mw_a','pet_sp_juno');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_mw_b','pet_sp_dash');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_board_a','pet_ht_otis');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_board_b','pet_ht_scout');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_board_c','pet_ht_ziggy');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_board_d','pet_ht_pepper');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_board_e','pet_ht_maple');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_day_a','pet_ht_scout');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_day_b','pet_ht_pepper');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_walk_a','pet_ht_ziggy');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_grp_a','pet_ht_scout');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_grp_b','pet_ht_ziggy');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_grp_c','pet_ht_pepper');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_pr_board_a','pet_pr_luna');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_pr_board_b','pet_pr_biscuit');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_pr_house_a','pet_pr_sable');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_pr_walk_a','pet_pr_biscuit');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_pr_walk_b','pet_pr_luna');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_pend1','pet_sp_bella');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_pend2','pet_sp_bella');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_sp_board1','pet_sp_bella');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_pend1','pet_ht_otis');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('seed_ht_board1','pet_ht_otis');
INSERT INTO "BookingRequestPets" ("BookingRequestId","PetId") VALUES('c671dc89-e902-4fb4-889d-90f9e07a4c09','9f9ca4bf-1b8b-4214-b39b-a1b4b99dca7a');
CREATE TABLE PetOwners (
  TenantId  TEXT NOT NULL REFERENCES Tenants(Id),
  PetId     TEXT NOT NULL REFERENCES EndUserPets(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (PetId, EndUserId)
);
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_sunnypaws','pet_sp_bella','eu_sp_jess','2026-07-29 16:11:18');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_sunnypaws','pet_sp_mochi','eu_sp_jess','2026-07-29 16:11:18');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_happytails','pet_ht_otis','eu_ht_jess','2026-07-29 16:11:18');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_pawsandrelax','pet_pr_luna','eu_pr_jess','2026-07-29 16:11:18');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_sunnypaws','pet_sp_juno','eu_sp_marco','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_sunnypaws','pet_sp_ollie','eu_sp_marco','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_sunnypaws','pet_sp_dash','eu_sp_priya','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_sunnypaws','pet_sp_clover','eu_sp_ana','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_happytails','pet_ht_scout','eu_ht_marco','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_happytails','pet_ht_ziggy','eu_ht_devon','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_happytails','pet_ht_pepper','eu_ht_kate','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_happytails','pet_ht_maple','eu_ht_rosa','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_pawsandrelax','pet_pr_biscuit','eu_pr_omar','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('tnt_pawsandrelax','pet_pr_sable','eu_pr_nina','2026-07-29 16:11:20');
INSERT INTO "PetOwners" ("TenantId","PetId","EndUserId","CreatedAt") VALUES('e66f579d-e056-4b94-9cc7-bfa096b4ebb7','9f9ca4bf-1b8b-4214-b39b-a1b4b99dca7a','dbbeedcd-7118-4525-8138-8446d8f0ef56','2026-08-02 03:45:12');
CREATE TABLE Payments (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id),
  Amount INTEGER NOT NULL CHECK (Amount > 0), -- whole dollars, matching EstCost/Rate
  Method TEXT NOT NULL CHECK (Method IN ('cash', 'venmo', 'zelle', 'paypal', 'check', 'card', 'other')),
  PaidDate TEXT NOT NULL, -- 'YYYY-MM-DD', sitter-entered (defaults to today in the UI)
  Note TEXT,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
, ExternalRef TEXT);
CREATE TABLE ProviderConnections (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  Capability TEXT NOT NULL,
  Provider TEXT NOT NULL,
  Status TEXT NOT NULL DEFAULT 'disconnected' CHECK (Status IN ('disconnected', 'connected')),
  ConnectedAt TEXT,
  -- AES-GCM ciphertext (base64 iv||ct), key derived from TOKEN_SECRET. NEVER returned to a client.
  AccessToken TEXT,
  RefreshToken TEXT,
  TokenExpiresAt TEXT,
  CalendarId TEXT,
  UNIQUE (TenantId, Capability)
);
INSERT INTO "ProviderConnections" ("Id","TenantId","Capability","Provider","Status","ConnectedAt","AccessToken","RefreshToken","TokenExpiresAt","CalendarId") VALUES('seed_sp_cal','tnt_sunnypaws','calendar','google-calendar','disconnected',NULL,NULL,NULL,NULL,NULL);
INSERT INTO "ProviderConnections" ("Id","TenantId","Capability","Provider","Status","ConnectedAt","AccessToken","RefreshToken","TokenExpiresAt","CalendarId") VALUES('seed_ht_cal','tnt_happytails','calendar','google-calendar','disconnected',NULL,NULL,NULL,NULL,NULL);
CREATE TABLE OwnerUsers (
  Id TEXT PRIMARY KEY,
  Email TEXT NOT NULL UNIQUE,
  PasswordHash TEXT NOT NULL,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO "OwnerUsers" ("Id","Email","PasswordHash","CreatedAt") VALUES('77efbf48-b591-4ff8-a58a-633ef12c72dc','bradburch@duck.com','pbkdf2$100000$52e3d42d2390b10122210345a185c6b0$935692a3934d6da5bbeeb3a6d428c27259a0ba3258dea93be0dda977d3c24a3e','2026-07-28 08:26:54');
CREATE TABLE AllowedSitters (
  Email TEXT PRIMARY KEY,
  AddedAt TEXT NOT NULL DEFAULT (datetime('now')),
  ClaimedAt TEXT,
  TenantId TEXT REFERENCES Tenants(Id)
);
INSERT INTO "AllowedSitters" ("Email","AddedAt","ClaimedAt","TenantId") VALUES('newsitter@pawservation.test','2026-07-29 16:11:18',NULL,NULL);
INSERT INTO "AllowedSitters" ("Email","AddedAt","ClaimedAt","TenantId") VALUES('hello@bradpaws.com','2026-08-02 02:23:49','2026-08-02T02:24:55.074Z','e66f579d-e056-4b94-9cc7-bfa096b4ebb7');
CREATE TABLE BookingCharges ( Id TEXT PRIMARY KEY, TenantId TEXT NOT NULL REFERENCES Tenants(Id), BookingRequestId TEXT NOT NULL REFERENCES BookingRequests(Id), Label TEXT NOT NULL, Amount INTEGER NOT NULL CHECK (Amount >= 1), CreatedAt TEXT NOT NULL DEFAULT (datetime('now')) , Origin TEXT CHECK (Origin IS NULL OR Origin IN ('extra_time_early', 'extra_time_late')));
CREATE TABLE SavedAnswers (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL,
  QuestionId TEXT NOT NULL,
  Shape TEXT NOT NULL,
  Value TEXT NOT NULL,
  UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (TenantId, EndUserId, ServiceType, QuestionId)
);
DELETE FROM sqlite_sequence;
CREATE INDEX idx_TenantServicePetRates_Lookup
  ON TenantServicePetRates (TenantId, ServiceType, OptionKey);
CREATE INDEX idx_BookingRequests_Tenant_Dates ON BookingRequests (TenantId, StartDate);
CREATE INDEX idx_BookingRequests_Slot
  ON BookingRequests (TenantId, ServiceType, OptionKey, StartDate);
CREATE INDEX idx_BookingRequests_Tenant_User ON BookingRequests (TenantId, EndUserId);
CREATE UNIQUE INDEX idx_BookingRequests_IdempotencyKey
  ON BookingRequests (TenantId, EndUserId, IdempotencyKey)
  WHERE IdempotencyKey IS NOT NULL;
CREATE INDEX idx_EndUserPets_Tenant_User ON EndUserPets (TenantId, EndUserId);
CREATE INDEX idx_BookingRequestPets_Pet ON BookingRequestPets (PetId);
CREATE INDEX idx_PetOwners_Tenant_User ON PetOwners (TenantId, EndUserId);
CREATE INDEX idx_Payments_Tenant_Date ON Payments (TenantId, PaidDate);
CREATE INDEX idx_Payments_Tenant_Booking ON Payments (TenantId, BookingRequestId);
CREATE UNIQUE INDEX idx_Payments_Tenant_ExternalRef ON Payments (TenantId, ExternalRef) WHERE ExternalRef IS NOT NULL;
CREATE INDEX idx_BookingCharges_Tenant_Booking ON BookingCharges (TenantId, BookingRequestId);
CREATE UNIQUE INDEX idx_BookingRequests_External ON BookingRequests (TenantId, GCalEventId) WHERE ServiceType = 'external';
CREATE INDEX idx_SavedAnswers_Lookup
  ON SavedAnswers (TenantId, EndUserId);
