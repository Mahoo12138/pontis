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
	if count != 1 {
		t.Errorf("schema_migrations count = %d, want 1", count)
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

	for _, table := range []string{"server_meta", "system_settings", "system_secrets"} {
		var name string
		err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name)
		if err != nil {
			t.Errorf("table %s missing: %v", table, err)
		}
	}
}
