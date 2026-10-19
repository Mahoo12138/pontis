package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/plaza"
)

// PublicationStore persists plaza publications.
type PublicationStore struct {
	db *sql.DB
}

// NewPublicationStore returns a publication store.
func NewPublicationStore(db *sql.DB) *PublicationStore { return &PublicationStore{db: db} }

const publicationColumns = `
	p.id, p.owner_user_id, COALESCE(u.display_name, u.username), p.space_id, p.root_node_id,
	p.title, p.description, p.tags, p.version, p.visibility,
	p.bookmark_count, p.folder_count, p.created_at, p.updated_at, p.tree, COALESCE(p.node_key, '')`

func scanPublication(row interface{ Scan(dest ...any) error }) (plaza.Publication, error) {
	var p plaza.Publication
	var visibility, tagsJSON, createdAt, updatedAt string
	var rootNode any
	var treeJSON string
	if err := row.Scan(&p.ID, &p.OwnerUserID, &p.PublisherName, &p.SpaceID, &rootNode,
		&p.Title, &p.Description, &tagsJSON, &p.Version, &visibility,
		&p.BookmarkCount, &p.FolderCount, &createdAt, &updatedAt, &treeJSON, &p.NodeKey); err != nil {
		return p, err
	}
	if rootNode != nil {
		p.RootNodeID = rootNode.(string)
	}
	_ = json.Unmarshal([]byte(tagsJSON), &p.Tags)
	p.Visibility = plaza.Visibility(visibility)
	p.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	p.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)
	_ = json.Unmarshal([]byte(treeJSON), &p.Tree)
	return p, nil
}

// Insert writes a new publication with its tree snapshot.
func (s *PublicationStore) Insert(ctx context.Context, p plaza.Publication) error {
	tree, err := json.Marshal(p.Tree)
	if err != nil {
		return err
	}
	tags, err := json.Marshal(p.Tags)
	if err != nil {
		return err
	}
	var rootNode any
	if p.RootNodeID != "" {
		rootNode = p.RootNodeID
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO publications (id, slug, owner_user_id, space_id, root_node_id,
			title, description, tags, version, visibility, tree, bookmark_count, folder_count,
			created_at, updated_at, node_key)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		p.ID, p.Slug, p.OwnerUserID, p.SpaceID, rootNode,
		p.Title, p.Description, string(tags), p.Version, string(p.Visibility), string(tree),
		p.BookmarkCount, p.FolderCount,
		formatTime(p.CreatedAt), formatTime(p.UpdatedAt), p.NodeKey)
	return err
}

// Get loads one publication.
func (s *PublicationStore) Get(ctx context.Context, id string) (plaza.Publication, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT `+publicationColumns+`
		FROM publications p LEFT JOIN users u ON u.id = p.owner_user_id
		WHERE p.id = ?`, id)
	p, err := scanPublication(row)
	if err == sql.ErrNoRows {
		return p, plaza.ErrNotFound
	}
	return p, err
}

// ListPlaza returns plaza-visible publications.
func (s *PublicationStore) ListPlaza(ctx context.Context) ([]plaza.Publication, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+publicationColumns+`
		FROM publications p LEFT JOIN users u ON u.id = p.owner_user_id
		WHERE p.visibility = 'plaza'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []plaza.Publication
	for rows.Next() {
		p, err := scanPublication(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListByOwner returns the owner's publications (any visibility).
func (s *PublicationStore) ListByOwner(ctx context.Context, userID string) ([]plaza.Publication, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT `+publicationColumns+`
		FROM publications p LEFT JOIN users u ON u.id = p.owner_user_id
		WHERE p.owner_user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []plaza.Publication
	for rows.Next() {
		p, err := scanPublication(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// UpdateSnapshot rewrites the tree and bumps the version.
func (s *PublicationStore) UpdateSnapshot(ctx context.Context, id string, tree plaza.Node, bookmarks, folders int64, version int, at time.Time) error {
	treeJSON, err := json.Marshal(tree)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE publications SET tree = ?, bookmark_count = ?, folder_count = ?, version = ?, updated_at = ?
		WHERE id = ?`, string(treeJSON), bookmarks, folders, version, formatTime(at), id)
	return err
}

// UpdateMeta patches title/description/visibility.
func (s *PublicationStore) UpdateMeta(ctx context.Context, id string, title, description *string, visibility *plaza.Visibility, at time.Time) error {
	if title != nil {
		if _, err := s.db.ExecContext(ctx, `UPDATE publications SET title = ?, updated_at = ? WHERE id = ?`,
			*title, formatTime(at), id); err != nil {
			return err
		}
	}
	if description != nil {
		if _, err := s.db.ExecContext(ctx, `UPDATE publications SET description = ?, updated_at = ? WHERE id = ?`,
			*description, formatTime(at), id); err != nil {
			return err
		}
	}
	if visibility != nil {
		if _, err := s.db.ExecContext(ctx, `UPDATE publications SET visibility = ?, updated_at = ? WHERE id = ?`,
			string(*visibility), formatTime(at), id); err != nil {
			return err
		}
	}
	return nil
}

// Delete removes the publication. Imported copies in other spaces are
// independent canonical nodes; only the apply records hang off this row, and
// the schema cascades those away.
func (s *PublicationStore) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM publications WHERE id = ?`, id)
	return err
}

// LatestImport returns the consumer's most recent apply of a publication with
// its published-node-to-canonical-node mapping.
func (s *PublicationStore) LatestImport(ctx context.Context, userID, publicationID string) (plaza.Import, map[string]canonical.NodeID, error) {
	var imp plaza.Import
	var parentKey, createdAt, updatedAt string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, publication_id, last_version, target_space_id, target_parent, created_at, updated_at
		FROM publication_imports WHERE user_id = ? AND publication_id = ?
		ORDER BY updated_at DESC, created_at DESC LIMIT 1`, userID, publicationID).
		Scan(&imp.ID, &imp.UserID, &imp.PublicationID, &imp.LastVersion, &imp.SpaceID,
			&parentKey, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return plaza.Import{}, nil, plaza.ErrNotFound
	}
	if err != nil {
		return plaza.Import{}, nil, err
	}
	imp.Parent = plaza.ParentRefFromKey(parentKey)
	imp.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	imp.UpdatedAt, _ = time.Parse(time.RFC3339Nano, updatedAt)

	mappings := map[string]canonical.NodeID{}
	rows, err := s.db.QueryContext(ctx,
		`SELECT publication_node_id, canonical_node_id FROM publication_import_mappings WHERE import_id = ?`, imp.ID)
	if err != nil {
		return plaza.Import{}, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var pubNode, canon string
		if err := rows.Scan(&pubNode, &canon); err != nil {
			return plaza.Import{}, nil, err
		}
		mappings[pubNode] = canonical.NodeID(canon)
	}
	if err := rows.Err(); err != nil {
		return plaza.Import{}, nil, err
	}
	return imp, mappings, nil
}

// SaveImport records one apply and replaces its node mapping wholesale. The
// mapping is rewritten rather than merged: a published node the snapshot no
// longer contains must not keep pointing at a node nobody asked to update.
func (s *PublicationStore) SaveImport(ctx context.Context, imp plaza.Import, mappings map[string]canonical.NodeID) error {
	if imp.ID == "" {
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		imp.ID = id.String()
	}
	parentKey := plaza.ParentKey(imp.Parent)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO publication_imports (id, user_id, publication_id, last_version,
			target_space_id, target_parent, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, publication_id, target_space_id, target_parent) DO UPDATE SET
			last_version = excluded.last_version,
			updated_at = excluded.updated_at`,
		imp.ID, imp.UserID, imp.PublicationID, imp.LastVersion, string(imp.SpaceID),
		parentKey, formatTime(imp.CreatedAt), formatTime(imp.UpdatedAt))
	if err != nil {
		return err
	}

	// The conflict path keeps the row that was already there, so read the id
	// back instead of assuming the one this call generated.
	storedID := imp.ID
	err = s.db.QueryRowContext(ctx, `
		SELECT id FROM publication_imports
		WHERE user_id = ? AND publication_id = ? AND target_space_id = ? AND target_parent = ?`,
		imp.UserID, imp.PublicationID, string(imp.SpaceID), parentKey).Scan(&storedID)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM publication_import_mappings WHERE import_id = ?`, storedID); err != nil {
		return err
	}
	for pubNode, canon := range mappings {
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO publication_import_mappings (import_id, publication_node_id, canonical_node_id)
			VALUES (?, ?, ?)`, storedID, pubNode, string(canon)); err != nil {
			return err
		}
	}
	return nil
}
