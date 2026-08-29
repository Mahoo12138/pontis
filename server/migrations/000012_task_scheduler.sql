-- 000012_task_scheduler: product-layer task model (doc 13 §3.1/§4/§5).
-- jobs is rebuilt: domain type names (backup.create, organizer.link_check,
-- journal.gc, ...), owner_user_id becomes nullable (NULL = system job).
-- schedules holds user and system plans; next_run_at is the scheduler's
-- source of truth, (schedule_id, scheduled_for) dedupes occurrences.

CREATE TABLE jobs_new (
    id                  TEXT PRIMARY KEY,
    type                TEXT NOT NULL CHECK (type IN (
                            'backup.create', 'organizer.link_check',
                            'journal.gc', 'receipt.gc', 'session.cleanup',
                            'artifact.cleanup', 'backup.retention',
                            'mail.send', 'import.run')),
    status              TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
    owner_user_id       TEXT REFERENCES users(id),
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

INSERT INTO jobs_new (
    id, type, status, owner_user_id, space_id, payload, result, error, phase,
    progress_current, progress_total, attempt, max_attempts, priority,
    cancel_requested_at, next_run_at, schedule_id, scheduled_for, worker_id,
    lease_until, scheduled_at, started_at, finished_at, created_at, updated_at)
SELECT
    id,
    CASE type
        WHEN 'backup' THEN 'backup.create'
        WHEN 'link_check' THEN 'organizer.link_check'
        WHEN 'maintenance' THEN 'session.cleanup'
        WHEN 'email' THEN 'mail.send'
        WHEN 'import' THEN 'import.run'
        ELSE type
    END,
    status, owner_user_id, space_id, payload, result, error, phase,
    progress_current, progress_total, attempt, max_attempts, priority,
    cancel_requested_at, next_run_at, schedule_id, scheduled_for, worker_id,
    lease_until, scheduled_at, started_at, finished_at, created_at, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

CREATE INDEX idx_jobs_poll ON jobs(status, next_run_at);
CREATE UNIQUE INDEX idx_jobs_schedule_dedupe
    ON jobs(schedule_id, scheduled_for) WHERE schedule_id IS NOT NULL;
CREATE INDEX idx_jobs_owner ON jobs(owner_user_id, created_at);

CREATE TABLE schedules (
    id            TEXT PRIMARY KEY,
    owner_user_id TEXT REFERENCES users(id),
    type          TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('daily', 'weekly', 'monthly')),
    schedule_expr TEXT NOT NULL,
    timezone      TEXT NOT NULL,
    payload       TEXT NOT NULL DEFAULT '{}',
    next_run_at   TEXT NOT NULL,
    last_run_at   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at);
CREATE INDEX idx_schedules_owner ON schedules(owner_user_id);
