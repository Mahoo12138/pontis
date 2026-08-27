package canonical

import (
	"context"
	"fmt"
	"time"
)

// Command is a canonical tree mutation intent executed by the Executor.
// Higher-level operations (restore, batch, import, transfer) are built on
// top of these primitives.
type Command interface{ command() }

// CreateNode inserts a new node. BeforeID == nil means append.
type CreateNode struct {
	SpaceID  SpaceID
	NodeID   NodeID
	Type     NodeType
	Title    string
	URL      string
	Parent   ParentRef
	BeforeID *NodeID
}

// UpdateNodeTitle renames a node.
type UpdateNodeTitle struct {
	SpaceID SpaceID
	NodeID  NodeID
	Title   string
}

// UpdateNodeURL changes a bookmark's URL.
type UpdateNodeURL struct {
	SpaceID SpaceID
	NodeID  NodeID
	URL     string
}

// MoveNode reparents and/or reorders a node. A move within the same parent
// is a reorder.
type MoveNode struct {
	SpaceID  SpaceID
	NodeID   NodeID
	Parent   ParentRef
	BeforeID *NodeID
}

// DeleteNode removes a node and its whole subtree.
type DeleteNode struct {
	SpaceID SpaceID
	NodeID  NodeID
}

func (CreateNode) command()      {}
func (UpdateNodeTitle) command() {}
func (UpdateNodeURL) command()   {}
func (MoveNode) command()        {}
func (DeleteNode) command()      {}

// Executor validates and applies canonical commands inside a single
// transaction. Every module that mutates the bookmark tree must go through
// the executor. Node changes, revision allocation, journal and tombstones
// commit atomically.
type Executor struct{}

// NewExecutor returns a canonical executor.
func NewExecutor() *Executor { return &Executor{} }

// Execute applies all commands atomically under the given origin: either
// every command commits or nothing does.
func (e *Executor) Execute(ctx context.Context, store Store, origin Origin, cmds ...Command) error {
	if len(cmds) == 0 {
		return nil
	}
	tx, err := store.BeginTx(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	for _, cmd := range cmds {
		if err := e.apply(ctx, tx, cmd, origin); err != nil {
			return err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

func (e *Executor) apply(ctx context.Context, tx Tx, cmd Command, origin Origin) error {
	switch c := cmd.(type) {
	case CreateNode:
		return e.create(ctx, tx, c, origin)
	case UpdateNodeTitle:
		return e.updateTitle(ctx, tx, c, origin)
	case UpdateNodeURL:
		return e.updateURL(ctx, tx, c, origin)
	case MoveNode:
		return e.move(ctx, tx, c, origin)
	case DeleteNode:
		return e.delete(ctx, tx, c, origin)
	default:
		return fmt.Errorf("canonical: unknown command %T", cmd)
	}
}

func (e *Executor) create(ctx context.Context, tx Tx, c CreateNode, origin Origin) error {
	if c.Title == "" {
		return ErrTitleRequired
	}
	if err := checkTypeURL(c.Type, c.URL); err != nil {
		return err
	}
	space, err := tx.LoadSpace(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	if err := validateParent(ctx, tx, c.SpaceID, c.Parent); err != nil {
		return err
	}

	children, err := tx.Children(ctx, c.SpaceID, c.Parent)
	if err != nil {
		return err
	}
	idx, err := planInsert(children, c.BeforeID)
	if err != nil {
		return err
	}

	rev, err := tx.AllocateRevision(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	node := Node{
		SpaceID:           c.SpaceID,
		ID:                c.NodeID,
		Type:              c.Type,
		Title:             c.Title,
		URL:               c.URL,
		Parent:            c.Parent,
		Position:          int64(idx),
		CreatedRevision:   rev,
		TitleRevision:     rev,
		URLRevision:       rev,
		StructureRevision: rev,
		CreatedAt:         now,
		UpdatedAt:         now,
	}
	if err := tx.InsertNode(ctx, node); err != nil {
		return err
	}

	// Dense reindex of the siblings pushed back by the insertion. Only the
	// position column changes; no sibling revision is bumped.
	updates := make(map[NodeID]int64, len(children)-idx)
	for i := idx; i < len(children); i++ {
		updates[children[i].ID] = int64(i) + 1
	}
	if len(updates) > 0 {
		if err := tx.SetSiblingPositions(ctx, c.SpaceID, updates); err != nil {
			return err
		}
	}

	return tx.AppendJournal(ctx, Change{
		SpaceID:   c.SpaceID,
		Epoch:     space.Epoch,
		Revision:  rev,
		Type:      ChangeTypeCreate,
		NodeID:    c.NodeID,
		Payload:   CreatePayload{Type: c.Type, Title: c.Title, URL: c.URL, Parent: c.Parent, Position: int64(idx)},
		Origin:    origin,
		CreatedAt: now,
	})
}

func (e *Executor) updateTitle(ctx context.Context, tx Tx, c UpdateNodeTitle, origin Origin) error {
	space, err := tx.LoadSpace(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	if _, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID); err != nil {
		return err
	}
	if c.Title == "" {
		return ErrTitleRequired
	}
	rev, err := tx.AllocateRevision(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if err := tx.SetNodeTitle(ctx, c.SpaceID, c.NodeID, c.Title, rev, now); err != nil {
		return err
	}
	return tx.AppendJournal(ctx, Change{
		SpaceID:   c.SpaceID,
		Epoch:     space.Epoch,
		Revision:  rev,
		Type:      ChangeTypeUpdateTitle,
		NodeID:    c.NodeID,
		Payload:   UpdateTitlePayload{Title: c.Title},
		Origin:    origin,
		CreatedAt: now,
	})
}

func (e *Executor) updateURL(ctx context.Context, tx Tx, c UpdateNodeURL, origin Origin) error {
	space, err := tx.LoadSpace(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
	if err != nil {
		return err
	}
	if node.Type != NodeTypeBookmark {
		return ErrURLNotAllowed
	}
	if c.URL == "" {
		return ErrURLRequired
	}
	rev, err := tx.AllocateRevision(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if err := tx.SetNodeURL(ctx, c.SpaceID, c.NodeID, c.URL, rev, now); err != nil {
		return err
	}
	return tx.AppendJournal(ctx, Change{
		SpaceID:   c.SpaceID,
		Epoch:     space.Epoch,
		Revision:  rev,
		Type:      ChangeTypeUpdateURL,
		NodeID:    c.NodeID,
		Payload:   UpdateURLPayload{URL: c.URL},
		Origin:    origin,
		CreatedAt: now,
	})
}

func (e *Executor) move(ctx context.Context, tx Tx, c MoveNode, origin Origin) error {
	space, err := tx.LoadSpace(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
	if err != nil {
		return err
	}
	if err := validateParent(ctx, tx, c.SpaceID, c.Parent); err != nil {
		return err
	}
	if node.Type == NodeTypeFolder && c.Parent.Type == ParentTypeNode {
		if c.Parent.NodeID == node.ID {
			return ErrNodeIsSelf
		}
		cyclic, err := tx.IsAncestorOrSelf(ctx, c.SpaceID, node.ID, c.Parent.NodeID)
		if err != nil {
			return err
		}
		if cyclic {
			return ErrTreeCycle
		}
	}

	// Move to before itself is a no-op.
	if c.BeforeID != nil && *c.BeforeID == node.ID && sameParent(node.Parent, c.Parent) {
		return nil
	}

	if sameParent(node.Parent, c.Parent) {
		return e.reorder(ctx, tx, node, c.BeforeID, space, origin)
	}
	return e.reparent(ctx, tx, node, c.Parent, c.BeforeID, space, origin)
}

// reorder handles a MOVE within the same parent.
func (e *Executor) reorder(ctx context.Context, tx Tx, node Node, beforeID *NodeID, space SyncSpace, origin Origin) error {
	children, err := tx.Children(ctx, node.SpaceID, node.Parent)
	if err != nil {
		return err
	}

	// Remove the moved node from its current spot.
	base := make([]Node, 0, len(children))
	for _, c := range children {
		if c.ID != node.ID {
			base = append(base, c)
		}
	}
	idx, err := planInsert(base, beforeID)
	if err != nil {
		return err
	}
	if int64(idx) == node.Position {
		return nil // already in place, no canonical change
	}

	rev, err := tx.AllocateRevision(ctx, node.SpaceID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()

	// Dense reindex of the remaining siblings; only the moved node gets a
	// structure revision bump.
	updates := make(map[NodeID]int64, len(base))
	for i, s := range base {
		pos := int64(i)
		if i >= idx {
			pos = int64(i) + 1
		}
		if s.Position != pos {
			updates[s.ID] = pos
		}
	}
	if len(updates) > 0 {
		if err := tx.SetSiblingPositions(ctx, node.SpaceID, updates); err != nil {
			return err
		}
	}
	if err := tx.SetNodeParent(ctx, node.SpaceID, node.ID, node.Parent, int64(idx), rev, now); err != nil {
		return err
	}
	return tx.AppendJournal(ctx, Change{
		SpaceID:   node.SpaceID,
		Epoch:     space.Epoch,
		Revision:  rev,
		Type:      ChangeTypeMove,
		NodeID:    node.ID,
		Payload:   MovePayload{Parent: node.Parent, Position: int64(idx)},
		Origin:    origin,
		CreatedAt: now,
	})
}

// reparent handles a MOVE across parents.
func (e *Executor) reparent(ctx context.Context, tx Tx, node Node, parent ParentRef, beforeID *NodeID, space SyncSpace, origin Origin) error {
	oldChildren, err := tx.Children(ctx, node.SpaceID, node.Parent)
	if err != nil {
		return err
	}
	newChildren, err := tx.Children(ctx, node.SpaceID, parent)
	if err != nil {
		return err
	}
	idx, err := planInsert(newChildren, beforeID)
	if err != nil {
		return err
	}

	rev, err := tx.AllocateRevision(ctx, node.SpaceID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()

	if err := tx.SetNodeParent(ctx, node.SpaceID, node.ID, parent, int64(idx), rev, now); err != nil {
		return err
	}

	// Compact the old parent's children after the node left.
	oldUpdates := make(map[NodeID]int64, len(oldChildren))
	pos := int64(0)
	for _, s := range oldChildren {
		if s.ID == node.ID {
			continue
		}
		if s.Position != pos {
			oldUpdates[s.ID] = pos
		}
		pos++
	}
	if len(oldUpdates) > 0 {
		if err := tx.SetSiblingPositions(ctx, node.SpaceID, oldUpdates); err != nil {
			return err
		}
	}

	// Push back the new parent's children from the insertion index.
	newUpdates := make(map[NodeID]int64, len(newChildren)-idx)
	for i := idx; i < len(newChildren); i++ {
		newUpdates[newChildren[i].ID] = int64(i) + 1
	}
	if len(newUpdates) > 0 {
		if err := tx.SetSiblingPositions(ctx, node.SpaceID, newUpdates); err != nil {
			return err
		}
	}

	return tx.AppendJournal(ctx, Change{
		SpaceID:   node.SpaceID,
		Epoch:     space.Epoch,
		Revision:  rev,
		Type:      ChangeTypeMove,
		NodeID:    node.ID,
		Payload:   MovePayload{Parent: parent, Position: int64(idx)},
		Origin:    origin,
		CreatedAt: now,
	})
}

func (e *Executor) delete(ctx context.Context, tx Tx, c DeleteNode, origin Origin) error {
	space, err := tx.LoadSpace(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
	if err != nil {
		return err
	}

	ids, err := tx.SubtreeIDs(ctx, c.SpaceID, c.NodeID)
	if err != nil {
		return err
	}

	rev, err := tx.AllocateRevision(ctx, c.SpaceID)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	if err := tx.DeleteNodes(ctx, c.SpaceID, ids); err != nil {
		return err
	}
	if err := tx.InsertTombstones(ctx, c.SpaceID, space.Epoch, rev, ids, now); err != nil {
		return err
	}

	// Compact the remaining siblings.
	siblings, err := tx.Children(ctx, c.SpaceID, node.Parent)
	if err != nil {
		return err
	}
	updates := make(map[NodeID]int64, len(siblings))
	for i, s := range siblings {
		if s.Position != int64(i) {
			updates[s.ID] = int64(i)
		}
	}
	if len(updates) > 0 {
		if err := tx.SetSiblingPositions(ctx, c.SpaceID, updates); err != nil {
			return err
		}
	}

	// One top-level DELETE canonical change for the whole subtree.
	return tx.AppendJournal(ctx, Change{
		SpaceID:   c.SpaceID,
		Epoch:     space.Epoch,
		Revision:  rev,
		Type:      ChangeTypeDelete,
		NodeID:    c.NodeID,
		Payload:   DeletePayload{Count: int64(len(ids))},
		Origin:    origin,
		CreatedAt: now,
	})
}

func validateParent(ctx context.Context, tx Tx, space SpaceID, parent ParentRef) error {
	switch parent.Type {
	case ParentTypeRoot:
		_, err := tx.LoadRootSlot(ctx, space, parent.RootKey)
		return err
	case ParentTypeNode:
		p, err := tx.LoadNode(ctx, space, parent.NodeID)
		if err != nil {
			return err
		}
		if p.Type != NodeTypeFolder {
			return ErrParentNotFolder
		}
		return nil
	default:
		return ErrParentMissing
	}
}

func checkTypeURL(t NodeType, url string) error {
	switch t {
	case NodeTypeFolder:
		if url != "" {
			return ErrURLNotAllowed
		}
	case NodeTypeBookmark:
		if url == "" {
			return ErrURLRequired
		}
	default:
		return fmt.Errorf("canonical: unknown node type %q", t)
	}
	return nil
}

// planInsert returns the index at which a node should be inserted among the
// ordered siblings so that it ends up before beforeID (append if nil).
func planInsert(children []Node, beforeID *NodeID) (int, error) {
	if beforeID == nil {
		return len(children), nil
	}
	for i, c := range children {
		if c.ID == *beforeID {
			return i, nil
		}
	}
	return 0, ErrNodeNotFound
}

func sameParent(a, b ParentRef) bool {
	if a.Type != b.Type {
		return false
	}
	switch a.Type {
	case ParentTypeNode:
		return a.NodeID == b.NodeID
	case ParentTypeRoot:
		return a.RootKey == b.RootKey
	default:
		return false
	}
}
