package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestOpenPragmas(t *testing.T) {
	db := openTestDB(t)

	for _, pragma := range []struct {
		query   string
		want    any
		failure string
	}{
		{`PRAGMA foreign_keys`, int64(1), "foreign_keys"},
		{`PRAGMA journal_mode`, "wal", "journal_mode"},
		{`PRAGMA synchronous`, int64(2), "synchronous FULL"},
		{`PRAGMA busy_timeout`, int64(5000), "busy_timeout"},
	} {
		var got any
		if err := db.QueryRow(pragma.query).Scan(&got); err != nil {
			t.Fatalf("%s: %v", pragma.failure, err)
		}
		if got != pragma.want {
			t.Errorf("%s = %v, want %v", pragma.failure, got, pragma.want)
		}
	}
}

func TestMigrateAppliesAndIsIdempotent(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	// Second run must be a no-op.
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("Migrate second run: %v", err)
	}

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 14 {
		t.Errorf("schema_migrations count = %d, want 14", count)
	}
}

func TestMigrateSeedsInstanceID(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()

	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	var instanceID string
	err := db.QueryRow(`SELECT value FROM server_meta WHERE key = 'instance_id'`).Scan(&instanceID)
	if err != nil {
		t.Fatalf("instance_id missing: %v", err)
	}
	if instanceID == "" {
		t.Error("instance_id is empty")
	}

	// Re-running must not rotate the instance id.
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("Migrate second run: %v", err)
	}
	var again string
	if err := db.QueryRow(`SELECT value FROM server_meta WHERE key = 'instance_id'`).Scan(&again); err != nil {
		t.Fatal(err)
	}
	if again != instanceID {
		t.Errorf("instance_id changed: %q -> %q", instanceID, again)
	}
}

func TestSystemTablesExist(t *testing.T) {
	db := openTestDB(t)

	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	for _, table := range []string{
		"server_meta", "system_settings", "system_secrets",
		"sync_spaces", "root_slots", "nodes",
	} {
		var name string
		err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name)
		if err != nil {
			t.Errorf("table %s missing: %v", table, err)
		}
	}
}

func TestNodeParentConstraint(t *testing.T) {
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}

	// Seed a space and a root slot.
	if _, err := db.Exec(`INSERT INTO sync_spaces (id, owner_user_id, name, created_at, updated_at)
		VALUES ('s1', 'u1', 'Main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO root_slots (space_id, key, display_name, position, created_at)
		VALUES ('s1', 'main', 'Main', 0, '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}

	// Both parent_id and root_key set must be rejected.
	_, err := db.Exec(`INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
		created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		VALUES ('s1', 'n1', 'bookmark', 'x', 'https://x', 'n0', 'main', 0, 1, 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	if err == nil {
		t.Error("expected CHECK failure when both parent_id and root_key are set")
	}

	// Neither parent_id nor root_key set must be rejected.
	_, err = db.Exec(`INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
		created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		VALUES ('s1', 'n1', 'bookmark', 'x', 'https://x', NULL, NULL, 0, 1, 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	if err == nil {
		t.Error("expected CHECK failure when neither parent_id nor root_key is set")
	}

	// Folder with URL must be rejected.
	_, err = db.Exec(`INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
		created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		VALUES ('s1', 'n1', 'folder', 'x', 'https://x', NULL, 'main', 0, 1, 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	if err == nil {
		t.Error("expected CHECK failure for folder with url")
	}

	// Bookmark without URL must be rejected.
	_, err = db.Exec(`INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
		created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		VALUES ('s1', 'n1', 'bookmark', 'x', NULL, NULL, 'main', 0, 1, 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	if err == nil {
		t.Error("expected CHECK failure for bookmark without url")
	}

	// Valid bookmark under a root slot must succeed.
	_, err = db.Exec(`INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
		created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		VALUES ('s1', 'n1', 'bookmark', 'x', 'https://x', NULL, 'main', 0, 1, 1, 1, 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	if err != nil {
		t.Errorf("valid node rejected: %v", err)
	}
}
