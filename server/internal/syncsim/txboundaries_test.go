package syncsim

// Transaction boundary tests (doc 04 §15, doc 06 §8, doc 21 §7): a /sync round
// and a snapshot are served from state that other writers may change while the
// request is inside the server. The probe below lets a second connection to the
// same database file commit at a chosen point of one round, so each test names
// an interleaving that has actually happened rather than one that is merely
// possible.

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
	"pontis/internal/store/sqlite"
	"pontis/internal/sync"
)

// boundaryProbe wraps the real sync store and runs a one-shot action after a
// chosen read. Actions commit through p.live: a second handle on the same file,
// which is what another request in flight looks like under WAL.
type boundaryProbe struct {
	sync.Store
	t          *testing.T
	live       *sql.DB
	hooks      map[string]func()
	failUpdate error
}

func (p *boundaryProbe) fire(key string) {
	if fn, ok := p.hooks[key]; ok {
		delete(p.hooks, key)
		fn()
	}
}

// after arms a one-shot action to run once the round has observed the given
// read: "Store.LoadSpace" is the advisory read of a round, "ReadTx.LoadSpace"
// the head read inside a snapshot.
func (p *boundaryProbe) after(key string, fn func()) { p.hooks[key] = fn }

func (p *boundaryProbe) LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	sp, err := p.Store.LoadSpace(ctx, id)
	p.fire("Store.LoadSpace")
	return sp, err
}

func (p *boundaryProbe) BeginReadTx(ctx context.Context) (sync.ReadTx, error) {
	read, err := p.Store.BeginReadTx(ctx)
	if err != nil {
		return nil, err
	}
	return &boundaryReadProbe{ReadTx: read, p: p}, nil
}

func (p *boundaryProbe) UpdateBindingSync(ctx context.Context, bindingID string, epoch, applied, received int64, at time.Time) error {
	if p.failUpdate != nil {
		return p.failUpdate
	}
	err := p.Store.UpdateBindingSync(ctx, bindingID, epoch, applied, received, at)
	p.fire("Store.UpdateBindingSync")
	return err
}

// boundaryReadProbe intercepts the reads of one read snapshot.
type boundaryReadProbe struct {
	sync.ReadTx
	p *boundaryProbe
}

func (r *boundaryReadProbe) LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	sp, err := r.ReadTx.LoadSpace(ctx, id)
	r.p.fire("ReadTx.LoadSpace")
	return sp, err
}

func (r *boundaryReadProbe) LoadSnapshotNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	nodes, err := r.ReadTx.LoadSnapshotNodes(ctx, space)
	r.p.fire("ReadTx.LoadSnapshotNodes")
	return nodes, err
}

// newProbe arms the world's sync service with a probe and returns it together
// with the side handle its commits land on.
func newProbe(t *testing.T, w *World) *boundaryProbe {
	t.Helper()
	side, err := sqlite.Open(w.dbPath)
	if err != nil {
		t.Fatalf("open side handle: %v", err)
	}
	t.Cleanup(func() { _ = side.Close() })
	p := &boundaryProbe{
		Store: sqlite.NewSyncStore(w.db),
		t:     t,
		live:  side,
		hooks: map[string]func(){},
	}
	w.SyncWith(p)
	return p
}

// execOn commits a statement through the side handle: another writer, not the
// round under test.
func execOn(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("side commit %q: %v", query, err)
	}
}

// roundFor builds one /sync request from a replica's current watermarks
// without putting the operations in its outbox: the round is driven by hand so
// the probe can cut in while it is inside the server.
func roundFor(b *FakeBrowser, ops ...sync.Operation) sync.SyncRequest {
	return sync.SyncRequest{
		ProtocolVersion:  sync.ProtocolVersion,
		DeviceID:         canonical.DeviceID(b.DeviceID),
		DeviceName:       b.Name,
		SpaceID:          b.world.SpaceID,
		Epoch:            b.epoch,
		AppliedRevision:  b.appliedRevision,
		ReceivedRevision: b.receivedRevision,
		Operations:       ops,
	}
}

// createOp is one bookmark create under the given root slot, with the seq and
// base the replica would have sent for it.
func createOp(t *testing.T, b *FakeBrowser, rootKey, title string) sync.Operation {
	t.Helper()
	nodeID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	op, _ := b.newOperation()
	op.Type = sync.OpCreate
	op.NodeID = canonical.NodeID(nodeID.String())
	op.NodeType = canonical.NodeTypeBookmark
	op.Title = title
	op.URL = "https://" + title + ".example"
	op.Parent = canonical.NewRootParent(rootKey)
	return op
}

func wantProtocolCode(t *testing.T, err error, want string) {
	t.Helper()
	var pe *sync.ProtocolError
	if !errors.As(err, &pe) {
		t.Fatalf("err = %v, want *sync.ProtocolError %s", err, want)
	}
	if pe.Code != want {
		t.Errorf("code = %s, want %s", pe.Code, want)
	}
}

func bindingMaxSeq(t *testing.T, w *World, bindingID string) int64 {
	t.Helper()
	var seq int64
	if err := w.db.QueryRow(`SELECT max_client_seq FROM device_space_bindings WHERE id = ?`, bindingID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	return seq
}

// TestRoundCannotApplyIntoAnEpochItNeverSaw is the Restore race: the round was
// admitted against epoch 1, then a restore replaced the canonical world, and
// the operation is still inside the server. Deciding against the numbers read
// before the transaction would write an intent of a dead epoch into the live
// journal.
func TestRoundCannotApplyIntoAnEpochItNeverSaw(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	headEpoch, _ := w.ServerHead()

	op := createOp(t, a, "main", "stale-intent")
	probe := newProbe(t, w)
	// What a completed restore commits: a new epoch over the tree.
	probe.after("Store.LoadSpace", func() {
		execOn(t, probe.live, `UPDATE sync_spaces SET epoch = epoch + 1 WHERE id = ?`, string(w.SpaceID))
	})

	_, err := w.Sync.Sync(context.Background(), roundFor(a, op))
	wantProtocolCode(t, err, sync.CodeEpochMismatch)

	// The intent must not have left a trace: no node, and no receipt for a
	// round that never decided anything.
	if _, found := w.ServerTree().Nodes[string(op.NodeID)]; found {
		t.Errorf("an operation of epoch %d created node %s in epoch %d", headEpoch, op.NodeID, headEpoch+1)
	}
	var rows int
	if err := probe.live.QueryRow(`SELECT COUNT(*) FROM client_operation_receipts WHERE binding_id = ?`, a.BindingID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Errorf("%d receipts written by a rejected round, want none", rows)
	}
}

// TestRoundCannotApplyBelowAFloorThatRoseUnderIt is the journal GC race: the
// space's floor moved above the operation's base while the round was inside the
// server, so the world the intent was written against no longer exists.
func TestRoundCannotApplyBelowAFloorThatRoseUnderIt(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	op := createOp(t, a, "main", "below-floor")
	_, revision := w.ServerHead()
	probe := newProbe(t, w)
	// What journal GC commits: the same epoch, the journal grown and its floor
	// pruned up past the revision this operation was written against.
	probe.after("Store.LoadSpace", func() {
		execOn(t, probe.live, `UPDATE sync_spaces SET current_revision = ?, journal_floor_revision = ? WHERE id = ?`,
			revision+1, revision+1, string(w.SpaceID))
	})

	_, err := w.Sync.Sync(context.Background(), roundFor(a, op))
	wantProtocolCode(t, err, sync.CodeOperationHistoryExpired)
	if _, found := w.ServerTree().Nodes[string(op.NodeID)]; found {
		t.Errorf("operation based on revision %d applied below floor %d", op.BaseRevision, revision+1)
	}
}

// TestRoundCannotServeAPageFromHistoryThatJustExpired is the GC race on the
// change stream: the round was admitted while the client's revision was still
// reachable, then journal GC pruned up past it before the page was read. The
// page would have started above the from_revision it promises, leaving the
// replica a hole it is never told about.
func TestRoundCannotServeAPageFromHistoryThatJustExpired(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	side := w.AddBrowser("Side")
	for _, b := range []*FakeBrowser{a, side} {
		if err := b.Initialize(); err != nil {
			t.Fatalf("%s initialize: %v", b.Name, err)
		}
	}

	// A change the lagging replica has not received yet: the page exists.
	op := createOp(t, side, "main", "pruned-before-delivery")
	_, head := w.ServerHead()
	commitRound(t, w, side, op)

	probe := newProbe(t, w)
	// What journal GC commits after the round was admitted.
	probe.after("Store.LoadSpace", func() {
		execOn(t, probe.live, `UPDATE sync_spaces SET journal_floor_revision = ? WHERE id = ?`,
			head+1, string(w.SpaceID))
	})

	_, err := w.Sync.Sync(context.Background(), roundFor(a))
	wantProtocolCode(t, err, sync.CodeHistoryExpired)
}

// TestSequenceIsSpentWithItsReceipt covers the half of the watermark that must
// never be lost: a round whose binding write fails still spent the client_seq it
// processed. Otherwise a committed receipt could be overwritten by a new
// operation reusing the number.
func TestSequenceIsSpentWithItsReceipt(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	first := createOp(t, a, "main", "spent")
	probe := newProbe(t, w)
	probe.failUpdate = errors.New("connection lost before the watermark write")

	if _, err := w.Sync.Sync(context.Background(), roundFor(a, first)); err == nil {
		t.Fatal("round succeeded, want the watermark write to fail")
	}

	// The operation is committed even though the round reported nothing back.
	if _, found := w.ServerTree().Nodes[string(first.NodeID)]; !found {
		t.Fatal("the committed operation vanished from the tree")
	}
	if seq := bindingMaxSeq(t, w, a.BindingID); seq < first.ClientSeq {
		t.Fatalf("binding max_client_seq = %d after processing seq %d, want it spent", seq, first.ClientSeq)
	}

	// A retry that reuses the spent number must be refused, not applied.
	probe.failUpdate = nil
	reused := createOp(t, a, "main", "reused")
	reused.ClientSeq = first.ClientSeq
	reused.OpID = first.OpID + "-b"
	_, err := w.Sync.Sync(context.Background(), roundFor(a, reused))
	wantProtocolCode(t, err, sync.CodeClientSeqRegressed)
	if _, found := w.ServerTree().Nodes[string(reused.NodeID)]; found {
		t.Error("an operation that reused a spent client_seq was applied")
	}
}

// TestSnapshotLabelsTheTreeItReturns is the read-snapshot race: a second device
// commits a bookmark between the head read and the tree read of a snapshot. The
// replica sets its watermarks to snapshot_revision and believes it holds that
// exact tree, so a node newer than the label is a change it never receives.
func TestSnapshotLabelsTheTreeItReturns(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	side := w.AddBrowser("Side")
	for _, b := range []*FakeBrowser{a, side} {
		if err := b.Initialize(); err != nil {
			t.Fatalf("%s initialize: %v", b.Name, err)
		}
	}

	op := createOp(t, side, "main", "landed-mid-snapshot")
	var appliedAt int64 = -1
	land := func() {
		if appliedAt != -1 {
			return // the interleaving only has to happen once
		}
		appliedAt = commitRound(t, w, side, op)
	}
	probe := newProbe(t, w)
	// Land after the snapshot has read the head, before it reads the tree.
	probe.after("ReadTx.LoadSpace", land)

	snap, err := w.Sync.Snapshot(context.Background(), canonical.DeviceID(a.DeviceID), w.SpaceID)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if appliedAt < 0 {
		t.Fatal("no concurrent round landed inside the snapshot; the interleaving never happened")
	}
	for _, n := range snap.Nodes {
		if n.ID == op.NodeID {
			t.Errorf("snapshot labelled revision %d carries node %s created at %d",
				snap.SnapshotRevision, n.ID, appliedAt)
		}
	}

	// The node is real; a later snapshot has to show it.
	again, err := w.Sync.Snapshot(context.Background(), canonical.DeviceID(a.DeviceID), w.SpaceID)
	if err != nil {
		t.Fatalf("second snapshot: %v", err)
	}
	found := false
	for _, n := range again.Nodes {
		if n.ID == op.NodeID {
			found = true
		}
	}
	if !found {
		t.Error("the node created concurrently is missing from the next snapshot")
	}
}

// commitRound runs one real /sync round on a second connection and returns the
// revision it applied at.
func commitRound(t *testing.T, w *World, b *FakeBrowser, op sync.Operation) int64 {
	t.Helper()
	side, err := sqlite.Open(w.dbPath)
	if err != nil {
		t.Fatalf("open side handle: %v", err)
	}
	defer side.Close()

	svc := sync.NewService(sqlite.NewSyncStore(side), changeset.NewService(sqlite.NewChangeSetStore(side)))
	resp, err := svc.Sync(context.Background(), roundFor(b, op))
	if err != nil {
		t.Fatalf("concurrent round: %v", err)
	}
	if len(resp.OperationResults) == 0 {
		t.Fatal("concurrent round returned no operation result")
	}
	return resp.OperationResults[0].ResultRevision
}
