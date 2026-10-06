-- 000007_reconcile: reconciliation sessions, snapshots and artifacts
-- (docs 08 §9-11, 18 §6). Large payloads are stored as artifacts; server
-- snapshots additionally freeze their node set for stable point-in-time
-- pagination.

CREATE TABLE sync_artifacts (
    id           TEXT PRIMARY KEY,
    binding_id   TEXT NOT NULL,
    kind         TEXT NOT NULL,
    epoch        INTEGER,
    revision     INTEGER,
    storage_key  TEXT NOT NULL,
    content      BLOB,
    checksum     TEXT NOT NULL DEFAULT '',
    size_bytes   INTEGER NOT NULL DEFAULT 0,
    expires_at   TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX idx_artifacts_binding ON sync_artifacts(binding_id, kind);

CREATE TABLE server_snapshots (
    id          TEXT PRIMARY KEY,
    binding_id  TEXT NOT NULL,
    space_id    TEXT NOT NULL,
    epoch       INTEGER NOT NULL,
    revision    INTEGER NOT NULL,
    node_count  INTEGER NOT NULL,
    checksum    TEXT NOT NULL,
    expires_at  TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE server_snapshot_nodes (
    snapshot_id TEXT NOT NULL REFERENCES server_snapshots(id) ON DELETE CASCADE,
    node_ref    TEXT NOT NULL,
    parent_ref  TEXT NOT NULL DEFAULT '',
    type        TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    url         TEXT NOT NULL DEFAULT '',
    root_key    TEXT NOT NULL DEFAULT '',
    position    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (snapshot_id, node_ref)
);

CREATE TABLE reconciliations (
    id                         TEXT PRIMARY KEY,
    binding_id                 TEXT NOT NULL,
    space_id                   TEXT NOT NULL,
    type                       TEXT NOT NULL,
    reason                     TEXT NOT NULL DEFAULT '',
    state                      TEXT NOT NULL,
    phase                      TEXT NOT NULL DEFAULT '',
    source_epoch               INTEGER NOT NULL DEFAULT 0,
    source_revision            INTEGER NOT NULL DEFAULT 0,
    target_epoch               INTEGER,
    target_revision            INTEGER,
    client_snapshot_artifact_id TEXT,
    server_snapshot_artifact_id TEXT,
    plan_artifact_id           TEXT,
    steps_artifact_id          TEXT,
    plan_hash                  TEXT,
    server_committed           INTEGER NOT NULL DEFAULT 0,
    commit_revision            INTEGER,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    completed_at               TEXT
);

-- A binding runs at most one active reconciliation at a time (doc 06 §3).
CREATE UNIQUE INDEX idx_reconciliations_active
    ON reconciliations(binding_id)
    WHERE state IN ('running', 'waiting_user');

CREATE TABLE reconciliation_issues (
    id                 TEXT PRIMARY KEY,
    reconciliation_id  TEXT NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
    type               TEXT NOT NULL,
    payload            TEXT NOT NULL,
    default_choice     TEXT NOT NULL DEFAULT '',
    selected_choice    TEXT,
    created_at         TEXT NOT NULL
);

CREATE INDEX idx_issues_reconciliation ON reconciliation_issues(reconciliation_id);
