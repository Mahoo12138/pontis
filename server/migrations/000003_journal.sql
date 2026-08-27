-- 000003_journal: canonical change history for incremental sync.
-- Journal stores final Canonical Changes (not client intent) and is GC-able
-- down to journal_floor_revision. Tombstones record recently deleted node
-- identity so stale client operations can be resolved as target_deleted.

CREATE TABLE journal (
    space_id           TEXT NOT NULL,
    epoch              INTEGER NOT NULL,
    revision           INTEGER NOT NULL,
    change_type        TEXT NOT NULL,
    node_id            TEXT,
    payload            TEXT NOT NULL,
    origin_type        TEXT NOT NULL,
    origin_user_id     TEXT,
    origin_device_id   TEXT,
    origin_binding_id  TEXT,
    origin_client_seq  INTEGER,
    op_id              TEXT,
    change_set_id      TEXT,
    request_id         TEXT,
    created_at         TEXT NOT NULL,
    PRIMARY KEY (space_id, epoch, revision)
);

CREATE TABLE tombstones (
    space_id         TEXT NOT NULL,
    node_id          TEXT NOT NULL,
    deleted_epoch    INTEGER NOT NULL,
    deleted_revision INTEGER NOT NULL,
    deleted_at       TEXT NOT NULL,
    PRIMARY KEY (space_id, node_id)
);

CREATE INDEX idx_tombstones_revision ON tombstones(space_id, deleted_epoch, deleted_revision);
