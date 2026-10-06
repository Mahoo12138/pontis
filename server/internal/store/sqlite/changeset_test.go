package sqlite

import (
	"context"
	"testing"
	"time"

	"pontis/internal/canonical"
)

// setupChangesetTest seeds one space and returns executor + store.
func setupChangesetTest(t *testing.T) (*canonical.Executor, *Store, canonical.SpaceID) {
	t.Helper()
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	for _, stmt := range []string{testUser, testSpace, testRootSlot} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	store := NewStore(db)
	return canonical.NewExecutor(), store, "s1"
}

// execCS runs one ChangeSet and fails the test on error.
func execCS(t *testing.T, ctx context.Context, e *canonical.Executor, store *Store, origin canonical.Origin, space canonical.SpaceID, input canonical.ChangeSetInput, cmds ...canonical.Command) canonical.ChangeSet {
	t.Helper()
	cs, err := e.ExecuteChangeSet(ctx, store, origin, space, input, cmds...)
	if err != nil {
		t.Fatalf("ExecuteChangeSet(%s): %v", input.Kind, err)
	}
	return cs
}

func undoCS(t *testing.T, ctx context.Context, e *canonical.Executor, store *Store, origin canonical.Origin, space canonical.SpaceID, id string) canonical.UndoPlan {
	t.Helper()
	plan, err := e.ExecuteUndo(ctx, store, origin, space, id)
	if err != nil {
		t.Fatalf("ExecuteUndo: %v", err)
	}
	return plan
}

func TestUndoUpdateTitleClean(t *testing.T) {
	e, store, space := setupChangesetTest(t)
	ctx := context.Background()
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: "u1"}

	seed := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create", Summary: "新建"}, canonical.CreateNode{
			SpaceID: space, NodeID: "n1", Type: canonical.NodeTypeBookmark,
			Title: "Original", URL: "https://x.example", Parent: canonical.NewRootParent("main"),
		})
	if seed.FirstRevision != 1 || seed.LastRevision != 1 {
		t.Fatalf("seed revisions = %d..%d", seed.FirstRevision, seed.LastRevision)
	}

	cs := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "update_title", Summary: "重命名"}, canonical.UpdateNodeTitle{
			SpaceID: space, NodeID: "n1", Title: "Renamed",
		})

	plan := undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoClean {
		t.Fatalf("undo status = %s (%+v)", plan.Status, plan.Reviews)
	}
	if node := loadNodeT(t, store, space, "n1"); node.Title != "Original" {
		t.Fatalf("title after undo = %q", node.Title)
	}
	// Revisions only move forward (doc 15 §2).
	if plan.ChangeSet.FirstRevision != 3 {
		t.Fatalf("undo ChangeSet first revision = %d", plan.ChangeSet.FirstRevision)
	}
	if plan.ChangeSet.InverseOf != cs.ID {
		t.Fatal("inverse linkage missing")
	}
}

func TestUndoUpdateTitleReviewRequired(t *testing.T) {
	e, store, space := setupChangesetTest(t)
	ctx := context.Background()
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: "u1"}

	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"}, canonical.CreateNode{
			SpaceID: space, NodeID: "n1", Type: canonical.NodeTypeBookmark,
			Title: "Original", URL: "https://x.example", Parent: canonical.NewRootParent("main"),
		})
	cs := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "update_title"}, canonical.UpdateNodeTitle{
			SpaceID: space, NodeID: "n1", Title: "Renamed",
		})
	// A later edit by another operation touches the same field.
	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "update_title"}, canonical.UpdateNodeTitle{
			SpaceID: space, NodeID: "n1", Title: "Third",
		})

	plan := undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoReviewRequired {
		t.Fatalf("status = %s, want review_required", plan.Status)
	}
	if len(plan.Reviews) != 1 || plan.Reviews[0].Reason != canonical.ReviewFieldChanged {
		t.Fatalf("reviews = %+v", plan.Reviews)
	}
	// The newer state must not be clobbered.
	if node := loadNodeT(t, store, space, "n1"); node.Title != "Third" {
		t.Fatalf("clobbered title = %q", node.Title)
	}
}

func TestUndoMoveCleanAndStale(t *testing.T) {
	e, store, space := setupChangesetTest(t)
	ctx := context.Background()
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: "u1"}

	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"},
		canonical.CreateNode{SpaceID: space, NodeID: "f1", Type: canonical.NodeTypeFolder, Title: "A", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: space, NodeID: "f2", Type: canonical.NodeTypeFolder, Title: "B", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: space, NodeID: "n1", Type: canonical.NodeTypeBookmark, Title: "X", URL: "https://x.example", Parent: canonical.NewRootParent("main")},
	)

	// Move X into A: undo pulls it back to the root.
	cs := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "move"}, canonical.MoveNode{
			SpaceID: space, NodeID: "n1", Parent: canonical.NewNodeParent("f1"),
		})
	plan := undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoClean {
		t.Fatalf("status = %s (%+v)", plan.Status, plan.Reviews)
	}
	if node := loadNodeT(t, store, space, "n1"); node.Parent.Type != canonical.ParentTypeRoot {
		t.Fatalf("parent after undo = %+v", node.Parent)
	}

	// A second, independent move: undoing the first move is now stale.
	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "move"}, canonical.MoveNode{
			SpaceID: space, NodeID: "n1", Parent: canonical.NewNodeParent("f2"),
		})
	plan = undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoReviewRequired || plan.Reviews[0].Reason != canonical.ReviewMovedSince {
		t.Fatalf("replay status = %s %+v", plan.Status, plan.Reviews)
	}
}

func TestUndoCreateBookmarkAndFolderProtection(t *testing.T) {
	e, store, space := setupChangesetTest(t)
	ctx := context.Background()
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: "u1"}

	// A bookmark create undoes as a delete.
	cs := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"}, canonical.CreateNode{
			SpaceID: space, NodeID: "b1", Type: canonical.NodeTypeBookmark,
			Title: "Solo", URL: "https://solo.example", Parent: canonical.NewRootParent("main"),
		})
	plan := undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoClean {
		t.Fatalf("bookmark undo = %s %v", plan.Status, plan.Reviews)
	}
	if _, err := loadNodeErr(store, space, "b1"); err == nil {
		t.Fatal("bookmark must be gone after create undo")
	}

	// A folder create that later gained foreign children requires review
	// (doc 15 §6): deleting it would destroy protected data.
	csFolder := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"}, canonical.CreateNode{
			SpaceID: space, NodeID: "f1", Type: canonical.NodeTypeFolder,
			Title: "Folder", Parent: canonical.NewRootParent("main"),
		})
	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"}, canonical.CreateNode{
			SpaceID: space, NodeID: "b2", Type: canonical.NodeTypeBookmark,
			Title: "Arrived later", URL: "https://later.example", Parent: canonical.NewNodeParent("f1"),
		})
	plan = undoCS(t, ctx, e, store, origin, space, csFolder.ID)
	if plan.Status != canonical.UndoReviewRequired || plan.Reviews[0].Reason != canonical.ReviewProtectedData {
		t.Fatalf("folder undo = %s %+v", plan.Status, plan.Reviews)
	}
}

func TestUndoDeleteRestoresSubtreeWithSameUUIDs(t *testing.T) {
	e, store, space := setupChangesetTest(t)
	ctx := context.Background()
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: "u1"}

	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"},
		canonical.CreateNode{SpaceID: space, NodeID: "f1", Type: canonical.NodeTypeFolder, Title: "Container", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: space, NodeID: "b1", Type: canonical.NodeTypeBookmark, Title: "Inner", URL: "https://inner.example", Parent: canonical.NewNodeParent("f1")},
	)
	// A sibling after the folder anchors the restore position.
	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"}, canonical.CreateNode{
			SpaceID: space, NodeID: "s1", Type: canonical.NodeTypeBookmark, Title: "After", URL: "https://after.example", Parent: canonical.NewRootParent("main"),
		})

	cs := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "delete", Summary: "删除了 Container"}, canonical.DeleteNode{
			SpaceID: space, NodeID: "f1",
		})

	plan := undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoClean {
		t.Fatalf("status = %s (%+v)", plan.Status, plan.Reviews)
	}
	// The original canonical UUIDs are preserved (doc 15 §7).
	folder := loadNodeT(t, store, space, "f1")
	if folder.Title != "Container" {
		t.Fatalf("restored folder = %+v", folder)
	}
	inner := loadNodeT(t, store, space, "b1")
	if inner.Parent.NodeID != "f1" || inner.URL != "https://inner.example" {
		t.Fatalf("restored child = %+v", inner)
	}
	// The folder sits before its original next sibling "After".
	if folder.Position != 0 || loadNodeT(t, store, space, "s1").Position != 1 {
		t.Fatalf("restore order wrong: folder=%d after=%d", folder.Position, loadNodeT(t, store, space, "s1").Position)
	}

	// A second restore hits the live ids: review, not duplication.
	plan = undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoReviewRequired || plan.Reviews[0].Reason != canonical.ReviewAlreadyRestored {
		t.Fatalf("second restore = %s %+v", plan.Status, plan.Reviews)
	}
}

func TestUndoDeleteWithDeadParentRecovers(t *testing.T) {
	e, store, space := setupChangesetTest(t)
	ctx := context.Background()
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: "u1"}

	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"}, canonical.CreateNode{
			SpaceID: space, NodeID: "f1", Type: canonical.NodeTypeFolder, Title: "Home", Parent: canonical.NewRootParent("main"),
		})
	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"}, canonical.CreateNode{
			SpaceID: space, NodeID: "b1", Type: canonical.NodeTypeBookmark, Title: "Treasure", URL: "https://t.example", Parent: canonical.NewNodeParent("f1"),
		})
	cs := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "delete"}, canonical.DeleteNode{SpaceID: space, NodeID: "b1"})
	// The original parent folder dies after the delete.
	execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "delete"}, canonical.DeleteNode{SpaceID: space, NodeID: "f1"})

	plan := undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoClean {
		t.Fatalf("status = %s (%+v)", plan.Status, plan.Reviews)
	}
	// The bookmark keeps its UUID and lands in a recovery root (doc 15 §7).
	restored := loadNodeT(t, store, space, "b1")
	if restored.Parent.Type != canonical.ParentTypeRoot || restored.Title != "Treasure" {
		t.Fatalf("recovered node = %+v", restored)
	}
}

func TestUndoExpiredAndNotUndoable(t *testing.T) {
	e, store, space := setupChangesetTest(t)
	ctx := context.Background()
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: "u1"}

	cs := execCS(t, ctx, e, store, origin, space,
		canonical.ChangeSetInput{Kind: "create"}, canonical.CreateNode{
			SpaceID: space, NodeID: "b1", Type: canonical.NodeTypeBookmark,
			Title: "X", URL: "https://x.example", Parent: canonical.NewRootParent("main"),
		})

	// Unknown ChangeSet id: not undoable.
	if plan := undoCS(t, ctx, e, store, origin, space, "missing"); plan.Status != canonical.UndoNotUndoable {
		t.Fatalf("unknown = %s", plan.Status)
	}

	// Expired undo data: expired, never applied.
	tx, err := store.BeginTx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	data, found, err := tx.LoadUndoData(ctx, cs.ID)
	if err != nil || !found {
		t.Fatalf("undo data: %v %v", found, err)
	}
	data.ExpiresAt = time.Now().UTC().Add(-time.Hour)
	if err := tx.UpdateUndoData(ctx, data); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	plan := undoCS(t, ctx, e, store, origin, space, cs.ID)
	if plan.Status != canonical.UndoExpired {
		t.Fatalf("status = %s, want expired", plan.Status)
	}
	if node := loadNodeT(t, store, space, "b1"); node.Title != "X" {
		t.Fatal("expired undo must not touch state")
	}
}

func loadNodeT(t *testing.T, store *Store, space canonical.SpaceID, id string) canonical.Node {
	t.Helper()
	ctx := context.Background()
	tx, err := store.BeginTx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	node, err := tx.LoadNode(ctx, space, canonical.NodeID(id))
	if err != nil {
		t.Fatalf("load %s: %v", id, err)
	}
	return node
}

func loadNodeErr(store *Store, space canonical.SpaceID, id string) (canonical.Node, error) {
	ctx := context.Background()
	tx, err := store.BeginTx(ctx)
	if err != nil {
		return canonical.Node{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return tx.LoadNode(ctx, space, canonical.NodeID(id))
}
