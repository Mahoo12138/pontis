package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
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

// ListChangeSets returns the space's ChangeSets (activity history, doc 15)
// newest first; delegated to the changeset store over the same database.
func (s *LibraryStore) ListChangeSets(ctx context.Context, space canonical.SpaceID, limit int) ([]changeset.ChangeSet, error) {
	return NewChangeSetStore(s.db).ListChangeSets(ctx, space, limit)
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

// Space is an alias of GetSpace matching the backup TreeSource contract.
func (s *LibraryStore) Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	return s.GetSpace(ctx, id)
}

// ListSpaceIDs returns every space id (system maintenance scope).
func (s *LibraryStore) ListSpaceIDs(ctx context.Context) ([]string, error) {
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
