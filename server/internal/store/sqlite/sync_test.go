package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
	"pontis/internal/device"
	"pontis/internal/sync"
)

const testUser = `INSERT INTO users (id, username, username_normalized, display_name, password_hash, role, status, locale, password_changed_at, created_at, updated_at)
	VALUES ('u1', 'alice', 'alice', 'Alice', 'x', 'admin', 'active', 'zh-CN', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`

const testSpace = `INSERT INTO sync_spaces (id, owner_user_id, name, created_at, updated_at)
	VALUES ('s1', 'u1', 'Main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`

const testRootSlot = `INSERT INTO root_slots (space_id, key, display_name, position, created_at)
	VALUES ('s1', 'main', 'Main', 0, '2026-01-01T00:00:00Z')`

// setupSyncTest returns a sync service with one active device bound to
// space "s1" (root slot "main").
func setupSyncTest(t *testing.T) (*sync.Service, *sql.DB, string) {
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
	devID := registerBoundDevice(t, db, "Edge")
	return sync.NewService(NewSyncStore(db), changeset.NewService(NewChangeSetStore(db))), db, devID
}

func registerBoundDevice(t *testing.T, db *sql.DB, name string) string {
	t.Helper()
	devSvc := device.NewService(NewDeviceStore(db))
	dev, _, err := devSvc.RegisterDevice(context.Background(), "u1", name, "extension", "edge", "windows")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := devSvc.BindSpace(context.Background(), dev.ID, canonical.SpaceID("s1")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE device_space_bindings SET state = 'active', initialized_at = '2026-01-01T00:00:00Z' WHERE device_id = ?`, dev.ID); err != nil {
		t.Fatal(err)
	}
	return dev.ID
}

func seedSystem(t *testing.T, db *sql.DB, cmds ...canonical.Command) {
	t.Helper()
	err := canonical.NewExecutor().Execute(context.Background(), NewStore(db),
		canonical.Origin{Type: canonical.OriginSystem}, cmds...)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func syncReq(devID string, epoch, applied, received int64, ops ...sync.Operation) sync.SyncRequest {
	return sync.SyncRequest{
		ProtocolVersion:  sync.ProtocolVersion,
		DeviceID:         canonical.DeviceID(devID),
		DeviceName:       "Edge",
		SpaceID:          canonical.SpaceID("s1"),
		Epoch:            epoch,
		AppliedRevision:  applied,
		ReceivedRevision: received,
		Operations:       ops,
	}
}

func mustSync(t *testing.T, svc *sync.Service, req sync.SyncRequest) sync.SyncResponse {
	t.Helper()
	resp, err := svc.Sync(context.Background(), req)
	if err != nil {
		t.Fatalf("Sync: %v", err)
	}
	return resp
}

func mustProtocolErr(t *testing.T, svc *sync.Service, req sync.SyncRequest, code string) {
	t.Helper()
	_, err := svc.Sync(context.Background(), req)
	var perr *sync.ProtocolError
	if !errors.As(err, &perr) {
		t.Fatalf("err = %v, want ProtocolError %s", err, code)
	}
	if perr.Code != code {
		t.Fatalf("code = %s, want %s", perr.Code, code)
	}
}

func loadNodeRow(t *testing.T, db *sql.DB, id canonical.NodeID) canonical.Node {
	t.Helper()
	store := &Store{db: db}
	n, err := scanNode(store.db.QueryRow(nodeColumns+` FROM nodes WHERE space_id = ? AND id = ?`, "s1", string(id)))
	if err != nil {
		t.Fatalf("load node %s: %v", id, err)
	}
	return n
}

func TestSyncCreateAndIdempotentReplay(t *testing.T) {
	svc, db, devID := setupSyncTest(t)
	main := canonical.NewRootParent("main")

	op := sync.Operation{
		OpID: "op-1", ClientSeq: 1, BaseRevision: 0,
		Type: sync.OpCreate, NodeID: "n1", NodeType: canonical.NodeTypeFolder,
		Title: "Dev", Parent: main,
	}
	resp := mustSync(t, svc, syncReq(devID, 1, 0, 0, op))
	if len(resp.OperationResults) != 1 {
		t.Fatalf("results = %d", len(resp.OperationResults))
	}
	res := resp.OperationResults[0]
	if res.Status != sync.StatusApplied {
		t.Errorf("status = %s, want APPLIED", res.Status)
	}
	if res.ResultRevision != 1 {
		t.Errorf("result_revision = %d, want 1", res.ResultRevision)
	}
	if resp.ServerRevision != 1 || resp.FromRevision != 1 || resp.ThroughRevision != 1 || resp.HasMore {
		t.Errorf("unexpected response envelope: %+v", resp)
	}
	// Client's own change flows back in the stream (doc 04 §13).
	if len(resp.Changes) != 1 || resp.Changes[0].Type != "create" || resp.Changes[0].Revision != 1 {
		t.Errorf("changes = %+v", resp.Changes)
	}

	// Duplicate submission: same op_id + same content replays the stored
	// receipt without consuming a revision.
	resp2 := mustSync(t, svc, syncReq(devID, 1, 1, 1, op))
	if resp2.OperationResults[0].Status != sync.StatusApplied || resp2.OperationResults[0].ResultRevision != 1 {
		t.Errorf("replay result = %+v", resp2.OperationResults[0])
	}
	if resp2.ServerRevision != 1 {
		t.Errorf("replay consumed a revision: server = %d", resp2.ServerRevision)
	}

	// Binding watermarks persisted.
	var maxSeq, received int64
	if err := db.QueryRow(`SELECT max_client_seq, received_revision FROM device_space_bindings WHERE device_id = ?`, devID).
		Scan(&maxSeq, &received); err != nil {
		t.Fatal(err)
	}
	if maxSeq != 1 || received != 1 {
		t.Errorf("binding watermarks = (%d, %d), want (1, 1)", maxSeq, received)
	}
}

func TestSyncDeleteWinsOverStaleUpdate(t *testing.T) {
	svc, db, devA := setupSyncTest(t)
	devB := registerBoundDevice(t, db, "Firefox")
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "x", Type: canonical.NodeTypeBookmark, Title: "Old", URL: "https://x", Parent: main},
	)
	// rev 1 = create x

	// A deletes x.
	delOp := sync.Operation{OpID: "a-del", ClientSeq: 1, BaseRevision: 1, Type: sync.OpDelete, NodeID: "x"}
	resp := mustSync(t, svc, syncReq(devA, 1, 1, 1, delOp))
	if resp.OperationResults[0].Status != sync.StatusApplied {
		t.Fatalf("delete status = %s", resp.OperationResults[0].Status)
	}

	// B, still anchored at rev 1, renames the deleted node.
	updOp := sync.Operation{OpID: "b-upd", ClientSeq: 1, BaseRevision: 1, Type: sync.OpUpdateTitle, NodeID: "x", Title: "New"}
	resp = mustSync(t, svc, syncReq(devB, 1, 1, 1, updOp))
	res := resp.OperationResults[0]
	if res.Status != sync.StatusRejected || res.Reason != sync.ReasonTargetDeleted {
		t.Fatalf("stale update result = %+v, want REJECTED target_deleted", res)
	}
	if res.SettleAfterRevision != 2 {
		t.Errorf("settle = %d, want 2", res.SettleAfterRevision)
	}

	// No resurrection: node stays deleted, no new revision consumed.
	if resp.ServerRevision != 2 {
		t.Errorf("server revision = %d, want 2", resp.ServerRevision)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM nodes WHERE id = 'x'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Error("deleted node was resurrected")
	}
}

func TestSyncSameFieldConflictAndNoop(t *testing.T) {
	svc, db, devA := setupSyncTest(t)
	devB := registerBoundDevice(t, db, "Firefox")
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "x", Type: canonical.NodeTypeBookmark, Title: "Old", URL: "https://x", Parent: main},
	) // rev 1

	// A renames first.
	resp := mustSync(t, svc, syncReq(devA, 1, 1, 1,
		sync.Operation{OpID: "a-t", ClientSeq: 1, BaseRevision: 1, Type: sync.OpUpdateTitle, NodeID: "x", Title: "New"},
	))
	if resp.OperationResults[0].Status != sync.StatusApplied {
		t.Fatalf("A update = %+v", resp.OperationResults[0])
	}

	// B concurrently renames to a different value: conflict.
	resp = mustSync(t, svc, syncReq(devB, 1, 1, 1,
		sync.Operation{OpID: "b-t1", ClientSeq: 1, BaseRevision: 1, Type: sync.OpUpdateTitle, NodeID: "x", Title: "Other"},
	))
	res := resp.OperationResults[0]
	if res.Status != sync.StatusConflict || res.Reason != sync.ReasonConcurrentUpdate {
		t.Fatalf("B conflict = %+v", res)
	}
	if res.SettleAfterRevision != 2 {
		t.Errorf("settle = %d, want 2", res.SettleAfterRevision)
	}
	if resp.ServerRevision != 2 {
		t.Errorf("conflict consumed a revision: %d", resp.ServerRevision)
	}

	// B concurrently renames to the same value: noop.
	resp = mustSync(t, svc, syncReq(devB, 1, 1, 1,
		sync.Operation{OpID: "b-t2", ClientSeq: 2, BaseRevision: 1, Type: sync.OpUpdateTitle, NodeID: "x", Title: "New"},
	))
	res = resp.OperationResults[0]
	if res.Status != sync.StatusNoop || res.Reason != sync.ReasonConcurrentUpdate {
		t.Fatalf("B noop = %+v", res)
	}

	// The canonical title stays "New".
	if n := loadNodeRow(t, db, "x"); n.Title != "New" {
		t.Errorf("title = %q, want New", n.Title)
	}
}

func TestSyncDifferentDimensionsMerge(t *testing.T) {
	svc, db, devA := setupSyncTest(t)
	devB := registerBoundDevice(t, db, "Firefox")
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "f", Type: canonical.NodeTypeFolder, Title: "F", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "x", Type: canonical.NodeTypeBookmark, Title: "Old", URL: "https://x", Parent: main},
	) // revs 1-2

	// A moves x into f.
	resp := mustSync(t, svc, syncReq(devA, 1, 2, 2,
		sync.Operation{OpID: "a-m", ClientSeq: 1, BaseRevision: 2, Type: sync.OpMove, NodeID: "x", Parent: canonical.NewNodeParent("f")},
	))
	if resp.OperationResults[0].Status != sync.StatusApplied {
		t.Fatalf("A move = %+v", resp.OperationResults[0])
	}

	// B concurrently renames: different field dimensions merge.
	resp = mustSync(t, svc, syncReq(devB, 1, 2, 2,
		sync.Operation{OpID: "b-t", ClientSeq: 1, BaseRevision: 2, Type: sync.OpUpdateTitle, NodeID: "x", Title: "New"},
	))
	if resp.OperationResults[0].Status != sync.StatusApplied {
		t.Fatalf("B rename should merge, got %+v", resp.OperationResults[0])
	}

	n := loadNodeRow(t, db, "x")
	if n.Title != "New" || n.Parent != canonical.NewNodeParent("f") {
		t.Errorf("merged state wrong: title=%q parent=%+v", n.Title, n.Parent)
	}
}

func TestSyncSameBindingCausality(t *testing.T) {
	svc, db, devID := setupSyncTest(t)
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "p1", Type: canonical.NodeTypeFolder, Title: "P1", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "p2", Type: canonical.NodeTypeFolder, Title: "P2", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "x", Type: canonical.NodeTypeBookmark, Title: "X", URL: "https://x", Parent: main},
	) // revs 1-3

	// Two quick moves from the same binding, both based on rev 3. The
	// second must not be misjudged as concurrent (doc 04 §9).
	resp := mustSync(t, svc, syncReq(devID, 1, 3, 3,
		sync.Operation{OpID: "m1", ClientSeq: 51, BaseRevision: 3, Type: sync.OpMove, NodeID: "x", Parent: canonical.NewNodeParent("p1")},
		sync.Operation{OpID: "m2", ClientSeq: 52, BaseRevision: 3, Type: sync.OpMove, NodeID: "x", Parent: canonical.NewNodeParent("p2")},
	))
	for i, res := range resp.OperationResults {
		if res.Status != sync.StatusApplied {
			t.Errorf("move %d result = %+v, want APPLIED", i, res)
		}
	}
	if n := loadNodeRow(t, db, "x"); n.Parent != canonical.NewNodeParent("p2") {
		t.Errorf("x parent = %+v, want p2", n.Parent)
	}
}

func TestSyncConcurrentMoveConflict(t *testing.T) {
	svc, db, devA := setupSyncTest(t)
	devB := registerBoundDevice(t, db, "Firefox")
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "p1", Type: canonical.NodeTypeFolder, Title: "P1", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "p2", Type: canonical.NodeTypeFolder, Title: "P2", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "x", Type: canonical.NodeTypeBookmark, Title: "X", URL: "https://x", Parent: main},
	) // revs 1-3

	mustSync(t, svc, syncReq(devA, 1, 3, 3,
		sync.Operation{OpID: "a-m", ClientSeq: 1, BaseRevision: 3, Type: sync.OpMove, NodeID: "x", Parent: canonical.NewNodeParent("p1")},
	))
	resp := mustSync(t, svc, syncReq(devB, 1, 3, 3,
		sync.Operation{OpID: "b-m", ClientSeq: 1, BaseRevision: 3, Type: sync.OpMove, NodeID: "x", Parent: canonical.NewNodeParent("p2")},
	))
	res := resp.OperationResults[0]
	if res.Status != sync.StatusConflict || res.Reason != sync.ReasonConcurrentMove {
		t.Fatalf("concurrent move = %+v, want CONFLICT concurrent_move", res)
	}
	if n := loadNodeRow(t, db, "x"); n.Parent != canonical.NewNodeParent("p1") {
		t.Errorf("winning parent wrong: %+v", n.Parent)
	}
}

func TestSyncStaleAnchorRebased(t *testing.T) {
	svc, db, devID := setupSyncTest(t)
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "a", Type: canonical.NodeTypeBookmark, Title: "A", URL: "https://a", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "b", Type: canonical.NodeTypeBookmark, Title: "B", URL: "https://b", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "c", Type: canonical.NodeTypeBookmark, Title: "C", URL: "https://c", Parent: main},
	) // revs 1-3; main = [a, b, c]

	// Anchor a is deleted after the client's base.
	seedSystem(t, db, canonical.DeleteNode{SpaceID: "s1", NodeID: "a"}) // rev 4; main = [b, c]

	before := canonical.NodeID("a")
	resp := mustSync(t, svc, syncReq(devID, 1, 3, 3,
		sync.Operation{
			OpID: "m", ClientSeq: 1, BaseRevision: 3, Type: sync.OpMove,
			NodeID: "b", Parent: main, BeforeID: &before,
		},
	))
	res := resp.OperationResults[0]
	if res.Status != sync.StatusRebased || res.Reason != sync.ReasonAnchorDeleted {
		t.Fatalf("stale anchor result = %+v, want REBASED anchor_deleted", res)
	}
	// Fallback is append: b moves to the end of [b, c] -> [c, b].
	if n := loadNodeRow(t, db, "b"); n.Position != 1 {
		t.Errorf("b position = %d, want 1 (append fallback)", n.Position)
	}
}

func TestSyncOfflineCreateRecovered(t *testing.T) {
	svc, db, devID := setupSyncTest(t)
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "f", Type: canonical.NodeTypeFolder, Title: "F", Parent: main},
	) // rev 1
	seedSystem(t, db, canonical.DeleteNode{SpaceID: "s1", NodeID: "f"}) // rev 2; client base is 1

	// Offline CREATE under the now-deleted folder: new data is protected.
	resp := mustSync(t, svc, syncReq(devID, 1, 1, 1,
		sync.Operation{
			OpID: "c", ClientSeq: 1, BaseRevision: 1, Type: sync.OpCreate,
			NodeID: "x", NodeType: canonical.NodeTypeBookmark, Title: "X", URL: "https://x",
			Parent: canonical.NewNodeParent("f"),
		},
	))
	res := resp.OperationResults[0]
	if res.Status != sync.StatusRecovered || res.Reason != sync.ReasonParentDeleted {
		t.Fatalf("recovery result = %+v, want RECOVERED parent_deleted", res)
	}
	if res.ResultRevision != 3 {
		t.Errorf("result revision = %d, want 3", res.ResultRevision)
	}

	// The node exists under the device recovery root slot.
	n := loadNodeRow(t, db, "x")
	wantKey := "recovered:" + devID
	if n.Parent.Type != canonical.ParentTypeRoot || n.Parent.RootKey != wantKey {
		t.Errorf("recovered parent = %+v, want root %q", n.Parent, wantKey)
	}
	var displayName string
	if err := db.QueryRow(`SELECT display_name FROM root_slots WHERE space_id = 's1' AND key = ?`, wantKey).
		Scan(&displayName); err != nil {
		t.Fatalf("recovery root slot missing: %v", err)
	}
	if displayName != "Recovered/Edge" {
		t.Errorf("recovery display name = %q", displayName)
	}
}

func TestSyncDeleteAlreadyDeletedIsNoop(t *testing.T) {
	svc, db, devA := setupSyncTest(t)
	devB := registerBoundDevice(t, db, "Firefox")
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "x", Type: canonical.NodeTypeBookmark, Title: "X", URL: "https://x", Parent: main},
	)
	mustSync(t, svc, syncReq(devA, 1, 1, 1,
		sync.Operation{OpID: "a-d", ClientSeq: 1, BaseRevision: 1, Type: sync.OpDelete, NodeID: "x"},
	))

	// B asks to delete the already-deleted node: intent already satisfied.
	resp := mustSync(t, svc, syncReq(devB, 1, 1, 1,
		sync.Operation{OpID: "b-d", ClientSeq: 1, BaseRevision: 1, Type: sync.OpDelete, NodeID: "x"},
	))
	res := resp.OperationResults[0]
	if res.Status != sync.StatusNoop || res.Reason != sync.ReasonAlreadyDeleted {
		t.Fatalf("double delete = %+v, want NOOP already_deleted", res)
	}
}

func TestSyncProtocolErrors(t *testing.T) {
	svc, db, devID := setupSyncTest(t)
	main := canonical.NewRootParent("main")
	ctx := context.Background()

	// Unsupported protocol version.
	mustProtocolErr(t, svc, func() sync.SyncRequest {
		r := syncReq(devID, 1, 0, 0)
		r.ProtocolVersion = 99
		return r
	}(), sync.CodeSyncProtocolUnsupported)

	// Binding not active: fresh device bound but pending initial.
	devSvc := device.NewService(NewDeviceStore(db))
	dev2, _, _ := devSvc.RegisterDevice(ctx, "u1", "Chrome", "extension", "chrome", "windows")
	_, _ = devSvc.BindSpace(ctx, dev2.ID, canonical.SpaceID("s1"))
	mustProtocolErr(t, svc, syncReq(dev2.ID, 1, 0, 0), sync.CodeBindingNotActive)

	// Epoch mismatch.
	mustProtocolErr(t, svc, syncReq(devID, 2, 0, 0), sync.CodeEpochMismatch)

	// Invalid watermark: applied > received.
	mustProtocolErr(t, svc, syncReq(devID, 1, 5, 3), sync.CodeInvalidWatermark)

	// History expired: journal floor ahead of client's received revision.
	if _, err := db.Exec(`UPDATE sync_spaces SET current_revision = 20, journal_floor_revision = 5 WHERE id = 's1'`); err != nil {
		t.Fatal(err)
	}
	mustProtocolErr(t, svc, syncReq(devID, 1, 3, 3), sync.CodeHistoryExpired)

	// Operation history expired: pending op predates the floor.
	mustProtocolErr(t, svc, syncReq(devID, 1, 10, 10,
		sync.Operation{OpID: "old", ClientSeq: 1, BaseRevision: 3, Type: sync.OpDelete, NodeID: "x"},
	), sync.CodeOperationHistoryExpired)

	// Client seq regression for a new op id.
	mustSync(t, svc, syncReq(devID, 1, 10, 10,
		sync.Operation{OpID: "s10", ClientSeq: 10, BaseRevision: 10, Type: sync.OpCreate, NodeID: "n10", NodeType: canonical.NodeTypeFolder, Title: "T", Parent: main},
	))
	mustProtocolErr(t, svc, syncReq(devID, 1, 11, 11,
		sync.Operation{OpID: "s9", ClientSeq: 9, BaseRevision: 10, Type: sync.OpDelete, NodeID: "n10"},
	), sync.CodeClientSeqRegressed)

	// Op id reused with a different payload.
	mustProtocolErr(t, svc, syncReq(devID, 1, 11, 11,
		sync.Operation{OpID: "s10", ClientSeq: 10, BaseRevision: 10, Type: sync.OpCreate, NodeID: "n10", NodeType: canonical.NodeTypeFolder, Title: "Different", Parent: main},
	), sync.CodeOpIDReused)
}

func TestSyncChangeStreamPagination(t *testing.T) {
	svc, db, devID := setupSyncTest(t)
	main := canonical.NewRootParent("main")

	// Five system changes.
	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "n1", Type: canonical.NodeTypeBookmark, Title: "1", URL: "https://1", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n2", Type: canonical.NodeTypeBookmark, Title: "2", URL: "https://2", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n3", Type: canonical.NodeTypeBookmark, Title: "3", URL: "https://3", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n4", Type: canonical.NodeTypeBookmark, Title: "4", URL: "https://4", Parent: main},
		canonical.CreateNode{SpaceID: "s1", NodeID: "n5", Type: canonical.NodeTypeBookmark, Title: "5", URL: "https://5", Parent: main},
	)

	req := syncReq(devID, 1, 0, 0)
	req.MaxChanges = 3
	resp := mustSync(t, svc, req)
	if len(resp.Changes) != 3 || !resp.HasMore {
		t.Fatalf("page 1: %d changes, has_more = %v", len(resp.Changes), resp.HasMore)
	}
	if resp.FromRevision != 1 || resp.ThroughRevision != 3 || resp.ServerRevision != 5 {
		t.Errorf("page 1 envelope = %+v", resp)
	}

	req2 := syncReq(devID, 1, 3, 3)
	req2.MaxChanges = 3
	resp2 := mustSync(t, svc, req2)
	if len(resp2.Changes) != 2 || resp2.HasMore {
		t.Fatalf("page 2: %d changes, has_more = %v", len(resp2.Changes), resp2.HasMore)
	}
	if resp2.FromRevision != 4 || resp2.ThroughRevision != 5 {
		t.Errorf("page 2 envelope = %+v", resp2)
	}
	// Pull-only request with no new changes.
	resp3 := mustSync(t, svc, syncReq(devID, 1, 5, 5))
	if len(resp3.Changes) != 0 || resp3.HasMore || resp3.ThroughRevision != 5 {
		t.Errorf("up-to-date pull = %+v", resp3)
	}
}

func TestSyncUrlUpdateOnFolderRejected(t *testing.T) {
	svc, db, devID := setupSyncTest(t)
	main := canonical.NewRootParent("main")

	seedSystem(t, db,
		canonical.CreateNode{SpaceID: "s1", NodeID: "f", Type: canonical.NodeTypeFolder, Title: "F", Parent: main},
	)
	resp := mustSync(t, svc, syncReq(devID, 1, 1, 1,
		sync.Operation{OpID: "u", ClientSeq: 1, BaseRevision: 1, Type: sync.OpUpdateURL, NodeID: "f", URL: "https://x"},
	))
	res := resp.OperationResults[0]
	if res.Status != sync.StatusRejected || res.Reason != sync.ReasonNotBookmark {
		t.Fatalf("url on folder = %+v, want REJECTED not_bookmark", res)
	}
}
