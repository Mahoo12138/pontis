package syncsim

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"

	"pontis/internal/canonical"
	"pontis/internal/device"
	"pontis/internal/reconcile"
	"pontis/internal/space"
	"pontis/internal/store/sqlite"
	"pontis/internal/sync"
)

// World is the simulation: the real server services over a temporary
// SQLite database plus any number of fake browser replicas, with fault
// injection between them (doc 21 §6-7).
type World struct {
	t         *testing.T
	ctx       context.Context
	dbPath    string
	db        *sql.DB
	SpaceID   canonical.SpaceID
	Space     *space.Service
	Devices   *device.Service
	Sync      *sync.Service
	Reconcile *reconcile.Service

	Browsers []*FakeBrowser

	// Fault knobs (doc 21 §7). Each is consumed once, then cleared.
	dropRequest   bool // request never reaches the server
	dropResponse  bool // server commits, the client never sees the response
	duplicateNext bool // the same request is delivered twice
}

// NewWorld boots a simulation world: one user, one space with the
// default root slot.
func NewWorld(t *testing.T) *World {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "sim.db")
	db, err := sqlite.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := sqlite.Migrate(ctx, db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	_, err = db.Exec(`INSERT INTO users (id, username, username_normalized, display_name, password_hash, role, status, locale, password_changed_at, created_at, updated_at)
		VALUES ('u1', 'alice', 'alice', 'Alice', 'x', 'admin', 'active', 'en', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
	if err != nil {
		t.Fatal(err)
	}

	spaces := space.NewService(sqlite.NewSpaceStore(db))
	sp, err := spaces.Create(ctx, "u1", "Sim Space")
	if err != nil {
		t.Fatalf("create space: %v", err)
	}

	w := &World{
		t:       t,
		ctx:     ctx,
		dbPath:  dbPath,
		db:      db,
		SpaceID: sp.ID,
	}
	w.wireServices()
	return w
}

func (w *World) wireServices() {
	w.Space = space.NewService(sqlite.NewSpaceStore(w.db))
	w.Devices = device.NewService(sqlite.NewDeviceStore(w.db))
	w.Sync = sync.NewService(sqlite.NewSyncStore(w.db))
	w.Reconcile = reconcile.NewService(sqlite.NewReconcileStore(w.db))
}

// AddBrowser registers a device, binds it to the world's space and
// returns the fake replica. The browser starts with one empty root
// container mapped to the space's "main" root slot.
func (w *World) AddBrowser(name string) *FakeBrowser {
	w.t.Helper()
	dev, _, err := w.Devices.RegisterDevice(w.ctx, "u1", name, "extension", "sim", "sim")
	if err != nil {
		w.t.Fatalf("register device: %v", err)
	}
	binding, err := w.Devices.BindSpace(w.ctx, dev.ID, w.SpaceID)
	if err != nil {
		w.t.Fatalf("bind space: %v", err)
	}
	b := newFakeBrowser(w, name)
	b.DeviceID = dev.ID
	b.BindingID = binding.ID
	bar := b.newBrowserID()
	b.addRootNode(bar, name+" Bar", "main")
	b.rootContainers["main"] = bar
	b.online = true
	w.Browsers = append(w.Browsers, b)
	return b
}

// deliver is the fault-injecting transport between replica and server.
func (w *World) deliver(req sync.SyncRequest) (sync.SyncResponse, bool, error) {
	if w.dropRequest {
		w.dropRequest = false
		return sync.SyncResponse{}, false, nil
	}
	resp, err := w.Sync.Sync(w.ctx, req)
	if err != nil {
		return sync.SyncResponse{}, true, err
	}
	if w.dropResponse {
		w.dropResponse = false
		return sync.SyncResponse{}, false, nil // committed server-side, lost in flight
	}
	if w.duplicateNext {
		w.duplicateNext = false
		if _, err := w.Sync.Sync(w.ctx, req); err != nil {
			return sync.SyncResponse{}, true, err
		}
	}
	return resp, true, nil
}

// Fault knobs.

// DropRequest makes the next request vanish before reaching the server.
func (w *World) DropRequest() { w.dropRequest = true }

// DropResponse lets the server commit but hides the response from the
// client (server commit before response, doc 21 §7).
func (w *World) DropResponse() { w.dropResponse = true }

// DuplicateNext replays the next request verbatim.
func (w *World) DuplicateNext() { w.duplicateNext = true }

// RestartServer simulates a server crash: the database closes and
// reopens with all services rewired. Replica state is untouched.
func (w *World) RestartServer() {
	w.t.Helper()
	if err := w.db.Close(); err != nil {
		w.t.Fatalf("close db: %v", err)
	}
	db, err := sqlite.Open(w.dbPath)
	if err != nil {
		w.t.Fatalf("reopen db: %v", err)
	}
	w.t.Cleanup(func() { db.Close() })
	if err := sqlite.Migrate(w.ctx, db); err != nil {
		w.t.Fatalf("re-migrate: %v", err)
	}
	w.db = db
	w.wireServices()
}

// SetOnline toggles every replica's network.
func (w *World) SetOnline(online bool) {
	for _, b := range w.Browsers {
		b.online = online
	}
}

// DrainAll brings every replica online and runs sync rounds until
// nothing progresses, then asserts convergence (doc 21 §8).
func (w *World) DrainAll() {
	w.t.Helper()
	w.SetOnline(true)
	for round := 0; round < 500; round++ {
		progress := false
		for _, b := range w.Browsers {
			p, err := b.SyncRound()
			if err != nil {
				w.t.Fatalf("%s: sync round: %v", b.Name, err)
			}
			progress = progress || p
		}
		if !progress {
			w.AssertConverged()
			return
		}
	}
	w.t.Fatal("simulation did not converge within 500 rounds")
}

// --- canonical tree reading ---

type treeNodeInfo struct {
	Parent string // container ref: root:<key> or parent canonical id
	Type   canonical.NodeType
	Title  string
	URL    string
}

// canonicalTree is the server-side truth: containers with ordered
// children plus node info.
type canonicalTree struct {
	Order map[string][]string
	Nodes map[string]treeNodeInfo
}

// ServerTree reads the current canonical tree.
func (w *World) ServerTree() canonicalTree {
	w.t.Helper()
	tx, err := w.ReconcileStore().BeginTx(w.ctx)
	if err != nil {
		w.t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(w.ctx) }()

	roots, err := tx.ListRootSlots(w.ctx, w.SpaceID)
	if err != nil {
		w.t.Fatal(err)
	}
	tree := canonicalTree{Order: map[string][]string{}, Nodes: map[string]treeNodeInfo{}}
	var walk func(parentRef canonical.ParentRef, container string)
	walk = func(parentRef canonical.ParentRef, container string) {
		children, err := tx.Children(w.ctx, w.SpaceID, parentRef)
		if err != nil {
			w.t.Fatal(err)
		}
		for _, node := range children {
			tree.Order[container] = append(tree.Order[container], string(node.ID))
			tree.Nodes[string(node.ID)] = treeNodeInfo{
				Parent: container,
				Type:   node.Type,
				Title:  node.Title,
				URL:    node.URL,
			}
			if node.Type == canonical.NodeTypeFolder {
				walk(canonical.NewNodeParent(node.ID), string(node.ID))
			}
		}
	}
	for _, root := range roots {
		walk(canonical.NewRootParent(root.Key), reconcile.RootRef(root.Key))
	}
	return tree
}

// ReconcileStore exposes a store for tree reads in tests.
func (w *World) ReconcileStore() *sqlite.ReconcileStore {
	return sqlite.NewReconcileStore(w.db)
}

// ServerHead returns the space's epoch and current revision.
func (w *World) ServerHead() (epoch, revision int64) {
	sp, err := w.Space.List(w.ctx, "u1")
	if err != nil {
		w.t.Fatal(err)
	}
	for _, s := range sp {
		if s.ID == w.SpaceID {
			return s.Epoch, s.CurrentRevision
		}
	}
	w.t.Fatal("space vanished")
	return 0, 0
}

// AssertConverged verifies the protocol invariant (doc 21 §8): every
// replica's browser projection equals the canonical tree, all operations
// settled, and the watermarks sit at the server head.
func (w *World) AssertConverged() {
	w.t.Helper()
	tree := w.ServerTree()
	epoch, revision := w.ServerHead()
	for _, b := range w.Browsers {
		projection := b.Projection()
		if len(projection.Order) != len(tree.Order) {
			w.t.Fatalf("%s: projection containers %d, want %d", b.Name, len(projection.Order), len(tree.Order))
		}
		for container, want := range tree.Order {
			got := projection.Order[container]
			if fmt.Sprint(got) != fmt.Sprint(want) {
				w.t.Fatalf("%s: container %s order\n got %v\nwant %v", b.Name, container, got, want)
			}
		}
		for id, want := range tree.Nodes {
			got, ok := projection.Nodes[id]
			if !ok {
				w.t.Fatalf("%s: node %s missing from projection", b.Name, id)
			}
			if got != want {
				w.t.Fatalf("%s: node %s\n got %+v\nwant %+v", b.Name, id, got, want)
			}
		}
		for id := range projection.Nodes {
			if _, ok := tree.Nodes[id]; !ok {
				w.t.Fatalf("%s: projection holds unknown node %s", b.Name, id)
			}
		}
		if n := b.PendingCount(); n != 0 {
			w.t.Fatalf("%s: %d operations never settled", b.Name, n)
		}
		if len(b.inbox) != 0 {
			w.t.Fatalf("%s: %d inbox changes left unapplied", b.Name, len(b.inbox))
		}
		if b.appliedRevision != revision || b.receivedRevision != revision || b.epoch != epoch {
			w.t.Fatalf("%s: watermarks epoch=%d applied=%d received=%d, want epoch=%d head=%d",
				b.Name, b.epoch, b.appliedRevision, b.receivedRevision, epoch, revision)
		}
	}
}
