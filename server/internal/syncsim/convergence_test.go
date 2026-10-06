package syncsim

import (
	"testing"

	"pontis/internal/sync"
)

// rootBrowser returns the browser id of the main root container.
func rootBrowser(b *FakeBrowser) string { return b.rootContainers["main"] }

// serverIDByTitle finds the canonical id of the (unique) node with the
// given title on the server.
func serverIDByTitle(t *testing.T, w *World, title string) string {
	t.Helper()
	tree := w.ServerTree()
	found := ""
	for id, info := range tree.Nodes {
		if info.Title == title {
			if found != "" {
				t.Fatalf("title %q is not unique on the server", title)
			}
			found = id
		}
	}
	if found == "" {
		t.Fatalf("no server node titled %q", title)
	}
	return found
}

func TestSingleDeviceConvergence(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")

	if err := a.Initialize(); err != nil {
		t.Fatalf("Initialize: %v", err)
	}

	f1 := a.CaptureCreate(rootBrowser(a), "folder", "Development", "")
	a.CaptureCreate(f1, "bookmark", "GitHub", "https://github.com")
	a.CaptureCreate(f1, "bookmark", "Go", "https://go.dev")
	a.CaptureCreate(rootBrowser(a), "bookmark", "Reading", "https://reading.example")

	w.DrainAll()

	// The doc 21 §5 core tree: create, move, delete.
	goID := a.BrowserIDOfCanonical(serverIDByTitle(t, w, "Go"))
	a.CaptureMove(goID, rootBrowser(a), "")
	devID := a.BrowserIDOfCanonical(serverIDByTitle(t, w, "Development"))
	a.CaptureDelete(devID)

	w.DrainAll()

	tree := w.ServerTree()
	if len(tree.Order["root:main"]) != 2 {
		t.Fatalf("root children = %v, want Reading and GitHub", tree.Order["root:main"])
	}
}

func TestInitialImportConvergence(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")

	// Pre-existing browser bookmarks: raw nodes without any mapping —
	// the "server empty + browser non-empty" case of doc 06 §5.
	f := a.SeedRaw(rootBrowser(a), "folder", "Imported", "")
	a.SeedRaw(f, "bookmark", "Docs", "https://docs.example")
	a.SeedRaw(rootBrowser(a), "bookmark", "Solo", "https://solo.example")

	if err := a.Initialize(); err != nil {
		t.Fatalf("Initialize: %v", err)
	}
	w.DrainAll()

	tree := w.ServerTree()
	if len(tree.Order["root:main"]) != 2 || len(tree.Nodes) != 3 {
		t.Fatalf("imported tree = %+v", tree)
	}

	// Post-import operations flow normally.
	a.CaptureUpdateTitle(a.BrowserIDOfCanonical(serverIDByTitle(t, w, "Solo")), "Solo renamed")
	w.DrainAll()
}

func TestSecondDeviceMergesAgainstServer(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	f := a.SeedRaw(rootBrowser(a), "folder", "Work", "")
	a.SeedRaw(f, "bookmark", "Issue tracker", "https://issues.example")
	if err := a.Initialize(); err != nil {
		t.Fatalf("A Initialize: %v", err)
	}

	// A second browser joins: server content must come down as steps.
	b := w.AddBrowser("Firefox")
	if err := b.Initialize(); err != nil {
		t.Fatalf("B Initialize: %v", err)
	}
	w.DrainAll()

	// Both replicas converge and remain independent.
	a.CaptureCreate(rootBrowser(a), "bookmark", "Edge only", "https://edge.example")
	b.CaptureCreate(rootBrowser(b), "bookmark", "Firefox only", "https://firefox.example")
	w.DrainAll()
}

func TestConcurrentDifferentFieldMerge(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	bm := a.CaptureCreate(rootBrowser(a), "bookmark", "Doc", "https://doc.example")
	w.DrainAll()

	// B joins and both edit different fields of the same node: the
	// dimensions merge (doc 04 §8).
	b := w.AddBrowser("Firefox")
	if err := b.Initialize(); err != nil {
		t.Fatal(err)
	}
	w.DrainAll()

	a.CaptureUpdateTitle(bm, "Doc v2")
	b.CaptureUpdateURL(b.BrowserIDOfCanonical(a.CanonicalIDOf(bm)), "https://doc-v2.example")
	w.DrainAll()

	if len(a.Conflicts())+len(b.Conflicts()) != 0 {
		t.Fatalf("different-field edits must merge: %+v %+v", a.Conflicts(), b.Conflicts())
	}
	tree := w.ServerTree()
	for _, info := range tree.Nodes {
		if info.Title == "Doc v2" && info.URL == "https://doc-v2.example" {
			return
		}
	}
	t.Fatalf("merged node state missing: %+v", tree.Nodes)
}

func TestConcurrentSameFieldConflict(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	id := a.CaptureCreate(rootBrowser(a), "bookmark", "Origin", "https://x.example")
	w.DrainAll()
	b := w.AddBrowser("Firefox")
	if err := b.Initialize(); err != nil {
		t.Fatal(err)
	}
	w.DrainAll()

	// Same-field, different values: the first writer wins, the second
	// gets a CONFLICT and settles on the canonical state (doc 04 §8).
	a.CaptureUpdateTitle(id, "From Edge")
	b.CaptureUpdateTitle(b.BrowserIDOfCanonical(a.CanonicalIDOf(id)), "From Firefox")
	w.DrainAll()

	if len(a.Conflicts()) != 0 {
		t.Fatalf("first writer must apply cleanly: %+v", a.Conflicts())
	}
	if len(b.Conflicts()) != 1 || b.Conflicts()[0].Reason != sync.ReasonConcurrentUpdate {
		t.Fatalf("second writer must conflict: %+v", b.Conflicts())
	}
	tree := w.ServerTree()
	for _, info := range tree.Nodes {
		if info.Title == "From Edge" {
			return
		}
	}
	t.Fatalf("winning title missing: %+v", tree.Nodes)
}

func TestConcurrentMoveConflict(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	p1 := a.CaptureCreate(rootBrowser(a), "folder", "Dest One", "")
	p2 := a.CaptureCreate(rootBrowser(a), "folder", "Dest Two", "")
	x := a.CaptureCreate(rootBrowser(a), "bookmark", "Wanderer", "https://w.example")
	w.DrainAll()
	b := w.AddBrowser("Firefox")
	if err := b.Initialize(); err != nil {
		t.Fatal(err)
	}
	w.DrainAll()

	// Two different canonical destinations: concurrent_move.
	a.CaptureMove(x, p1, "")
	b.CaptureMove(b.BrowserIDOfCanonical(a.CanonicalIDOf(x)), b.BrowserIDOfCanonical(a.CanonicalIDOf(p2)), "")
	w.DrainAll()

	moved := 0
	for _, br := range []*FakeBrowser{a, b} {
		for _, c := range br.Conflicts() {
			if c.Reason == sync.ReasonConcurrentMove {
				moved++
			}
		}
	}
	if moved != 1 {
		t.Fatalf("want exactly one concurrent_move conflict, got %d", moved)
	}
}

func TestOfflineEditingPreservesNewData(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	b := w.AddBrowser("Firefox")
	if err := b.Initialize(); err != nil {
		t.Fatal(err)
	}
	shared := a.CaptureCreate(rootBrowser(a), "bookmark", "Shared", "https://shared.example")
	w.DrainAll()

	// A goes offline and accumulates intents; B renames the same node.
	a.online = false
	offline := a.CaptureCreate(rootBrowser(a), "bookmark", "Offline note", "https://offline.example")
	a.CaptureUpdateTitle(shared, "Renamed offline")
	b.CaptureUpdateTitle(b.BrowserIDOfCanonical(a.CanonicalIDOf(shared)), "Renamed online")

	// Doc 21 §8: nothing created offline may silently disappear.
	a.online = true
	w.DrainAll()

	tree := w.ServerTree()
	found := false
	for _, info := range tree.Nodes {
		if info.Title == "Offline note" && info.URL == "https://offline.example" {
			found = true
		}
	}
	if !found {
		t.Fatalf("offline-created node lost: %+v", tree.Nodes)
	}
	_ = offline
	// One of the two title intents conflicts; the data converges.
	total := len(a.Conflicts()) + len(b.Conflicts())
	if total != 1 {
		t.Fatalf("want exactly one concurrent_update conflict, got %d", total)
	}
}

func TestResponseLossRetriesIdempotently(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}

	// Server commit before response (doc 21 §7): the ops commit, the
	// client never sees the result and retries later. Receipts must
	// settle the retry without consuming extra revisions.
	a.CaptureCreate(rootBrowser(a), "bookmark", "One", "https://one.example")
	a.CaptureCreate(rootBrowser(a), "bookmark", "Two", "https://two.example")
	a.CaptureCreate(rootBrowser(a), "bookmark", "Three", "https://three.example")
	w.DropResponse()

	if _, err := a.SyncRound(); err != nil {
		t.Fatalf("round with lost response: %v", err)
	}
	if a.PendingCount() == 0 {
		t.Fatal("ops must stay pending after a lost response")
	}
	epoch, revision := w.ServerHead()
	if revision != 3 {
		t.Fatalf("server consumed %d revisions, want 3", revision)
	}

	w.DrainAll()
	if _, rev := w.ServerHead(); rev != 3 {
		t.Fatalf("retry consumed extra revisions: head = %d", rev)
	}
	_ = epoch
}

func TestDuplicateRequestDelivery(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	a.CaptureCreate(rootBrowser(a), "bookmark", "Once", "https://once.example")
	w.DuplicateNext()

	w.DrainAll()

	if _, rev := w.ServerHead(); rev != 1 {
		t.Fatalf("duplicate delivery consumed extra revisions: head = %d", rev)
	}
	if n := len(a.Rejections()); n != 0 {
		t.Fatalf("duplicate delivery must replay receipts, not reject: %+v", a.Rejections())
	}
}

func TestCrashBeforeInboxApply(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	b := w.AddBrowser("Firefox")
	if err := b.Initialize(); err != nil {
		t.Fatal(err)
	}
	a.CaptureCreate(rootBrowser(a), "bookmark", "Crashy", "https://crashy.example")

	// B receives the change but dies between persistence and apply
	// (doc 05 §6): the next round must resume from the inbox.
	b.CrashBeforeInboxApply()
	if _, err := a.SyncRound(); err != nil {
		t.Fatalf("A round: %v", err)
	}
	if _, err := b.SyncRound(); err != nil {
		t.Fatalf("B round: %v", err)
	}
	if b.appliedRevision >= b.receivedRevision {
		t.Fatal("crash point not hit: applied should lag received")
	}
	w.DrainAll()
}

func TestCrashMidApplyResumes(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	b := w.AddBrowser("Firefox")
	if err := b.Initialize(); err != nil {
		t.Fatal(err)
	}
	for _, title := range []string{"A", "B", "C", "D"} {
		a.CaptureCreate(rootBrowser(a), "bookmark", title, "https://"+title+".example")
	}
	// Change applied before watermark advance (doc 21 §7): apply two
	// inbox entries, then die. Ensure-state re-application must converge.
	b.CrashMidApply(2)
	if _, err := a.SyncRound(); err != nil {
		t.Fatalf("A round: %v", err)
	}
	if _, err := b.SyncRound(); err != nil {
		t.Fatalf("B round: %v", err)
	}
	if b.appliedRevision == b.receivedRevision {
		t.Fatal("crash point not hit")
	}
	w.DrainAll()
}

func TestServerRestartBetweenRounds(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	a.CaptureCreate(rootBrowser(a), "bookmark", "Durable", "https://durable.example")

	if _, err := a.SyncRound(); err != nil {
		t.Fatalf("round: %v", err)
	}
	w.RestartServer()
	w.DrainAll()

	tree := w.ServerTree()
	found := false
	for _, info := range tree.Nodes {
		if info.Title == "Durable" {
			found = true
		}
	}
	if !found {
		t.Fatal("node missing after server restart")
	}
}

func TestDeleteWinsOverStaleUpdate(t *testing.T) {
	w := NewWorld(t)
	a := w.AddBrowser("Edge")
	if err := a.Initialize(); err != nil {
		t.Fatal(err)
	}
	x := a.CaptureCreate(rootBrowser(a), "bookmark", "Doomed", "https://doomed.example")
	w.DrainAll()
	b := w.AddBrowser("Firefox")
	if err := b.Initialize(); err != nil {
		t.Fatal(err)
	}
	w.DrainAll()

	// A deletes; B, ignorant of the delete, updates the title. DELETE
	// wins and never resurrects (doc 04 §8).
	cid := a.CanonicalIDOf(x)
	a.CaptureDelete(x)
	b.CaptureUpdateTitle(b.BrowserIDOfCanonical(cid), "Zombie")
	w.DrainAll()

	rejected := false
	for _, r := range b.Rejections() {
		if r.Reason == sync.ReasonTargetDeleted {
			rejected = true
		}
	}
	if !rejected {
		t.Fatalf("stale update must be rejected with target_deleted: %+v", b.Rejections())
	}
	tree := w.ServerTree()
	for _, info := range tree.Nodes {
		if info.Title == "Zombie" || info.Title == "Doomed" {
			t.Fatalf("deleted node resurrected: %+v", tree.Nodes)
		}
	}
}
