package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pontis/internal/canonical"
)

// Store implements canonical.Store on top of SQLite.
type Store struct {
	db *sql.DB
}

// NewStore wraps an opened database as a canonical store.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// BeginTx starts a canonical write transaction.
func (s *Store) BeginTx(ctx context.Context) (canonical.Tx, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin canonical tx: %w", err)
	}
	return &canonTx{tx: tx}, nil
}

type canonTx struct {
	tx *sql.Tx
}

func (t *canonTx) Commit(ctx context.Context) error   { return t.tx.Commit() }
func (t *canonTx) Rollback(ctx context.Context) error { return t.tx.Rollback() }

func (t *canonTx) LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	var s canonical.SyncSpace
	var createdAt, updatedAt string
	err := t.tx.QueryRowContext(ctx, `
		SELECT id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at
		FROM sync_spaces WHERE id = ?`, string(id)).
		Scan(&s.ID, &s.OwnerUserID, &s.Name, &s.Epoch, &s.CurrentRevision, &s.JournalFloorRevision, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return canonical.SyncSpace{}, canonical.ErrSpaceNotFound
	}
	if err != nil {
		return canonical.SyncSpace{}, err
	}
	s.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	s.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
	return s, nil
}

func (t *canonTx) LoadNode(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) (canonical.Node, error) {
	return scanNode(t.tx.QueryRowContext(ctx, nodeColumns+` FROM nodes WHERE space_id = ? AND id = ?`,
		string(space), string(id)))
}

func (t *canonTx) LoadRootSlot(ctx context.Context, space canonical.SpaceID, key string) (canonical.RootSlot, error) {
	var s canonical.RootSlot
	var createdAt string
	err := t.tx.QueryRowContext(ctx, `
		SELECT space_id, key, display_name, position, created_at
		FROM root_slots WHERE space_id = ? AND key = ?`, string(space), key).
		Scan(&s.SpaceID, &s.Key, &s.DisplayName, &s.Position, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return canonical.RootSlot{}, canonical.ErrRootSlotNotFound
	}
	if err != nil {
		return canonical.RootSlot{}, err
	}
	s.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return s, nil
}

const nodeColumns = `
	SELECT space_id, id, type, title, url, parent_id, root_key, position,
	       created_revision, title_revision, url_revision, structure_revision,
	       created_at, updated_at`

func scanNode(row interface{ Scan(dest ...any) error }) (canonical.Node, error) {
	var n canonical.Node
	var typ, url, parentID, rootKey, createdAt, updatedAt sql.NullString
	err := row.Scan(&n.SpaceID, &n.ID, &typ, &n.Title, &url, &parentID, &rootKey, &n.Position,
		&n.CreatedRevision, &n.TitleRevision, &n.URLRevision, &n.StructureRevision,
		&createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return canonical.Node{}, canonical.ErrNodeNotFound
	}
	if err != nil {
		return canonical.Node{}, err
	}
	n.Type = canonical.NodeType(typ.String)
	n.URL = url.String
	if parentID.Valid {
		n.Parent = canonical.NewNodeParent(canonical.NodeID(parentID.String))
	} else {
		n.Parent = canonical.NewRootParent(rootKey.String)
	}
	n.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt.String)
	n.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt.String)
	return n, nil
}

func (t *canonTx) Children(ctx context.Context, space canonical.SpaceID, parent canonical.ParentRef) ([]canonical.Node, error) {
	var query string
	var args []any
	if parent.Type == canonical.ParentTypeNode {
		query = nodeColumns + ` FROM nodes WHERE space_id = ? AND parent_id = ? ORDER BY position, id`
		args = []any{string(space), string(parent.NodeID)}
	} else {
		query = nodeColumns + ` FROM nodes WHERE space_id = ? AND root_key = ? ORDER BY position, id`
		args = []any{string(space), parent.RootKey}
	}

	rows, err := t.tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var children []canonical.Node
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return nil, err
		}
		children = append(children, n)
	}
	return children, rows.Err()
}

func (t *canonTx) IsAncestorOrSelf(ctx context.Context, space canonical.SpaceID, ancestor, node canonical.NodeID) (bool, error) {
	// Walk up from node collecting itself and all ancestors, then check
	// whether ancestor is among them.
	var found bool
	err := t.tx.QueryRowContext(ctx, `
		WITH RECURSIVE up(node_id) AS (
			SELECT id FROM nodes WHERE space_id = ? AND id = ?
			UNION ALL
			SELECT n.parent_id FROM nodes n JOIN up ON n.id = up.node_id
			WHERE n.space_id = ? AND n.parent_id IS NOT NULL
		)
		SELECT EXISTS(SELECT 1 FROM up WHERE node_id = ?)`,
		string(space), string(node), string(space), string(ancestor)).
		Scan(&found)
	return found, err
}

func (t *canonTx) AllocateRevision(ctx context.Context, space canonical.SpaceID) (int64, error) {
	var rev int64
	err := t.tx.QueryRowContext(ctx, `
		UPDATE sync_spaces
		SET current_revision = current_revision + 1, updated_at = ?
		WHERE id = ?
		RETURNING current_revision`,
		formatTime(time.Now().UTC()), string(space)).
		Scan(&rev)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, canonical.ErrSpaceNotFound
	}
	return rev, err
}

func (t *canonTx) InsertNode(ctx context.Context, n canonical.Node) error {
	var parentID, rootKey any
	if n.Parent.Type == canonical.ParentTypeNode {
		parentID = string(n.Parent.NodeID)
	} else {
		rootKey = n.Parent.RootKey
	}
	var url any
	if n.URL != "" {
		url = n.URL
	}
	_, err := t.tx.ExecContext(ctx, `
		INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
			created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		string(n.SpaceID), string(n.ID), string(n.Type), n.Title, url, parentID, rootKey, n.Position,
		n.CreatedRevision, n.TitleRevision, n.URLRevision, n.StructureRevision,
		formatTime(n.CreatedAt), formatTime(n.UpdatedAt))
	return err
}

func (t *canonTx) SetNodeTitle(ctx context.Context, space canonical.SpaceID, id canonical.NodeID, title string, revision int64, updatedAt time.Time) error {
	_, err := t.tx.ExecContext(ctx, `
		UPDATE nodes SET title = ?, title_revision = ?, updated_at = ?
		WHERE space_id = ? AND id = ?`,
		title, revision, formatTime(updatedAt), string(space), string(id))
	return err
}

func (t *canonTx) SetNodeURL(ctx context.Context, space canonical.SpaceID, id canonical.NodeID, url string, revision int64, updatedAt time.Time) error {
	_, err := t.tx.ExecContext(ctx, `
		UPDATE nodes SET url = ?, url_revision = ?, updated_at = ?
		WHERE space_id = ? AND id = ?`,
		url, revision, formatTime(updatedAt), string(space), string(id))
	return err
}

func (t *canonTx) SetNodeParent(ctx context.Context, space canonical.SpaceID, id canonical.NodeID, parent canonical.ParentRef, position int64, revision int64, updatedAt time.Time) error {
	var parentID, rootKey any
	if parent.Type == canonical.ParentTypeNode {
		parentID = string(parent.NodeID)
	} else {
		rootKey = parent.RootKey
	}
	_, err := t.tx.ExecContext(ctx, `
		UPDATE nodes SET parent_id = ?, root_key = ?, position = ?, structure_revision = ?, updated_at = ?
		WHERE space_id = ? AND id = ?`,
		parentID, rootKey, position, revision, formatTime(updatedAt), string(space), string(id))
	return err
}

func (t *canonTx) SetSiblingPositions(ctx context.Context, space canonical.SpaceID, positions map[canonical.NodeID]int64) error {
	for id, pos := range positions {
		if _, err := t.tx.ExecContext(ctx, `
			UPDATE nodes SET position = ? WHERE space_id = ? AND id = ?`,
			pos, string(space), string(id)); err != nil {
			return err
		}
	}
	return nil
}

func (t *canonTx) SubtreeIDs(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) ([]canonical.NodeID, error) {
	rows, err := t.tx.QueryContext(ctx, `
		WITH RECURSIVE sub(id, depth) AS (
			SELECT id, 0 FROM nodes WHERE space_id = ? AND id = ?
			UNION ALL
			SELECT n.id, sub.depth + 1 FROM nodes n JOIN sub ON n.parent_id = sub.id
			WHERE n.space_id = ? AND n.parent_id IS NOT NULL
		)
		SELECT id FROM sub ORDER BY depth DESC`,
		string(space), string(id), string(space))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []canonical.NodeID
	for rows.Next() {
		var nodeID canonical.NodeID
		if err := rows.Scan(&nodeID); err != nil {
			return nil, err
		}
		ids = append(ids, nodeID)
	}
	return ids, rows.Err()
}

func (t *canonTx) DeleteNodes(ctx context.Context, space canonical.SpaceID, ids []canonical.NodeID) error {
	// Caller passes ids deepest-first so the parent FK RESTRICT never fires.
	for _, id := range ids {
		if _, err := t.tx.ExecContext(ctx, `
			DELETE FROM nodes WHERE space_id = ? AND id = ?`,
			string(space), string(id)); err != nil {
			return err
		}
	}
	return nil
}

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
