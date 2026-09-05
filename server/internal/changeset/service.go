package changeset

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Store is the persistence contract required by the service, defined on
// the consumer side. The in-transaction methods take the caller's
// canonical.Tx; the sqlite implementation commits them atomically with the
// canonical mutation (doc 15 §13: the Before Image must never be persisted
// after the fact).
type Store interface {
	// BeginTx starts a transaction for undo execution.
	BeginTx(ctx context.Context) (canonical.Tx, error)

	InsertChangeSetTx(ctx context.Context, tx canonical.Tx, cs ChangeSet) error

	// ChangeSetJournalRangeTx returns the first/last revision and the row
	// count of the journal entries linked to one ChangeSet.
	ChangeSetJournalRangeTx(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, epoch int64, changeSetID string) (first, last, count int64, err error)

	MarkChangeSetUndoneTx(ctx context.Context, tx canonical.Tx, id, undoneBy string, at time.Time) error

	// DeleteTombstonesTx clears the deletion records of restored nodes so
	// future stale operations are not resolved as target_deleted.
	DeleteTombstonesTx(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, ids []canonical.NodeID) error

	// EnsureRootSlotTx creates a root slot if missing (undo fallback
	// location, doc 15 §7).
	EnsureRootSlotTx(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, key, displayName string) error

	GetChangeSet(ctx context.Context, id string) (ChangeSet, bool, error)
	ListChangeSets(ctx context.Context, space canonical.SpaceID, limit int) ([]ChangeSet, error)
}

// Service records ChangeSets alongside canonical mutations and executes
// ChangeSet-level undo.
type Service struct {
	store    Store
	executor *canonical.Executor
}

// NewService returns a changeset service.
func NewService(store Store) *Service {
	return &Service{store: store, executor: canonical.NewExecutor()}
}

// The recovery location for restored subtrees whose original parent is
// gone: content is never lost (doc 15 §7).
const (
	undoRecoveryRootKey  = "recovered:undo"
	undoRecoveryRootName = "Recovered/Undo"
)

// Batch records one ChangeSet while applying its commands inside a caller
// transaction. Per command the Before Image is captured before the
// mutation and the row is persisted by Finish in the same transaction.
type Batch struct {
	svc       *Service
	space     canonical.SpaceID
	kind      Kind
	origin    canonical.Origin // ChangeSetID set
	undoable  bool
	id        string
	inverseOf string
	started   time.Time

	updates []UpdateUndo
	moves   []MoveUndo
	creates []CreateUndo
	deletes []SubtreeSnapshot
	// titles collected at capture time for move summaries.
	titles map[canonical.NodeID]string
}

// BeginBatch starts a ChangeSet batch. When undoable is false the batch
// still links its journal entries but stores no Before Image (not
// undoable, e.g. transfer sides).
func (s *Service) BeginBatch(space canonical.SpaceID, kind Kind, origin canonical.Origin, undoable bool) *Batch {
	id := uuid.NewString()
	origin.ChangeSetID = id
	return &Batch{
		svc:      s,
		space:    space,
		kind:     kind,
		origin:   origin,
		undoable: undoable,
		id:       id,
		started:  time.Now().UTC(),
		titles:   map[canonical.NodeID]string{},
	}
}

// ID returns the ChangeSet id stamped on the journal entries.
func (b *Batch) ID() string { return b.id }

// Apply captures the before image, applies the command and captures the
// post-state, all inside the caller's transaction.
func (b *Batch) Apply(ctx context.Context, tx canonical.Tx, cmd canonical.Command) error {
	if b.undoable {
		if err := b.captureBefore(ctx, tx, cmd); err != nil {
			return err
		}
	}
	if err := b.svc.executor.ApplyTx(ctx, tx, b.origin, cmd); err != nil {
		return err
	}
	if b.undoable {
		if err := b.captureAfter(ctx, tx, cmd); err != nil {
			return err
		}
	}
	return nil
}

func (b *Batch) captureBefore(ctx context.Context, tx canonical.Tx, cmd canonical.Command) error {
	switch c := cmd.(type) {
	case canonical.CreateNode:
		b.creates = append(b.creates, CreateUndo{NodeID: c.NodeID, Type: c.Type, Title: c.Title})
	case canonical.UpdateNodeTitle:
		node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
		if err != nil {
			return err
		}
		b.updates = append(b.updates, UpdateUndo{
			NodeID: c.NodeID, Field: "title", Title: node.Title,
			Before: node.Title, ExpectedAfter: c.Title,
		})
	case canonical.UpdateNodeURL:
		node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
		if err != nil {
			return err
		}
		b.updates = append(b.updates, UpdateUndo{
			NodeID: c.NodeID, Field: "url", Title: node.Title,
			Before: node.URL, ExpectedAfter: c.URL,
		})
	case canonical.MoveNode:
		node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
		if err != nil {
			return err
		}
		b.titles[c.NodeID] = node.Title
		b.moves = append(b.moves, MoveUndo{
			NodeID: c.NodeID, Title: node.Title,
			OldParent: fromParent(node.Parent), OldPosition: node.Position,
		})
	case canonical.DeleteNode:
		snap, err := readSubtree(ctx, tx, c.SpaceID, c.NodeID)
		if err != nil {
			return err
		}
		b.deletes = append(b.deletes, snap)
	default:
		return fmt.Errorf("changeset: unsupported command %T", cmd)
	}
	return nil
}

func (b *Batch) captureAfter(ctx context.Context, tx canonical.Tx, cmd canonical.Command) error {
	c, ok := cmd.(canonical.MoveNode)
	if !ok {
		return nil
	}
	node, err := tx.LoadNode(ctx, c.SpaceID, c.NodeID)
	if err != nil {
		return err
	}
	// Record the actual post-move location on the latest capture of this
	// node (the anchor may have been rebased during decide).
	for i := len(b.moves) - 1; i >= 0; i-- {
		if b.moves[i].NodeID == c.NodeID {
			b.moves[i].ExpectedParent = fromParent(node.Parent)
			b.moves[i].ExpectedPosition = node.Position
			break
		}
	}
	return nil
}

// Finish persists the ChangeSet row when the batch produced at least one
// journal entry; canonical no-ops (e.g. a move onto itself) record
// nothing. An empty summary falls back to the kind default.
func (b *Batch) Finish(ctx context.Context, tx canonical.Tx, summary string) (bool, error) {
	sp, err := tx.LoadSpace(ctx, b.space)
	if err != nil {
		return false, err
	}
	first, last, count, err := b.svc.store.ChangeSetJournalRangeTx(ctx, tx, b.space, sp.Epoch, b.id)
	if err != nil {
		return false, err
	}
	if count == 0 {
		return false, nil
	}
	if summary == "" {
		summary = b.defaultSummary()
	}
	cs := ChangeSet{
		ID:            b.id,
		SpaceID:       b.space,
		Epoch:         sp.Epoch,
		Kind:          b.kind,
		Summary:       summary,
		OriginType:    b.origin.Type,
		ActorUserID:   b.origin.UserID,
		ActorDeviceID: b.origin.DeviceID,
		FirstRevision: first,
		LastRevision:  last,
		InverseOf:     b.inverseOf,
		CreatedAt:     b.started,
	}
	if b.undoable {
		data, err := json.Marshal(UndoData{
			Updates: b.updates, Moves: b.moves, Creates: b.creates, Deletes: b.deletes,
		})
		if err != nil {
			return false, err
		}
		cs.UndoDataJSON = string(data)
	}
	if err := b.svc.store.InsertChangeSetTx(ctx, tx, cs); err != nil {
		return false, err
	}
	return true, nil
}

func (b *Batch) defaultSummary() string {
	switch b.kind {
	case KindNodeCreate:
		if len(b.creates) > 0 {
			return fmt.Sprintf("新建了「%s」", b.creates[0].Title)
		}
	case KindNodeUpdate:
		title, hasTitle, hasURL := "", false, false
		for _, u := range b.updates {
			if u.Field == "title" {
				hasTitle = true
				title = u.Title
			} else {
				hasURL = true
				if title == "" {
					title = u.Title
				}
			}
		}
		switch {
		case hasTitle && hasURL:
			return fmt.Sprintf("修改了「%s」的标题和链接", title)
		case hasURL:
			return fmt.Sprintf("修改了「%s」的链接", title)
		case hasTitle:
			return fmt.Sprintf("修改了「%s」的标题", title)
		}
	case KindNodeMove:
		if len(b.moves) > 0 {
			return fmt.Sprintf("移动了「%s」", b.moves[0].Title)
		}
	case KindNodeDelete:
		if len(b.deletes) > 0 {
			first := b.deletes[0].Nodes[0]
			if extra := len(b.deletes[0].Nodes) - 1; extra > 0 {
				return fmt.Sprintf("删除了「%s」及 %d 个子项", first.Title, extra)
			}
			return fmt.Sprintf("删除了「%s」", first.Title)
		}
	}
	return string(b.kind)
}

// RecordNodeOp applies one primitive node operation (or a title+url pair)
// as a single ChangeSet inside the caller's transaction. It returns
// applied=false for canonical no-ops.
func (s *Service) RecordNodeOp(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, origin canonical.Origin, cmds ...canonical.Command) (bool, error) {
	if len(cmds) == 0 {
		return false, nil
	}
	kind, err := nodeKind(cmds)
	if err != nil {
		return false, err
	}
	b := s.BeginBatch(space, kind, origin, true)
	for _, cmd := range cmds {
		if err := b.Apply(ctx, tx, cmd); err != nil {
			return false, err
		}
	}
	return b.Finish(ctx, tx, "")
}

func nodeKind(cmds []canonical.Command) (Kind, error) {
	var kind Kind
	for _, cmd := range cmds {
		var k Kind
		switch cmd.(type) {
		case canonical.CreateNode:
			k = KindNodeCreate
		case canonical.UpdateNodeTitle, canonical.UpdateNodeURL:
			k = KindNodeUpdate
		case canonical.MoveNode:
			k = KindNodeMove
		case canonical.DeleteNode:
			k = KindNodeDelete
		default:
			return "", fmt.Errorf("changeset: unsupported command %T", cmd)
		}
		if kind == "" {
			kind = k
		} else if kind != k {
			return "", fmt.Errorf("changeset: mixed command kinds in one node operation")
		}
	}
	return kind, nil
}

// Undo builds the plan for one ChangeSet and, when clean, executes the
// inverse commands as a new ChangeSet (doc 15 §8). Undo never rolls back
// revisions: every inverse step allocates fresh revisions.
func (s *Service) Undo(ctx context.Context, space canonical.SpaceID, changeSetID string, actor canonical.UserID) (UndoResult, error) {
	cs, found, err := s.store.GetChangeSet(ctx, changeSetID)
	if err != nil {
		return UndoResult{}, err
	}
	if !found || cs.SpaceID != space {
		return UndoResult{}, ErrChangeSetNotFound
	}
	if cs.UndoneByChangeSet != "" {
		return UndoResult{Status: PlanNotUndoable, Summary: cs.Summary}, ErrAlreadyUndone
	}
	if cs.UndoDataJSON == "" {
		return UndoResult{Status: PlanNotUndoable, Summary: cs.Summary}, nil
	}
	if time.Since(cs.CreatedAt) > UndoWindow {
		return UndoResult{Status: PlanExpired, Summary: cs.Summary}, nil
	}

	var ud UndoData
	if err := json.Unmarshal([]byte(cs.UndoDataJSON), &ud); err != nil {
		return UndoResult{}, fmt.Errorf("changeset: decode undo data: %w", err)
	}

	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return UndoResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	sp, err := tx.LoadSpace(ctx, space)
	if err != nil {
		return UndoResult{}, err
	}
	// A ChangeSet from a previous epoch refers to a superseded canonical
	// world (e.g. after a backup restore): its Before Image is stale.
	if cs.Epoch != sp.Epoch {
		return UndoResult{Status: PlanNotUndoable, Summary: cs.Summary}, nil
	}

	reasons, err := s.reviewReasons(ctx, tx, space, cs, &ud)
	if err != nil {
		return UndoResult{}, err
	}
	if len(reasons) > 0 {
		return UndoResult{Status: PlanReviewRequired, Summary: cs.Summary, Reasons: reasons}, nil
	}

	undoID, err := s.applyInverse(ctx, tx, space, cs, &ud, actor)
	if err != nil {
		return UndoResult{}, err
	}
	if err := s.store.MarkChangeSetUndoneTx(ctx, tx, cs.ID, undoID, time.Now().UTC()); err != nil {
		return UndoResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return UndoResult{}, err
	}
	committed = true
	return UndoResult{Status: PlanClean, ChangeSetID: undoID, Summary: "撤销：" + cs.Summary}, nil
}

// reviewReasons returns the human-readable blockers that force a review
// instead of a clean undo (doc 15 §4-§8).
func (s *Service) reviewReasons(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, cs ChangeSet, ud *UndoData) ([]string, error) {
	var reasons []string
	add := func(format string, args ...any) {
		reasons = append(reasons, fmt.Sprintf(format, args...))
	}

	// UPDATE: the field must still hold the expected after-state.
	for _, u := range dedupeUpdates(ud.Updates) {
		node, err := tx.LoadNode(ctx, space, u.NodeID)
		if errors.Is(err, canonical.ErrNodeNotFound) {
			add("「%s」已被删除，无法撤销修改", u.Title)
			continue
		}
		if err != nil {
			return nil, err
		}
		current, rev := node.Title, node.TitleRevision
		if u.Field == "url" {
			current, rev = node.URL, node.URLRevision
		}
		if rev > cs.LastRevision || current != u.ExpectedAfter {
			add("「%s」后来已被修改，撤销需要人工确认", u.Title)
		}
	}

	// MOVE: the node must not have been moved again; the old location
	// must still exist.
	for _, m := range dedupeMoves(ud.Moves) {
		node, err := tx.LoadNode(ctx, space, m.NodeID)
		if errors.Is(err, canonical.ErrNodeNotFound) {
			add("「%s」已被删除，无法撤销移动", m.Title)
			continue
		}
		if err != nil {
			return nil, err
		}
		if node.StructureRevision > cs.LastRevision {
			add("「%s」后来又被移动，撤销需要人工确认", m.Title)
			continue
		}
		if ok, err := parentExists(ctx, tx, space, m.OldParent.toParent()); err != nil {
			return nil, err
		} else if !ok {
			add("「%s」的原位置已不存在", m.Title)
		}
	}

	// CREATE: folders must not contain data added after this ChangeSet.
	created := make(map[canonical.NodeID]bool, len(ud.Creates))
	for _, c := range ud.Creates {
		created[c.NodeID] = true
	}
	for _, c := range ud.Creates {
		node, err := tx.LoadNode(ctx, space, c.NodeID)
		if errors.Is(err, canonical.ErrNodeNotFound) {
			continue // already gone: nothing to remove
		}
		if err != nil {
			return nil, err
		}
		if node.Type != canonical.NodeTypeFolder {
			continue
		}
		ids, err := tx.SubtreeIDs(ctx, space, c.NodeID)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			if id != c.NodeID && !created[id] {
				add("「%s」内已有后续新增的内容，删除需要人工确认", c.Title)
				break
			}
		}
	}

	// DELETE restore: the original canonical UUID must be free.
	for _, d := range ud.Deletes {
		if _, err := tx.LoadNode(ctx, space, d.Root); err == nil {
			add("「%s」当前已存在，无法恢复", d.Nodes[0].Title)
		} else if !errors.Is(err, canonical.ErrNodeNotFound) {
			return nil, err
		}
	}
	return reasons, nil
}

// applyInverse executes the inverse commands as one new ChangeSet and
// returns its id (empty when there was nothing to invert).
func (s *Service) applyInverse(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, cs ChangeSet, ud *UndoData, actor canonical.UserID) (string, error) {
	b := s.BeginBatch(space, KindUndo, canonical.Origin{Type: canonical.OriginUser, UserID: actor}, false)
	b.inverseOf = cs.ID

	// 1. Restore deleted subtrees, last deleted first: a parent deleted
	//    after its child is restored before the child needs it again.
	for i := len(ud.Deletes) - 1; i >= 0; i-- {
		if err := s.restoreSnapshot(ctx, tx, b, space, ud.Deletes[i]); err != nil {
			return "", err
		}
	}
	// 2. Revert field updates.
	for _, u := range dedupeUpdates(ud.Updates) {
		var cmd canonical.Command
		if u.Field == "url" {
			cmd = canonical.UpdateNodeURL{SpaceID: space, NodeID: u.NodeID, URL: u.Before}
		} else {
			cmd = canonical.UpdateNodeTitle{SpaceID: space, NodeID: u.NodeID, Title: u.Before}
		}
		if err := b.Apply(ctx, tx, cmd); err != nil {
			return "", err
		}
	}
	// 3. Move nodes back to their old location.
	for _, m := range dedupeMoves(ud.Moves) {
		parent := m.OldParent.toParent()
		anchor, err := anchorAt(ctx, tx, space, parent, m.OldPosition)
		if err != nil {
			return "", err
		}
		if err := b.Apply(ctx, tx, canonical.MoveNode{
			SpaceID: space, NodeID: m.NodeID, Parent: parent, BeforeID: anchor,
		}); err != nil {
			return "", err
		}
	}
	// 4. Remove created nodes. Only the top-level ones are deleted: their
	//    subtrees hold no foreign data (guaranteed by the plan).
	for i := len(ud.Creates) - 1; i >= 0; i-- {
		c := ud.Creates[i]
		node, err := tx.LoadNode(ctx, space, c.NodeID)
		if errors.Is(err, canonical.ErrNodeNotFound) {
			continue
		}
		if err != nil {
			return "", err
		}
		if node.Parent.Type == canonical.ParentTypeNode && createdSetHas(ud.Creates, node.Parent.NodeID) {
			continue // covered by the ancestor's recursive delete
		}
		if err := b.Apply(ctx, tx, canonical.DeleteNode{SpaceID: space, NodeID: c.NodeID}); err != nil {
			return "", err
		}
	}

	applied, err := b.Finish(ctx, tx, "撤销："+cs.Summary)
	if err != nil {
		return "", err
	}
	if !applied {
		return "", nil
	}
	return b.ID(), nil
}

func createdSetHas(creates []CreateUndo, id canonical.NodeID) bool {
	for _, c := range creates {
		if c.NodeID == id {
			return true
		}
	}
	return false
}

// restoreSnapshot re-creates a deleted subtree with its original canonical
// UUIDs. When the original parent is gone the subtree falls back to the
// recovery root instead of being lost (doc 15 §7).
func (s *Service) restoreSnapshot(ctx context.Context, tx canonical.Tx, b *Batch, space canonical.SpaceID, snap SubtreeSnapshot) error {
	rootParent := snap.Parent.toParent()
	if ok, err := parentExists(ctx, tx, space, rootParent); err != nil {
		return err
	} else if !ok {
		if err := s.store.EnsureRootSlotTx(ctx, tx, space, undoRecoveryRootKey, undoRecoveryRootName); err != nil {
			return err
		}
		rootParent = canonical.NewRootParent(undoRecoveryRootKey)
	}
	ids := make([]canonical.NodeID, 0, len(snap.Nodes))
	for i, n := range snap.Nodes {
		parent := rootParent
		if i > 0 {
			// In-subtree parents are restored just before their children.
			parent = n.Parent.toParent()
		}
		if err := b.Apply(ctx, tx, canonical.CreateNode{
			SpaceID: space, NodeID: n.ID, Type: n.Type,
			Title: n.Title, URL: n.URL, Parent: parent,
		}); err != nil {
			return err
		}
		ids = append(ids, n.ID)
	}
	// The tombstones of restored nodes are stale: the nodes are alive
	// again and must not resolve future stale operations as deleted.
	return s.store.DeleteTombstonesTx(ctx, tx, space, ids)
}

// anchorAt resolves the insert anchor landing a node at position among the
// parent's current children (append when out of range).
func anchorAt(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, parent canonical.ParentRef, position int64) (*canonical.NodeID, error) {
	children, err := tx.Children(ctx, space, parent)
	if err != nil {
		return nil, err
	}
	if position < 0 || position >= int64(len(children)) {
		return nil, nil
	}
	id := children[position].ID
	return &id, nil
}

func parentExists(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, parent canonical.ParentRef) (bool, error) {
	switch parent.Type {
	case canonical.ParentTypeNode:
		_, err := tx.LoadNode(ctx, space, parent.NodeID)
		if errors.Is(err, canonical.ErrNodeNotFound) {
			return false, nil
		}
		return err == nil, err
	case canonical.ParentTypeRoot:
		_, err := tx.LoadRootSlot(ctx, space, parent.RootKey)
		if errors.Is(err, canonical.ErrRootSlotNotFound) {
			return false, nil
		}
		return err == nil, err
	default:
		return false, nil
	}
}

// readSubtree snapshots the whole subtree (parents before children) before
// a delete commits.
func readSubtree(ctx context.Context, tx canonical.Tx, space canonical.SpaceID, root canonical.NodeID) (SubtreeSnapshot, error) {
	node, err := tx.LoadNode(ctx, space, root)
	if err != nil {
		return SubtreeSnapshot{}, err
	}
	snap := SubtreeSnapshot{
		Root:     root,
		Parent:   fromParent(node.Parent),
		Position: node.Position,
		Nodes:    []NodeSnapshot{nodeSnapshotOf(node)},
	}
	queue := []canonical.NodeID{root}
	for len(queue) > 0 {
		parent := queue[0]
		queue = queue[1:]
		children, err := tx.Children(ctx, space, canonical.NewNodeParent(parent))
		if err != nil {
			return SubtreeSnapshot{}, err
		}
		for _, c := range children {
			snap.Nodes = append(snap.Nodes, nodeSnapshotOf(c))
			queue = append(queue, c.ID)
		}
	}
	return snap, nil
}

func nodeSnapshotOf(n canonical.Node) NodeSnapshot {
	return NodeSnapshot{
		ID:       n.ID,
		Type:     n.Type,
		Title:    n.Title,
		URL:      n.URL,
		Parent:   fromParent(n.Parent),
		Position: n.Position,
	}
}

// dedupeUpdates merges repeated edits of the same field into one undo step:
// the earliest Before with the latest ExpectedAfter.
func dedupeUpdates(in []UpdateUndo) []UpdateUndo {
	out := make([]UpdateUndo, 0, len(in))
	idx := map[string]int{}
	for _, u := range in {
		key := string(u.NodeID) + "|" + u.Field
		if i, ok := idx[key]; ok {
			out[i].ExpectedAfter = u.ExpectedAfter
			continue
		}
		idx[key] = len(out)
		out = append(out, u)
	}
	return out
}

// dedupeMoves merges repeated moves of the same node: the earliest old
// location with the latest expected location.
func dedupeMoves(in []MoveUndo) []MoveUndo {
	out := make([]MoveUndo, 0, len(in))
	idx := map[canonical.NodeID]int{}
	for _, m := range in {
		if i, ok := idx[m.NodeID]; ok {
			out[i].ExpectedParent = m.ExpectedParent
			out[i].ExpectedPosition = m.ExpectedPosition
			continue
		}
		idx[m.NodeID] = len(out)
		out = append(out, m)
	}
	return out
}
