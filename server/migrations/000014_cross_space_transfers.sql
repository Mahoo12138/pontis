-- Cross-Space Transfer records (doc 18 §8): the idempotency and audit
-- trail for the atomic transfer protocol. `mapping_json` holds the
-- source→target node id map of the committed transfer so an idempotent
-- replay can return the same answer without re-reading journals.
CREATE TABLE IF NOT EXISTS cross_space_transfers (
    id                    TEXT PRIMARY KEY,
    owner_user_id         TEXT NOT NULL,
    source_space_id       TEXT NOT NULL,
    target_space_id       TEXT NOT NULL,
    source_binding_id     TEXT,
    target_binding_id     TEXT,
    state                 TEXT NOT NULL,
    request_hash          TEXT NOT NULL,
    mapping_json          TEXT NOT NULL DEFAULT '[]',
    source_change_set_id  TEXT,
    target_change_set_id  TEXT,
    created_at            TEXT NOT NULL,
    completed_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_cross_space_transfers_owner
    ON cross_space_transfers (owner_user_id, created_at);
