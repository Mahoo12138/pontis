package sqlite

import (
	"context"
	"database/sql"
	"time"

	"pontis/internal/jobs"
	"pontis/internal/schedule"
)

// ScheduleStore persists plan tasks.
type ScheduleStore struct {
	db *sql.DB
}

// NewScheduleStore returns a schedule store.
func NewScheduleStore(db *sql.DB) *ScheduleStore { return &ScheduleStore{db: db} }

const scheduleColumns = `
	id, COALESCE(owner_user_id, ''), COALESCE(space_id, ''), type, enabled, schedule_type, schedule_expr,
	timezone, next_run_at, last_run_at, created_at, updated_at`

func scanSchedule(row interface{ Scan(dest ...any) error }) (schedule.Schedule, error) {
	var s schedule.Schedule
	var typ, kind, expr, tz, nextRunAt, createdAt, updatedAt string
	var enabled int
	var lastRun *string
	if err := row.Scan(&s.ID, &s.OwnerUserID, &s.SpaceID, &typ, &enabled, &kind, &expr, &tz,
		&nextRunAt, &lastRun, &createdAt, &updatedAt); err != nil {
		return s, err
	}
	s.Type = jobs.Type(typ)
	s.Enabled = enabled != 0
	s.Kind = schedule.Kind(kind)
	s.TimeOfDay = expr
	s.Timezone = tz
	s.NextRunAt, _ = time.Parse(time.RFC3339Nano, nextRunAt)
	s.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	s.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
	if lastRun != nil {
		v, _ := time.Parse(time.RFC3339Nano, *lastRun)
		s.LastRunAt = &v
	}
	return s, nil
}

// Insert writes a new schedule.
func (s *ScheduleStore) Insert(ctx context.Context, sched schedule.Schedule) error {
	var owner any
	if sched.OwnerUserID != "" {
		owner = sched.OwnerUserID
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO schedules (id, owner_user_id, space_id, type, enabled, schedule_type, schedule_expr,
			timezone, next_run_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		sched.ID, owner, nullableString(sched.SpaceID), string(sched.Type), boolToInt(sched.Enabled),
		string(sched.Kind), sched.TimeOfDay, sched.Timezone,
		formatTime(sched.NextRunAt), formatTime(sched.CreatedAt), formatTime(sched.UpdatedAt))
	return err
}

// Get loads one schedule.
func (s *ScheduleStore) Get(ctx context.Context, id string) (schedule.Schedule, error) {
	row := s.db.QueryRowContext(ctx, `SELECT `+scheduleColumns+` FROM schedules WHERE id = ?`, id)
	sched, err := scanSchedule(row)
	if err == sql.ErrNoRows {
		return sched, schedule.ErrNotFound
	}
	return sched, err
}

// ListByOwner returns the owner's schedules (empty owner never matches:
// system schedules are not user-visible, doc 13 §3.1).
func (s *ScheduleStore) ListByOwner(ctx context.Context, owner string) ([]schedule.Schedule, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+scheduleColumns+` FROM schedules WHERE owner_user_id = ? ORDER BY created_at, id`, owner)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []schedule.Schedule
	for rows.Next() {
		sched, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sched)
	}
	return out, rows.Err()
}

// ListDue returns enabled schedules whose next_run_at has passed.
func (s *ScheduleStore) ListDue(ctx context.Context, now time.Time) ([]schedule.Schedule, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+scheduleColumns+` FROM schedules
		WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at`, formatTime(now))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []schedule.Schedule
	for rows.Next() {
		sched, err := scanSchedule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sched)
	}
	return out, rows.Err()
}

// Update rewrites a schedule row.
func (s *ScheduleStore) Update(ctx context.Context, sched schedule.Schedule) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE schedules SET space_id = ?, type = ?, enabled = ?, schedule_type = ?, schedule_expr = ?,
			timezone = ?, next_run_at = ?, updated_at = ?
		WHERE id = ?`,
		nullableString(sched.SpaceID), string(sched.Type), boolToInt(sched.Enabled), string(sched.Kind),
		sched.TimeOfDay, sched.Timezone, formatTime(sched.NextRunAt),
		formatTime(sched.UpdatedAt), sched.ID)
	return err
}

// Delete removes a schedule.
func (s *ScheduleStore) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM schedules WHERE id = ?`, id)
	return err
}

// AdvanceNextRun persists the next occurrence and the last handled one.
func (s *ScheduleStore) AdvanceNextRun(ctx context.Context, id string, next, lastRun time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE schedules SET next_run_at = ?, last_run_at = ?, updated_at = ?
		WHERE id = ?`, formatTime(next), formatTime(lastRun), formatTime(time.Now().UTC()), id)
	return err
}

// FindByType returns the owner's schedule of one type (used for seeding).
// An empty owner binds NULL so system schedules (owner IS NULL) match.
func (s *ScheduleStore) FindByType(ctx context.Context, owner string, t jobs.Type) (schedule.Schedule, bool, error) {
	var ownerArg any
	if owner != "" {
		ownerArg = owner
	}
	row := s.db.QueryRowContext(ctx, `
		SELECT `+scheduleColumns+` FROM schedules WHERE owner_user_id IS ? AND type = ? LIMIT 1`, ownerArg, string(t))
	sched, err := scanSchedule(row)
	if err == sql.ErrNoRows {
		return sched, false, nil
	}
	return sched, err == nil, err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
