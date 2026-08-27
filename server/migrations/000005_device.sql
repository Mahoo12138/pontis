-- 000005_device: devices, one-time device credentials and per
-- (device, space) bindings. Browser mount IDs never enter the server
-- schema. Receipts land with the sync engine module.

CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id),
    name          TEXT NOT NULL,
    client_type   TEXT NOT NULL,
    browser       TEXT NOT NULL DEFAULT '',
    platform      TEXT NOT NULL DEFAULT '',
    sync_mode     TEXT CHECK (sync_mode IN ('full', 'partial')),
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT,
    revoked_at    TEXT
);

CREATE INDEX idx_devices_owner ON devices(owner_user_id);

CREATE TABLE device_credentials (
    id           TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL REFERENCES devices(id),
    token_prefix TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
);

CREATE INDEX idx_device_credentials_device ON device_credentials(device_id);

CREATE TABLE device_space_bindings (
    id                TEXT PRIMARY KEY,
    device_id         TEXT NOT NULL REFERENCES devices(id),
    space_id          TEXT NOT NULL REFERENCES sync_spaces(id),
    state             TEXT NOT NULL CHECK (state IN ('pending_initial', 'active', 'suspended')),
    epoch             INTEGER NOT NULL,
    applied_revision  INTEGER NOT NULL DEFAULT 0,
    received_revision INTEGER NOT NULL DEFAULT 0,
    max_client_seq    INTEGER NOT NULL DEFAULT 0,
    initialized_at    TEXT,
    last_sync_at      TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (device_id, space_id)
);
