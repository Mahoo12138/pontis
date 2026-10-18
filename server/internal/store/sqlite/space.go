package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/space"
)

// SpaceStore implements space.Store.
type SpaceStore struct {
	db *sql.DB
}

// NewSpaceStore wraps an opened database as a space store.
func NewSpaceStore(db *sql.DB) *SpaceStore { return &SpaceStore{db: db} }

// CreateSpace inserts the space and its default root slot atomically.
func (s *SpaceStore) CreateSpace(ctx context.Context, sp canonical.SyncSpace, rootDisplayName string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO sync_spaces (id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at)
		VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
		string(sp.ID), string(sp.OwnerUserID), sp.Name, sp.Epoch,
		formatTime(sp.CreatedAt), formatTime(sp.UpdatedAt)); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return space.ErrTooManySpaces // unreachable in practice; defensive
		}
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO root_slots (space_id, key, display_name, position, created_at)
		VALUES (?, ?, ?, 0, ?)`,
		string(sp.ID), space.DefaultRootKey, rootDisplayName, formatTime(sp.CreatedAt)); err != nil {
		return err
	}
	return tx.Commit()
}

// ListByOwner returns the owner's spaces ordered by creation.
func (s *SpaceStore) ListByOwner(ctx context.Context, owner canonical.UserID) ([]canonical.SyncSpace, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at
		FROM sync_spaces WHERE owner_user_id = ? ORDER BY created_at, id`, string(owner))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []canonical.SyncSpace
	for rows.Next() {
		sp, err := scanSpace(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, sp)
	}
	return out, rows.Err()
}

// CountByOwner returns how many spaces the owner has.
func (s *SpaceStore) CountByOwner(ctx context.Context, owner canonical.UserID) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sync_spaces WHERE owner_user_id = ?`, string(owner)).Scan(&n)
	return n, err
}

// RenameSpace sets the display name. The owner is part of the predicate so a
// guessed id cannot rename someone else's space.
func (s *SpaceStore) RenameSpace(
	ctx context.Context,
	owner canonical.UserID,
	id canonical.SpaceID,
	name string,
	at time.Time,
) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE sync_spaces SET name = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?`,
		name, formatTime(at), string(id), string(owner))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// spaceBlockers count the rows that keep a space from being deleted. Every one
// of these tables references sync_spaces(id) with no ON DELETE clause, so the
// database would refuse the delete anyway; counting them first turns that
// refusal into a reason the client can show.
var spaceBlockers = []string{
	`SELECT COUNT(*) FROM nodes WHERE space_id = ?`,
	`SELECT COUNT(*) FROM device_space_bindings WHERE space_id = ?`,
	`SELECT COUNT(*) FROM space_backups WHERE space_id = ?`,
	`SELECT COUNT(*) FROM publications WHERE space_id = ?`,
	`SELECT COUNT(*) FROM schedules WHERE space_id = ?`,
}

// DeleteSpace removes an empty space and its root slots, clearing it from the
// owner's default first. It reports false when the id is not the owner's, and
// returns ErrSpaceNotEmpty without touching anything when content or a binding
// still refers to it.
func (s *SpaceStore) DeleteSpace(ctx context.Context, owner canonical.UserID, id canonical.SpaceID) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	var mine int64
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sync_spaces WHERE id = ? AND owner_user_id = ?`,
		string(id), string(owner)).Scan(&mine); err != nil {
		return false, err
	}
	if mine == 0 {
		return false, nil
	}

	for _, query := range spaceBlockers {
		var n int64
		if err := tx.QueryRowContext(ctx, query, string(id)).Scan(&n); err != nil {
			return false, err
		}
		if n > 0 {
			return false, space.ErrSpaceNotEmpty
		}
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET default_space_id = NULL WHERE default_space_id = ?`, string(id)); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM root_slots WHERE space_id = ?`, string(id)); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sync_spaces WHERE id = ?`, string(id)); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// InstanceID reads the instance identifier seeded by migrations.
func InstanceID(ctx context.Context, db *sql.DB) (string, error) {
	var id string
	err := db.QueryRowContext(ctx,
		`SELECT value FROM server_meta WHERE key = 'instance_id'`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}
