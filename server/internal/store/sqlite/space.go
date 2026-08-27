package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"strings"

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
