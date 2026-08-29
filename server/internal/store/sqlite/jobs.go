package sqlite

import (
	"context"
	"database/sql"
	"time"

	"pontis/internal/jobs"
)

// JobStore implements the SQLite job queue with claim+lease semantics.
type JobStore struct {
	db *sql.DB
}

// NewJobStore returns a job store.
func NewJobStore(db *sql.DB) *JobStore { return &JobStore{db: db} }

const jobColumns = `
	id, type, status, owner_user_id, COALESCE(space_id, ''), payload, COALESCE(error, ''),
	COALESCE(phase, ''), progress_current, progress_total, attempt, max_attempts,
	COALESCE(cancel_requested_at, ''), scheduled_at, started_at, finished_at`

func scanJob(row interface{ Scan(dest ...any) error }) (jobs.Job, error) {
	var j jobs.Job
	var typ, status, scheduledAt, cancelFlag string
	var startedAt, finishedAt *string
	var progressCur, progressTot *int64
	if err := row.Scan(&j.ID, &typ, &status, &j.OwnerUserID, &j.SpaceID, &j.Payload, &j.Error,
		&j.Phase, &progressCur, &progressTot, &j.Attempt, &j.MaxAttempts,
		&cancelFlag, &scheduledAt, &startedAt, &finishedAt); err != nil {
		return j, err
	}
	j.CancelRequested = cancelFlag != ""
	j.Type = jobs.Type(typ)
	j.Status = jobs.Status(status)
	j.ScheduledAt, _ = time.Parse(time.RFC3339Nano, scheduledAt)
	if startedAt != nil {
		v, _ := time.Parse(time.RFC3339Nano, *startedAt)
		j.StartedAt = &v
	}
	if finishedAt != nil {
		v, _ := time.Parse(time.RFC3339Nano, *finishedAt)
		j.FinishedAt = &v
	}
	j.ProgressCur = progressCur
	j.ProgressTot = progressTot
	return j, nil
}

// Enqueue writes a queued job.
func (s *JobStore) Enqueue(ctx context.Context, j jobs.Job) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO jobs (id, type, status, owner_user_id, space_id, payload,
			attempt, max_attempts, next_run_at, scheduled_at, created_at, updated_at)
		VALUES (?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
		j.ID, string(j.Type), j.OwnerUserID, nullableString(j.SpaceID), j.Payload,
		j.MaxAttempts, formatTime(j.ScheduledAt), formatTime(j.ScheduledAt),
		formatTime(j.ScheduledAt), formatTime(j.ScheduledAt))
	return err
}

// Claim atomically moves one due job (queued or retry_wait past its
// backoff) to running with a lease.
func (s *JobStore) Claim(ctx context.Context, workerID string, leaseUntil time.Time) (jobs.Job, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return jobs.Job{}, err
	}
	defer tx.Rollback()

	var id string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM jobs
		WHERE status IN ('queued', 'retry_wait') AND next_run_at <= ?
		ORDER BY priority DESC, next_run_at
		LIMIT 1`, formatTime(time.Now().UTC())).Scan(&id)
	if err == sql.ErrNoRows {
		return jobs.Job{}, jobs.ErrNotFound
	}
	if err != nil {
		return jobs.Job{}, err
	}
	now := time.Now().UTC()
	res := tx.QueryRowContext(ctx, `
		UPDATE jobs SET status = 'running', worker_id = ?, lease_until = ?,
			started_at = COALESCE(started_at, ?), updated_at = ?
		WHERE id = ? AND status IN ('queued', 'retry_wait')
		RETURNING `+jobColumns,
		workerID, formatTime(leaseUntil), formatTime(now), formatTime(now), id)
	j, err := scanJob(res)
	if err != nil {
		return jobs.Job{}, err
	}
	if err := tx.Commit(); err != nil {
		return jobs.Job{}, err
	}
	return j, nil
}

// UpdateProgress rewrites phase/progress while the job is running.
func (s *JobStore) UpdateProgress(ctx context.Context, id, phase string, current, total *int64) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET phase = ?, progress_current = ?, progress_total = ?, updated_at = ?
		WHERE id = ?`, phase, nullableInt64(current), nullableInt64(total),
		formatTime(time.Now().UTC()), id)
	return err
}

// Finish marks the terminal state.
func (s *JobStore) Finish(ctx context.Context, id string, status jobs.Status, jobErr string, at time.Time) error {
	var result any
	if status == jobs.StatusSucceeded {
		result = "{}"
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET status = ?, error = NULLIF(?, ''), result = ?, finished_at = ?, updated_at = ?
		WHERE id = ?`, string(status), jobErr, result, formatTime(at), formatTime(at), id)
	return err
}

// ScheduleRetry puts a job back to retry_wait with backoff.
func (s *JobStore) ScheduleRetry(ctx context.Context, id string, attempt int, nextRunAt time.Time, jobErr string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET status = 'retry_wait', attempt = ?, next_run_at = ?, error = ?, updated_at = ?
		WHERE id = ?`, attempt, formatTime(nextRunAt), jobErr, formatTime(time.Now().UTC()), id)
	return err
}

// RequestCancel flags cooperative cancellation.
func (s *JobStore) RequestCancel(ctx context.Context, id string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE jobs SET cancel_requested_at = ?, updated_at = ? WHERE id = ?`,
		formatTime(at), formatTime(at), id)
	return err
}

// Get loads one job.
func (s *JobStore) Get(ctx context.Context, id string) (jobs.Job, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+jobColumns+` FROM jobs WHERE id = ?`, id)
	j, err := scanJob(row)
	if err == sql.ErrNoRows {
		return j, jobs.ErrNotFound
	}
	return j, err
}

// List returns recent jobs, newest first.
func (s *JobStore) List(ctx context.Context, limit int) ([]jobs.Job, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+jobColumns+` FROM jobs ORDER BY created_at DESC, id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []jobs.Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// RecoverExpiredLeases requeues running jobs whose worker died.
func (s *JobStore) RecoverExpiredLeases(ctx context.Context, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE jobs SET status = 'queued', worker_id = NULL, lease_until = NULL, updated_at = ?
		WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?`,
		formatTime(at), formatTime(at))
	return err
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableInt64(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}
