package sqlite

import (
	"context"
	"errors"
	"testing"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
)

// setupUndoTest returns a changeset service and canonical store over a
// migrated database with space "s1" and root slot "main".
func setupUndoTest(t *testing.T) (*changeset.Service, *Store, canonical.SpaceID) {
	t.Helper()
	_, store, space := setupCanonicalTest(t)
	svc := changeset.NewService(NewChangeSetStore(store.db))
	return svc, store, space
}

var undoOrigin = canonical.Origin{Type: canonical.OriginUser, UserID: "u1"}

// applyOp records one node operation as a ChangeSet and returns its id.
func applyOp(t *testing.T, svc *changeset.Service, store *Store, space canonical.SpaceID, cmds ...canonical.Command) string {
	t.Helper()
	ctx := context.Background()
	tx, err := store.BeginTx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	applied, err := svc.RecordNodeOp(ctx, tx, space, undoOrigin, cmds...)
	if err != nil {
		t.Fatalf("RecordNodeOp: %v", err)
	}
	if !applied {
		t.Fatal("operation was a canonical no-op")
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	committed = true

	var id string
	if err := store.db.QueryRow(`SELECT id FROM changesets WHERE space_id = ? ORDER BY last_revision DESC LIMIT 1`,
		string(space)).Scan(&id); err != nil {
		t.Fatalf("load changeset id: %v", err)
	}
	return id
}

func loadChangeSet(t *testing.T, store *Store, id string) changeset.ChangeSet {
	t.Helper()
	cs, found, err := NewChangeSetStore(store.db).GetChangeSet(context.Background(), id)
	if err != nil || !found {
		t.Fatalf("load changeset %s: %v %v", id, found, err)
	}
	return cs
}

func undo(t *testing.T, svc *changeset.Service, space canonical.SpaceID, csID string) changeset.UndoResult {
	t.Helper()
	res, err := svc.Undo(context.Background(), space, csID, "u1")
	if err != nil {
		t.Fatalf("Undo(%s): %v", csID, err)
	}
	return res
}

func TestUndoUpdateTitle(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "bm", Type: canonical.NodeTypeBookmark,
		Title: "GitHub", URL: "https://github.com", Parent: main,
	})
	cs := applyOp(t, svc, store, space, canonical.UpdateNodeTitle{SpaceID: space, NodeID: "bm", Title: "GH"})
	if got := loadNode(t, store, space, "bm").Title; got != "GH" {
		t.Fatalf("title after rename = %q", got)
	}
	if cs2 := loadChangeSet(t, store, cs); cs2.UndoDataJSON == "" {
		t.Fatal("rename changeset has no undo data")
	}

	revBefore := currentRevision(t, store, space)
	res := undo(t, svc, space, cs)
	if res.Status != changeset.PlanClean {
		t.Fatalf("undo status = %s, want clean", res.Status)
	}
	if got := loadNode(t, store, space, "bm").Title; got != "GitHub" {
		t.Fatalf("title after undo = %q, want GitHub", got)
	}
	// Undo never rolls back revisions (doc 15 §2): the inverse is new work.
	if rev := currentRevision(t, store, space); rev <= revBefore {
		t.Fatalf("revision %d did not advance past %d", rev, revBefore)
	}

	// The inverse is a fresh ChangeSet linked back to the original.
	inverse := loadChangeSet(t, store, res.ChangeSetID)
	if inverse.Kind != changeset.KindUndo || inverse.InverseOf != cs {
		t.Fatalf("inverse changeset = %+v", inverse)
	}
	if got := loadChangeSet(t, store, cs).UndoneByChangeSet; got != res.ChangeSetID {
		t.Fatalf("original not marked undone, marked by %q", got)
	}

	// Undoing twice is rejected.
	if _, err := svc.Undo(context.Background(), space, cs, "u1"); !errors.Is(err, changeset.ErrAlreadyUndone) {
		t.Fatalf("second undo err = %v, want ErrAlreadyUndone", err)
	}
}

func TestUndoUpdateRequiresReviewAfterLaterEdit(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "bm", Type: canonical.NodeTypeBookmark,
		Title: "GitHub", URL: "https://github.com", Parent: main,
	})
	first := applyOp(t, svc, store, space, canonical.UpdateNodeTitle{SpaceID: space, NodeID: "bm", Title: "GH"})
	applyOp(t, svc, store, space, canonical.UpdateNodeTitle{SpaceID: space, NodeID: "bm", Title: "GitHub.com"})

	res := undo(t, svc, space, first)
	if res.Status != changeset.PlanReviewRequired {
		t.Fatalf("undo status = %s, want review_required", res.Status)
	}
	if len(res.Reasons) == 0 {
		t.Fatal("review without reasons")
	}
	if got := loadNode(t, store, space, "bm").Title; got != "GitHub.com" {
		t.Fatalf("review must not overwrite later state, title = %q", got)
	}
}

func TestUndoURLUpdate(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "bm", Type: canonical.NodeTypeBookmark,
		Title: "Go", URL: "https://go.dev", Parent: main,
	})
	cs := applyOp(t, svc, store, space, canonical.UpdateNodeURL{SpaceID: space, NodeID: "bm", URL: "https://go.org"})

	res := undo(t, svc, space, cs)
	if res.Status != changeset.PlanClean {
		t.Fatalf("undo status = %s, want clean", res.Status)
	}
	if got := loadNode(t, store, space, "bm").URL; got != "https://go.dev" {
		t.Fatalf("url after undo = %q", got)
	}
}

func TestUndoMove(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "dev", Type: canonical.NodeTypeFolder, Title: "Dev", Parent: main,
	})
	applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "bm", Type: canonical.NodeTypeBookmark,
		Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("dev"),
	})
	cs := applyOp(t, svc, store, space, canonical.MoveNode{SpaceID: space, NodeID: "bm", Parent: main})
	if got := loadNode(t, store, space, "bm").Parent; got.NodeID != "" {
		t.Fatalf("bookmark not moved to root: %+v", got)
	}

	res := undo(t, svc, space, cs)
	if res.Status != changeset.PlanClean {
		t.Fatalf("undo status = %s, want clean", res.Status)
	}
	if got := loadNode(t, store, space, "bm").Parent; got.NodeID != "dev" {
		t.Fatalf("bookmark not moved back: %+v", got)
	}
}

func TestUndoMoveRequiresReviewWhenMovedAgain(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "dev", Type: canonical.NodeTypeFolder, Title: "Dev", Parent: main,
	})
	applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "bm", Type: canonical.NodeTypeBookmark,
		Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("dev"),
	})
	first := applyOp(t, svc, store, space, canonical.MoveNode{SpaceID: space, NodeID: "bm", Parent: main})
	applyOp(t, svc, store, space, canonical.MoveNode{SpaceID: space, NodeID: "bm", Parent: canonical.NewNodeParent("dev")})

	res := undo(t, svc, space, first)
	if res.Status != changeset.PlanReviewRequired {
		t.Fatalf("undo status = %s, want review_required", res.Status)
	}
	// The node stays where the later move put it (doc 15 §5).
	if got := loadNode(t, store, space, "bm").Parent; got.NodeID != "dev" {
		t.Fatalf("undo dragged the node back: %+v", got)
	}
}

func TestUndoCreateBookmark(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	cs := applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "bm", Type: canonical.NodeTypeBookmark,
		Title: "Go", URL: "https://go.dev", Parent: main,
	})

	res := undo(t, svc, space, cs)
	if res.Status != changeset.PlanClean {
		t.Fatalf("undo status = %s, want clean", res.Status)
	}
	if nodeExists(t, store, space, "bm") {
		t.Fatal("created bookmark still exists after undo")
	}
}

func TestUndoCreateFolderWithLaterContentRequiresReview(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	cs := applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "dev", Type: canonical.NodeTypeFolder, Title: "Dev", Parent: main,
	})
	// Later data inside the created folder must be protected (doc 15 §6).
	mustExec(t, canonical.NewExecutor(), store, canonical.CreateNode{
		SpaceID: space, NodeID: "foreign", Type: canonical.NodeTypeBookmark,
		Title: "Later", URL: "https://later.dev", Parent: canonical.NewNodeParent("dev"),
	})

	res := undo(t, svc, space, cs)
	if res.Status != changeset.PlanReviewRequired {
		t.Fatalf("undo status = %s, want review_required", res.Status)
	}
	if !nodeExists(t, store, space, "dev") || !nodeExists(t, store, space, "foreign") {
		t.Fatal("review undid the folder anyway")
	}
}

func TestUndoDeleteRestoresSubtreeWithOriginalUUIDs(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	// Pre-existing tree created by another actor (no changesets).
	mustExec(t, canonical.NewExecutor(), store,
		canonical.CreateNode{SpaceID: space, NodeID: "dev", Type: canonical.NodeTypeFolder, Title: "Dev", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: "go", Type: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("dev")},
		canonical.CreateNode{SpaceID: space, NodeID: "gh", Type: canonical.NodeTypeBookmark, Title: "GitHub", URL: "https://github.com", Parent: canonical.NewNodeParent("dev")},
	)

	cs := applyOp(t, svc, store, space, canonical.DeleteNode{SpaceID: space, NodeID: "dev"})
	for _, id := range []canonical.NodeID{"dev", "go", "gh"} {
		if nodeExists(t, store, space, id) {
			t.Fatalf("node %s not deleted", id)
		}
	}
	// Tombstones exist while deleted.
	var tombs int
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM tombstones WHERE space_id = 's1'`).Scan(&tombs)
	if tombs != 3 {
		t.Fatalf("tombstones = %d, want 3", tombs)
	}

	res := undo(t, svc, space, cs)
	if res.Status != changeset.PlanClean {
		t.Fatalf("undo status = %s, want clean", res.Status)
	}
	for _, id := range []canonical.NodeID{"dev", "go", "gh"} {
		if !nodeExists(t, store, space, id) {
			t.Fatalf("node %s not restored with its original UUID", id)
		}
	}
	if got := loadNode(t, store, space, "go").Parent; got.NodeID != "dev" {
		t.Fatalf("restored child parent = %+v", got)
	}
	// Stale tombstones must be gone.
	_ = store.db.QueryRow(`SELECT COUNT(*) FROM tombstones WHERE space_id = 's1'`).Scan(&tombs)
	if tombs != 0 {
		t.Fatalf("tombstones after restore = %d, want 0", tombs)
	}
}

func TestUndoDeleteFallsBackToRecoveryRoot(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	mustExec(t, canonical.NewExecutor(), store,
		canonical.CreateNode{SpaceID: space, NodeID: "a", Type: canonical.NodeTypeFolder, Title: "A", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: "b", Type: canonical.NodeTypeFolder, Title: "B", Parent: canonical.NewNodeParent("a")},
	)
	csB := applyOp(t, svc, store, space, canonical.DeleteNode{SpaceID: space, NodeID: "b"})
	applyOp(t, svc, store, space, canonical.DeleteNode{SpaceID: space, NodeID: "a"})

	// Undo B's delete: its parent A is gone, so B must land in the recovery
	// root instead of being lost (doc 15 §7).
	res := undo(t, svc, space, csB)
	if res.Status != changeset.PlanClean {
		t.Fatalf("undo status = %s, want clean", res.Status)
	}
	if !nodeExists(t, store, space, "b") {
		t.Fatal("content lost instead of recovered")
	}
	if got := loadNode(t, store, space, "b").Parent; got.RootKey != "recovered:undo" {
		t.Fatalf("recovered parent = %+v, want recovery root", got)
	}
	var name string
	if err := store.db.QueryRow(`SELECT display_name FROM root_slots WHERE space_id = 's1' AND key = 'recovered:undo'`).Scan(&name); err != nil {
		t.Fatalf("recovery root slot missing: %v", err)
	}
}

func TestUndoExpiredBeyondWindow(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "bm", Type: canonical.NodeTypeBookmark,
		Title: "Go", URL: "https://go.dev", Parent: main,
	})
	cs := applyOp(t, svc, store, space, canonical.UpdateNodeTitle{SpaceID: space, NodeID: "bm", Title: "Old"})
	// Age the ChangeSet past the undo window.
	if _, err := store.db.Exec(`UPDATE changesets SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?`, cs); err != nil {
		t.Fatal(err)
	}

	res := undo(t, svc, space, cs)
	if res.Status != changeset.PlanExpired {
		t.Fatalf("undo status = %s, want expired", res.Status)
	}
	if got := loadNode(t, store, space, "bm").Title; got != "Old" {
		t.Fatalf("expired undo changed state: %q", got)
	}
}

func TestUndoImportBatchAsOneChangeSet(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	ctx := context.Background()
	main := canonical.NewRootParent("main")

	tx, err := store.BeginTx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	rec := svc.BeginBatch(space, changeset.KindImport, undoOrigin, true)
	cmds := []canonical.Command{
		canonical.CreateNode{SpaceID: space, NodeID: "f", Type: canonical.NodeTypeFolder, Title: "Imported", Parent: main},
		canonical.CreateNode{SpaceID: space, NodeID: "b1", Type: canonical.NodeTypeBookmark, Title: "One", URL: "https://one.dev", Parent: canonical.NewNodeParent("f")},
		canonical.CreateNode{SpaceID: space, NodeID: "b2", Type: canonical.NodeTypeBookmark, Title: "Two", URL: "https://two.dev", Parent: canonical.NewNodeParent("f")},
	}
	for _, cmd := range cmds {
		if err := rec.Apply(ctx, tx, cmd); err != nil {
			t.Fatalf("batch apply: %v", err)
		}
	}
	if _, err := rec.Finish(ctx, tx, "导入合并：新增 3 项"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	committed = true

	var csID string
	if err := store.db.QueryRow(`SELECT id FROM changesets WHERE space_id = ? AND kind = 'import'`, string(space)).Scan(&csID); err != nil {
		t.Fatalf("import changeset missing: %v", err)
	}

	res := undo(t, svc, space, csID)
	if res.Status != changeset.PlanClean {
		t.Fatalf("undo status = %s, want clean", res.Status)
	}
	for _, id := range []canonical.NodeID{"f", "b1", "b2"} {
		if nodeExists(t, store, space, id) {
			t.Fatalf("imported node %s still exists after undo", id)
		}
	}

	// With later foreign content inside the imported folder, undo requires
	// review instead of deleting the new data.
	tx2, err := store.BeginTx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rec2 := svc.BeginBatch(space, changeset.KindImport, undoOrigin, true)
	for _, cmd := range cmds {
		if err := rec2.Apply(ctx, tx2, cmd); err != nil {
			t.Fatalf("batch apply 2: %v", err)
		}
	}
	if _, err := rec2.Finish(ctx, tx2, "导入合并：新增 3 项"); err != nil {
		t.Fatal(err)
	}
	if err := tx2.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	mustExec(t, canonical.NewExecutor(), store, canonical.CreateNode{
		SpaceID: space, NodeID: "late", Type: canonical.NodeTypeBookmark,
		Title: "Late", URL: "https://late.dev", Parent: canonical.NewNodeParent("f"),
	})
	var csID2 string
	if err := store.db.QueryRow(`SELECT id FROM changesets WHERE space_id = ? AND kind = 'import' AND undone_by_changeset IS NULL`, string(space)).Scan(&csID2); err != nil {
		t.Fatalf("second import changeset missing: %v", err)
	}
	res2 := undo(t, svc, space, csID2)
	if res2.Status != changeset.PlanReviewRequired {
		t.Fatalf("undo status = %s, want review_required", res2.Status)
	}
	if !nodeExists(t, store, space, "late") {
		t.Fatal("review deleted later content")
	}
}

func TestUndoNotUndoableChangeSet(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	ctx := context.Background()
	main := canonical.NewRootParent("main")

	// Transfer-style batch: linked journal entries but no Before Image.
	tx, err := store.BeginTx(ctx)
	if err != nil {
		t.Fatal(err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	rec := svc.BeginBatch(space, changeset.KindTransferIn, undoOrigin, false)
	if err := rec.Apply(ctx, tx, canonical.CreateNode{
		SpaceID: space, NodeID: "in", Type: canonical.NodeTypeBookmark,
		Title: "In", URL: "https://in.dev", Parent: main,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := rec.Finish(ctx, tx, "跨空间转入 1 个条目"); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	committed = true

	var csID string
	if err := store.db.QueryRow(`SELECT id FROM changesets WHERE space_id = ? AND kind = 'transfer_in'`, string(space)).Scan(&csID); err != nil {
		t.Fatal(err)
	}
	res := undo(t, svc, space, csID)
	if res.Status != changeset.PlanNotUndoable {
		t.Fatalf("undo status = %s, want not_undoable", res.Status)
	}
	if !nodeExists(t, store, space, "in") {
		t.Fatal("not_undoable undo changed state")
	}
}

func TestUndoUnknownChangeSet(t *testing.T) {
	svc, _, space := setupUndoTest(t)
	if _, err := svc.Undo(context.Background(), space, "missing", "u1"); !errors.Is(err, changeset.ErrChangeSetNotFound) {
		t.Fatalf("err = %v, want ErrChangeSetNotFound", err)
	}
}

func TestChangeSetJournalLinkAndSummary(t *testing.T) {
	svc, store, space := setupUndoTest(t)
	main := canonical.NewRootParent("main")

	cs := applyOp(t, svc, store, space, canonical.CreateNode{
		SpaceID: space, NodeID: "bm", Type: canonical.NodeTypeBookmark,
		Title: "GitHub", URL: "https://github.com", Parent: main,
	})

	var linked int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM journal WHERE space_id = ? AND change_set_id = ?`,
		string(space), cs).Scan(&linked); err != nil {
		t.Fatal(err)
	}
	if linked != 1 {
		t.Fatalf("journal rows linked to changeset = %d, want 1", linked)
	}

	row := loadChangeSet(t, store, cs)
	if row.Summary != "新建了「GitHub」" {
		t.Fatalf("summary = %q", row.Summary)
	}
	if row.Kind != changeset.KindNodeCreate || row.FirstRevision != row.LastRevision {
		t.Fatalf("changeset = %+v", row)
	}
}
