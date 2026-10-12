package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"pontis/internal/canonical"
	"pontis/internal/startpage"
)

// seedGrantTree puts one account, one device, one space and a source folder
// two levels deep in place. node-old hangs off a root slot rather than off
// node-root, so it is the case a source read must exclude.
func seedGrantTree(t *testing.T, db *sql.DB) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	seed := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("seed: %v\n%s", err, query)
		}
	}

	seed(`INSERT INTO users (id, username, username_normalized, display_name, password_hash,
		role, status, password_changed_at, created_at, updated_at)
		VALUES ('user-1', 'mahoo', 'mahoo', 'Mahoo', 'x', 'user', 'active', ?, ?, ?)`, now, now, now)
	seed(`INSERT INTO devices (id, owner_user_id, name, client_type, created_at)
		VALUES ('dev-1', 'user-1', 'Edge', 'extension', ?)`, now)
	seed(`INSERT INTO sync_spaces (id, owner_user_id, name, epoch, current_revision, journal_floor_revision, created_at, updated_at)
		VALUES ('space-1', 'user-1', 'Personal', 3, 42, 0, ?, ?)`, now, now)
	seed(`INSERT INTO root_slots (space_id, key, display_name, position, created_at)
		VALUES ('space-1', 'main', 'Main', 0, ?)`, now)

	const nodeSQL = `INSERT INTO nodes (id, space_id, type, title, url, parent_id, root_key, position,
		created_revision, title_revision, url_revision, structure_revision, created_at, updated_at)
		VALUES (?, 'space-1', ?, ?, ?, ?, ?, ?, 1, 1, 1, 1, ?, ?)`
	for _, n := range []struct {
		id, typ, title, url, parent, root string
		position                          int
	}{
		{"node-root", "folder", "Entries", "", "", "main", 0},
		{"node-in", "folder", "Daily", "", "node-root", "", 0},
		{"node-page", "bookmark", "GitHub", "https://github.com/", "node-root", "", 1},
		{"node-old", "bookmark", "Outside", "https://outside.example", "", "main", 1},
		{"node-bookmark", "bookmark", "MDN", "https://developer.mozilla.org", "node-in", "", 0},
		{"node-deeper", "bookmark", "Deep", "https://deep.example", "node-in", "", 2},
	} {
		seed(nodeSQL, n.id, n.typ, n.title, nilIfEmpty(n.url), nilIfEmpty(n.parent), nilIfEmpty(n.root),
			n.position, now, now)
	}
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func TestStartPageSubtreeStaysInsideTheSource(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	seedGrantTree(t, db)

	sub, err := NewStartPageStore(db).Subtree(ctx, "space-1", "node-root", 100)
	if err != nil {
		t.Fatalf("subtree: %v", err)
	}
	if sub.Source.ID != "node-root" {
		t.Fatalf("source = %v", sub.Source.ID)
	}
	// The space row rides along with the nodes it dates: the response claims
	// one epoch/revision for a tree that only existed at that pair.
	if sub.Space.Epoch != 3 || sub.Space.CurrentRevision != 42 {
		t.Fatalf("space = epoch %d rev %d, want 3/42", sub.Space.Epoch, sub.Space.CurrentRevision)
	}

	var ids []string
	for _, n := range sub.Nodes {
		ids = append(ids, n.ID.String())
	}
	// node-old hangs off the root slot, outside the source, and must not be
	// swept in; node-root itself is the source, not one of its contents.
	want := map[string]bool{"node-in": true, "node-page": true, "node-bookmark": true, "node-deeper": true}
	if len(ids) != len(want) {
		t.Fatalf("nodes = %v, want %v", ids, want)
	}
	for _, id := range ids {
		if !want[id] {
			t.Fatalf("nodes = %v contains %v", ids, id)
		}
	}

	// Children of one parent come back in canonical sibling order, which is
	// what lets the client group by parent without re-sorting.
	var inOrder []string
	for _, n := range sub.Nodes {
		if n.Parent.Type == canonical.ParentTypeNode && n.Parent.NodeID == "node-in" {
			inOrder = append(inOrder, n.ID.String())
		}
	}
	if len(inOrder) != 2 || inOrder[0] != "node-bookmark" || inOrder[1] != "node-deeper" {
		t.Fatalf("children of node-in = %v, want [node-bookmark node-deeper]", inOrder)
	}
}

func TestStartPageSubtreeReportsOneRowPastTheBudget(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	seedGrantTree(t, db)

	sub, err := NewStartPageStore(db).Subtree(ctx, "space-1", "node-root", 3)
	if err != nil {
		t.Fatalf("subtree: %v", err)
	}
	// Four descendants exist and the budget is three: the read must show the
	// overflow rather than hand back a trimmed list that looks complete.
	if len(sub.Nodes) != 4 {
		t.Fatalf("nodes = %d, want 4 so the caller can see the budget broke", len(sub.Nodes))
	}
}

func TestStartPageSubtreeOfAMissingSource(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	seedGrantTree(t, db)

	_, err := NewStartPageStore(db).Subtree(ctx, "space-1", "node-gone", 100)
	if !errors.Is(err, canonical.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound", err)
	}
}

func TestStartPageGrantRoundTrip(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	seedGrantTree(t, db)
	store := NewStartPageStore(db)
	now := time.Now().UTC()

	g := startpage.Grant{ID: "grant-1", DeviceID: "dev-1", UserID: "user-1",
		SpaceID: "space-1", FolderID: "node-root", Version: 1, CreatedAt: now, UpdatedAt: now}
	if err := store.InsertGrant(ctx, g); err != nil {
		t.Fatalf("insert: %v", err)
	}
	active, err := store.ActiveGrant(ctx, "dev-1")
	if err != nil {
		t.Fatalf("active: %v", err)
	}
	if active.FolderID != "node-root" || active.Version != 1 {
		t.Fatalf("active = %+v", active)
	}

	if err := store.RepointGrant(ctx, "grant-1", "space-1", "node-in", now.Add(time.Second)); err != nil {
		t.Fatalf("repoint: %v", err)
	}
	after, err := store.ActiveGrant(ctx, "dev-1")
	if err != nil {
		t.Fatalf("active after repoint: %v", err)
	}
	if after.FolderID != "node-in" || after.Version != 2 {
		t.Fatalf("after = folder %v version %d, want node-in/2", after.FolderID, after.Version)
	}

	if err := store.RevokeGrant(ctx, "grant-1", now); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := store.ActiveGrant(ctx, "dev-1"); !errors.Is(err, startpage.ErrGrantNotFound) {
		t.Fatalf("active after revoke = %v, want ErrGrantNotFound", err)
	}
	// A revoked grant is history, not a live row waiting to be re-aimed.
	if err := store.RepointGrant(ctx, "grant-1", "space-1", "node-root", now); !errors.Is(err, startpage.ErrGrantNotFound) {
		t.Fatalf("repoint revoked = %v, want ErrGrantNotFound", err)
	}
}

func TestStartPageOneActiveGrantPerDevice(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	seedGrantTree(t, db)
	store := NewStartPageStore(db)
	now := time.Now().UTC()

	first := startpage.Grant{ID: "grant-1", DeviceID: "dev-1", UserID: "user-1",
		SpaceID: "space-1", FolderID: "node-root", Version: 1, CreatedAt: now, UpdatedAt: now}
	second := startpage.Grant{ID: "grant-2", DeviceID: "dev-1", UserID: "user-1",
		SpaceID: "space-1", FolderID: "node-in", Version: 1, CreatedAt: now, UpdatedAt: now}
	if err := store.InsertGrant(ctx, first); err != nil {
		t.Fatalf("insert first: %v", err)
	}
	if err := store.InsertGrant(ctx, second); err == nil {
		t.Fatal("a second live grant was accepted: 'this device's source' would be whichever row the query found")
	}
	// The first one going away is what lets the device choose a new source.
	if err := store.RevokeGrant(ctx, "grant-1", now); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if err := store.InsertGrant(ctx, second); err != nil {
		t.Fatalf("insert after revoke: %v", err)
	}
}

func TestStartPageDeviceOwner(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if err := Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	seedGrantTree(t, db)
	store := NewStartPageStore(db)

	owner, err := store.DeviceOwner(ctx, "dev-1")
	if err != nil {
		t.Fatalf("owner: %v", err)
	}
	if owner != "user-1" {
		t.Fatalf("owner = %v", owner)
	}
	if _, err := store.DeviceOwner(ctx, "dev-gone"); !errors.Is(err, startpage.ErrDeviceNotFound) {
		t.Fatalf("unknown device = %v, want ErrDeviceNotFound", err)
	}
}
