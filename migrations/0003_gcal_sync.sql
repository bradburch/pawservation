-- Google Calendar source of truth (feat/gcal-source-of-truth).
-- Numbering note: main's migrations/ was empty when this branch started. 0001 lives on the
-- unmerged venmo branch and 0002 on the unmerged holiday branch; this is the gcal branch's one
-- migration file (0003) — later DDL for this branch is appended here, not split into new files.
-- Additive + old-worker-safe: apply to prod BEFORE merging the branch (see the ops runbook,
-- docs/superpowers/plans/2026-07-27-gcal-ops.md).
ALTER TABLE BookingRequests ADD COLUMN SyncPending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE BookingRequests ADD COLUMN ExternalSummary TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_BookingRequests_External
  ON BookingRequests (TenantId, GCalEventId) WHERE ServiceType = 'external';
