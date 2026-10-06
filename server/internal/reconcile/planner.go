package reconcile

import (
	"fmt"

	"pontis/internal/canonical"
)

// identityResolver maps desired nodes into the current tree. currentRef
// returns the current-tree ref holding the desired node's identity, or
// "" when the node has no counterpart.
type identityResolver interface {
	currentRef(d *DesiredNode) string
}

// canonicalIdentity plans in canonical id space. It resolves desired ids
// through the current tree's CanonicalID fields, falling back to the ref
// itself for canonical snapshots where ref == id.
type canonicalIdentity struct {
	byCID map[string]string
}

// newCanonicalIdentity indexes the current tree by canonical identity.
func newCanonicalIdentity(current *Tree) canonicalIdentity {
	byCID := map[string]string{}
	for _, node := range current.Nodes {
		if node.Type == NodeRoot {
			continue
		}
		cid := node.CanonicalID
		if cid == "" {
			cid = node.Ref
		}
		byCID[cid] = node.Ref
	}
	return canonicalIdentity{byCID: byCID}
}

func (x canonicalIdentity) currentRef(d *DesiredNode) string { return x.byCID[d.ID] }

// sourceRefIdentity plans in client identity space: the current tree is
// a client snapshot and correspondence comes from the source linkage.
type sourceRefIdentity struct{}

func (sourceRefIdentity) currentRef(d *DesiredNode) string { return d.SourceRef }

// Plan computes the ordered primitives that transform current into
// desired (doc 07 §7): creates first (parents before children), then
// field updates, then moves, then deletes. Sibling reorders use LIS to
// minimize emitted moves (doc 07 §8). Anchors always reference nodes
// that exist at execution time, so the plan is crash-safe to retry.
func BuildPlan(current *Tree, desired *DesiredTree, policy Policy, resolver identityResolver) (*Plan, error) {
	idx, err := current.index()
	if err != nil {
		return nil, err
	}

	// desiredToCur maps desired node id → current ref; curToDesired is
	// its reverse over mapped nodes.
	desiredToCur := map[string]string{}
	curToDesired := map[string]string{}
	for id, d := range desired.Nodes {
		cur := resolver.currentRef(d)
		if cur == "" {
			continue
		}
		if _, exists := idx.byRef[cur]; !exists {
			continue
		}
		desiredToCur[id] = cur
		curToDesired[cur] = id
	}

	// containerOf normalizes a current node's parent into a desired
	// container ref: root slots become root:<key>; mapped parents map
	// into their desired id; unmapped parents stay in their own space,
	// which can never equal a desired container (the node must move in).
	containerOf := func(n TreeNode) string {
		if n.ParentRef == "" {
			return ""
		}
		p := idx.byRef[n.ParentRef]
		if p.Type == NodeRoot {
			return RootRef(p.RootKey)
		}
		if id, ok := curToDesired[p.Ref]; ok {
			return id
		}
		return p.Ref
	}

	// childrenOfContainer lists the current children of a container ref.
	// Folder containers are desired ids and resolve through the identity
	// mapping; root containers resolve through their root key.
	childrenOfContainer := func(container string) []string {
		if isRootRef(container) {
			for _, n := range idx.byRef {
				if n.Type == NodeRoot && n.RootKey == container[5:] {
					return idx.children[n.Ref]
				}
			}
			return nil
		}
		if cur, ok := desiredToCur[container]; ok {
			return idx.children[cur]
		}
		return nil
	}

	// Delete set: current nodes whose identity the desired tree dropped.
	// Only minimal roots are emitted; the executor deletes recursively.
	inDesired := map[string]bool{}
	for _, cur := range desiredToCur {
		inDesired[cur] = true
	}
	deleted := map[string]bool{}
	for ref, n := range idx.byRef {
		if n.Type != NodeRoot && !inDesired[ref] {
			deleted[ref] = true
		}
	}

	p := &Plan{Strategy: policy.Strategy, Placement: policy.Placement}

	// --- creates ---
	// Per container top-down; inside a container, descending desired
	// order, anchored to the nearest successor that is already in this
	// container (present member) or is a create of this plan.
	created := map[string]bool{}
	for _, container := range desired.Containers() {
		order := desired.Children(container)
		memberHere := map[string]bool{}
		for _, id := range order {
			if cur, ok := desiredToCur[id]; ok && containerOf(idx.byRef[cur]) == container {
				memberHere[id] = true
			}
		}
		for i := len(order) - 1; i >= 0; i-- {
			d := desired.Nodes[order[i]]
			if _, done := desiredToCur[d.ID]; done {
				continue
			}
			anchor := ""
			for j := i + 1; j < len(order); j++ {
				succ := order[j]
				if created[succ] || memberHere[succ] {
					anchor = succ
					break
				}
			}
			p.Operations = append(p.Operations, Primitive{
				Kind:      KindCreate,
				NodeID:    d.ID,
				Type:      d.Type,
				Title:     d.Title,
				URL:       d.URL,
				Parent:    parentRef(container),
				BeforeID:  anchor,
				SourceRef: d.SourceRef,
			})
			created[d.ID] = true
			p.Stats.Creates++
		}
	}

	// --- updates ---
	for id, d := range desired.Nodes {
		cur, ok := desiredToCur[id]
		if !ok {
			continue
		}
		cn := idx.byRef[cur]
		if cn.Type != d.Type {
			p.Warnings = append(p.Warnings,
				fmt.Sprintf("node %s: type mismatch between current and desired state", cur))
			continue
		}
		if cn.Title != d.Title {
			p.Operations = append(p.Operations, Primitive{
				Kind:      KindUpdateTitle,
				NodeID:    cur,
				Title:     d.Title,
				SourceRef: d.SourceRef,
			})
			p.Stats.Updates++
		}
		if d.Type == NodeBookmark && cn.URL != d.URL {
			p.Operations = append(p.Operations, Primitive{
				Kind:      KindUpdateURL,
				NodeID:    cur,
				URL:       d.URL,
				SourceRef: d.SourceRef,
			})
			p.Stats.Updates++
		}
	}

	// --- moves ---
	// Per container: simulate the order after the create phase, keep the
	// LIS of the desired sequence, then move everything else into place
	// in descending desired order. Mover-ins (mapped nodes whose current
	// parent differs) always move.
	for _, container := range desired.Containers() {
		order := desired.Children(container)
		if len(order) == 0 {
			continue
		}
		desiredIndex := make(map[string]int, len(order))
		inOrder := make(map[string]bool, len(order))
		for i, id := range order {
			desiredIndex[id] = i
			inOrder[id] = true
		}

		memberHere := map[string]bool{}
		for _, id := range order {
			if cur, ok := desiredToCur[id]; ok && containerOf(idx.byRef[cur]) == container {
				memberHere[id] = true
			}
		}

		// Simulate the container's member order after creates. Foreign
		// members (to-be-deleted or moving-out nodes) participate in the
		// simulation to keep insertion anchors honest, then drop out.
		const foreign = "\x00foreign:"
		list := make([]string, 0, len(order))
		for _, cur := range childrenOfContainer(container) {
			if id, ok := curToDesired[cur]; ok && inOrder[id] {
				list = append(list, id)
			} else {
				list = append(list, foreign+cur)
			}
		}
		for i := len(order) - 1; i >= 0; i-- {
			d := desired.Nodes[order[i]]
			if _, isPresent := desiredToCur[d.ID]; isPresent {
				continue
			}
			anchorPos := -1
			for j := i + 1; j < len(order) && anchorPos < 0; j++ {
				succ := order[j]
				if !created[succ] && !memberHere[succ] {
					continue
				}
				for k, entry := range list {
					if entry == succ {
						anchorPos = k
						break
					}
				}
			}
			if anchorPos < 0 {
				list = append(list, d.ID)
				continue
			}
			list = append(list, "")
			copy(list[anchorPos+1:], list[anchorPos:])
			list[anchorPos] = d.ID
		}

		// Surviving members in simulated order.
		var seq []int
		var members []string
		for _, entry := range list {
			if !inOrder[entry] {
				continue
			}
			seq = append(seq, desiredIndex[entry])
			members = append(members, entry)
		}

		keep := map[string]bool{}
		for _, i := range longestIncreasingSubsequence(seq) {
			keep[members[i]] = true
		}

		// Mover-ins plus non-LIS members, descending desired order. A
		// redundant move is left to the executor, which skips reorders
		// that would change nothing.
		var movers []string
		for i := len(order) - 1; i >= 0; i-- {
			id := order[i]
			cur, isPresent := desiredToCur[id]
			switch {
			case isPresent && containerOf(idx.byRef[cur]) == container:
				if !keep[id] {
					movers = append(movers, id)
				}
			case isPresent:
				// Mover-in: current node lives under another container.
				movers = append(movers, id)
			default:
				// A create whose simulated position is off (its anchor
				// skipped over mover-ins) still needs one move.
				if !keep[id] {
					movers = append(movers, id)
				}
			}
		}
		for _, id := range movers {
			before := ""
			if i := desiredIndex[id]; i+1 < len(order) {
				before = order[i+1]
			}
			nodeID := desiredToCur[id]
			if nodeID == "" {
				nodeID = id // freshly created in this plan
			}
			d := desired.Nodes[id]
			p.Operations = append(p.Operations, Primitive{
				Kind:      KindMove,
				NodeID:    nodeID,
				Parent:    parentRef(container),
				BeforeID:  before,
				SourceRef: d.SourceRef,
			})
			p.Stats.Moves++
		}
	}

	// --- deletes ---
	deleteRoots := 0
	for ref, n := range idx.byRef {
		if !deleted[ref] {
			continue
		}
		if p := idx.byRef[n.ParentRef]; p.Ref != "" && deleted[p.Ref] {
			continue // covered by an ancestor delete
		}
		p.Operations = append(p.Operations, Primitive{
			Kind:   KindDelete,
			NodeID: ref,
		})
		p.Stats.Deletes++
		deleteRoots++
	}
	if deleteRoots > 0 {
		p.Warnings = append(p.Warnings,
			fmt.Sprintf("plan deletes %d top-level subtrees", deleteRoots))
	}

	p.Hash = p.computeHash()
	return p, nil
}

func nodeTypeOf(t NodeType) canonical.NodeType {
	if t == NodeBookmark {
		return canonical.NodeTypeBookmark
	}
	return canonical.NodeTypeFolder
}
