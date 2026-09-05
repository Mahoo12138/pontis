package sqlite

import (
	"context"
	"errors"
	"testing"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
	"pontis/internal/spacetransfer"
)

// setupTransferTest seeds two spaces owned by u1 (plus u2's space for
// cross-owner cases) with default root slots.
func setupTransferTest(t *testing.T) (*spacetransfer.Service, *Store) {
	t.Helper()
	db := openTestDB(t)
	if err := Migrate(context.Background(), db); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	store := NewStore(db)
	for _, row := range []string{
		`('s1', 'u1', 'Source', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		`('s2', 'u1', 'Target', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
		`('s3', 'u2', 'Foreign', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
	} {
		if _, err := db.Exec(`INSERT INTO sync_spaces (id, owner_user_id, name, created_at, updated_at) VALUES ` + row); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []string{
		`('s1', 'main', 'Main', 0, '2026-01-01T00:00:00Z')`,
		`('s2', 'main', 'Main', 0, '2026-01-01T00:00:00Z')`,
		`('s3', 'main', 'Main', 0, '2026-01-01T00:00:00Z')`,
	} {
		if _, err := db.Exec(`INSERT INTO root_slots (space_id, key, display_name, position, created_at) VALUES ` + row); err != nil {
			t.Fatal(err)
		}
	}
	return spacetransfer.NewService(store, changeset.NewService(NewChangeSetStore(db))), store
}

func seedTransferSource(t *testing.T, store *Store) canonical.NodeID {
	t.Helper()
	e := canonical.NewExecutor()
	mustExec(t, e, store,
		canonical.CreateNode{SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeFolder, Title: "Dev", Parent: canonical.NewRootParent("main")},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n2", Type: canonical.NodeTypeBookmark, Title: "Go", URL: "https://go.dev", Parent: canonical.NewNodeParent("n1")},
	)
	return "n1"
}

func TestTransferMovesSubtreeAtomically(t *testing.T) {
	svc, store := setupTransferTest(t)
	root := seedTransferSource(t, store)

	res, err := svc.Transfer(context.Background(), "u1", spacetransfer.Request{
		TransferID:   "t-1",
		SourceSpace:  "s1",
		TargetSpace:  "s2",
		NodeID:       root,
		TargetParent: canonical.NewRootParent("main"),
	})
	if err != nil {
		t.Fatalf("Transfer: %v", err)
	}

	if len(res.Mapping) != 2 {
		t.Fatalf("mapping = %v", res.Mapping)
	}
	if res.TargetRevision != 2 || res.SourceRevision != 3 {
		t.Errorf("revisions = target %d / source %d", res.TargetRevision, res.SourceRevision)
	}

	// Source is empty again; target holds the fresh-id subtree.
	if nodeExists(t, store, "s1", "n1") || nodeExists(t, store, "s1", "n2") {
		t.Error("source subtree still present")
	}
	bySrc := map[string]string{}
	for _, m := range res.Mapping {
		bySrc[m.SourceNodeID.String()] = m.TargetNodeID.String()
	}
	folder := loadNode(t, store, "s2", canonical.NodeID(bySrc["n1"]))
	if folder.Parent.Type != canonical.ParentTypeRoot || folder.Parent.RootKey != "main" {
		t.Errorf("folder parent = %+v", folder.Parent)
	}
	child := loadNode(t, store, "s2", canonical.NodeID(bySrc["n2"]))
	if child.Title != "Go" || child.URL != "https://go.dev" {
		t.Errorf("child = %+v", child)
	}
	if child.Parent.NodeID != folder.ID {
		t.Errorf("child parent = %+v", child.Parent)
	}
	if bySrc["n1"] == "n1" || bySrc["n2"] == "n2" {
		t.Error("mapping must produce fresh uuids")
	}

	// Journal: 2 creates in target, 1 delete in source, tombstones written.
	var creates, deletes int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM journal WHERE space_id = 's2' AND change_type = 'create'`).Scan(&creates); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM journal WHERE space_id = 's1' AND change_type = 'delete'`).Scan(&deletes); err != nil {
		t.Fatal(err)
	}
	if creates != 2 || deletes != 1 {
		t.Errorf("journal creates=%d deletes=%d", creates, deletes)
	}
	var tombstones int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM tombstones WHERE space_id = 's1'`).Scan(&tombstones); err != nil {
		t.Fatal(err)
	}
	if tombstones != 2 {
		t.Errorf("tombstones = %d, want 2", tombstones)
	}
}

func TestTransferIsIdempotentOnTransferID(t *testing.T) {
	svc, store := setupTransferTest(t)
	root := seedTransferSource(t, store)
	req := spacetransfer.Request{
		TransferID:   "t-1",
		SourceSpace:  "s1",
		TargetSpace:  "s2",
		NodeID:       root,
		TargetParent: canonical.NewRootParent("main"),
	}

	first, err := svc.Transfer(context.Background(), "u1", req)
	if err != nil {
		t.Fatalf("first transfer: %v", err)
	}

	replayed, err := svc.Transfer(context.Background(), "u1", req)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if len(replayed.Mapping) != len(first.Mapping) {
		t.Fatalf("replay mapping = %v, want %v", replayed.Mapping, first.Mapping)
	}
	for _, m := range first.Mapping {
		found := false
		for _, r := range replayed.Mapping {
			if r == m {
				found = true
			}
		}
		if !found {
			t.Errorf("replay missing mapping %v", m)
		}
	}
	// No duplicate revisions were allocated by the replay.
	if got := currentRevision(t, store, "s2"); got != first.TargetRevision {
		t.Errorf("target revision after replay = %d, want %d", got, first.TargetRevision)
	}
}

func TestTransferIDReusedWithDifferentPayload(t *testing.T) {
	svc, store := setupTransferTest(t)
	root := seedTransferSource(t, store)
	if _, err := svc.Transfer(context.Background(), "u1", spacetransfer.Request{
		TransferID: "t-1", SourceSpace: "s1", TargetSpace: "s2", NodeID: root,
		TargetParent: canonical.NewRootParent("main"),
	}); err != nil {
		t.Fatalf("first transfer: %v", err)
	}
	// Seed another subtree so the conflicting request is structurally valid.
	mustExec(t, canonical.NewExecutor(), store,
		canonical.CreateNode{SpaceID: "s1", NodeID: "n9", Type: canonical.NodeTypeFolder, Title: "Other", Parent: canonical.NewRootParent("main")},
	)
	_, err := svc.Transfer(context.Background(), "u1", spacetransfer.Request{
		TransferID: "t-1", SourceSpace: "s1", TargetSpace: "s2", NodeID: "n9",
		TargetParent: canonical.NewRootParent("main"),
	})
	if !errors.Is(err, spacetransfer.ErrTransferIDReused) {
		t.Fatalf("err = %v, want ErrTransferIDReused", err)
	}
}

func TestTransferRejectsCrossOwnerAndBadTargets(t *testing.T) {
	svc, store := setupTransferTest(t)
	root := seedTransferSource(t, store)
	ctx := context.Background()

	if _, err := svc.Transfer(ctx, "u2", spacetransfer.Request{
		TransferID: "t-o", SourceSpace: "s1", TargetSpace: "s2", NodeID: root,
		TargetParent: canonical.NewRootParent("main"),
	}); !errors.Is(err, spacetransfer.ErrNotSpaceOwner) {
		t.Errorf("cross owner err = %v", err)
	}
	if _, err := svc.Transfer(ctx, "u1", spacetransfer.Request{
		TransferID: "t-s", SourceSpace: "s1", TargetSpace: "s1", NodeID: root,
		TargetParent: canonical.NewRootParent("main"),
	}); !errors.Is(err, spacetransfer.ErrSameSpace) {
		t.Errorf("same space err = %v", err)
	}
	if _, err := svc.Transfer(ctx, "u1", spacetransfer.Request{
		TransferID: "t-n", SourceSpace: "s1", TargetSpace: "s2", NodeID: root,
		TargetParent: canonical.NewNodeParent("missing"),
	}); !errors.Is(err, spacetransfer.ErrTargetParentInvalid) {
		t.Errorf("bad parent err = %v", err)
	}
	if _, err := svc.Transfer(ctx, "u1", spacetransfer.Request{
		TransferID: "t-x", SourceSpace: "s1", TargetSpace: "s2", NodeID: "nope",
		TargetParent: canonical.NewRootParent("main"),
	}); !errors.Is(err, canonical.ErrNodeNotFound) {
		t.Errorf("unknown node err = %v", err)
	}
	// Nothing was transferred by the failed attempts.
	if got := currentRevision(t, store, "s2"); got != 0 {
		t.Errorf("target revision = %d, want 0", got)
	}
}
