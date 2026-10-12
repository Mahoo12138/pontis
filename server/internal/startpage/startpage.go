// Package startpage implements the start page's read side: the snapshot of
// one folder subtree, for a device that already syncs the space it lives in
// (pontis-start-page-v1 §11).
//
// It is not a replica and carries no write path. Reading a source never
// creates a binding, touches pending operations, or advances a watermark —
// the projection is allowed to look at the tree, not to take a position in it
// (§11.1).
//
// Authorization is deliberately *derived*, not stored: a device may read a
// folder when it already has an active binding for that space, because the
// sync protocol lets it read that whole space anyway. Naming a folder inside a
// space you are entitled to is not a widening of scope, so no separate grant
// object — and no account re-authentication — is needed to pick one. What the
// projection still enforces is the *shape*: one folder, its descendants only,
// inside the size the page can honestly render.
package startpage

import (
	"context"
	"errors"

	"pontis/internal/canonical"
)

// Subtree is one consistent read of a source folder and everything below it.
type Subtree struct {
	Space  canonical.SyncSpace
	Source canonical.Node
	// Nodes are the descendants, excluding Source itself. Children of any
	// one parent appear in canonical sibling order.
	Nodes []canonical.Node
}

// Read budgets (§18). They are V1 engineering limits, not platform ceilings:
// a source over them is refused rather than silently truncated, because a
// partial snapshot marked complete would be shown as the whole folder.
const (
	// MaxDescendants bounds the node count of one source subtree.
	MaxDescendants = 10_000
	// MaxSnapshotBytes bounds the snapshot payload on both ends.
	MaxSnapshotBytes = 8 << 20
)

// Errors. A space the device does not sync and a space that does not exist
// answer alike: the first says something about the account's binding layout
// that the caller has no business probing for (§13.3).
var (
	ErrSpaceNotSynced = errors.New("startpage: this device does not sync that space")
	// ErrSourceUnavailable covers a folder that is gone, is not a folder, or
	// sits outside every space the device may read. There is no fallback to
	// the whole Space behind it (§5.2).
	ErrSourceUnavailable = errors.New("startpage: source folder unavailable")
	ErrSourceTooLarge    = errors.New("startpage: source subtree exceeds the read budget")
)

// TreeStore reads the canonical tree the source points into.
type TreeStore interface {
	Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	Node(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) (canonical.Node, error)
	Subtree(ctx context.Context, space canonical.SpaceID, folder canonical.NodeID, budget int) (Subtree, error)
}

// SpaceAccess reports whether one device may read one space with its own
// credential. It is answered from the device's binding, so the start page
// inherits an authorization that already exists instead of minting a second
// one that could drift from it.
type SpaceAccess func(ctx context.Context, deviceID string, space canonical.SpaceID) (bool, error)

// Service implements the start page's snapshot reads.
type Service struct {
	tree    TreeStore
	allowed SpaceAccess
}

// NewService returns a start-page read service.
func NewService(tree TreeStore, allowed SpaceAccess) *Service {
	return &Service{tree: tree, allowed: allowed}
}

// Snapshot reads the subtree one device asked to display.
//
// The folder id arrives from the request, which is safe only because of the
// binding check that precedes it: everything reachable from here is something
// the same credential could already pull through /sync. The check that is NOT
// relaxed is the boundary of the answer — the source's own subtree, never its
// parents, never another space (§11.3).
func (s *Service) Snapshot(ctx context.Context, deviceID string,
	spaceID canonical.SpaceID, folderID canonical.NodeID) (Subtree, error) {

	if s.allowed == nil {
		return Subtree{}, ErrSpaceNotSynced
	}
	allowed, err := s.allowed(ctx, deviceID, spaceID)
	if err != nil {
		return Subtree{}, err
	}
	if !allowed {
		return Subtree{}, ErrSpaceNotSynced
	}

	sp, err := s.tree.Space(ctx, spaceID)
	if err != nil {
		if errors.Is(err, canonical.ErrSpaceNotFound) {
			return Subtree{}, ErrSpaceNotSynced
		}
		return Subtree{}, err
	}
	node, err := s.tree.Node(ctx, spaceID, folderID)
	if err != nil {
		if errors.Is(err, canonical.ErrNodeNotFound) {
			return Subtree{}, ErrSourceUnavailable
		}
		return Subtree{}, err
	}
	// A bookmark, or anything that is not a container, cannot be a source.
	// The space itself and its root slots are not selectable either: V1 shows
	// one real folder rather than inventing a second kind of root (§5.1).
	if node.Type != canonical.NodeTypeFolder {
		return Subtree{}, ErrSourceUnavailable
	}
	return s.read(ctx, sp, spaceID, folderID)
}

func (s *Service) read(ctx context.Context, sp canonical.SyncSpace,
	spaceID canonical.SpaceID, folderID canonical.NodeID) (Subtree, error) {

	sub, err := s.tree.Subtree(ctx, spaceID, folderID, MaxDescendants)
	if err != nil {
		return Subtree{}, err
	}
	// Read with room for one more row: finding the budget full means the tree
	// is bigger than the source may be shown as, and a truncated list must
	// never be reported as the whole folder.
	if len(sub.Nodes) > MaxDescendants {
		return Subtree{}, ErrSourceTooLarge
	}
	if snapshotBytes(sub) > MaxSnapshotBytes {
		return Subtree{}, ErrSourceTooLarge
	}
	// The space row was read to decide entitlement; the subtree read carries
	// its own, from the same transaction as the nodes it describes.
	if sub.Space.UpdatedAt.IsZero() {
		sub.Space = sp
	}
	return sub, nil
}

// snapshotBytes estimates the payload the nodes will serialize to. Titles and
// URLs are what a bookmark costs; the fixed term covers ids, positions and
// JSON syntax.
func snapshotBytes(sub Subtree) int {
	total := 0
	for _, n := range sub.Nodes {
		total += len(n.Title) + len(n.URL) + 96
	}
	return total
}
