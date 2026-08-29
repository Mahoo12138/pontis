package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/library"
)

// LibraryStore provides the read side of the canonical tree for the web
// API (explorer listing, activity). Writes always go through the
// canonical executor inside a canonical transaction.
type LibraryStore struct {
	db *sql.DB
}

// NewLibraryStore returns a canonical read store.
func NewLibraryStore(db *sql.DB) *LibraryStore { return &LibraryStore{db: db} }

// GetSpace loads one space or returns canonical.ErrSpaceNotFound.
func (s *LibraryStore) GetSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at
		FROM sync_spaces WHERE id = ?`, string(id))
	return scanSpace(row)
}

// ListNodes returns every node of the space; the explorer builds the tree.
func (s *LibraryStore) ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT space_id, id, type, title, url, parent_id, root_key, position,
		       created_revision, title_revision, url_revision, structure_revision,
		       created_at, updated_at
		FROM nodes WHERE space_id = ?
		ORDER BY position, id`, string(space))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []canonical.Node
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// GetNode loads one node or returns canonical.ErrNodeNotFound.
func (s *LibraryStore) GetNode(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) (canonical.Node, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT space_id, id, type, title, url, parent_id, root_key, position,
		       created_revision, title_revision, url_revision, structure_revision,
		       created_at, updated_at
		FROM nodes WHERE space_id = ? AND id = ?`, string(space), string(id))
	return scanNode(row)
}

// ListRootSlots returns the space's root slots ordered by position.
func (s *LibraryStore) ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT space_id, key, display_name, position, created_at
		FROM root_slots WHERE space_id = ?
		ORDER BY position, key`, string(space))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []canonical.RootSlot
	for rows.Next() {
		var slot canonical.RootSlot
		var createdAt string
		if err := rows.Scan(&slot.SpaceID, &slot.Key, &slot.DisplayName, &slot.Position, &createdAt); err != nil {
			return nil, err
		}
		slot.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		out = append(out, slot)
	}
	return out, rows.Err()
}

// JournalRow is one committed canonical change with its origin; the wire
// type lives in the library package (store constructs domain types).
type JournalRow = library.JournalRow

// ListJournal returns the space's newest journal rows (current epoch)
// ordered by descending revision.
func (s *LibraryStore) ListJournal(ctx context.Context, space canonical.SpaceID, epoch int64, limit int) ([]JournalRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT revision, change_type, COALESCE(node_id, ''), payload,
		       origin_type, COALESCE(origin_user_id, ''), COALESCE(origin_device_id, ''), created_at
		FROM journal
		WHERE space_id = ? AND epoch = ?
		ORDER BY revision DESC
		LIMIT ?`, string(space), epoch, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []JournalRow
	for rows.Next() {
		var r JournalRow
		if err := rows.Scan(&r.Revision, &r.ChangeType, &r.NodeID, &r.PayloadJSON,
			&r.OriginType, &r.OriginUserID, &r.OriginDeviceID, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeviceName returns the device's display name, empty when unknown.
func (s *LibraryStore) DeviceName(ctx context.Context, id string) (string, error) {
	if id == "" {
		return "", nil
	}
	var name string
	err := s.db.QueryRowContext(ctx, `SELECT name FROM devices WHERE id = ?`, id).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return name, err
}

// UserName returns the account's display name, empty when unknown.
func (s *LibraryStore) UserName(ctx context.Context, id string) (string, error) {
	if id == "" {
		return "", nil
	}
	var name string
	err := s.db.QueryRowContext(ctx, `SELECT display_name FROM users WHERE id = ?`, id).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return name, err
}
