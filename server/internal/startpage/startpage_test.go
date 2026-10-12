package startpage

import (
	"context"
	"errors"
	"testing"

	"pontis/internal/canonical"
)

// fakeTree stands in for the SQLite read so the decisions this service makes —
// what counts as a source, how far an answer may reach, when a folder is too
// big to show — can be tested without a database.
type fakeTree struct {
	spaces map[canonical.SpaceID]canonical.SyncSpace
	nodes  map[canonical.NodeID]canonical.Node
	// children of one folder, in the order the store returns them
	below map[canonical.NodeID][]canonical.Node
}

func (f *fakeTree) Space(_ context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	sp, ok := f.spaces[id]
	if !ok {
		return canonical.SyncSpace{}, canonical.ErrSpaceNotFound
	}
	return sp, nil
}

func (f *fakeTree) Node(_ context.Context, _ canonical.SpaceID, id canonical.NodeID) (canonical.Node, error) {
	n, ok := f.nodes[id]
	if !ok {
		return canonical.Node{}, canonical.ErrNodeNotFound
	}
	return n, nil
}

func (f *fakeTree) Subtree(_ context.Context, space canonical.SpaceID, folder canonical.NodeID, _ int) (Subtree, error) {
	kids, ok := f.below[folder]
	if !ok {
		return Subtree{}, canonical.ErrNodeNotFound
	}
	return Subtree{Space: f.spaces[space], Source: f.nodes[folder], Nodes: kids}, nil
}

func newTestService() (*Service, *fakeTree, *int) {
	tree := &fakeTree{
		spaces: map[canonical.SpaceID]canonical.SyncSpace{
			"space-1": {ID: "space-1", OwnerUserID: "user-1", Name: "Personal", Epoch: 3, CurrentRevision: 42},
		},
		nodes: map[canonical.NodeID]canonical.Node{
			"folder-1": {ID: "folder-1", SpaceID: "space-1", Type: canonical.NodeTypeFolder, Title: "Entries"},
			"mark-1":   {ID: "mark-1", SpaceID: "space-1", Type: canonical.NodeTypeBookmark, Title: "GitHub", URL: "https://github.com/"},
			"child-1":  {ID: "child-1", SpaceID: "space-1", Type: canonical.NodeTypeBookmark, Title: "MDN", URL: "https://developer.mozilla.org"},
		},
		below: map[canonical.NodeID][]canonical.Node{
			"folder-1": {
				{ID: "child-1", SpaceID: "space-1", Type: canonical.NodeTypeBookmark, Title: "MDN", URL: "https://developer.mozilla.org"},
			},
			"mark-1": {},
		},
	}
	accessCalls := 0
	allowed := map[string]bool{"dev-1|space-1": true, "dev-2|space-2": true}
	svc := NewService(tree, func(_ context.Context, deviceID string, space canonical.SpaceID) (bool, error) {
		accessCalls++
		return allowed[deviceID+"|"+string(space)], nil
	})
	return svc, tree, &accessCalls
}

// The whole authorization question, in one case: a device reads a folder in a
// space it syncs, and cannot read one in a space it does not.
func TestSnapshotNeedsAnActiveBindingNotAnApproval(t *testing.T) {
	svc, _, accessCalls := newTestService()
	ctx := context.Background()

	sub, err := svc.Snapshot(ctx, "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(sub.Nodes) != 1 || sub.Space.CurrentRevision != 42 {
		t.Fatalf("subtree = %+v", sub)
	}

	// A space this device never bound. The device could not read it through
	// /sync either, so the start page is not narrowing anything by refusing.
	if _, err := svc.Snapshot(ctx, "dev-1", "space-2", "folder-1"); !errors.Is(err, ErrSpaceNotSynced) {
		t.Fatalf("unbound space = %v, want ErrSpaceNotSynced", err)
	}
	// A space that does not exist answers the same way: which space ids this
	// account holds is not something to confirm to a caller (§13.3).
	if _, err := svc.Snapshot(ctx, "dev-1", "space-nope", "folder-1"); !errors.Is(err, ErrSpaceNotSynced) {
		t.Fatalf("unknown space = %v, want ErrSpaceNotSynced", err)
	}
	// Entitlement is asked once per read, not re-derived per node.
	if *accessCalls != 3 {
		t.Fatalf("access checks = %d, want 3", *accessCalls)
	}
}

// A bookmark, a missing node, and a foreign folder id all fail the same way:
// they are not sources, and there is no fallback to the space behind them.
func TestSnapshotSourceMustBeAFolder(t *testing.T) {
	svc, _, _ := newTestService()
	ctx := context.Background()

	if _, err := svc.Snapshot(ctx, "dev-1", "space-1", "mark-1"); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("bookmark source = %v, want ErrSourceUnavailable", err)
	}
	if _, err := svc.Snapshot(ctx, "dev-1", "space-1", "node-gone"); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("unknown folder = %v, want ErrSourceUnavailable", err)
	}
}

// A folder id from another space must not resolve, even though the id itself
// exists somewhere: the binding gates the space, and the node is looked up
// inside it.
func TestSnapshotCannotReachIntoAnotherSpace(t *testing.T) {
	svc, tree, _ := newTestService()
	ctx := context.Background()

	// space-2 holds a folder the device may not read; it is registered in the
	// shared node map, which is exactly the confusion the space-scoped lookup
	// has to prevent.
	tree.spaces["space-2"] = canonical.SyncSpace{ID: "space-2", OwnerUserID: "user-1", Name: "Work"}
	if _, err := svc.Snapshot(ctx, "dev-1", "space-2", "folder-1"); !errors.Is(err, ErrSpaceNotSynced) {
		t.Fatalf("cross-space read = %v, want ErrSpaceNotSynced", err)
	}
	// The same device, bound to space-2, can read it.
	if _, err := svc.Snapshot(ctx, "dev-2", "space-2", "folder-1"); err != nil {
		t.Fatalf("bound device cross-space read: %v", err)
	}
}

func TestSourceOverTheNodeBudgetIsRefused(t *testing.T) {
	svc, tree, _ := newTestService()
	ctx := context.Background()

	tree.below["folder-1"] = manyNodes(MaxDescendants + 1)
	// Refused, not trimmed: a truncated list labelled complete would be shown
	// as the whole folder.
	if _, err := svc.Snapshot(ctx, "dev-1", "space-1", "folder-1"); !errors.Is(err, ErrSourceTooLarge) {
		t.Fatalf("err = %v, want ErrSourceTooLarge", err)
	}
}

func TestSourceOverTheByteBudgetIsRefused(t *testing.T) {
	svc, tree, _ := newTestService()
	ctx := context.Background()

	long := make([]byte, 4096)
	for i := range long {
		long[i] = 'a'
	}
	nodes := manyNodes(3000)
	for i := range nodes {
		nodes[i].Title = string(long)
	}
	tree.below["folder-1"] = nodes

	if _, err := svc.Snapshot(ctx, "dev-1", "space-1", "folder-1"); !errors.Is(err, ErrSourceTooLarge) {
		t.Fatalf("err = %v, want ErrSourceTooLarge under the node cap but over the byte cap", err)
	}
}

// Exactly at the budget is still a complete read: the refusal has to start one
// past the line, not on it.
func TestSourceAtTheBudgetIsAccepted(t *testing.T) {
	svc, tree, _ := newTestService()
	ctx := context.Background()

	tree.below["folder-1"] = manyNodes(MaxDescendants)
	sub, err := svc.Snapshot(ctx, "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("at-budget source refused: %v", err)
	}
	if len(sub.Nodes) != MaxDescendants {
		t.Fatalf("nodes = %d, want %d", len(sub.Nodes), MaxDescendants)
	}
}

func manyNodes(n int) []canonical.Node {
	out := make([]canonical.Node, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, canonical.Node{
			ID: canonical.NodeID("n"), SpaceID: "space-1",
			Type: canonical.NodeTypeBookmark, Title: "t", URL: "https://e.example",
		})
	}
	return out
}
