package syncsim

import (
	"pontis/internal/canonical"
	"pontis/internal/reconcile"
)

// Projection renders the browser's actual state in canonical identity
// space. This is what convergence compares against (doc 21 §8): the
// mirror may lag, the browser tree may not.
func (b *FakeBrowser) Projection() canonicalTree {
	out := canonicalTree{Order: map[string][]string{}, Nodes: map[string]treeNodeInfo{}}
	var walk func(browserID, container string)
	walk = func(browserID, container string) {
		for _, child := range b.children(browserID) {
			cid, ok := b.byBrowserID[child]
			if !ok {
				b.world.t.Fatalf("%s: browser node %s is unmapped inside the managed scope", b.Name, child)
			}
			node := b.nodes[child]
			out.Order[container] = append(out.Order[container], cid)
			out.Nodes[cid] = treeNodeInfo{
				Parent: container,
				Type:   node.Type,
				Title:  node.Title,
				URL:    node.URL,
			}
			walk(child, cid)
		}
	}
	for _, key := range b.sortedRootKeys() {
		walk(b.rootContainers[key], reconcile.RootRef(key))
	}
	return out
}

// rebuildMirrorPositions refreshes the mirror's parent/position columns
// from the browser tree — the integrity scan of doc 05 §4. Used after
// reconciliation steps, which carry anchors instead of positions.
func (b *FakeBrowser) rebuildMirrorPositions() {
	var walk func(id string, parentRef canonical.ParentRef)
	walk = func(id string, parentRef canonical.ParentRef) {
		for i, child := range b.children(id) {
			cid, ok := b.byBrowserID[child]
			if !ok {
				continue
			}
			m := b.mirror[cid]
			if m == nil {
				continue
			}
			m.Position = int64(i)
			m.Parent = parentRef
			if b.nodes[child].Type == canonical.NodeTypeFolder {
				walk(child, canonical.NewNodeParent(canonical.NodeID(cid)))
			}
		}
	}
	for _, key := range b.sortedRootKeys() {
		walk(b.rootContainers[key], canonical.NewRootParent(key))
	}
}

// sortedRootKeys lists mapped root slot keys deterministically.
func (b *FakeBrowser) sortedRootKeys() []string {
	keys := make([]string, 0, len(b.rootContainers))
	for key := range b.rootContainers {
		keys = append(keys, key)
	}
	// insertion-order-independent deterministic sort
	for i := 0; i < len(keys); i++ {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}
