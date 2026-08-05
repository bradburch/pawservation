-- Migration 0012. PERSONAL ACCESS TOKENS — a long-lived credential a customer issues to
-- themselves, so that something other than the widget can call the booking API as them.
--
-- WHY THIS EXISTS. `server/lib/llms.ts` already publishes a per-tenant `llms.txt` telling any
-- agent that reaches a sitter's booking page how to check availability, quote, book, change and
-- cancel — and every one of those endpoints requires `endUserAuth`. The only credential that
-- satisfies it today is the widget JWT, which lives 24 hours and is minted only by the email-code
-- flow the widget itself drives. So the published document describes an API that nothing outside
-- the widget can practically use: a script the customer wrote, a shell one-liner, or an assistant
-- acting on their behalf all die the next morning. This table is what turns that document into a
-- usable API. It is the credential, and nothing else — it grants exactly what the caller could
-- already do in the widget, for the same end user, under the same tenant.
--
-- ONLY A HASH IS STORED, and it is a plain SHA-256 of the token rather than a PBKDF2 derivation
-- like `TenantUsers.PasswordHash`. That difference is deliberate and is a consequence of where the
-- entropy comes from. A password is a low-entropy string a human chose, so a stolen hash is worth
-- attacking and the defence is to make each guess expensive. A token here is 256 bits straight out
-- of the CSPRNG, which no amount of computation guesses, so an iterated KDF would buy nothing —
-- while costing 100k iterations on EVERY authenticated request, on a credential designed to be
-- presented constantly. See `server/lib/personal-access-token.ts`, which owns this reasoning.
--
-- REVOCATION IS A TIMESTAMP, NOT A DELETE. `RevokedAt` keeps the row (and therefore the hash)
-- after the owner cuts the token off, so a revoked secret can never be re-minted onto a fresh row
-- by coincidence, and the owner keeps a record that the thing they revoked existed. Expiry is
-- deliberately NOT a column: the widget JWT's 24h TTL is its only revocation mechanism, and the
-- whole point of this table is that these tokens have a real one instead.
--
-- LastUsedAt is a RECOGNITION AID, not an audit log — "is this the one my laptop uses?" — and is
-- stamped at coarse resolution so a chatty client does not turn every read into a write. See
-- `LAST_USED_RESOLUTION_MS` in server/lib/personal-access-token.ts.
--
-- Tenant-scoped like every other customer-facing table (Model A): the same email may be two
-- unrelated people under two sitters, so a token resolves within ONE tenant and the lookup binds
-- TenantId. There is no global "find this token" query anywhere, by construction.
--
-- No `Tenants` column, so the KV tenant-config cache key (`tenant:<slug>:config:v2`) needs NO bump.
CREATE TABLE IF NOT EXISTS PersonalAccessTokens (
  Id TEXT PRIMARY KEY,
  TenantId TEXT NOT NULL REFERENCES Tenants(Id),
  EndUserId TEXT NOT NULL REFERENCES EndUsers(Id),
  -- The owner's own label for the client they issued it to ("my laptop", "my assistant"). Shown
  -- back to them in the revoke list and nowhere else; it is how they tell one token from another,
  -- so it is required. Never interpreted.
  Name TEXT NOT NULL,
  -- Lowercase hex SHA-256 of the token. The plaintext is returned once, at creation, and is not
  -- stored in any form from which it could be recovered.
  TokenHash TEXT NOT NULL,
  CreatedAt TEXT NOT NULL DEFAULT (datetime('now')),
  LastUsedAt TEXT,
  -- NULL = live. Set = dead, from that instant; the auth path filters on it, so revocation takes
  -- effect on the very next request rather than at some expiry.
  RevokedAt TEXT
);

-- The authentication lookup, and the only index the hot path uses: (TenantId, TokenHash) is bound
-- on every PAT-authenticated request. UNIQUE is free here and makes a hash collision — or a bug
-- that re-inserted the same secret — a write-time error instead of an ambiguous read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_PersonalAccessTokens_Hash
  ON PersonalAccessTokens (TenantId, TokenHash);

-- The owner's own list, and the scope of every management route.
CREATE INDEX IF NOT EXISTS idx_PersonalAccessTokens_Owner
  ON PersonalAccessTokens (TenantId, EndUserId);
