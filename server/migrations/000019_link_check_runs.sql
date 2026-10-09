-- 000019_link_check_runs: Link Check work lives in the database (doc 12 §2,
-- doc 13 §5). One run row per job, one item row per bookmark. The item's
-- status is the checkpoint: a worker that dies leaves its unchecked items
-- pending, and the retried job picks up exactly those. The run's totals are
-- counted from its items, so nothing here can drift from what was snapshotted.

CREATE TABLE link_check_runs (
    job_id      TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    space_id    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_link_check_runs_space
    ON link_check_runs(space_id, created_at DESC, job_id DESC);

CREATE TABLE link_check_items (
    job_id       TEXT NOT NULL REFERENCES link_check_runs(job_id) ON DELETE CASCADE,
    node_id      TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    url          TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'checked')) DEFAULT 'pending',
    status_class TEXT NOT NULL DEFAULT '',
    http_status  INTEGER NOT NULL DEFAULT 0,
    error_type   TEXT NOT NULL DEFAULT '',
    latency_ms   INTEGER NOT NULL DEFAULT 0,
    final_url    TEXT NOT NULL DEFAULT '',
    checked_at   TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (job_id, node_id)
);

CREATE INDEX idx_link_check_items_pending
    ON link_check_items(job_id, status, node_id);
