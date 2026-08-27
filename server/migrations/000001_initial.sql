-- 000001_initial: system-level tables.
-- Canonical tree tables (sync_spaces, root_slots, nodes, journal, ...) are
-- introduced by later migrations as the corresponding modules land.

CREATE TABLE server_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE system_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE system_secrets (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce      BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
