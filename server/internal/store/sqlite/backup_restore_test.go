package sqlite

import (
	"context"
	"errors"
	"strings"
	"testing"

	"pontis/internal/backup"
	"pontis/internal/canonical"
)

// The space holds the review's failing shape: a root bookmark sorting before
// a root folder that itself has children, plus journal history and an active
// binding that the restore must reset.
func setupRestoreTest(t *testing.T) *BackupStore {
	t.Helper()
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	for _, stmt := range []string{
		`INSERT INTO users (id, username, username_normalized, display_name, password_hash, role, status, locale, password_changed_at, created_at, updated_at)
		 VALUES ('u1', 'alice', 'alice', 'Alice', 'x', 'admin', 'active', 'zh-CN', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		`INSERT INTO sync_spaces (id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at)
		 VALUES ('s1', 'u1', 'Personal', 3, 42, 20, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		`INSERT INTO root_slots (space_id, key, display_name, position, created_at)
		 VALUES ('s1', 'main', 'Main', 0, '2026-01-01T00:00:00Z')`,
		`INSERT INTO nodes (space_id, id, type, title, url, parent_id, root_key, position,
				created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		 VALUES ('s1', 'old', 'bookmark', 'Old', 'https://old', NULL, 'main', 0, 7, 7, 7, 7, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		`INSERT INTO devices (id, owner_user_id, name, client_type, browser, platform, sync_mode, created_at)
		 VALUES ('d1', 'u1', 'Edge', 'extension', 'edge', 'windows', 'partial', '2026-01-01T00:00:00Z')`,
		`INSERT INTO device_space_bindings (id, device_id, space_id, state, epoch, applied_revision, received_revision, max_client_seq, created_at, updated_at)
		 VALUES ('b1', 'd1', 's1', 'active', 3, 42, 42, 5, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		`INSERT INTO journal (space_id, epoch, revision, change_type, node_id, payload, origin_type, created_at)
		 VALUES ('s1', 3, 1, 'create', 'old', '{}', 'user', '2026-01-01T00:00:00Z')`,
		`INSERT INTO tombstones (space_id, node_id, deleted_epoch, deleted_revision, deleted_at)
		 VALUES ('s1', 'gone', 3, 11, '2026-01-01T00:00:00Z')`,
		`INSERT INTO client_operation_receipts (binding_id, op_id, client_seq, request_epoch, base_revision, request_hash, status, reason, processed_at_revision, created_at)
		 VALUES ('b1', 'op1', 5, 3, 40, 'hash', 'APPLIED', '', 42, '2026-01-01T00:00:00Z')`,
	} {
		if _, err := db.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	t.Cleanup(func() { db.Close() })
	return NewBackupStore(db)
}

func ref(s string) *string { return &s }

// A snapshot in export order puts a child before the folder holding it; the
// restore must hand the store parents first so the immediate parent FK accepts
// the insert, and must return the tree, watermarks and history to one
// consistent zero baseline.
func TestReplaceBaselineRestoresTreeAndResetsBaseline(t *testing.T) {
	store := setupRestoreTest(t)
	ctx := context.Background()

	slots := []backup.SlotDTO{{Key: "main", DisplayName: "Main", Position: 0, CreatedAt: "2026-01-01T00:00:00Z"}}
	// Parent-first as backup.Service orders it.
	nodes := []backup.NodeDTO{
		{ID: "a", Type: "bookmark", Title: "A", URL: ref("https://a"), RootKey: ref("main"), Position: 0,
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"},
		{ID: "f", Type: "folder", Title: "F", RootKey: ref("main"), Position: 1,
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"},
		{ID: "c", Type: "bookmark", Title: "C", URL: ref("https://c"), ParentID: ref("f"), Position: 0,
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"},
	}

	epoch, err := store.ReplaceBaseline(ctx, "s1", slots, nodes)
	if err != nil {
		t.Fatalf("ReplaceBaseline: %v", err)
	}
	if epoch != 4 {
		t.Fatalf("epoch = %d, want 4 (allocated inside the write transaction)", epoch)
	}

	db := store.db
	var currentRevision, floor int64
	var storedEpoch int64
	if err := db.QueryRowContext(ctx,
		`SELECT epoch, current_revision, journal_floor_revision FROM sync_spaces WHERE id = 's1'`).
		Scan(&storedEpoch, &currentRevision, &floor); err != nil {
		t.Fatal(err)
	}
	if storedEpoch != epoch || currentRevision != 0 || floor != 0 {
		t.Fatalf("space = (epoch %d, revision %d, floor %d), want (%d, 0, 0)", storedEpoch, currentRevision, floor, epoch)
	}

	type nodeRow struct {
		id, title, typ                             string
		position, created, title2, urlR, structure int64
	}
	rows, err := db.QueryContext(ctx, `
		SELECT id, type, title, position, created_revision, title_revision, url_revision, structure_revision
		FROM nodes WHERE space_id = 's1' ORDER BY position, id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []nodeRow
	for rows.Next() {
		var n nodeRow
		if err := rows.Scan(&n.id, &n.typ, &n.title, &n.position, &n.created, &n.title2, &n.urlR, &n.structure); err != nil {
			t.Fatal(err)
		}
		got = append(got, n)
	}
	if len(got) != 3 {
		t.Fatalf("restored %d nodes, want 3: %+v", len(got), got)
	}
	for _, n := range got {
		// The baseline must be uniform: the space restarted at revision 0, so
		// a node stamped with revision 1 would make every resynced device's
		// first operation look like a concurrent update.
		if n.created != 0 || n.title2 != 0 || n.urlR != 0 || n.structure != 0 {
			t.Fatalf("node %s carries revisions (%d,%d,%d,%d), want the 0 baseline",
				n.id, n.created, n.title2, n.urlR, n.structure)
		}
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO nodes (space_id, id, type, title, url, parent_id, position,
			created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		VALUES ('s1', 'later', 'bookmark', 'Later', 'https://later', 'f', 9, 4, 4, 4, 4, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatalf("the restored folder must still accept children: %v", err)
	}

	// Old-epoch history no longer participates in correctness.
	for _, table := range []string{"journal", "tombstones", "client_operation_receipts"} {
		var n int64
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("%s survived the baseline replacement with %d rows", table, n)
		}
	}

	var state string
	var bindEpoch, applied, received int64
	if err := db.QueryRowContext(ctx, `
		SELECT state, epoch, applied_revision, received_revision FROM device_space_bindings WHERE id = 'b1'`).
		Scan(&state, &bindEpoch, &applied, &received); err != nil {
		t.Fatal(err)
	}
	if state != "pending_initial" || bindEpoch != epoch || applied != 0 || received != 0 {
		t.Fatalf("binding = (%s, epoch %d, %d/%d), want pending_initial at the new baseline",
			state, bindEpoch, applied, received)
	}
}

// Documents why the ordering matters: the same payload in export order aborts
// on the parent FK. The transaction rollback must leave the live tree alone.
func TestReplaceBaselineRejectsChildBeforeParent(t *testing.T) {
	store := setupRestoreTest(t)
	ctx := context.Background()

	slots := []backup.SlotDTO{{Key: "main", DisplayName: "Main", Position: 0, CreatedAt: "2026-01-01T00:00:00Z"}}
	childFirst := []backup.NodeDTO{
		{ID: "a", Type: "bookmark", Title: "A", URL: ref("https://a"), RootKey: ref("main"), Position: 0,
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"},
		{ID: "c", Type: "bookmark", Title: "C", URL: ref("https://c"), ParentID: ref("f"), Position: 0,
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"},
		{ID: "f", Type: "folder", Title: "F", RootKey: ref("main"), Position: 1,
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-01T00:00:00Z"},
	}

	_, err := store.ReplaceBaseline(ctx, "s1", slots, childFirst)
	if err == nil || !strings.Contains(err.Error(), "FOREIGN KEY") {
		t.Fatalf("ReplaceBaseline err = %v, want the parent foreign key failure", err)
	}
	// Rolled back: the previous tree and epoch survive untouched.
	var epoch int64
	if err := store.db.QueryRowContext(ctx, `SELECT epoch FROM sync_spaces WHERE id = 's1'`).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	if epoch != 3 {
		t.Fatalf("epoch = %d after a failed restore, want 3", epoch)
	}
	var titles []string
	rows, err := store.db.QueryContext(ctx, `SELECT title FROM nodes WHERE space_id = 's1'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		titles = append(titles, s)
	}
	if len(titles) != 1 || titles[0] != "Old" {
		t.Fatalf("live tree after rollback = %v, want the original [Old]", titles)
	}
}

func TestReplaceBaselineUnknownSpace(t *testing.T) {
	store := setupRestoreTest(t)
	if _, err := store.ReplaceBaseline(context.Background(), "nope", nil, nil); !errors.Is(err, canonical.ErrSpaceNotFound) {
		t.Fatalf("err = %v, want ErrSpaceNotFound", err)
	}
}
