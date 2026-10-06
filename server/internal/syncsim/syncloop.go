package syncsim

import (
	"encoding/json"
	"fmt"
	"sort"

	"pontis/internal/canonical"
	"pontis/internal/reconcile"
	"pontis/internal/sync"
)

// SyncRound performs one sync cycle: apply the persisted inbox first
// (crash resume), then flush the outbox and pull remote changes while
// online. It reports whether anything progressed.
func (b *FakeBrowser) SyncRound() (bool, error) {
	progress := b.applyInbox()
	if !b.online {
		return progress, nil
	}
	flushed, err := b.flushOutbox()
	if err != nil {
		return progress, err
	}
	pulled, err := b.pull()
	if err != nil {
		return progress, err
	}
	return progress || flushed || pulled, nil
}

// PendingCount returns the operations not yet settled.
func (b *FakeBrowser) PendingCount() int {
	n := len(b.outbox)
	for _, p := range b.resolved {
		if !p.Settled {
			n++
		}
	}
	return n
}

// flushOutbox sends every queued operation in client_seq order and
// settles the results. Response persistence happens before anything else
// touches the browser (doc 05 §6, crash rule 3).
func (b *FakeBrowser) flushOutbox() (bool, error) {
	if len(b.outbox) == 0 {
		return false, nil
	}
	ops := make([]sync.Operation, 0, len(b.outbox))
	for _, p := range b.outbox {
		ops = append(ops, p.Op)
	}
	req := sync.SyncRequest{
		ProtocolVersion:  sync.ProtocolVersion,
		DeviceID:         canonical.DeviceID(b.DeviceID),
		DeviceName:       b.Name,
		SpaceID:          b.world.SpaceID,
		Epoch:            b.epoch,
		AppliedRevision:  b.appliedRevision,
		ReceivedRevision: b.receivedRevision,
		Operations:       ops,
	}
	resp, delivered, err := b.world.deliver(req)
	if err != nil {
		return false, err
	}
	if !delivered {
		return false, nil // network drop or lost response: retry next round
	}
	b.ingestResponse(resp)
	if b.crashBeforeInboxApply {
		b.crashBeforeInboxApply = false
		return true, nil // worker killed after persisting, before applying
	}
	b.applyInbox()
	return true, nil
}

// pull drains the remaining change stream.
func (b *FakeBrowser) pull() (bool, error) {
	progress := false
	for {
		req := sync.SyncRequest{
			ProtocolVersion:  sync.ProtocolVersion,
			DeviceID:         canonical.DeviceID(b.DeviceID),
			DeviceName:       b.Name,
			SpaceID:          b.world.SpaceID,
			Epoch:            b.epoch,
			AppliedRevision:  b.appliedRevision,
			ReceivedRevision: b.receivedRevision,
		}
		resp, delivered, err := b.world.deliver(req)
		if err != nil {
			return progress, err
		}
		if !delivered {
			return progress, nil
		}
		before := b.receivedRevision
		b.ingestResponse(resp)
		if b.receivedRevision > before || len(resp.OperationResults) > 0 {
			progress = true // only real movement counts, not the confirming poll
		}
		if b.crashBeforeInboxApply {
			b.crashBeforeInboxApply = false
			return progress, nil
		}
		if b.applyInbox() {
			progress = true
		}
		if b.receivedRevision >= resp.ServerRevision {
			return progress, nil
		}
	}
}

// ingestResponse persists operation results and remote changes and
// advances received_revision only after the data is durable (doc 05 §6).
func (b *FakeBrowser) ingestResponse(resp sync.SyncResponse) {
	byOpID := map[string]*pendingOp{}
	for _, p := range b.outbox {
		byOpID[p.Op.OpID] = p
	}
	for _, result := range resp.OperationResults {
		p, ok := byOpID[result.OpID]
		if !ok {
			continue // settled by an earlier replay
		}
		p.Result = result
		p.State = pendingResolved
		p.SettleAt = result.SettleAfterRevision
		if p.SettleAt == 0 {
			p.Settled = true
		}
		delete(byOpID, result.OpID)
		b.resolved = append(b.resolved, p)
	}
	// Rebuild the queue without the resolved ops, preserving order.
	queued := b.outbox[:0]
	for _, p := range b.outbox {
		if p.State == pendingQueued {
			queued = append(queued, p)
		}
	}
	b.outbox = queued

	for _, ch := range resp.Changes {
		if ch.Revision <= b.receivedRevision || b.inboxRevisions[ch.Revision] {
			continue // duplicate delivery (replayed request or lost response retry)
		}
		b.inbox = append(b.inbox, ch)
		b.inboxRevisions[ch.Revision] = true
	}
	if resp.ThroughRevision > b.receivedRevision {
		b.receivedRevision = resp.ThroughRevision
	}
	if resp.Epoch > b.epoch {
		b.epoch = resp.Epoch
	}
}

// applyInbox applies the persisted inbox in strict revision order and
// advances applied_revision only after the browser state is confirmed
// (doc 05 §7, §11, crash rule 4).
func (b *FakeBrowser) applyInbox() bool {
	progress := false
	sort.SliceStable(b.inbox, func(i, j int) bool {
		return b.inbox[i].Revision < b.inbox[j].Revision
	})
	for len(b.inbox) > 0 {
		ch := b.inbox[0]
		if ch.Revision <= b.appliedRevision {
			// Already applied before a crash; drop the duplicate.
			b.inbox = b.inbox[1:]
			delete(b.inboxRevisions, ch.Revision)
			continue
		}
		if err := b.applyChange(ch); err != nil {
			b.world.t.Fatalf("%s: apply change %d (%s %s): %v", b.Name, ch.Revision, ch.Type, ch.NodeID, err)
		}
		b.appliedRevision = ch.Revision
		b.inbox = b.inbox[1:]
		delete(b.inboxRevisions, ch.Revision)
		progress = true
		if b.crashMidApply > 0 {
			b.crashMidApply--
			if b.crashMidApply == 0 {
				b.crashMidApply = -1 // consumed
				return progress      // killed mid-apply; resume next round
			}
		}
	}
	b.settleResolved()
	return progress
}

// settleResolved marks resolved operations as settled once their
// canonical winning state has been applied (doc 04 §7). Settled
// operations stay inspectable for assertions.
func (b *FakeBrowser) settleResolved() {
	for _, p := range b.resolved {
		if !p.Settled && p.SettleAt > 0 && b.appliedRevision >= p.SettleAt {
			p.Settled = true
		}
	}
}

// CrashBeforeInboxApply arms the replica to die after its next response
// persistence but before applying (doc 05 §6, crash rule 3).
func (b *FakeBrowser) CrashBeforeInboxApply() { b.crashBeforeInboxApply = true }

// CrashMidApply arms the replica to die after N inbox applications
// (doc 05 §10: change applied before watermark advance).
func (b *FakeBrowser) CrashMidApply(n int) { b.crashMidApply = n }

// Conflicts returns the recorded conflict outcomes of settled operations.
func (b *FakeBrowser) Conflicts() []sync.OperationResult {
	var out []sync.OperationResult
	for _, p := range b.resolved {
		if p.Result.Status == sync.StatusConflict {
			out = append(out, p.Result)
		}
	}
	return out
}

// Rejections returns recorded rejection outcomes.
func (b *FakeBrowser) Rejections() []sync.OperationResult {
	var out []sync.OperationResult
	for _, p := range b.resolved {
		if p.Result.Status == sync.StatusRejected {
			out = append(out, p.Result)
		}
	}
	return out
}

// --- remote change application (ensure-state, doc 05 §10) ---

func (b *FakeBrowser) applyChange(ch sync.JournalChange) error {
	switch sync.OpType(ch.Type) {
	case sync.OpCreate:
		var p createPayload
		if err := json.Unmarshal([]byte(ch.PayloadJSON), &p); err != nil {
			return err
		}
		if m, ok := b.mirror[ch.NodeID]; ok {
			// Own echo or re-delivery: ensure the browser already shows
			// the canonical state and treat the change as applied
			// (doc 04 §13).
			b.ensureNodeFields(m, p.Title, p.URL)
			return b.ensurePlacement(m, p.Parent.toRef(), p.Position)
		}
		parentBrowserID, err := b.resolveParentBrowser(p.Parent.toRef())
		if err != nil {
			return err
		}
		id := b.newBrowserID()
		node := &browserNode{
			ID:     id,
			Type:   canonical.NodeType(p.Type),
			Title:  p.Title,
			URL:    p.URL,
			Parent: parentBrowserID,
		}
		b.nodes[id] = node
		b.mirror[ch.NodeID] = &mirrorNode{
			CanonicalID: ch.NodeID,
			BrowserID:   id,
			Type:        node.Type,
			Title:       p.Title,
			URL:         p.URL,
			Parent:      p.Parent.toRef(),
			Position:    p.Position,
		}
		b.byBrowserID[id] = ch.NodeID
		m := b.mirror[ch.NodeID]
		if err := b.ensurePlacement(m, p.Parent.toRef(), p.Position); err != nil {
			return err
		}
		return nil
	case sync.OpUpdateTitle:
		var p updateTitlePayload
		if err := json.Unmarshal([]byte(ch.PayloadJSON), &p); err != nil {
			return err
		}
		m, ok := b.mirror[ch.NodeID]
		if !ok {
			return fmt.Errorf("update_title for unknown node %s", ch.NodeID)
		}
		b.ensureNodeFields(m, p.Title, "")
		return nil
	case sync.OpUpdateURL:
		var p updateURLPayload
		if err := json.Unmarshal([]byte(ch.PayloadJSON), &p); err != nil {
			return err
		}
		m, ok := b.mirror[ch.NodeID]
		if !ok {
			return fmt.Errorf("update_url for unknown node %s", ch.NodeID)
		}
		b.ensureNodeFields(m, "", p.URL)
		return nil
	case sync.OpMove:
		var p movePayload
		if err := json.Unmarshal([]byte(ch.PayloadJSON), &p); err != nil {
			return err
		}
		m, ok := b.mirror[ch.NodeID]
		if !ok {
			return fmt.Errorf("move for unknown node %s", ch.NodeID)
		}
		return b.ensurePlacement(m, p.Parent.toRef(), p.Position)
	case sync.OpDelete:
		m, ok := b.mirror[ch.NodeID]
		if !ok {
			return nil // own delete echo: already gone
		}
		b.removeSubtree(m.BrowserID)
		return nil
	default:
		return fmt.Errorf("unknown change type %q", ch.Type)
	}
}

// ensureNodeFields aligns the browser node with canonical field state.
func (b *FakeBrowser) ensureNodeFields(m *mirrorNode, title, url string) {
	node := b.nodes[m.BrowserID]
	if title != "" && node.Title != title {
		node.Title = title
		m.Title = title
	}
	if url != "" && node.URL != url {
		node.URL = url
		m.URL = url
	}
}

// resolveParentBrowser maps a canonical parent reference onto a browser
// container, creating a local container for unknown root slots (the
// Recovered/<Device> case, doc 04 §11).
func (b *FakeBrowser) resolveParentBrowser(ref canonical.ParentRef) (string, error) {
	switch ref.Type {
	case canonical.ParentTypeRoot:
		if id, ok := b.rootContainers[ref.RootKey]; ok {
			return id, nil
		}
		id := b.newBrowserID()
		b.addRootNode(id, ref.RootKey, ref.RootKey)
		b.rootContainers[ref.RootKey] = id
		return id, nil
	case canonical.ParentTypeNode:
		if m, ok := b.mirror[string(ref.NodeID)]; ok {
			return m.BrowserID, nil
		}
		return "", fmt.Errorf("parent %s not known to the replica", ref.NodeID)
	default:
		return "", fmt.Errorf("invalid parent reference %+v", ref)
	}
}

// ensurePlacement aligns the browser position of a node with the
// canonical parent and position, updating mirror positions of shifted
// siblings the way the executor's dense reindex does.
func (b *FakeBrowser) ensurePlacement(m *mirrorNode, parent canonical.ParentRef, position int64) error {
	parentBrowserID, err := b.resolveParentBrowser(parent)
	if err != nil {
		return err
	}

	// Canonical sibling order: all mirror rows under the same parent,
	// self removed, sorted by last-known position, self re-inserted.
	// Gaps from old-parent compaction preserve relative order, and the
	// reindex below normalizes them.
	type sib struct {
		cid string
		pos int64
	}
	var siblings []sib
	for cid, other := range b.mirror {
		if cid == m.CanonicalID || !sameParentRef(other.Parent, parent) {
			continue
		}
		siblings = append(siblings, sib{cid, other.Position})
	}
	sort.SliceStable(siblings, func(i, j int) bool { return siblings[i].pos < siblings[j].pos })
	at := int(position)
	if at < 0 || at > len(siblings) {
		at = len(siblings)
	}
	order := make([]string, 0, len(siblings)+1)
	for i, s := range siblings {
		if i == at {
			order = append(order, m.CanonicalID)
		}
		order = append(order, s.cid)
	}
	if len(order) == len(siblings) {
		order = append(order, m.CanonicalID)
	}
	for i, cid := range order {
		b.mirror[cid].Position = int64(i)
	}
	m.Parent = parent

	// Browser placement: anchor on the next canonical sibling present in
	// the browser; unmapped transients are skipped.
	node := b.nodes[m.BrowserID]
	if node.Parent != parentBrowserID {
		b.detach(m.BrowserID)
		node.Parent = parentBrowserID
	}
	anchor := ""
	for i, cid := range order {
		if cid != m.CanonicalID {
			continue
		}
		for _, next := range order[i+1:] {
			if other, ok := b.mirror[next]; ok {
				if b.nodes[other.BrowserID] != nil && b.nodes[other.BrowserID].Parent == parentBrowserID {
					anchor = other.BrowserID
				}
				break
			}
		}
		break
	}
	b.detach(m.BrowserID)
	b.insertBefore(parentBrowserID, m.BrowserID, anchor)
	return nil
}

func sameParentRef(a, bRef canonical.ParentRef) bool {
	if a.Type != bRef.Type {
		return false
	}
	switch a.Type {
	case canonical.ParentTypeNode:
		return a.NodeID == bRef.NodeID
	case canonical.ParentTypeRoot:
		return a.RootKey == bRef.RootKey
	default:
		return false
	}
}

// --- initial reconciliation (doc 06 §4, reference flow for Phase 8) ---

// Initialize runs the initial reconciliation for the binding: snapshot
// the browser tree, plan, commit server-side, apply the steps, complete.
// Ambiguities keep the safe default (duplicate create, never guessed).
func (b *FakeBrowser) Initialize() error {
	svc := b.world.Reconcile
	sess, err := svc.CreateSession(b.world.ctx, b.BindingID, reconcile.TypeInitial, "syncsim initial")
	if err != nil {
		return err
	}
	if _, err := svc.SubmitClientSnapshot(b.world.ctx, b.BindingID, b.clientSnapshot()); err != nil {
		return err
	}
	if _, err := svc.CreateServerSnapshot(b.world.ctx, b.BindingID); err != nil {
		return err
	}
	sess, issues, err := svc.Plan(b.world.ctx, sess.ID)
	if err != nil {
		return err
	}
	if len(issues) > 0 {
		decisions := map[string]string{}
		for _, issue := range issues {
			decisions[issue.ID] = issue.DefaultChoice // safe default: duplicate
		}
		if _, _, err := svc.Decide(b.world.ctx, sess.ID, decisions); err != nil {
			return err
		}
	}
	if _, err := svc.Commit(b.world.ctx, sess.ID); err != nil {
		return err
	}
	steps, err := svc.Steps(b.world.ctx, sess.ID)
	if err != nil {
		return err
	}
	if err := b.applySteps(steps.Steps); err != nil {
		return err
	}
	done, err := svc.Complete(b.world.ctx, sess.ID)
	if err != nil {
		return err
	}
	// Step carries anchors rather than positions: refresh the mirror's
	// parent/position columns from the browser tree (doc 05 §4).
	b.rebuildMirrorPositions()
	b.epoch = done.TargetEpoch
	b.appliedRevision = done.CommitRevision
	b.receivedRevision = done.CommitRevision
	return nil
}

// clientSnapshot projects the browser tree into the doc 08 §10 wire
// shape. Session-local refs are the fake's browser ids.
func (b *FakeBrowser) clientSnapshot() reconcile.ClientSnapshotJSON {
	snap := reconcile.ClientSnapshotJSON{Roots: []reconcile.ClientRootJSON{}, Nodes: []reconcile.ClientNodeJSON{}}
	// Deterministic order: walk the browser tree depth-first.
	var walk func(id, parentRef string)
	walk = func(id, parentRef string) {
		node := b.nodes[id]
		if node.RootKey != "" {
			snap.Roots = append(snap.Roots, reconcile.ClientRootJSON{
				LocalRef: id, RootKey: node.RootKey, Title: node.Title,
			})
		} else {
			snap.Nodes = append(snap.Nodes, reconcile.ClientNodeJSON{
				LocalRef:       id,
				ParentLocalRef: parentRef,
				Type:           string(node.Type),
				Title:          node.Title,
				URL:            node.URL,
			})
		}
		for _, child := range b.children(id) {
			walk(child, id)
		}
	}
	for _, rootID := range b.sortedRootIDs() {
		walk(rootID, "")
	}
	return snap
}

// applySteps executes the reconciliation steps with ensure-state
// semantics (doc 08 §13): assign_identity establishes mappings, the
// rest converges the browser tree.
func (b *FakeBrowser) applySteps(steps []reconcile.StepJSON) error {
	for _, step := range steps {
		switch step.Kind {
		case reconcile.StepAssignIdentity:
			id := step.LocalRef
			if _, ok := b.nodes[id]; !ok {
				return fmt.Errorf("assign_identity for unknown browser node %q", id)
			}
			b.byBrowserID[id] = step.CanonicalID
			node := b.nodes[id]
			typ := canonical.NodeTypeFolder
			if node.Type == canonical.NodeTypeBookmark {
				typ = canonical.NodeTypeBookmark
			}
			b.mirror[step.CanonicalID] = &mirrorNode{
				CanonicalID: step.CanonicalID,
				BrowserID:   id,
				Type:        typ,
				Title:       node.Title,
				URL:         node.URL,
			}
		case reconcile.StepCreate:
			parent, err := b.resolveParentBrowser(parentFromStep(step.Parent))
			if err != nil {
				return err
			}
			id := b.newBrowserID()
			node := &browserNode{
				ID:     id,
				Type:   canonical.NodeType(step.Type),
				Title:  step.Title,
				URL:    step.URL,
				Parent: parent,
			}
			b.nodes[id] = node
			b.insertBefore(parent, id, b.browserRefOf(step.BeforeID))
			b.mirror[step.CanonicalID] = &mirrorNode{
				CanonicalID: step.CanonicalID,
				BrowserID:   id,
				Type:        node.Type,
				Title:       step.Title,
				URL:         step.URL,
				Parent:      parentFromStep(step.Parent),
			}
			b.byBrowserID[id] = step.CanonicalID
		case reconcile.StepUpdate:
			m, ok := b.mirror[step.CanonicalID]
			if !ok {
				return fmt.Errorf("update for unknown canonical node %q", step.CanonicalID)
			}
			b.ensureNodeFields(m, step.Title, step.URL)
		case reconcile.StepMove:
			m, ok := b.mirror[step.CanonicalID]
			if !ok {
				return fmt.Errorf("move for unknown canonical node %q", step.CanonicalID)
			}
			ref := parentFromStep(step.Parent)
			parentBrowserID, err := b.resolveParentBrowser(ref)
			if err != nil {
				return err
			}
			node := b.nodes[m.BrowserID]
			if node.Parent != parentBrowserID {
				b.detach(m.BrowserID)
				node.Parent = parentBrowserID
			}
			b.detach(m.BrowserID)
			b.insertBefore(parentBrowserID, m.BrowserID, b.browserRefOf(step.BeforeID))
			m.Parent = ref
		case reconcile.StepDelete:
			m, ok := b.mirror[step.CanonicalID]
			if !ok {
				continue // ensure-state: already gone
			}
			b.removeSubtree(m.BrowserID)
		default:
			return fmt.Errorf("unknown step kind %q", step.Kind)
		}
	}
	return nil
}

func parentFromStep(p *reconcile.ParentJSON) canonical.ParentRef {
	if p == nil {
		return canonical.ParentRef{}
	}
	if p.Type == "node" {
		return canonical.NewNodeParent(canonical.NodeID(p.ID))
	}
	return canonical.NewRootParent(p.Key)
}

// browserRefOf maps a canonical before_id onto a browser node, "" when
// unknown or empty (append).
func (b *FakeBrowser) browserRefOf(cid string) string {
	if cid == "" {
		return ""
	}
	if m, ok := b.mirror[cid]; ok {
		return m.BrowserID
	}
	return ""
}

// sortedRootIDs lists browser root ids deterministically.
func (b *FakeBrowser) sortedRootIDs() []string {
	var roots []string
	for id, node := range b.nodes {
		if node.RootKey != "" {
			roots = append(roots, id)
		}
	}
	sort.Strings(roots)
	return roots
}
