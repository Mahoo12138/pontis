// Package syncsim is the simulation harness for the sync protocol
// (doc 21 §6-8): fake browser replicas driven against the real server
// services with fault injection, and a convergence checker asserting
// that every drained replica's projection equals the canonical tree.
//
// The fake browser is the reference client for the Phase 8 extension:
// it follows doc 05's replica rules (mirror + outbox + inbox, the four
// crash-consistency rules, strict serial apply, ensure-state idempotent
// remote mutations).
package syncsim

import (
	"fmt"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/sync"
)

// pendingState tracks an operation through its lifecycle (doc 05 §5).
type pendingState string

const (
	pendingQueued   pendingState = "QUEUED"
	pendingResolved pendingState = "RESOLVED" // server processed, awaiting settle
	pendingSettled  pendingState = "SETTLED"  // canonical state applied client-side
)

// pendingOp is one entry of the outbox.
type pendingOp struct {
	Op         sync.Operation
	State      pendingState
	SettleAt   int64 // settle_after_revision; 0 = settled on receipt
	Result     sync.OperationResult
	Settled    bool
}

// browserNode is a node of the fake browser's own bookmark tree.
type browserNode struct {
	ID      string
	Type    canonical.NodeType // folder | bookmark; roots are containers
	Title   string
	URL     string
	Parent  string // parent browser id, "" for browser roots
	RootKey string // browser roots only: the canonical root slot key
}

// mirrorNode is one local_nodes row (doc 05 §4): identity mapping plus
// the last-known canonical projection.
type mirrorNode struct {
	CanonicalID string
	BrowserID   string
	Type        canonical.NodeType
	Title       string
	URL         string
	Parent      canonical.ParentRef
	Position    int64
}

// FakeBrowser simulates one extension installation.
type FakeBrowser struct {
	Name      string
	DeviceID  string
	BindingID string

	// Browser bookmark tree (durable in a real browser).
	nodes      map[string]*browserNode
	childOrder map[string][]string // parent browser id → ordered children

	// binding_roots: canonical root slot key → browser root container id.
	// Unknown keys (Recovered/<Device>) get a local container on demand.
	rootContainers map[string]string

	// Persisted replica state (the IndexedDB analog): mirror, outbox,
	// inbox, watermarks. All of it survives a crash; only in-flight
	// processing is lost.
	mirror          map[string]*mirrorNode // canonical id → mirror row
	byBrowserID     map[string]string      // browser id → canonical id
	outbox          []*pendingOp           // QUEUED, client_seq order
	resolved        []*pendingOp           // RESOLVED / SETTLED
	inbox           []sync.JournalChange   // persisted, not yet applied
	inboxRevisions  map[int64]bool
	epoch           int64
	appliedRevision int64
	receivedRevision int64
	clientSeq       int64

	nextBrowserID int

	// Crash knobs, armed per replica (doc 21 §7). Consumed once.
	crashBeforeInboxApply bool // killed after persisting, before applying
	crashMidApply         int  // killed after N inbox applications

	// online gates network access; capture always works (offline
	// editing, doc 04).
	online bool

	world *World
}

func newFakeBrowser(world *World, name string) *FakeBrowser {
	return &FakeBrowser{
		Name:           name,
		nodes:          map[string]*browserNode{},
		childOrder:     map[string][]string{},
		rootContainers: map[string]string{},
		mirror:         map[string]*mirrorNode{},
		byBrowserID:    map[string]string{},
		inboxRevisions: map[int64]bool{},
		nextBrowserID:  1,
		world:          world,
	}
}

// --- browser tree helpers ---

func (b *FakeBrowser) newBrowserID() string {
	id := fmt.Sprintf("%s-b%d", b.Name, b.nextBrowserID)
	b.nextBrowserID++
	return id
}

// addRootNode creates a browser root container.
func (b *FakeBrowser) addRootNode(id, title, rootKey string) {
	b.nodes[id] = &browserNode{ID: id, Title: title, RootKey: rootKey}
	b.childOrder[id] = nil
}

func (b *FakeBrowser) addChild(parent, id string) {
	b.childOrder[parent] = append(b.childOrder[parent], id)
}

func (b *FakeBrowser) detach(id string) {
	node := b.nodes[id]
	if node == nil || node.Parent == "" {
		return
	}
	siblings := b.childOrder[node.Parent]
	for i, cur := range siblings {
		if cur == id {
			b.childOrder[node.Parent] = append(siblings[:i], siblings[i+1:]...)
			return
		}
	}
}

func (b *FakeBrowser) insertBefore(parent, id, before string) {
	siblings := b.childOrder[parent]
	at := len(siblings)
	if before != "" {
		for i, cur := range siblings {
			if cur == before {
				at = i
				break
			}
		}
	}
	siblings = append(siblings, "")
	copy(siblings[at+1:], siblings[at:])
	siblings[at] = id
	b.childOrder[parent] = siblings
}

// children returns the ordered children of a browser node.
func (b *FakeBrowser) children(id string) []string { return b.childOrder[id] }

// --- local event capture (doc 05 §5) ---
// Every capture mirrors the mutation and queues the operation in one
// "transaction": there is no observable intermediate state.

func (b *FakeBrowser) newOperation() (sync.Operation, *pendingOp) {
	opID, err := uuid.NewV7()
	if err != nil {
		panic(err) // uuid failure is a platform failure in tests
	}
	b.clientSeq++
	op := sync.Operation{OpID: opID.String(), ClientSeq: b.clientSeq, BaseRevision: b.appliedRevision}
	p := &pendingOp{Op: op, State: pendingQueued}
	return op, p
}

func (b *FakeBrowser) enqueue(p *pendingOp) {
	b.outbox = append(b.outbox, p)
}

func (b *FakeBrowser) mirrorOf(browserID string) *mirrorNode {
	if cid, ok := b.byBrowserID[browserID]; ok {
		return b.mirror[cid]
	}
	return nil
}

func (b *FakeBrowser) parentRefOfBrowser(id string) canonical.ParentRef {
	node := b.nodes[id]
	if node.RootKey != "" {
		return canonical.NewRootParent(node.RootKey)
	}
	if m := b.mirrorOf(id); m != nil {
		return canonical.NewNodeParent(canonical.NodeID(m.CanonicalID))
	}
	return canonical.ParentRef{}
}

// CaptureCreate adds a bookmark tree node through the browser API and
// queues the CREATE intent. The canonical id is generated client-side so
// the mapping exists before the server ever sees the op (doc 04: own
// changes flow back as echoes and settle idempotently).
func (b *FakeBrowser) CaptureCreate(parentBrowserID, typ, title, url string) string {
	cid, err := uuid.NewV7()
	if err != nil {
		panic(err)
	}
	id := b.newBrowserID()
	node := &browserNode{ID: id, Type: canonical.NodeType(typ), Title: title, URL: url, Parent: parentBrowserID}
	b.nodes[id] = node
	b.addChild(parentBrowserID, id)

	op, p := b.newOperation()
	op.Type = sync.OpCreate
	op.NodeID = canonical.NodeID(cid.String())
	op.NodeType = node.Type
	op.Title = title
	op.URL = url
	op.Parent = b.parentRefOfBrowser(parentBrowserID)
	// Anchor: next mapped sibling's canonical id, append when none.
	op.BeforeID = b.canonicalAnchor(parentBrowserID, id)
	p.Op = op

	b.mirror[op.NodeID.String()] = &mirrorNode{
		CanonicalID: op.NodeID.String(),
		BrowserID:   id,
		Type:        node.Type,
		Title:       title,
		URL:         url,
		Parent:      op.Parent,
		Position:    int64(len(b.children(parentBrowserID)) - 1),
	}
	b.byBrowserID[id] = op.NodeID.String()
	b.enqueue(p)
	return id
}

// canonicalAnchor returns the canonical id of the first mapped sibling
// after browserID, or "" for append (doc 05 §12).
func (b *FakeBrowser) canonicalAnchor(parentBrowserID, browserID string) *canonical.NodeID {
	siblings := b.children(parentBrowserID)
	found := false
	for _, cur := range siblings {
		if cur == browserID {
			found = true
			continue
		}
		if found {
			if m := b.mirrorOf(cur); m != nil {
				id := canonical.NodeID(m.CanonicalID)
				return &id
			}
		}
	}
	return nil
}

// CaptureUpdateTitle renames a node in the browser and queues the intent.
func (b *FakeBrowser) CaptureUpdateTitle(browserID, title string) {
	node, ok := b.nodes[browserID]
	if !ok {
		panic("syncsim: CaptureUpdateTitle on unknown browser node " + browserID)
	}
	node.Title = title
	if m := b.mirrorOf(browserID); m != nil {
		m.Title = title
	}
	op, p := b.newOperation()
	op.Type = sync.OpUpdateTitle
	op.NodeID = canonical.NodeID(b.byBrowserID[browserID])
	op.Title = title
	p.Op = op
	b.enqueue(p)
}

// CaptureUpdateURL changes a bookmark's URL and queues the intent.
func (b *FakeBrowser) CaptureUpdateURL(browserID, url string) {
	node, ok := b.nodes[browserID]
	if !ok {
		panic("syncsim: CaptureUpdateURL on unknown browser node " + browserID)
	}
	node.URL = url
	if m := b.mirrorOf(browserID); m != nil {
		m.URL = url
	}
	op, p := b.newOperation()
	op.Type = sync.OpUpdateURL
	op.NodeID = canonical.NodeID(b.byBrowserID[browserID])
	op.URL = url
	p.Op = op
	b.enqueue(p)
}

// CaptureMove moves a node in the browser tree and queues the intent.
func (b *FakeBrowser) CaptureMove(browserID, parentBrowserID, beforeBrowserID string) {
	if b.nodes[browserID] == nil {
		panic("syncsim: CaptureMove on unknown browser node " + browserID)
	}
	b.detach(browserID)
	b.nodes[browserID].Parent = parentBrowserID
	b.insertBefore(parentBrowserID, browserID, beforeBrowserID)

	op, p := b.newOperation()
	op.Type = sync.OpMove
	op.NodeID = canonical.NodeID(b.byBrowserID[browserID])
	op.Parent = b.parentRefOfBrowser(parentBrowserID)
	if beforeBrowserID != "" {
		if m := b.mirrorOf(beforeBrowserID); m != nil {
			id := canonical.NodeID(m.CanonicalID)
			op.BeforeID = &id
		}
	}
	if m := b.mirrorOf(browserID); m != nil {
		m.Parent = op.Parent
		m.Position = int64(indexOf(b.children(parentBrowserID), browserID))
	}
	p.Op = op
	b.enqueue(p)
}

// CaptureDelete removes a node (and its subtree) in the browser and
// queues the DELETE intent. Mappings of the subtree are dropped; if the
// server later rejects the delete, the change stream re-creates the
// nodes and the mirror is rebuilt by the remote applier.
func (b *FakeBrowser) CaptureDelete(browserID string) []string {
	if b.nodes[browserID] == nil {
		panic("syncsim: CaptureDelete on unknown browser node " + browserID)
	}
	cid := b.byBrowserID[browserID]
	removed := b.removeSubtree(browserID)
	op, p := b.newOperation()
	op.Type = sync.OpDelete
	op.NodeID = canonical.NodeID(cid)
	p.Op = op
	b.enqueue(p)
	return removed
}

func (b *FakeBrowser) removeSubtree(browserID string) []string {
	removed := []string{}
	stack := []string{browserID}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		stack = append(stack, b.childOrder[id]...)
		b.detach(id)
		removed = append(removed, id)
		delete(b.childOrder, id)
		if cid, ok := b.byBrowserID[id]; ok {
			delete(b.mirror, cid)
			delete(b.byBrowserID, id)
		}
		delete(b.nodes, id)
	}
	return removed
}

func indexOf(list []string, want string) int {
	for i, cur := range list {
		if cur == want {
			return i
		}
	}
	return -1
}

// --- change payload decoding (journal wire format, doc 04 §13) ---

type journalParent struct {
	Type string `json:"type"`
	ID   string `json:"id,omitempty"`
	Key  string `json:"key,omitempty"`
}

func (p journalParent) toRef() canonical.ParentRef {
	if p.Type == "node" {
		return canonical.NewNodeParent(canonical.NodeID(p.ID))
	}
	return canonical.NewRootParent(p.Key)
}

type createPayload struct {
	Type     string        `json:"type"`
	Title    string        `json:"title"`
	URL      string        `json:"url,omitempty"`
	Parent   journalParent `json:"parent"`
	Position int64         `json:"position"`
}

type updateTitlePayload struct {
	Title string `json:"title"`
}

type updateURLPayload struct {
	URL string `json:"url"`
}

type movePayload struct {
	Parent   journalParent `json:"parent"`
	Position int64         `json:"position"`
}

// SeedRaw populates the browser tree directly without mapping or
// outbox: pre-extension browser content that initial reconciliation
// must discover.
func (b *FakeBrowser) SeedRaw(parentBrowserID, typ, title, url string) string {
	id := b.newBrowserID()
	node := &browserNode{ID: id, Type: canonical.NodeType(typ), Title: title, URL: url, Parent: parentBrowserID}
	b.nodes[id] = node
	b.addChild(parentBrowserID, id)
	return id
}

// CanonicalIDOf returns the canonical id mapped to a browser node.
func (b *FakeBrowser) CanonicalIDOf(browserID string) string { return b.byBrowserID[browserID] }

// BrowserIDOfCanonical returns the browser node mapped to a canonical id.
func (b *FakeBrowser) BrowserIDOfCanonical(cid string) string {
	if m, ok := b.mirror[cid]; ok {
		return m.BrowserID
	}
	return ""
}
