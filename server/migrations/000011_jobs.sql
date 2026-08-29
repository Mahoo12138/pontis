-- 000011_jobs: SQLite persistent job queue (doc 13).
-- Claim+lease worker model, bounded exponential backoff, cooperative
-- cancellation via cancel_requested_at. Schedule dedupe is enforced for
-- future scheduler rows; manual enqueues carry no schedule_id.

CREATE TABLE jobs (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL CHECK (type IN ('link_check', 'backup', 'maintenance', 'email', 'import')),
    status              TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
    owner_user_id       TEXT NOT NULL,
    space_id            TEXT,
    payload             TEXT NOT NULL DEFAULT '{}',
    result              TEXT,
    error               TEXT,
    phase               TEXT,
    progress_current    INTEGER,
    progress_total      INTEGER,
    attempt             INTEGER NOT NULL DEFAULT 0,
    max_attempts        INTEGER NOT NULL DEFAULT 3,
    priority            INTEGER NOT NULL DEFAULT 0,
    cancel_requested_at TEXT,
    next_run_at         TEXT NOT NULL,
    schedule_id         TEXT,
    scheduled_for       TEXT,
    worker_id           TEXT,
    lease_until         TEXT,
    scheduled_at        TEXT NOT NULL,
    started_at          TEXT,
    finished_at         TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE INDEX idx_jobs_poll ON jobs(status, next_run_at);
CREATE UNIQUE INDEX idx_jobs_schedule_dedupe
    ON jobs(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;
