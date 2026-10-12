package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/startpage"
)

// StartPageStore persists start-page source grants and reads the one folder
// subtree a source points at. It shares the process's *sql.DB with every
// other store; it holds no write path into the canonical tree.
type StartPageStore struct {
	db *sql.DB
}

// NewStartPageStore returns a start-page store.
func NewStartPageStore(db *sql.DB) *StartPageStore { return &StartPageStore{db: db} }

const grantColumns = `
	SELECT id, device_id, user_id, space_id, folder_id, version,
	       created_at, updated_at, revoked_at
	FROM start_page_grants`

func scanGrant(row interface{ Scan(dest ...any) error }) (startpage.Grant, error) {
	var g startpage.Grant
	var createdAt, updatedAt string
	var revokedAt sql.NullString
	err := row.Scan(&g.ID, &g.DeviceID, &g.UserID, &g.SpaceID, &g.FolderID, &g.Version,
		&createdAt, &updatedAt, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return startpage.Grant{}, startpage.ErrGrantNotFound
	}
	if err != nil {
		return startpage.Grant{}, err
	}
	g.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	g.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
	if revokedAt.Valid {
		g.RevokedAt, _ = time.Parse(time.RFC3339Nano, revokedAt.String)
	}
	return g, nil
}

// InsertGrant writes a new active grant.
func (s *StartPageStore) InsertGrant(ctx context.Context, g startpage.Grant) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO start_page_grants
			(id, device_id, user_id, space_id, folder_id, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		g.ID, g.DeviceID, string(g.UserID), string(g.SpaceID), string(g.FolderID), g.Version,
		formatTime(g.CreatedAt), formatTime(g.UpdatedAt))
	if err != nil {
		return fmt.Errorf("insert start-page grant: %w", err)
	}
	return nil
}

// RepointGrant moves a grant onto another folder and bumps its version, so a
// client holding the previous source's snapshot cannot read it as current.
func (s *StartPageStore) RepointGrant(ctx context.Context, id string,
	space canonical.SpaceID, folder canonical.NodeID, at time.Time) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE start_page_grants
		SET space_id = ?, folder_id = ?, version = version + 1, updated_at = ?
		WHERE id = ? AND revoked_at IS NULL`,
		string(space), string(folder), formatTime(at), id)
	if err != nil {
		return fmt.Errorf("repoint start-page grant: %w", err)
	}
	// The grant the caller read may have been revoked between the read and
	// this write. Silently bumping a revoked row would resurrect it.
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return startpage.ErrGrantNotFound
	}
	return nil
}

// RevokeGrant withdraws a grant.
func (s *StartPageStore) RevokeGrant(ctx context.Context, id string, at time.Time) error {
	if _, err := s.db.ExecContext(ctx,
		`UPDATE start_page_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
		formatTime(at), id); err != nil {
		return fmt.Errorf("revoke start-page grant: %w", err)
	}
	return nil
}

// GetGrant loads one grant.
func (s *StartPageStore) GetGrant(ctx context.Context, id string) (startpage.Grant, error) {
	return scanGrant(s.db.QueryRowContext(ctx, grantColumns+` WHERE id = ?`, id))
}

// ActiveGrant loads a device's live grant, or startpage.ErrGrantNotFound.
func (s *StartPageStore) ActiveGrant(ctx context.Context, deviceID string) (startpage.Grant, error) {
	return scanGrant(s.db.QueryRowContext(ctx, grantColumns+` WHERE device_id = ? AND revoked_at IS NULL`, deviceID))
}

// ListGrants returns the account's grants newest source first.
func (s *StartPageStore) ListGrants(ctx context.Context, user canonical.UserID) ([]startpage.Grant, error) {
	rows, err := s.db.QueryContext(ctx, grantColumns+` WHERE user_id = ? ORDER BY updated_at DESC, id`, string(user))
	if err != nil {
		return nil, fmt.Errorf("list start-page grants: %w", err)
	}
	defer rows.Close()

	var out []startpage.Grant
	for rows.Next() {
		g, err := scanGrant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// DeviceOwner resolves whose device this is. A missing device and a foreign
// one answer alike through the service, so this says only what the row says.
func (s *StartPageStore) DeviceOwner(ctx context.Context, deviceID string) (canonical.UserID, error) {
	var owner canonical.UserID
	err := s.db.QueryRowContext(ctx, `SELECT owner_user_id FROM devices WHERE id = ?`, deviceID).Scan(&owner)
	if errors.Is(err, sql.ErrNoRows) {
		return "", startpage.ErrDeviceNotFound
	}
	if err != nil {
		return "", fmt.Errorf("load device owner: %w", err)
	}
	return owner, nil
}

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
