-- Migration 0017. THE FREE PRODUCT CAN RECORD A PLAN.
-- Five nullable columns on Tenants: which plan a sitter is on, what her subscription has paid
-- through, the two processor ids that identify it, and when the last applied billing event was
-- created. Additive only.
-- None of these columns takes an initial value, deliberately: every existing row reads NULL, NULL
-- is false on both clauses of the entitlement expression, and so applying this file moves no
-- tenant's entitlement by a hair. Seeding Plan to 'solo' on every row would silently make the whole
-- book Solo-entitled.
-- It DOES add Tenants columns the request path reads, so the KV tenant-config cache key moves to
-- v6 alongside it, in the same change (server/lib/tenant-resolve.ts).
-- NO SchemaMeta MARKER, and that is a decision rather than an omission: 0015 needs one because its
-- applied and un-applied states are indistinguishable and a second run is destructive. This one is
-- purely additive — a second run dies loudly on `duplicate column name`, and
-- `PRAGMA table_info(Tenants)` answers "has it been applied?" outright.
-- BEFORE APPLYING, CHECK FOR A RESERVED-SLUG COLLISION. This branch adds 'billing' to
-- RESERVED_SLUGS (server/lib/middleware.ts), and tenantMiddleware calls next() for a reserved slug
-- WITHOUT resolving a tenant. A sitter provisioned before this branch could already hold the word,
-- and from the deploy onwards her whole /api/billing/* surface would resolve nothing — a 404 on
-- every request, silently. Signup has always refused the other four, so only 'billing' is new.
--   npx wrangler d1 execute pawservation-db --remote --command \
--     "SELECT Id, Slug FROM Tenants WHERE Slug IN ('admin','signup','owner','password-reset','billing')"
-- Expect zero rows. IF A ROW COMES BACK, do not fix it here: renaming a sitter's slug breaks every
-- embed on her own website and every link she has sent a customer, so it is a conversation with
-- that sitter and a coordinated change to her embed, not a migration. Deal with it before this
-- branch deploys; the reservation is what stops a NEW one from ever being created.
-- This migration therefore changes no data — it is the five ALTER TABLEs and nothing else.
-- This file must never wrap its statements in an explicit SQL transaction (see migrations/README.md
-- and 0011's history) — D1's remote executor rejects that outright.
ALTER TABLE Tenants ADD COLUMN Plan TEXT CHECK (Plan IS NULL OR Plan IN ('solo', 'pro'));
ALTER TABLE Tenants ADD COLUMN BilledUntil TEXT;
ALTER TABLE Tenants ADD COLUMN StripeCustomerId TEXT;
ALTER TABLE Tenants ADD COLUMN StripeSubscriptionId TEXT;
ALTER TABLE Tenants ADD COLUMN LastBillingEventAt TEXT;
