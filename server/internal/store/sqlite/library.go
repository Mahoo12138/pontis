package sqlite

import (
	"context"
	"database/sql"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/library"
)

// LibraryStore implements library.Store on top of SQLite.
type LibraryStore struct {
	db *sql.DB
}

// NewLibraryStore wraps an opened database as a library store.
func NewLibraryStore(db *sql.DB) *LibraryStore {
	return &LibraryStore{db: db}
}

// BeginTx starts a canonical write transaction for library mutations.
func (s *LibraryStore) BeginTx(ctx context.Context) (canonical.Tx, error) {
	return NewStore(s.db).BeginTx(ctx)
}

// LoadSpace loads a sync space.
func (s *LibraryStore) LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	return scanSpace(s.db.QueryRowContext(ctx, spaceColumns, string(id)))
}

// ListNodes returns every node of the space ordered by tree position.
func (s *LibraryStore) ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	rows, err := s.db.QueryContext(ctx, nodeColumns+` FROM nodes WHERE space_id = ? ORDER BY created_revision, id`, string(space))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var nodes []canonical.Node
	for rows.Next() {
		node, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		nodes = append(nodes, node)
	}
	return nodes, rows.Err()
}

// ListRootSlots returns the space's root slots ordered by position.
func (s *LibraryStore) ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT space_id, key, display_name, position, created_at
		FROM root_slots WHERE space_id = ? ORDER BY position, key`, string(space))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var slots []canonical.RootSlot
	for rows.Next() {
		var slot canonical.RootSlot
		var createdAt string
		if err := rows.Scan(&slot.SpaceID, &slot.Key, &slot.DisplayName, &slot.Position, &createdAt); err != nil {
			return nil, err
		}
		slot.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		slots = append(slots, slot)
	}
	return slots, rows.Err()
}

// ListRecentJournal returns the newest journal entries of the space's
// current epoch, newest first.
func (s *LibraryStore) ListRecentJournal(ctx context.Context, space canonical.SpaceID, limit int) ([]library.JournalRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT j.epoch, j.revision, j.change_type, COALESCE(j.node_id, ''), j.payload,
		       COALESCE(j.origin_type, ''), COALESCE(j.origin_user_id, ''), COALESCE(j.origin_device_id, ''), j.created_at
		FROM journal j
		JOIN sync_spaces sp ON sp.id = j.space_id AND sp.epoch = j.epoch
		WHERE j.space_id = ?
		ORDER BY j.revision DESC
		LIMIT ?`, string(space), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []library.JournalRow
	for rows.Next() {
		var row library.JournalRow
		var createdAt string
		if err := rows.Scan(&row.Epoch, &row.Revision, &row.Type, &row.NodeID, &row.PayloadJSON,
			&row.OriginType, &row.OriginUserID, &row.OriginDeviceID, &createdAt); err != nil {
			return nil, err
		}
		row.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
		out = append(out, row)
	}
	return out, rows.Err()
}

// DeviceName resolves a device display name.
func (s *LibraryStore) DeviceName(ctx context.Context, deviceID string) (string, error) {
	var name string
	err := s.db.QueryRowContext(ctx, `SELECT name FROM devices WHERE id = ?`, deviceID).Scan(&name)
	if err != nil {
		return "", err
	}
	return name, nil
}

// Username resolves an account display name (fallback username).
func (s *LibraryStore) Username(ctx context.Context, userID string) (string, error) {
	var name string
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(NULLIF(display_name, ''), username) FROM users WHERE id = ?`, userID).Scan(&name)
	if err != nil {
		return "", err
	}
	return name, nil
}
