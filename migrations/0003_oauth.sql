-- Phase 6 groundwork: storage for the MCP connector's OAuth flow (NOTE_SPEC.md §8a).
--
-- Claude connects from Anthropic's cloud, not from a browser, so it cannot complete
-- a Cloudflare Access login. /mcp therefore carries its own OAuth, and these two
-- tables are what that flow needs to remember.
--
-- D1 rather than Workers KV. The reference OAuth provider for Workers stores its
-- state in KV, which would put authorisation — the thing that decides who may read
-- the log — outside src/db.ts, the single module every other query goes through.
-- Two small tables here keep that rule intact, and keep the whole project on one
-- storage engine with one backup story (§10).
--
-- There is deliberately no clients table. A registered client is remembered by
-- signing its details into the client_id itself, so an unauthenticated caller
-- hitting /oauth/register writes no rows at all — no spam surface, and no table
-- that would have to exist without a user_id (§4).

-- --------------------------------------------------------- authorisation codes
-- Short-lived and single-use: consumed by the token exchange, which deletes the
-- row. PKCE only — public clients get no secret, so the code_challenge is what
-- proves the caller redeeming the code is the one that asked for it.
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  client_id      TEXT NOT NULL,
  client_name    TEXT,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL
);

-- ------------------------------------------------------------------- tokens
-- Only the SHA-256 of a token is stored. A leaked database is then not a set of
-- working credentials, and the app never needs the original back — every check is
-- "does this hash exist", never "what was the token".
CREATE TABLE oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  client_id    TEXT NOT NULL,
  client_name  TEXT,
  kind         TEXT NOT NULL,             -- 'access' | 'refresh'
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

-- The settings screen lists live connections; revoking one walks the same index.
CREATE INDEX idx_oauth_tokens_user ON oauth_tokens(user_id, revoked_at, created_at);
