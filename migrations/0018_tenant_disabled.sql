-- Owner can disable a sitter (widget dark + admin read-only) without deleting them.
-- NULL = active; timestamp = disabled. Reversible via PATCH /api/owner/sitters/:tenantId.
ALTER TABLE Tenants ADD COLUMN DisabledAt TEXT;
