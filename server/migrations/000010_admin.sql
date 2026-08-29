-- 000010_admin: admin user management and password reset flow.
-- Reset tokens are stored hashed, single-use and short-lived; the admin
-- never sees the new password (doc 09 §15).

CREATE TABLE password_reset_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_reset_tokens_user ON password_reset_tokens(user_id);
