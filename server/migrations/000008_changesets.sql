-- 000008_changesets: user-facing activity history and undo (doc 15, 18 §7).
-- One ChangeSet per business-semantic operation; journal rows link via
-- change_set_id. Undo data holds the atomic before-image captured in
-- the same transaction as the mutation.

CREATE TABLE change_sets (
    id                       TEXT PRIMARY KEY,
    space_id                 TEXT NOT NULL,
    actor_type               TEXT NOT NULL,
    actor_user_id            TEXT,
    actor_device_id          TEXT,
    kind                     TEXT NOT NULL,
    summary                  TEXT NOT NULL DEFAULT '',
    first_revision           INTEGER NOT NULL,
    last_revision            INTEGER NOT NULL,
    inverse_of_change_set_id TEXT,
    created_at               TEXT NOT NULL
);

CREATE INDEX idx_change_sets_space ON change_sets(space_id, created_at DESC, id);

CREATE TABLE change_set_undo_data (
    change_set_id  TEXT PRIMARY KEY,
    format_version INTEGER NOT NULL,
    codec          TEXT NOT NULL,
    payload        BLOB NOT NULL,
    expires_at     TEXT,
    created_at     TEXT NOT NULL
);
