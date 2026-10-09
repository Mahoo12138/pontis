package sqlite

import (
	"context"
	"strings"
	"testing"
	"time"

	"pontis/internal/backup"
)

// The catalog must carry the opaque physical key: the display filename is
// built from the space title and two spaces may share one.
func TestBackupCatalogRoundTripsStorageKey(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO sync_spaces (id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at)
		VALUES ('space-1', 'user-1', 'Personal', 1, 0, 0, ?, ?)`,
		time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatalf("seed space: %v", err)
	}

	store := NewBackupStore(db)
	now := time.Now().UTC()
	first := backup.Backup{
		ID: "backup-1", SpaceID: "space-1", Kind: backup.KindManual,
		Filename: "Personal-20240101-101010-manual.json", StorageKey: "01aaa.json",
		SizeBytes: 10, NodeCount: 2, BookmarkCount: 1, CreatedAt: now,
	}
	if err := store.Insert(ctx, first); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, err := store.Get(ctx, first.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.StorageKey != first.StorageKey || got.Filename != first.Filename {
		t.Fatalf("round trip lost the key: %+v", got)
	}
	list, err := store.List(ctx, "space-1")
	if err != nil || len(list) != 1 || list[0].StorageKey != first.StorageKey {
		t.Fatalf("list = %+v, err %v", list, err)
	}

	// Two backups can never point at the same payload.
	dup := first
	dup.ID, dup.StorageKey = "backup-2", "01aaa.json"
	if err := store.Insert(ctx, dup); err == nil ||
		!strings.Contains(strings.ToLower(err.Error()), "unique") {
		t.Fatalf("duplicate storage key err = %v, want uniqueness failure", err)
	}

	// Legacy rows may still carry no key, and they must not collide with each
	// other over it (the partial index ignores them).
	for _, id := range []string{"legacy-1", "legacy-2"} {
		legacy := first
		legacy.ID, legacy.StorageKey, legacy.Filename = id, "", "Personal-20240101-101010-manual.json"
		if err := store.Insert(ctx, legacy); err != nil {
			t.Fatalf("insert legacy %s: %v", id, err)
		}
	}
	loaded, err := store.Get(ctx, "legacy-1")
	if err != nil || loaded.StorageKey != "" {
		t.Fatalf("legacy row = %+v, err %v", loaded, err)
	}
}
