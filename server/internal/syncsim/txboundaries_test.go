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
	"strings"
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
	// wrapsTx is set when a test armed an in-transaction hook. Wrapping is not
	// free: the store unwraps a transaction through an unexported method, which
	// a wrapper around the interface cannot forward, so the probe only wraps
	// when it actually has something to intercept.
	wrapsTx bool
}

// BeginTx wraps the round's transaction so a test can cut in while the round is
// inside it.
func (p *boundaryProbe) BeginTx(ctx context.Context) (sync.Tx, error) {
	tx, err := p.Store.BeginTx(ctx)
	if err != nil {
		return nil, err
	}
	if !p.wrapsTx {
		return tx, nil
	}
	return &boundaryTxProbe{Tx: tx, p: p}, nil
}

// boundaryTxProbe intercepts the writes of one round transaction.
type boundaryTxProbe struct {
	sync.Tx
	p *boundaryProbe
}

// LoadSpace is the round's first read inside the transaction: the head it
// reports and the absence of a receipt are decided here, so a commit that lands
// after this line is the overlap a lock has to survive.
func (t *boundaryTxProbe) LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	sp, err := t.Tx.LoadSpace(ctx, id)
	t.p.fire("Tx.LoadSpace")
	return sp, err
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
func (p *boundaryProbe) after(key string, fn func()) {
	p.hooks[key] = fn
	if strings.HasPrefix(key, "Tx.") {
		p.wrapsTx = true
	}
}

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

// Two processes can be mid-round for one binding at the same moment. Inside one
// process they cannot: sqlite.Open caps a handle at a single connection, so the
// second round waits for the first. Across two handles the round under test has
// already read the head and found no receipt when the other one commits the very
// same intent — and the pair of them must still leave one node, one journal
// revision and one receipt behind, not two.
func TestOverlappingRoundsOfOneBindingApplyOneIntentOnce(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	op := createOp(t, a, "main", "raced-intent")
	req := roundFor(a, op)
	_, headBefore := w.ServerHead()

	probe := newProbe(t, w)
	committedElsewhere := false
	probe.after("Tx.LoadSpace", func() {
		if committedElsewhere {
			return // the interleaving only has to happen once
		}
		committedElsewhere = true
		commitRound(t, w, a, op)
	})

	_, err := w.Sync.Sync(context.Background(), req)
	if !committedElsewhere {
		t.Fatal("the other round never landed inside the transaction; the overlap was not staged")
	}

	// The loser of a write race is allowed to fail; what it is not allowed to do
	// is report success for an intent that is already settled, having decided
	// against numbers it read before the other commit.
	var journalRows, receiptRows int
	if err := probe.live.QueryRow(`SELECT COUNT(*) FROM journal WHERE space_id = ? AND node_id = ?`,
		string(w.SpaceID), string(op.NodeID)).Scan(&journalRows); err != nil {
		t.Fatal(err)
	}
	if err := probe.live.QueryRow(`SELECT COUNT(*) FROM client_operation_receipts WHERE binding_id = ? AND op_id = ?`,
		a.BindingID, op.OpID).Scan(&receiptRows); err != nil {
		t.Fatal(err)
	}
	_, headAfter := w.ServerHead()
	if journalRows != 1 {
		t.Errorf("%d journal revisions for one intent, want 1 (round err = %v)", journalRows, err)
	}
	if receiptRows != 1 {
		t.Errorf("%d receipts for one intent, want 1 (round err = %v)", receiptRows, err)
	}
	if headAfter != headBefore+1 {
		t.Errorf("space revision went %d → %d, want exactly one new revision", headBefore, headAfter)
	}
	if _, found := w.ServerTree().Nodes[string(op.NodeID)]; !found {
		t.Error("the intent is missing from the tree")
	}

	// A retry after the dust settles is the ordinary client behaviour, and it
	// has to converge on the settled answer.
	if _, err := w.Sync.Sync(context.Background(), req); err != nil {
		t.Fatalf("the losing round's retry failed: %v", err)
	}
	if _, head := w.ServerHead(); head != headBefore+1 {
		t.Fatalf("replaying a settled operation advanced the head to %d", head)
	}
	if seq := bindingMaxSeq(t, w, a.BindingID); seq < op.ClientSeq {
		t.Errorf("binding max_client_seq = %d, want at least the spent %d", seq, op.ClientSeq)
	}
}

// One operation's tree write, journal row, receipt and spent sequence are one
// transaction, so a round that dies partway through has to end up
// indistinguishable from one that never ran. The collision below is what a lost
// write race looks like to SQLite: the revision this round is about to append is
// already taken, and the failure lands after the node insert, before the commit.
func TestRoundThatFailedInsideItsTransactionLeftNoTrace(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatalf("initialize: %v", err)
	}

	op := createOp(t, a, "main", "died-mid-transaction")
	epoch, head := w.ServerHead()
	probe := newProbe(t, w)
	execOn(t, probe.live, `
		INSERT INTO journal (space_id, epoch, revision, change_type, node_id, payload, origin_type, created_at)
		VALUES (?, ?, ?, 'create', 'someone-elses-entry', '{}', 'system', ?)`,
		string(w.SpaceID), epoch, head+1, time.Now().UTC().Format(time.RFC3339Nano))

	if _, err := w.Sync.Sync(context.Background(), roundFor(a, op)); err == nil {
		t.Fatal("the round reported success although its journal insert collided")
	}
	if _, found := w.ServerTree().Nodes[string(op.NodeID)]; found {
		t.Error("the failed round left its node in the tree")
	}
	var receipts int
	if err := probe.live.QueryRow(`SELECT COUNT(*) FROM client_operation_receipts WHERE binding_id = ?`,
		a.BindingID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 0 {
		t.Errorf("%d receipts from a round that never committed, want none", receipts)
	}
	if seq := bindingMaxSeq(t, w, a.BindingID); seq != 0 {
		t.Errorf("binding max_client_seq = %d after an uncommitted round, want it unspent", seq)
	}
	if _, now := w.ServerHead(); now != head {
		t.Errorf("space revision went to %d on a round that never committed, want %d", now, head)
	}

	// Clear the collision: the retry is exactly what a replica does after it
	// reconnects, and it has to land rather than be refused by half a record.
	execOn(t, probe.live, `DELETE FROM journal WHERE space_id = ? AND revision = ?`,
		string(w.SpaceID), head+1)
	if _, err := w.Sync.Sync(context.Background(), roundFor(a, op)); err != nil {
		t.Fatalf("retry of the failed operation: %v", err)
	}
	if _, found := w.ServerTree().Nodes[string(op.NodeID)]; !found {
		t.Error("the retried operation never landed")
	}
	if _, now := w.ServerHead(); now != head+1 {
		t.Fatalf("space revision = %d after one applied operation, want %d", now, head+1)
	}
}

// Journal GC against a pull that is already inside the server, driven by the
// real collector rather than a hand-written UPDATE: GC deletes journal rows,
// tombstones and receipts and only then raises the floor. A page read across
// that boundary would either skip revisions the replica never saw or serve rows
// the collector meant to remove.
func TestRealJournalGCUnderAFlyingPull(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	side := w.AddBrowser("Side")
	for _, b := range []*FakeBrowser{a, side} {
		if err := b.Initialize(); err != nil {
			t.Fatalf("%s initialize: %v", b.Name, err)
		}
	}

	// History the lagging replica has not received yet, then age it past the
	// 30-day window so the real collector considers it collectable.
	for _, title := range []string{"one", "two", "three"} {
		commitRound(t, w, side, createOp(t, side, "main", title))
	}
	_, head := w.ServerHead()
	probe := newProbe(t, w)
	probe.after("Store.LoadSpace", func() {
		if _, err := probe.live.Exec(`UPDATE journal SET created_at = datetime('now', '-40 day') WHERE space_id = ?`,
			string(w.SpaceID)); err != nil {
			t.Fatalf("age the journal: %v", err)
		}
		// The real writer, on the other handle: it prunes and moves the floor
		// in one transaction of its own.
		gc := sqlite.NewLibraryStore(probe.live)
		floor, removed, err := gc.JournalGCSpace(context.Background(), string(w.SpaceID), time.Now().UTC(), 1)
		if err != nil {
			t.Fatalf("journal gc: %v", err)
		}
		if removed == 0 {
			t.Fatalf("gc collected nothing (floor %d), so the race this test stages never happened", floor)
		}
		if floor >= head {
			t.Fatalf("gc floor %d reached the head %d; keep at least one row so a hole cannot be hidden", floor, head)
		}
	})

	// The replica asks from revision 0, which the collector has just pruned.
	_, err := w.Sync.Sync(context.Background(), roundFor(a))
	wantProtocolCode(t, err, sync.CodeHistoryExpired)

	// And the rows really are gone: the refusal has to be the only answer a
	// reader can get, not a page that happens to start above from_revision.
	var survivors int
	if err := probe.live.QueryRow(`SELECT COUNT(*) FROM journal WHERE space_id = ? AND revision <= ?`,
		string(w.SpaceID), head-1).Scan(&survivors); err != nil {
		t.Fatal(err)
	}
	if survivors != 0 {
		t.Errorf("%d pruned journal rows still readable below the floor", survivors)
	}
}
