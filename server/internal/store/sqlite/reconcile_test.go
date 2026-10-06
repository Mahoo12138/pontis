package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"pontis/internal/canonical"
	"pontis/internal/device"
	"pontis/internal/reconcile"
)

// setupReconcileTest returns a reconciliation service over one space
// (s1, root slot "main").
func setupReconcileTest(t *testing.T) (*reconcile.Service, *reconcileDeps) {
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
	return reconcile.NewService(NewReconcileStore(db)), &reconcileDeps{t: t, db: db}
}

type reconcileDeps struct {
	t  *testing.T
	db *sql.DB
}

// registerPendingBinding registers a device and binds it to s1 without
// activating: the binding stays pending_initial.
func (d *reconcileDeps) registerPendingBinding(name string) (deviceID, bindingID string) {
	d.t.Helper()
	devSvc := device.NewService(NewDeviceStore(d.db))
	dev, _, err := devSvc.RegisterDevice(context.Background(), "u1", name, "extension", "edge", "windows")
	if err != nil {
		d.t.Fatal(err)
	}
	binding, err := devSvc.BindSpace(context.Background(), dev.ID, canonical.SpaceID("s1"))
	if err != nil {
		d.t.Fatal(err)
	}
	return dev.ID, binding.ID
}

func (d *reconcileDeps) activateBinding(bindingID string) {
	d.t.Helper()
	if _, err := d.db.Exec(`UPDATE device_space_bindings SET state = 'active', initialized_at = '2026-01-01T00:00:00Z' WHERE id = ?`, bindingID); err != nil {
		d.t.Fatal(err)
	}
}

func (d *reconcileDeps) bindingWatermarks(bindingID string) (state string, epoch, applied, received int64) {
	d.t.Helper()
	err := d.db.QueryRow(`SELECT state, epoch, applied_revision, received_revision FROM device_space_bindings WHERE id = ?`, bindingID).
		Scan(&state, &epoch, &applied, &received)
	if err != nil {
		d.t.Fatal(err)
	}
	return
}

// mustNode loads a canonical node through a read transaction.
func (d *reconcileDeps) mustNode(id canonical.NodeID) canonical.Node {
	d.t.Helper()
	ctx := context.Background()
	tx, err := NewStore(d.db).BeginTx(ctx)
	if err != nil {
		d.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	node, err := tx.LoadNode(ctx, "s1", id)
	if err != nil {
		d.t.Fatalf("node %s: %v", id, err)
	}
	return node
}

// clientSnapshot builds a client snapshot in the doc 08 §10 wire shape.
func clientSnapshot(roots []reconcile.ClientRootJSON, nodes []reconcile.ClientNodeJSON) reconcile.ClientSnapshotJSON {
	return reconcile.ClientSnapshotJSON{Epoch: 0, Revision: 0, Roots: roots, Nodes: nodes}
}

func initialBrowserSnapshot() reconcile.ClientSnapshotJSON {
	return clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_f1", ParentLocalRef: "l_bar", Type: "folder", Title: "Development"},
			{LocalRef: "l_b1", ParentLocalRef: "l_f1", Type: "bookmark", Title: "GitHub", URL: "https://github.com"},
		},
	)
}

func TestReconcileInitialFlow(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "first pairing")
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}

	if _, _, err := svc.Plan(ctx, sess.ID); !errors.Is(err, reconcile.ErrSnapshotMissing) {
		t.Fatalf("plan before snapshots = %v, want ErrSnapshotMissing", err)
	}

	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, initialBrowserSnapshot()); err != nil {
		t.Fatalf("SubmitClientSnapshot: %v", err)
	}
	snap, err := svc.CreateServerSnapshot(ctx, bindingID)
	if err != nil {
		t.Fatalf("CreateServerSnapshot: %v", err)
	}
	if snap.Epoch != 1 || snap.Revision != 0 || snap.NodeCount != 1 {
		t.Fatalf("snapshot = %+v, want epoch 1 revision 0 with one root node", snap)
	}

	updated, issues, err := svc.Plan(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if len(issues) != 0 {
		t.Fatalf("clean merge must not raise issues: %+v", issues)
	}
	if updated.State != reconcile.StateRunning || updated.Phase != reconcile.PhasePlanned {
		t.Fatalf("state/phase = %s/%s, want running/planned", updated.State, updated.Phase)
	}

	steps, err := svc.Steps(ctx, sess.ID)
	if !errors.Is(err, reconcile.ErrInvalidSessionState) {
		t.Fatalf("steps before commit = %v, want ErrInvalidSessionState", err)
	}

	committed, err := svc.Commit(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if !committed.ServerCommitted || committed.CommitRevision != 2 {
		t.Fatalf("commit state: %+v", committed)
	}

	// The canonical tree now holds the imported browser nodes under the
	// pre-assigned ids the steps hand out.
	steps, err = svc.Steps(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Steps: %v", err)
	}
	ids := map[string]string{} // local ref → canonical id
	for _, step := range steps.Steps {
		if step.Kind != reconcile.StepAssignIdentity {
			t.Fatalf("empty-server initial merge must only assign identities: %+v", step)
		}
		ids[step.LocalRef] = step.CanonicalID
	}
	if len(ids) != 2 {
		t.Fatalf("want two identity assignments, got %v", ids)
	}
	folder := deps.mustNode(canonical.NodeID(ids["l_f1"]))
	if folder.Parent.RootKey != "main" || folder.Title != "Development" {
		t.Fatalf("folder node: %+v", folder)
	}
	bookmark := deps.mustNode(canonical.NodeID(ids["l_b1"]))
	if bookmark.Parent.NodeID != folder.ID || bookmark.URL != "https://github.com" {
		t.Fatalf("bookmark node: %+v", bookmark)
	}

	// Journal entries carry the reconciliation origin for same-binding
	// bookkeeping.
	var originType, originBinding string
	if err := deps.db.QueryRow(`SELECT origin_type, COALESCE(origin_binding_id, '') FROM journal WHERE space_id = 's1' AND revision = 1`).
		Scan(&originType, &originBinding); err != nil {
		t.Fatal(err)
	}
	if originType != "reconciliation" || originBinding != bindingID {
		t.Fatalf("journal origin = %s/%s", originType, originBinding)
	}

	done, err := svc.Complete(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if done.State != reconcile.StateCompleted {
		t.Fatalf("state = %s", done.State)
	}
	state, epoch, applied, received := deps.bindingWatermarks(bindingID)
	if state != "active" || epoch != 1 || applied != 2 || received != 2 {
		t.Fatalf("binding watermarks = %s %d %d %d", state, epoch, applied, received)
	}

	// A second session of the same type is no longer eligible.
	if _, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "again"); !errors.Is(err, reconcile.ErrBindingNotEligible) {
		t.Fatalf("second initial session = %v, want ErrBindingNotEligible", err)
	}
}

func TestReconcileOneActiveSessionPerBinding(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	if _, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "first"); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "second"); !errors.Is(err, reconcile.ErrActiveSessionExists) {
		t.Fatalf("second session = %v, want ErrActiveSessionExists", err)
	}
}

func TestReconcilePlanStale(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "pairing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, initialBrowserSnapshot()); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatal(err)
	}

	// The canonical head advances after the plan was computed.
	seedSystem(t, deps.db, canonical.CreateNode{
		SpaceID: "s1", NodeID: "nX", Type: canonical.NodeTypeBookmark,
		Title: "Late", URL: "https://late.example", Parent: canonical.NewRootParent("main"),
	})

	if _, err := svc.Commit(ctx, sess.ID); !errors.Is(err, reconcile.ErrPlanStale) {
		t.Fatalf("commit = %v, want ErrPlanStale", err)
	}
	// Re-planning against the new head succeeds.
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatalf("re-plan: %v", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("commit after re-plan: %v", err)
	}
}

func TestReconcileServerSnapshotStable(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")
	deps.activateBinding(bindingID)

	if _, err := svc.CreateSession(ctx, bindingID, reconcile.TypeFullResync, "drift"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, clientSnapshot(nil, nil)); err != nil {
		t.Fatal(err)
	}
	snap, err := svc.CreateServerSnapshot(ctx, bindingID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.NodeCount != 1 {
		t.Fatalf("node count = %d, want 1 (root only)", snap.NodeCount)
	}
	before, err := NewReconcileStore(deps.db).ListSnapshotNodes(ctx, snap.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}

	// Canonical writes after the snapshot must not leak into it.
	seedSystem(t, deps.db, canonical.CreateNode{
		SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeBookmark,
		Title: "New", URL: "https://new.example", Parent: canonical.NewRootParent("main"),
	})
	after, err := NewReconcileStore(deps.db).ListSnapshotNodes(ctx, snap.ID, 0, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) {
		t.Fatalf("snapshot mutated: %d → %d nodes", len(before), len(after))
	}
}

func TestReconcileMergePlan(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	// Canonical side: Development/Go.
	seedSystem(t, deps.db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeFolder,
			Title: "Development", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n2", Type: canonical.NodeTypeBookmark,
			Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("n1")},
	)

	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_f1", ParentLocalRef: "l_bar", Type: "folder", Title: "Development"},
			{LocalRef: "l_b1", ParentLocalRef: "l_f1", Type: "bookmark", Title: "Go (renamed)", URL: "https://go.dev"},
			{LocalRef: "l_b2", ParentLocalRef: "l_f1", Type: "bookmark", Title: "Browser only", URL: "https://only.example"},
		},
	)

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "pairing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	_, _, err = svc.Plan(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// Matched bookmark: source title wins through an UPDATE.
	n2 := deps.mustNode("n2")
	if n2.Title != "Go (renamed)" {
		t.Fatalf("matched node title = %q", n2.Title)
	}
	// Browser-only bookmark was created under the matched folder.
	var count int
	if err := deps.db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE space_id = 's1' AND url = 'https://only.example'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("browser-only bookmark missing (count=%d)", count)
	}
}

func TestReconcileAmbiguityDecision(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")

	// Two identical bookmarks on the server: the browser counterpart is
	// ambiguous and must not be guessed (doc 06 §6).
	seedSystem(t, deps.db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "t1", Type: canonical.NodeTypeBookmark,
			Title: "First", URL: "https://x.example", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "t2", Type: canonical.NodeTypeBookmark,
			Title: "Second", URL: "https://x.example", Parent: canonical.NewRootParent("main")},
	)

	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l_b1", ParentLocalRef: "l_bar", Type: "bookmark", Title: "Same", URL: "https://x.example"},
		},
	)

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeInitial, "pairing")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateServerSnapshot(ctx, bindingID); err != nil {
		t.Fatal(err)
	}
	sess, issues, err := svc.Plan(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if sess.State != reconcile.StateWaitingUser || len(issues) != 1 {
		t.Fatalf("state = %s issues = %d, want waiting_user with one issue", sess.State, len(issues))
	}
	if len(issues[0].Payload.Candidates) != 2 {
		t.Fatalf("candidates: %+v", issues[0])
	}

	// The user picks t2 as the real counterpart.
	updated, _, err := svc.Decide(ctx, sess.ID, map[string]string{issues[0].ID: "t2"})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if updated.State != reconcile.StateRunning {
		t.Fatalf("state after decision = %s, want running", updated.State)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// t2 keeps its identity and takes the source title; t1 survives as a
	// target-only keep (merge never deletes).
	t2 := deps.mustNode("t2")
	if t2.Title != "Same" {
		t.Fatalf("t2 title = %q, want the source title", t2.Title)
	}
	t1 := deps.mustNode("t1")
	if t1.Title != "First" {
		t.Fatalf("t1 title = %q", t1.Title)
	}
}

func TestReconcileFullResyncFlow(t *testing.T) {
	svc, deps := setupReconcileTest(t)
	ctx := context.Background()
	_, bindingID := deps.registerPendingBinding("Edge")
	deps.activateBinding(bindingID)

	seedSystem(t, deps.db, canonical.CreateNode{SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeBookmark,
		Title: "Server", URL: "https://srv.example", Parent: canonical.NewRootParent("main")})

	// Browser holds the mapped node plus one local extra that full resync
	// drops (no pending intent by definition of a resync).
	snapshot := clientSnapshot(
		[]reconcile.ClientRootJSON{{LocalRef: "l_bar", RootKey: "main", Title: "Bar"}},
		[]reconcile.ClientNodeJSON{
			{LocalRef: "l1", ParentLocalRef: "l_bar", Type: "bookmark", Title: "Server", URL: "https://srv.example", CanonicalID: "n1"},
			{LocalRef: "l2", ParentLocalRef: "l_bar", Type: "bookmark", Title: "Local extra", URL: "https://extra.example"},
		},
	)

	sess, err := svc.CreateSession(ctx, bindingID, reconcile.TypeFullResync, "history expired")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitClientSnapshot(ctx, bindingID, snapshot); err != nil {
		t.Fatal(err)
	}
	snap, err := svc.CreateServerSnapshot(ctx, bindingID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Plan(ctx, sess.ID); err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if _, err := svc.Commit(ctx, sess.ID); err != nil {
		t.Fatalf("Commit: %v", err)
	}

	// The commit must not have touched the canonical tree.
	var revision int64
	if err := deps.db.QueryRow(`SELECT current_revision FROM sync_spaces WHERE id = 's1'`).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	if revision != 1 {
		t.Fatalf("resync commit changed the canonical revision to %d", revision)
	}

	steps, err := svc.Steps(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Steps: %v", err)
	}
	deletes := 0
	for _, step := range steps.Steps {
		if step.Kind == reconcile.StepDelete && step.LocalRef == "l2" {
			deletes++
		}
	}
	if deletes != 1 {
		t.Fatalf("resync must delete the browser-only node: %+v", steps.Steps)
	}

	done, err := svc.Complete(ctx, sess.ID)
	if err != nil {
		t.Fatalf("Complete: %v", err)
	}
	if done.CommitRevision != 1 {
		t.Fatalf("commit revision = %d, want 1", done.CommitRevision)
	}
	state, _, applied, received := deps.bindingWatermarks(bindingID)
	if state != "active" || applied != snap.Revision || received != snap.Revision {
		t.Fatalf("watermarks after resync = %s %d %d, want snapshot revision %d", state, applied, received, snap.Revision)
	}
}
