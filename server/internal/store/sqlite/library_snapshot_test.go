package sqlite

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"pontis/internal/canonical"
)

// The capture behind a backup or an export needs the space, its nodes and its
// root slots as one instant. Read separately, the three statements can straddle
// somebody else's commit, and the payload they then describe never existed —
// which is exactly what the restore validator refuses, after the catalog has
// already promised the file is a backup.
func TestSnapshotTreeReadsSpaceNodesAndSlotsTogether(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	seedTree(t, db)

	library := NewLibraryStore(db)
	space, nodes, slots, err := library.SnapshotTree(ctx, "space-1")
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if space.ID != "space-1" || space.Name != "Personal" {
		t.Fatalf("space = %+v", space)
	}
	if len(nodes) != 2 || len(slots) != 1 {
		t.Fatalf("snapshot = %d nodes, %d slots, want 2 and 1", len(nodes), len(slots))
	}
	// The folder has to come back too: a payload that holds the child without
	// its parent is the torn read this method exists to prevent.
	byID := map[canonical.NodeID]canonical.Node{}
	for _, n := range nodes {
		byID[n.ID] = n
	}
	child, ok := byID["node-child"]
	if !ok {
		t.Fatalf("child missing from %v", nodes)
	}
	if child.Parent.Type != canonical.ParentTypeNode || child.Parent.NodeID != "node-folder" {
		t.Fatalf("child parent = %+v, want node-folder", child.Parent)
	}
	if byID["node-folder"].Type != canonical.NodeTypeFolder {
		t.Fatalf("folder came back as %v", byID["node-folder"].Type)
	}
}

// An empty space is the state right after creating one, and a backup of it has
// to be as restorable as any other.
func TestSnapshotTreeOfAnEmptySpace(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO sync_spaces (id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at)
		VALUES ('space-empty', 'user-1', 'Fresh', 1, 0, 0, ?, ?)`,
		time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatalf("seed space: %v", err)
	}

	space, nodes, slots, err := NewLibraryStore(db).SnapshotTree(ctx, "space-empty")
	if err != nil {
		t.Fatalf("snapshot of an empty space: %v", err)
	}
	if space.ID != "space-empty" {
		t.Fatalf("space = %+v", space)
	}
	if len(nodes) != 0 || len(slots) != 0 {
		t.Fatalf("empty space returned %d nodes and %d slots", len(nodes), len(slots))
	}

	if _, _, _, err := NewLibraryStore(db).SnapshotTree(ctx, "no-such-space"); err == nil {
		t.Fatal("snapshot of an unknown space should fail rather than return an empty tree")
	}
}

// seedTree writes one space holding a folder with a child, the smallest tree
// whose payload can be torn apart by a read that straddles a commit.
func seedTree(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	stmts := []string{
		`INSERT INTO sync_spaces (id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at)
		 VALUES ('space-1', 'user-1', 'Personal', 1, 2, 0, '` + now + `', '` + now + `')`,
		`INSERT INTO root_slots (space_id, key, display_name, position, created_at)
		 VALUES ('space-1', 'main', 'Main', 0, '` + now + `')`,
		`INSERT INTO nodes (id, space_id, type, title, url, parent_id, root_key, position,
		                    created_revision, title_revision, url_revision, structure_revision,
		                    created_at, updated_at)
		 VALUES ('node-folder', 'space-1', 'folder', 'Reading', NULL, NULL, 'main', 0,
		         1, 1, 1, 1, '` + now + `', '` + now + `')`,
		`INSERT INTO nodes (id, space_id, type, title, url, parent_id, root_key, position,
		                    created_revision, title_revision, url_revision, structure_revision,
		                    created_at, updated_at)
		 VALUES ('node-child', 'space-1', 'bookmark', 'Example', 'https://example.com', 'node-folder', NULL, 1,
		         2, 2, 2, 2, '` + now + `', '` + now + `')`,
	}
	for _, q := range stmts {
		if _, err := db.ExecContext(ctx, q); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
}
