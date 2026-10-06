package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"pontis/internal/backup"
)

// BackupStore implements the backup catalog and the baseline replacement.
type BackupStore struct {
	db *sql.DB
}

// NewBackupStore returns a backup store.
func NewBackupStore(db *sql.DB) *BackupStore { return &BackupStore{db: db} }

func scanBackup(row interface{ Scan(dest ...any) error }) (backup.Backup, error) {
	var b backup.Backup
	var kind, createdAt string
	var protected int
	if err := row.Scan(&b.ID, &b.SpaceID, &kind, &b.Filename, &b.SizeBytes,
		&b.NodeCount, &b.BookmarkCount, &protected, &createdAt); err != nil {
		return b, err
	}
	b.Kind = backup.Kind(kind)
	b.Protected = protected != 0
	b.CreatedAt, _ = time.Parse(time.RFC3339Nano, createdAt)
	return b, nil
}

// Insert writes a catalog row.
func (s *BackupStore) Insert(ctx context.Context, b backup.Backup) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO space_backups (id, space_id, kind, filename, size_bytes, node_count, bookmark_count, protected, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		b.ID, b.SpaceID, string(b.Kind), b.Filename, b.SizeBytes,
		b.NodeCount, b.BookmarkCount, boolInt(b.Protected), formatTime(b.CreatedAt))
	return err
}

// List returns the space's catalog rows.
func (s *BackupStore) List(ctx context.Context, spaceID string) ([]backup.Backup, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, space_id, kind, filename, size_bytes, node_count, bookmark_count, protected, created_at
		FROM space_backups WHERE space_id = ? ORDER BY created_at DESC, id`, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []backup.Backup
	for rows.Next() {
		b, err := scanBackup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// Get loads one catalog row.
func (s *BackupStore) Get(ctx context.Context, id string) (backup.Backup, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, space_id, kind, filename, size_bytes, node_count, bookmark_count, protected, created_at
		FROM space_backups WHERE id = ?`, id)
	b, err := scanBackup(row)
	if err == sql.ErrNoRows {
		return b, backup.ErrNotFound
	}
	return b, err
}

// Delete removes a catalog row.
func (s *BackupStore) Delete(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM space_backups WHERE id = ?`, id)
	return err
}

// SetProtected toggles the retention exemption.
func (s *BackupStore) SetProtected(ctx context.Context, id string, protected bool) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE space_backups SET protected = ? WHERE id = ?`, boolInt(protected), id)
	return err
}

// ReplaceBaseline atomically swaps the space's canonical tree for the
// snapshot content: canonical UUIDs are preserved, revisions restart at
// the new epoch's baseline, journal/tombstones/receipts are cleared and
// every binding returns to pending_initial (doc 14 §12).
func (s *BackupStore) ReplaceBaseline(ctx context.Context, spaceID string, newEpoch int64, slots []backup.SlotDTO, nodes []backup.NodeDTO) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Leaf-first wipe of the whole tree: the nodes FK is RESTRICT, so
	// parents may only disappear after their children.
	for {
		res, err := tx.ExecContext(ctx, `
			DELETE FROM nodes WHERE space_id = ? AND id NOT IN
				(SELECT parent_id FROM nodes WHERE space_id = ? AND parent_id IS NOT NULL)`,
			spaceID, spaceID)
		if err != nil {
			return fmt.Errorf("backup: clear nodes: %w", err)
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			break
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM root_slots WHERE space_id = ?`, spaceID); err != nil {
		return fmt.Errorf("backup: clear root slots: %w", err)
	}
	// Sync history of old epochs no longer participates in correctness.
	for _, stmt := range []string{
		`DELETE FROM journal WHERE space_id = ?`,
		`DELETE FROM tombstones WHERE space_id = ?`,
		`DELETE FROM client_operation_receipts WHERE binding_id IN
			(SELECT id FROM device_space_bindings WHERE space_id = ?)`,
	} {
		if _, err := tx.ExecContext(ctx, stmt, spaceID); err != nil {
			return fmt.Errorf("backup: clear history: %w", err)
		}
	}

	for _, slot := range slots {
		createdAt, _ := time.Parse(time.RFC3339Nano, slot.CreatedAt)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO root_slots (space_id, key, display_name, position, created_at)
			VALUES (?, ?, ?, ?, ?)`,
			spaceID, slot.Key, slot.DisplayName, slot.Position, formatTime(createdAt)); err != nil {
			return fmt.Errorf("backup: insert root slot: %w", err)
		}
	}

	for _, n := range nodes {
		url := any(nil)
		if n.URL != nil {
			url = *n.URL
		}
		parentID := any(nil)
		rootKey := any(nil)
		if n.ParentID != nil {
			parentID = *n.ParentID
		} else if n.RootKey != nil {
			rootKey = *n.RootKey
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
				created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?)`,
			spaceID, n.ID, n.Type, n.Title, url, parentID, rootKey, n.Position, n.CreatedAt, n.UpdatedAt); err != nil {
			return fmt.Errorf("backup: insert node: %w", err)
		}
	}

	// Epoch bump and revision baseline.
	if _, err := tx.ExecContext(ctx, `
		UPDATE sync_spaces SET epoch = ?, current_revision = 0, journal_floor_revision = 0, updated_at = ?
		WHERE id = ?`, newEpoch, formatTime(time.Now().UTC()), spaceID); err != nil {
		return fmt.Errorf("backup: bump epoch: %w", err)
	}
	// Every binding resyncs against the new baseline.
	if _, err := tx.ExecContext(ctx, `
		UPDATE device_space_bindings
		SET epoch = ?, applied_revision = 0, received_revision = 0, state = 'pending_initial', updated_at = ?
		WHERE space_id = ?`, newEpoch, formatTime(time.Now().UTC()), spaceID); err != nil {
		return fmt.Errorf("backup: reset bindings: %w", err)
	}

	return tx.Commit()
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
