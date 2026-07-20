-- Service-level capacity + pet-type attributes (spec: 2026-07-19-service-level-attributes-design.md).
-- Caps move onto the services they describe: TenantServices gains MaxConcurrentPets (boarding-kind:
-- pets in care per day for THIS service) and MaxPerDay (housesit-kind: bookings of THIS service per
-- day), both NULL = unlimited. Tenants.MaxBoardingPets/MaxHouseSitsPerDay/MaxStayNights and
-- TenantPetTypes.Enabled are RETIRED IN PLACE: columns stay (this migration is purely additive —
-- ALTER ADD + UPDATEs, never a rebuild), but no code reads or writes them after this ships.
-- A future 0016+ cleanup migration may drop them once every DB has 0015.
--
-- NOT IDEMPOTENT — apply exactly once, and only via `wrangler d1 execute --file` (below). That
-- runner wraps the file in a single transaction, so an accidental re-run fails on the duplicate
-- `ALTER ... ADD COLUMN` and rolls the whole file back. A non-transactional runner would instead
-- re-run the materializing UPDATEs and OVERWRITE any per-service cap edits a sitter has made
-- since the first apply, reverting them to the migration-time derived values. Never re-run;
-- write a new migration instead.
--
-- Apply with:
--   npx wrangler d1 execute pawbook-db --local  --file ./migrations/0015_service_level_attributes.sql
--   npx wrangler d1 execute pawbook-db --remote --file ./migrations/0015_service_level_attributes.sql

-- 1) The two per-service cap columns (NULL = unlimited, matching MinNights/MaxNights/etc.).
ALTER TABLE TenantServices ADD COLUMN MaxConcurrentPets INTEGER;
ALTER TABLE TenantServices ADD COLUMN MaxPerDay INTEGER;

-- 2) Copy the tenant caps per CapacityKind. Plain correlated copies; NULL (unlimited) copies
--    through as NULL. Note: a tenant with TWO services of one kind gets the cap on EACH — pools
--    are per-service now (owner's directive, accepted as designed).
UPDATE TenantServices SET MaxConcurrentPets =
  (SELECT MaxBoardingPets FROM Tenants t WHERE t.Id = TenantId)
WHERE CapacityKind = 'boarding';
UPDATE TenantServices SET MaxPerDay =
  (SELECT MaxHouseSitsPerDay FROM Tenants t WHERE t.Id = TenantId)
WHERE CapacityKind = 'housesit';

-- 3) Stay length folds into per-service MaxNights as the EFFECTIVE MIN (spec F2): both limits are
--    enforced today, so the effective ceiling is the smaller one — a plain copy-where-NULL would
--    silently loosen a service whose explicit MaxNights exceeds the tenant cap.
UPDATE TenantServices SET MaxNights =
  (SELECT CASE
     WHEN MaxNights IS NULL THEN t.MaxStayNights
     WHEN t.MaxStayNights IS NULL THEN MaxNights
     ELSE MIN(MaxNights, t.MaxStayNights) END
   FROM Tenants t WHERE t.Id = TenantId)
WHERE Shape = 'range';

-- 4) Materialize Enabled = 0 into acceptance lists (spec F1): with the tenant gate gone, a NULL
--    list would suddenly accept a tenant's DISABLED types. For every tenant that has any disabled
--    row, each service with a NULL list gets the explicit enabled-slug list.
UPDATE TenantServices SET AcceptedPetTypes =
  (SELECT json_group_array(PetType)
   FROM (SELECT p.PetType FROM TenantPetTypes p
         WHERE p.TenantId = TenantServices.TenantId AND p.Enabled = 1
         ORDER BY p.PetType))
WHERE AcceptedPetTypes IS NULL
  AND EXISTS (SELECT 1 FROM TenantPetTypes p
              WHERE p.TenantId = TenantServices.TenantId AND p.Enabled = 0);

-- 5) Scrub disabled slugs from EXPLICIT lists — such an entry was dead under the tenant gate and
--    would come alive without this. Order within the list is preserved (json_each key order).
UPDATE TenantServices SET AcceptedPetTypes =
  (SELECT json_group_array(value)
   FROM (SELECT je.value AS value FROM json_each(TenantServices.AcceptedPetTypes) je
         WHERE NOT EXISTS (SELECT 1 FROM TenantPetTypes p
                           WHERE p.TenantId = TenantServices.TenantId
                             AND p.PetType = je.value AND p.Enabled = 0)
         ORDER BY je.key))
WHERE AcceptedPetTypes IS NOT NULL
  AND EXISTS (SELECT 1 FROM json_each(TenantServices.AcceptedPetTypes) je2
              JOIN TenantPetTypes p2
                ON p2.TenantId = TenantServices.TenantId AND p2.PetType = je2.value
              WHERE p2.Enabled = 0);

-- 6) An enabled service whose list emptied (steps 4/5) accepts nothing = disable it (the
--    documented rule). It was already unbookable — every booking died at the tenant gate — so
--    this preserves behavior. The stored '[]' on a DISABLED service is allowed; re-enabling via
--    the settings PUT forces an explicit acceptance choice.
UPDATE TenantServices SET Enabled = 0
WHERE Enabled = 1 AND AcceptedPetTypes = '[]';

-- Steps 2-6 leave TenantPetTypes.Enabled and the three Tenants columns with their old values —
-- retired, unread.
