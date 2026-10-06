package sqlite

import (
	"context"
	"time"

	"pontis/internal/changeset"
)

// Maintenance methods live on the stores that own their tables; no
// separate service is needed for the system jobs.

// PurgeExpiredSessions deletes web sessions past their expiry.
func (s *AccountStore) PurgeExpiredSessions(ctx context.Context, at time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM sessions WHERE expires_at < ?`, formatTime(at))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// JournalGCSpace advances one space's journal floor and prunes history.
// A journal row is collectable only when it violates BOTH retention
// windows: older than 30 days AND below current-50000 revisions
// (doc 14 §3). Tombstones and receipts follow the floor.
func (s *LibraryStore) JournalGCSpace(ctx context.Context, spaceID string, now time.Time, minKeepRevisions int64) (newFloor int64, removed int64, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()

	var current int64
	if err := tx.QueryRowContext(ctx,
		`SELECT current_revision FROM sync_spaces WHERE id = ?`, spaceID).Scan(&current); err != nil {
		return 0, 0, err
	}
	cutoff := now.Add(-30 * 24 * time.Hour).Format(time.RFC3339Nano)
	var rev30d int64
	_ = tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(revision), 0) FROM journal WHERE space_id = ? AND created_at < ?`,
		spaceID, cutoff).Scan(&rev30d)

	byAge := rev30d
	byCount := current - minKeepRevisions
	floor := byAge
	if byCount < floor {
		floor = byCount
	}
	if floor <= 0 {
		return 0, 0, tx.Commit()
	}

	for _, stmt := range []string{
		`DELETE FROM journal WHERE space_id = ? AND revision <= ?`,
		`DELETE FROM tombstones WHERE space_id = ? AND deleted_revision <= ?`,
		`DELETE FROM client_operation_receipts WHERE binding_id IN
			(SELECT id FROM device_space_bindings WHERE space_id = ?)
		 AND COALESCE(processed_at_revision, 0) <= ?`,
	} {
		res, err := tx.ExecContext(ctx, stmt, spaceID, floor, spaceID, floor)
		if err != nil {
			return 0, 0, err
		}
		n, _ := res.RowsAffected()
		removed += n
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE sync_spaces SET journal_floor_revision = MAX(journal_floor_revision, ?), updated_at = ?
		WHERE id = ?`, floor, now.Format(time.RFC3339Nano), spaceID); err != nil {
		return 0, 0, err
	}

	// ChangeSet retention is independent of the journal floor (doc 15 §12):
	// undo data expires with the undo window, activity rows with the longer
	// activity retention.
	undoCutoff := now.Add(-changeset.UndoWindow).Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `
		UPDATE changesets SET undo_data = NULL
		WHERE space_id = ? AND undo_data IS NOT NULL AND created_at < ?`,
		spaceID, undoCutoff); err != nil {
		return 0, 0, err
	}
	activityCutoff := now.Add(-changeset.ActivityRetention).Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM changesets WHERE space_id = ? AND created_at < ?`,
		spaceID, activityCutoff); err != nil {
		return 0, 0, err
	}
	return floor, removed, tx.Commit()
}

// ListAllSpaces returns every space id (system maintenance scope).
func (s *LibraryStore) ListAllSpaces(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM sync_spaces ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
