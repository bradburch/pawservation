-- Saved intake answers (owner directive 2026-07-29: "Accounts should also have an option to save
-- required question answers for future bookings").
--
-- Decision: PRE-FILL, ALWAYS EDITABLE. Saved per customer, per service, per question. The next
-- booking form for that service arrives filled in; the customer may change anything; whatever they
-- submit is stored on that booking AND becomes the new saved value. No opt-in checkbox, no
-- sitter-managed variant.
--
-- Keying. `TenantServices.Questions` is JSON and each question carries its own `id` — client-minted
-- and preserved verbatim by the settings PUT, so it IS stable across sitter edits. Stable is not
-- the same as meaningful: a sitter can keep the id and change what the question ASKS ("Feeding
-- routine" -> "Emergency vet phone"), or change its type, and a key of id alone would silently
-- pre-fill an answer that no longer answers anything. So every row also stores `Shape` —
-- `questionShape()` in src/shared/booking/service-rules.ts, `type + normalized label` — as of the
-- answer, and a saved answer is offered ONLY when the question's current shape still matches.
-- Constraints (`options`, `min`, `max`, `required`) are deliberately NOT part of the shape: they
-- bound the answer rather than change the question, and `validateAnswer` already refuses a saved
-- value that no longer satisfies them (checked on read AND again on the next POST).
--
-- ServiceType is in the key because question ids are unique only within one service's Questions
-- JSON — the seeded demo reuses `vaccines` and `entry` across services.
--
-- Additive: one new table + one index. No column is added to `Tenants`, so the KV tenant-config
-- cache key (`tenant:<slug>:config:v2`) does NOT need bumping for this migration.

CREATE TABLE IF NOT EXISTS SavedAnswers (
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  ServiceType TEXT NOT NULL,
  QuestionId TEXT NOT NULL,
  Shape TEXT NOT NULL,
  Value TEXT NOT NULL,
  UpdatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (TenantId, EndUserId, ServiceType, QuestionId)
);

CREATE INDEX IF NOT EXISTS idx_SavedAnswers_Lookup
  ON SavedAnswers (TenantId, EndUserId);
