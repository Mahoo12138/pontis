// Package reconcile implements the tree reconciliation engine: identity
// resolution between two bookmark trees, desired-state construction and a
// minimal-diff apply plan (doc 07). Pure Go: it emits a Plan and never
// touches HTTP, SQL or the browser (doc 20 §10).
package reconcile

import "fmt"

// NodeType extends the canonical node types with the synthetic root kind.
// Root nodes represent either canonical root slots (server snapshots) or
// browser roots mapped onto them (client snapshots).
type NodeType string

const (
	NodeRoot     NodeType = "root"
	NodeFolder   NodeType = "folder"
	NodeBookmark NodeType = "bookmark"
)

// RootRef returns the tree ref of the root container for a root slot key.
func RootRef(key string) string { return "root:" + key }

// TreeNode is one node of an input tree. Ref is unique within its tree: a
// canonical node id (server snapshots), a session-local local_ref (client
// snapshots, doc 08 §10) or a root:<key> container. CanonicalID carries a
// known canonical identity when one exists.
type TreeNode struct {
	Ref         string
	ParentRef   string // empty only for root nodes
	Type        NodeType
	Title       string
	URL         string // bookmarks only
	RootKey     string // root nodes only: canonical root slot key
	CanonicalID string // known canonical identity, if any
}

// Tree is a flat, parent-linked node tree. Order of nodes carrying the
// same ParentRef is the sibling order.
type Tree struct {
	Nodes []TreeNode
}

// treeIndex is the derived lookup structure over a Tree.
type treeIndex struct {
	byRef    map[string]TreeNode
	byCID    map[string]string   // canonical id → ref (non-root nodes)
	children map[string][]string // parent ref → child refs in order
}

func (t *Tree) index() (*treeIndex, error) {
	idx := &treeIndex{
		byRef:    make(map[string]TreeNode, len(t.Nodes)),
		byCID:    map[string]string{},
		children: make(map[string][]string, len(t.Nodes)),
	}
	for _, n := range t.Nodes {
		if n.Ref == "" {
			return nil, fmt.Errorf("reconcile: node with empty ref")
		}
		if _, dup := idx.byRef[n.Ref]; dup {
			return nil, fmt.Errorf("reconcile: duplicate ref %q", n.Ref)
		}
		if n.Type != NodeRoot && n.CanonicalID != "" {
			if _, dup := idx.byCID[n.CanonicalID]; dup {
				return nil, fmt.Errorf("reconcile: duplicate canonical id %q", n.CanonicalID)
			}
			idx.byCID[n.CanonicalID] = n.Ref
		}
		idx.byRef[n.Ref] = n
	}
	for _, n := range t.Nodes {
		switch n.Type {
		case NodeRoot:
			if n.ParentRef != "" {
				return nil, fmt.Errorf("reconcile: root %q must not have a parent", n.Ref)
			}
			if n.RootKey == "" {
				return nil, fmt.Errorf("reconcile: root %q missing root key", n.Ref)
			}
		case NodeFolder, NodeBookmark:
			if n.ParentRef == "" {
				return nil, fmt.Errorf("reconcile: node %q missing parent", n.Ref)
			}
			if _, ok := idx.byRef[n.ParentRef]; !ok {
				return nil, fmt.Errorf("reconcile: node %q has unknown parent %q", n.Ref, n.ParentRef)
			}
		default:
			return nil, fmt.Errorf("reconcile: node %q has unknown type %q", n.Ref, n.Type)
		}
		idx.children[n.ParentRef] = append(idx.children[n.ParentRef], n.Ref)
	}
	// Acyclicity: every node's parent chain must terminate at a root.
	for _, n := range t.Nodes {
		seen := map[string]bool{n.Ref: true}
		cur := n
		for cur.ParentRef != "" {
			p, ok := idx.byRef[cur.ParentRef]
			if !ok {
				break // already reported above
			}
			if seen[p.Ref] {
				return nil, fmt.Errorf("reconcile: cycle at %q", n.Ref)
			}
			seen[p.Ref] = true
			cur = p
		}
	}
	return idx, nil
}

// rootByKeys returns the root nodes keyed by their root slot key.
func (idx *treeIndex) rootByKeys() map[string]TreeNode {
	roots := make(map[string]TreeNode)
	for _, n := range idx.byRef {
		if n.Type == NodeRoot {
			roots[n.RootKey] = n
		}
	}
	return roots
}
