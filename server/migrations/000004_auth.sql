-- 000004_auth: users and web sessions.
-- V1 roles: admin | user. Server-side opaque sessions; only the token
-- hash is stored. API tokens and device credentials come with their own
-- modules.

CREATE TABLE users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    display_name        TEXT NOT NULL,
    email               TEXT,
    email_normalized    TEXT,
    password_hash       TEXT NOT NULL,
    role                TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    status              TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    locale              TEXT NOT NULL DEFAULT 'zh-CN',
    default_space_id    TEXT,
    email_verified_at   TEXT,
    password_changed_at TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- Email uniqueness among non-NULL values.
CREATE UNIQUE INDEX idx_users_email_normalized
    ON users(email_normalized) WHERE email_normalized IS NOT NULL;

CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    user_agent   TEXT NOT NULL DEFAULT ''
);
