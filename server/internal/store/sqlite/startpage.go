package sqlite

import (
	"context"
	"database/sql"
	"fmt"

	"pontis/internal/canonical"
	"pontis/internal/startpage"
)

// StartPageStore reads the one folder subtree a start page displays. It holds
// no table of its own: the projection is authorized by a device's existing
// binding, so it needs no persisted state beyond the canonical tree (§11.2).
type StartPageStore struct {
	db *sql.DB
}

// NewStartPageStore returns a start-page read store.
func NewStartPageStore(db *sql.DB) *StartPageStore { return &StartPageStore{db: db} }

// Space loads one space, or canonical.ErrSpaceNotFound.
func (s *StartPageStore) Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	return scanSpace(s.db.QueryRowContext(ctx, spaceColumns, string(id)))
}

// Node loads one node, or canonical.ErrNodeNotFound.
func (s *StartPageStore) Node(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) (canonical.Node, error) {
	return scanNode(s.db.QueryRowContext(ctx, nodeColumns+` FROM nodes WHERE space_id = ? AND id = ?`,
		string(space), string(id)))
}

// subtreeColumns lists the node columns with the alias the descendant join
// needs. The shared nodeColumns cannot be reused here: the recursive side of
// the join also exposes an `id`, which would make the bare name ambiguous.
const subtreeColumns = `
	WITH RECURSIVE sub(id, depth) AS (
		SELECT id, 0 FROM nodes WHERE space_id = ? AND id = ?
		UNION ALL
		SELECT n.id, sub.depth + 1 FROM nodes n JOIN sub ON n.parent_id = sub.id
		WHERE n.space_id = ?
	)
	SELECT n.space_id, n.id, n.type, n.title, n.url, n.parent_id, n.root_key, n.position,
	       n.created_revision, n.title_revision, n.url_revision, n.structure_revision,
	       n.created_at, n.updated_at
	FROM sub JOIN nodes n ON n.space_id = ? AND n.id = sub.id
	WHERE sub.depth > 0
	ORDER BY n.position, n.id
	LIMIT ?`

// Subtree reads the source node and its descendants together with the space
// row that dates them.
//
// The three reads share one transaction for the same reason a backup does
// (see LibraryStore.SnapshotTree): three plain queries can straddle another
// request's commit, and the tree they describe then never existed at any
// instant. A start-page snapshot is cached and presented as "the folder as it
// is", so a description with no such moment is not a detail — it is a wrong
// page the client cannot detect.
func (s *StartPageStore) Subtree(ctx context.Context, space canonical.SpaceID,
	folder canonical.NodeID, budget int) (startpage.Subtree, error) {

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return startpage.Subtree{}, fmt.Errorf("begin source subtree: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	sp, err := scanSpace(tx.QueryRowContext(ctx, spaceColumns, string(space)))
	if err != nil {
		return startpage.Subtree{}, err
	}
	source, err := scanNode(tx.QueryRowContext(ctx, nodeColumns+` FROM nodes WHERE space_id = ? AND id = ?`,
		string(space), string(folder)))
	if err != nil {
		return startpage.Subtree{}, err
	}
	// budget+1 rows: the caller has to be able to tell "exactly full" from
	// "over the line", and a source reported over the line must not be
	// rendered as if it had been read whole.
	rows, err := tx.QueryContext(ctx, subtreeColumns,
		string(space), string(folder), string(space), string(space), budget+1)
	if err != nil {
		return startpage.Subtree{}, fmt.Errorf("read source subtree: %w", err)
	}
	defer rows.Close()

	var nodes []canonical.Node
	for rows.Next() {
		n, err := scanNode(rows)
		if err != nil {
			return startpage.Subtree{}, err
		}
		nodes = append(nodes, n)
	}
	if err := rows.Err(); err != nil {
		return startpage.Subtree{}, err
	}
	if err := tx.Commit(); err != nil {
		return startpage.Subtree{}, err
	}
	return startpage.Subtree{Space: sp, Source: source, Nodes: nodes}, nil
}
