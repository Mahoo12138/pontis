-- 000007_api_tokens: external API credentials (doc 09 §9-10).
-- Secrets are stored hashed; the raw token is shown exactly once.
-- Space restriction is 'all' or a JSON array of space ids.

CREATE TABLE api_tokens (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    name         TEXT NOT NULL,
    scopes       TEXT NOT NULL,
    space_scope  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
);

CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);

CREATE TABLE api_token_secrets (
    token_id     TEXT PRIMARY KEY REFERENCES api_tokens(id) ON DELETE CASCADE,
    token_prefix TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL
);
