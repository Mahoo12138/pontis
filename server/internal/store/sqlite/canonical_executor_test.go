package sqlite

import (
	"context"
	"errors"
	"testing"

	"pontis/internal/canonical"
)

// setupCanonicalTest returns an executor backed by a migrated test database
// plus a seeded space ("s1") with a single root slot "main".
func setupCanonicalTest(t *testing.T) (*canonical.Executor, *Store, canonical.SpaceID) {
	t.Helper()
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	store := NewStore(db)
	if _, err := db.Exec(`INSERT INTO sync_spaces (id, owner_user_id, name, created_at, updated_at)
		VALUES ('s1', 'u1', 'Main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO root_slots (space_id, key, display_name, position, created_at)
		VALUES ('s1', 'main', 'Main', 0, '2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	return canonical.NewExecutor(), store, canonical.SpaceID("s1")
}

func mustExec(t *testing.T, e *canonical.Executor, store *Store, cmds ...canonical.Command) {
	t.Helper()
	if err := e.Execute(context.Background(), store, cmds...); err != nil {
		t.Fatalf("Execute: %v", err)
	}
}

func loadNode(t *testing.T, store *Store, space canonical.SpaceID, id canonical.NodeID) canonical.Node {
	t.Helper()
	n, err := scanNode(store.db.QueryRow(nodeColumns+` FROM nodes WHERE space_id = ? AND id = ?`, string(space), string(id)))
	if err != nil {
		t.Fatalf("load node %s: %v", id, err)
	}
	return n
}

func nodeExists(t *testing.T, store *Store, space canonical.SpaceID, id canonical.NodeID) bool {
	t.Helper()
	var one int
	err := store.db.QueryRow(`SELECT 1 FROM nodes WHERE space_id = ? AND id = ?`,
		string(space), string(id)).Scan(&one)
	return err == nil
}

func currentRevision(t *testing.T, store *Store, space canonical.SpaceID) int64 {
	t.Helper()
	var rev int64
	if err := store.db.QueryRow(`SELECT current_revision FROM sync_spaces WHERE id = ?`,
		string(space)).Scan(&rev); err != nil {
		t.Fatal(err)
	}
	return rev
}

func TestTreeCreateMoveDelete(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	dev := canonical.NodeID("dev")
	reading := canonical.NodeID("reading")
	github := canonical.NodeID("github")
	golang := canonical.NodeID("golang")

	mustExec(t, e, store,
		canonical.CreateNode{SpaceID: space, NodeID: dev, Type: canonical.NodeTypeFolder, Title: "Development", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: reading, Type: canonical.NodeTypeFolder, Title: "Reading", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: github, Type: canonical.NodeTypeBookmark, Title: "GitHub", URL: "https://github.com", Parent: canonical.NewNodeParent(dev)},
		canonical.CreateNode{SpaceID: space, NodeID: golang, Type: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent(dev)},
	)

	// Move GitHub -> Reading.
	mustExec(t, e, store, canonical.MoveNode{
		SpaceID: space, NodeID: github, Parent: canonical.NewNodeParent(reading),
	})

	// Delete Development (recursively removes Go, GitHub must survive).
	mustExec(t, e, store, canonical.DeleteNode{SpaceID: space, NodeID: dev})

	if !nodeExists(t, store, space, github) {
		t.Error("GitHub should survive under Reading")
	}
	if nodeExists(t, store, space, golang) {
		t.Error("Go should be deleted with Development")
	}
	if nodeExists(t, store, space, dev) {
		t.Error("Development should be deleted")
	}

	gh := loadNode(t, store, space, github)
	if gh.Parent != canonical.NewNodeParent(reading) {
		t.Errorf("GitHub parent = %+v, want Reading", gh.Parent)
	}

	// 4 creates + 1 move + 1 delete = 6 revisions.
	if rev := currentRevision(t, store, space); rev != 6 {
		t.Errorf("current_revision = %d, want 6", rev)
	}
}

func TestMoveCycleRejected(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	a := canonical.NodeID("a")
	b := canonical.NodeID("b")
	mustExec(t, e, store,
		canonical.CreateNode{SpaceID: space, NodeID: a, Type: canonical.NodeTypeFolder, Title: "A", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: b, Type: canonical.NodeTypeFolder, Title: "B", Parent: canonical.NewNodeParent(a)},
	)
	revBefore := currentRevision(t, store, space)

	err := e.Execute(context.Background(), store, canonical.MoveNode{
		SpaceID: space, NodeID: a, Parent: canonical.NewNodeParent(b),
	})
	if !errors.Is(err, canonical.ErrTreeCycle) {
		t.Errorf("move folder under descendant: err = %v, want ErrTreeCycle", err)
	}

	err = e.Execute(context.Background(), store, canonical.MoveNode{
		SpaceID: space, NodeID: a, Parent: canonical.NewNodeParent(a),
	})
	if !errors.Is(err, canonical.ErrNodeIsSelf) {
		t.Errorf("move folder under itself: err = %v, want ErrNodeIsSelf", err)
	}

	// Failed commands must not consume revisions or change the tree.
	if rev := currentRevision(t, store, space); rev != revBefore {
		t.Errorf("current_revision = %d, want unchanged %d", rev, revBefore)
	}
	bNode := loadNode(t, store, space, b)
	if bNode.Parent != canonical.NewNodeParent(a) {
		t.Errorf("tree changed after rejected move: B parent = %+v", bNode.Parent)
	}
}

func TestRecursiveDeleteRemovesWholeSubtree(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	f := canonical.NodeID("f")
	c1 := canonical.NodeID("c1")
	f2 := canonical.NodeID("f2")
	c2 := canonical.NodeID("c2")
	mustExec(t, e, store,
		canonical.CreateNode{SpaceID: space, NodeID: f, Type: canonical.NodeTypeFolder, Title: "F", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: c1, Type: canonical.NodeTypeBookmark, Title: "C1", URL: "https://c1", Parent: canonical.NewNodeParent(f)},
		canonical.CreateNode{SpaceID: space, NodeID: f2, Type: canonical.NodeTypeFolder, Title: "F2", Parent: canonical.NewNodeParent(f)},
		canonical.CreateNode{SpaceID: space, NodeID: c2, Type: canonical.NodeTypeBookmark, Title: "C2", URL: "https://c2", Parent: canonical.NewNodeParent(f2)},
	)

	mustExec(t, e, store, canonical.DeleteNode{SpaceID: space, NodeID: f})

	for _, id := range []canonical.NodeID{f, c1, f2, c2} {
		if nodeExists(t, store, space, id) {
			t.Errorf("node %s should be deleted", id)
		}
	}
}

func TestSiblingReorderOnlyMovesRevisionOfMovedNode(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	a := canonical.NodeID("a")
	b := canonical.NodeID("b")
	c := canonical.NodeID("c")
	mustExec(t, e, store,
		canonical.CreateNode{SpaceID: space, NodeID: a, Type: canonical.NodeTypeBookmark, Title: "A", URL: "https://a", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: b, Type: canonical.NodeTypeBookmark, Title: "B", URL: "https://b", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: c, Type: canonical.NodeTypeBookmark, Title: "C", URL: "https://c", Parent: main},
	)

	aBefore := loadNode(t, store, space, a)
	bBefore := loadNode(t, store, space, b)
	cBefore := loadNode(t, store, space, c)

	// Move A before C.
	before := canonical.NodeID("c")
	mustExec(t, e, store, canonical.MoveNode{
		SpaceID: space, NodeID: a, Parent: main, BeforeID: &before,
	})

	aAfter := loadNode(t, store, space, a)
	bAfter := loadNode(t, store, space, b)
	cAfter := loadNode(t, store, space, c)

	if aAfter.Position != 1 {
		t.Errorf("A position = %d, want 1", aAfter.Position)
	}
	if bAfter.Position != 0 {
		t.Errorf("B position = %d, want 0", bAfter.Position)
	}
	if cAfter.Position != 2 {
		t.Errorf("C position = %d, want 2", cAfter.Position)
	}

	// Only the semantically moved node gets a structure revision bump.
	if aAfter.StructureRevision <= aBefore.StructureRevision {
		t.Errorf("A structure_revision should bump: %d -> %d", aBefore.StructureRevision, aAfter.StructureRevision)
	}
	if bAfter.StructureRevision != bBefore.StructureRevision {
		t.Errorf("B structure_revision must not change: %d -> %d", bBefore.StructureRevision, bAfter.StructureRevision)
	}
	if cAfter.StructureRevision != cBefore.StructureRevision {
		t.Errorf("C structure_revision must not change: %d -> %d", cBefore.StructureRevision, cAfter.StructureRevision)
	}
}

func TestValidationErrors(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	bookmark := canonical.NodeID("bm")
	mustExec(t, e, store,
		canonical.CreateNode{SpaceID: space, NodeID: bookmark, Type: canonical.NodeTypeBookmark, Title: "BM", URL: "https://bm", Parent: main},
	)

	// Bookmark cannot become a parent.
	folder := canonical.NodeID("fld")
	err := e.Execute(context.Background(), store, canonical.CreateNode{
		SpaceID: space, NodeID: folder, Type: canonical.NodeTypeFolder, Title: "F", Parent: canonical.NewNodeParent(bookmark),
	})
	if !errors.Is(err, canonical.ErrParentNotFolder) {
		t.Errorf("parent not folder: err = %v, want ErrParentNotFolder", err)
	}

	// Empty title.
	err = e.Execute(context.Background(), store, canonical.CreateNode{
		SpaceID: space, NodeID: folder, Type: canonical.NodeTypeFolder, Title: "", Parent: main,
	})
	if !errors.Is(err, canonical.ErrTitleRequired) {
		t.Errorf("empty title: err = %v, want ErrTitleRequired", err)
	}

	// Bookmark without URL.
	err = e.Execute(context.Background(), store, canonical.CreateNode{
		SpaceID: space, NodeID: "bm2", Type: canonical.NodeTypeBookmark, Title: "BM2", Parent: main,
	})
	if !errors.Is(err, canonical.ErrURLRequired) {
		t.Errorf("bookmark without url: err = %v, want ErrURLRequired", err)
	}

	// Folder with URL.
	err = e.Execute(context.Background(), store, canonical.CreateNode{
		SpaceID: space, NodeID: folder, Type: canonical.NodeTypeFolder, Title: "F", URL: "https://x", Parent: main,
	})
	if !errors.Is(err, canonical.ErrURLNotAllowed) {
		t.Errorf("folder with url: err = %v, want ErrURLNotAllowed", err)
	}

	// Update URL on a folder.
	mustExec(t, e, store, canonical.CreateNode{
		SpaceID: space, NodeID: folder, Type: canonical.NodeTypeFolder, Title: "F", Parent: main,
	})
	err = e.Execute(context.Background(), store, canonical.UpdateNodeURL{SpaceID: space, NodeID: folder, URL: "https://x"})
	if !errors.Is(err, canonical.ErrURLNotAllowed) {
		t.Errorf("url on folder: err = %v, want ErrURLNotAllowed", err)
	}

	// Unknown root slot.
	err = e.Execute(context.Background(), store, canonical.CreateNode{
		SpaceID: space, NodeID: "x", Type: canonical.NodeTypeBookmark, Title: "X", URL: "https://x", Parent: canonical.NewRootParent("nope"),
	})
	if !errors.Is(err, canonical.ErrRootSlotNotFound) {
		t.Errorf("unknown root slot: err = %v, want ErrRootSlotNotFound", err)
	}

	// Unknown node.
	err = e.Execute(context.Background(), store, canonical.DeleteNode{SpaceID: space, NodeID: "ghost"})
	if !errors.Is(err, canonical.ErrNodeNotFound) {
		t.Errorf("unknown node: err = %v, want ErrNodeNotFound", err)
	}
}

func TestExecuteAtomicRollback(t *testing.T) {
	e, store, space := setupCanonicalTest(t)
	main := canonical.NewRootParent("main")

	// A valid create followed by an invalid one must roll back both.
	err := e.Execute(context.Background(), store,
		canonical.CreateNode{SpaceID: space, NodeID: "ok", Type: canonical.NodeTypeBookmark, Title: "OK", URL: "https://ok", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: "bad", Type: canonical.NodeTypeBookmark, Title: "Bad", Parent: main}, // missing URL
	)
	if !errors.Is(err, canonical.ErrURLRequired) {
		t.Fatalf("err = %v, want ErrURLRequired", err)
	}
	if nodeExists(t, store, space, "ok") {
		t.Error("first command should have been rolled back")
	}
	if rev := currentRevision(t, store, space); rev != 0 {
		t.Errorf("current_revision = %d, want 0 after rollback", rev)
	}
}
