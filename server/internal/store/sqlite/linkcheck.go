package sqlite

import (
	"context"
	"database/sql"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/organizer"
)

// LinkCheckStore persists the work and the results of link check runs.
// The job row is the run; these rows are its per-bookmark checkpoint, so the
// queue's claim/lease/retry machinery is the only task system Link Check
// needs (doc 12 §2, doc 13 §5).
type LinkCheckStore struct {
	db *sql.DB
}

// NewLinkCheckStore returns a link check run store.
func NewLinkCheckStore(db *sql.DB) *LinkCheckStore { return &LinkCheckStore{db: db} }

// SeedRun writes the bookmark snapshot for one job. Re-running it adds
// nothing: the items already checked keep their results, which is what makes
// a retried job resume instead of start over.
func (s *LinkCheckStore) SeedRun(ctx context.Context, jobID string, space canonical.SpaceID,
	items []organizer.LinkItem, at time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO link_check_runs (job_id, space_id, created_at)
		VALUES (?, ?, ?)
		ON CONFLICT(job_id) DO NOTHING`,
		jobID, string(space), formatTime(at)); err != nil {
		return err
	}
	for _, it := range items {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO link_check_items (job_id, node_id, title, url)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(job_id, node_id) DO NOTHING`,
			jobID, it.NodeID, it.Title, it.URL); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// PendingItems returns the items of one job with no result yet.
func (s *LinkCheckStore) PendingItems(ctx context.Context, jobID string) ([]organizer.LinkItem, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT node_id, title, url FROM link_check_items
		WHERE job_id = ? AND status = 'pending' ORDER BY node_id`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []organizer.LinkItem
	for rows.Next() {
		var it organizer.LinkItem
		if err := rows.Scan(&it.NodeID, &it.Title, &it.URL); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// CountItems reports the snapshot size of one job and how much is checked.
func (s *LinkCheckStore) CountItems(ctx context.Context, jobID string) (total int, checked int, err error) {
	err = s.db.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(CASE WHEN status = 'checked' THEN 1 ELSE 0 END), 0)
		FROM link_check_items WHERE job_id = ?`, jobID).Scan(&total, &checked)
	return total, checked, err
}

// RecordResult stores one outcome. The write is guarded by (job_id,
// node_id), so a duplicate result from a racing worker cannot corrupt run 1
// with run 2's findings.
func (s *LinkCheckStore) RecordResult(ctx context.Context, jobID, nodeID string, res organizer.LinkResult) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE link_check_items
		SET status = 'checked', status_class = ?, http_status = ?, error_type = ?,
		    latency_ms = ?, final_url = ?, checked_at = ?
		WHERE job_id = ? AND node_id = ?`,
		res.StatusClass, res.HTTPStatus, res.ErrorType, res.LatencyMS,
		res.FinalURL, res.CheckedAt, jobID, nodeID)
	return err
}

// FinishRun stamps the completion time of a run that checked everything.
func (s *LinkCheckStore) FinishRun(ctx context.Context, jobID string, at time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE link_check_runs SET finished_at = ? WHERE job_id = ?`, formatTime(at), jobID)
	return err
}

// LatestRun returns the newest run of a space with the results it has so
// far. Results are ordered by node id: they arrive out of order, and the
// page must not reshuffle between polls.
func (s *LinkCheckStore) LatestRun(ctx context.Context, space canonical.SpaceID) (organizer.LinkRun, bool, error) {
	var run organizer.LinkRun
	var finished sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT r.job_id, COUNT(i.job_id), NULLIF(r.finished_at, '')
		FROM link_check_runs r
		LEFT JOIN link_check_items i ON i.job_id = r.job_id
		WHERE r.space_id = ?
		GROUP BY r.job_id
		ORDER BY r.created_at DESC, r.job_id DESC
		LIMIT 1`, string(space)).Scan(&run.JobID, &run.Total, &finished)
	if err == sql.ErrNoRows {
		return organizer.LinkRun{}, false, nil
	}
	if err != nil {
		return organizer.LinkRun{}, false, err
	}
	if finished.Valid {
		run.FinishedAt = finished.String
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT node_id, title, url, status_class, http_status, error_type,
		       latency_ms, final_url, checked_at
		FROM link_check_items
		WHERE job_id = ? AND status = 'checked'
		ORDER BY node_id`, run.JobID)
	if err != nil {
		return organizer.LinkRun{}, false, err
	}
	defer rows.Close()
	// Checked results only: the page shows what has been found, and an
	// unchecked bookmark is not a finding.
	run.Results = []organizer.LinkResult{}
	for rows.Next() {
		var nodeID, title, url, statusClass, errorType, finalURL, checkedAt string
		var httpStatus, latency int
		if err := rows.Scan(&nodeID, &title, &url, &statusClass, &httpStatus,
			&errorType, &latency, &finalURL, &checkedAt); err != nil {
			return organizer.LinkRun{}, false, err
		}
		run.Done++
		run.Results = append(run.Results, organizer.LinkResult{
			NodeID:      nodeID,
			Title:       title,
			CheckedURL:  url,
			StatusClass: statusClass,
			HTTPStatus:  httpStatus,
			ErrorType:   errorType,
			LatencyMS:   int64(latency),
			FinalURL:    finalURL,
			CheckedAt:   checkedAt,
		})
	}
	return run, true, rows.Err()
}
