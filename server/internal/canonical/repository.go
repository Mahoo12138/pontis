package canonical

import (
	"context"
	"time"
)

// Store is the persistence contract required by the canonical executor,
// defined on the consumer side. The sqlite package implements it.
type Store interface {
	// BeginTx starts a canonical write transaction.
	BeginTx(ctx context.Context) (Tx, error)
}

// Tx is a canonical write transaction. All methods operate within it.
type Tx interface {
	Commit(ctx context.Context) error
	Rollback(ctx context.Context) error

	LoadSpace(ctx context.Context, id SpaceID) (SyncSpace, error)
	LoadNode(ctx context.Context, space SpaceID, id NodeID) (Node, error)
	LoadRootSlot(ctx context.Context, space SpaceID, key string) (RootSlot, error)

	// Children returns the parent's children ordered by position.
	Children(ctx context.Context, space SpaceID, parent ParentRef) ([]Node, error)

	// IsAncestorOrSelf reports whether ancestor is node itself or one of
	// node's ancestors.
	IsAncestorOrSelf(ctx context.Context, space SpaceID, ancestor, node NodeID) (bool, error)

	// AllocateRevision increments the space's current revision and returns
	// the new value.
	AllocateRevision(ctx context.Context, space SpaceID) (int64, error)

	InsertNode(ctx context.Context, n Node) error
	SetNodeTitle(ctx context.Context, space SpaceID, id NodeID, title string, revision int64, updatedAt time.Time) error
	SetNodeURL(ctx context.Context, space SpaceID, id NodeID, url string, revision int64, updatedAt time.Time) error
	SetNodeParent(ctx context.Context, space SpaceID, id NodeID, parent ParentRef, position int64, revision int64, updatedAt time.Time) error

	// SetSiblingPositions rewrites sibling positions without bumping any
	// revision: pure storage reordering.
	SetSiblingPositions(ctx context.Context, space SpaceID, positions map[NodeID]int64) error

	// SubtreeIDs returns the ids of the whole subtree rooted at id
	// (inclusive), deepest first.
	SubtreeIDs(ctx context.Context, space SpaceID, id NodeID) ([]NodeID, error)
	DeleteNodes(ctx context.Context, space SpaceID, ids []NodeID) error
}
