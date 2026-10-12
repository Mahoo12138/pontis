// Package startpage implements the start page's read side: one per-device
// source grant and the snapshot of exactly one folder subtree
// (pontis-start-page-v1 §5, §11).
//
// It is not a replica and carries no write path. Reading a source never
// creates a sync binding, touches pending operations, or advances a
// watermark — the grant is a narrower *read* capability than the device's
// existing sync scope, and it exists so a browser can show one folder of the
// tree without subscribing to a Space at all (§5.3).
package startpage

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Grant is one device's approved start-page source: whose tree, which folder,
// as of which version.
type Grant struct {
	ID       string
	DeviceID string
	UserID   canonical.UserID
	SpaceID  canonical.SpaceID
	FolderID canonical.NodeID
	// Version rises when the grant is re-pointed at another folder. Clients
	// key their cached snapshot on it, so a moved source can never be served
	// from the previous source's cache (§14.1).
	Version   int64
	CreatedAt time.Time
	UpdatedAt time.Time
	RevokedAt time.Time
}

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

// Errors. A grant, device or space that belongs to someone else reports the
// same way as one that does not exist: resource ids are not capabilities and
// the API must not confirm which of the two a guesser struck (§13.3).
var (
	ErrDeviceNotFound = errors.New("startpage: device not found")
	ErrSpaceNotFound  = errors.New("startpage: space not found")
	ErrGrantNotFound  = errors.New("startpage: grant not found")
	ErrNotConfigured  = errors.New("startpage: no source configured")
	// ErrSourceUnavailable covers a source that is gone, is no longer a
	// folder, or no longer belongs to the granting account. There is no
	// fallback to the whole Space behind it (§5.2).
	ErrSourceUnavailable = errors.New("startpage: source folder unavailable")
	ErrSourceTooLarge    = errors.New("startpage: source subtree exceeds the read budget")
)

// GrantStore persists source grants and the device lookups Authorize needs.
type GrantStore interface {
	InsertGrant(ctx context.Context, g Grant) error
	RepointGrant(ctx context.Context, id string, space canonical.SpaceID, folder canonical.NodeID, at time.Time) error
	RevokeGrant(ctx context.Context, id string, at time.Time) error
	GetGrant(ctx context.Context, id string) (Grant, error)
	ActiveGrant(ctx context.Context, deviceID string) (Grant, error)
	ListGrants(ctx context.Context, user canonical.UserID) ([]Grant, error)
	DeviceOwner(ctx context.Context, deviceID string) (canonical.UserID, error)
}

// TreeStore reads the canonical tree the source points into.
type TreeStore interface {
	Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	Node(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) (canonical.Node, error)
	Subtree(ctx context.Context, space canonical.SpaceID, folder canonical.NodeID, budget int) (Subtree, error)
}

// Service implements the start page's read authorization and snapshot reads.
type Service struct {
	grants GrantStore
	tree   TreeStore
}

// NewService returns a start-page read service.
func NewService(grants GrantStore, tree TreeStore) *Service {
	return &Service{grants: grants, tree: tree}
}

// Authorize confirms a device's start-page source, or moves it to another
// folder. Only the device's owner may call it, and only for a folder they
// themselves own.
//
// The credential that gets here is a web session or the short-lived pairing
// session — never the standing device credential. A device that could mint
// its own grant could aim it at any folder in the account, which would make
// the runtime snapshot endpoint as broad as the tree it was meant to narrow
// (§11.2).
func (s *Service) Authorize(ctx context.Context, user canonical.UserID, deviceID string,
	spaceID canonical.SpaceID, folderID canonical.NodeID) (Grant, error) {

	owner, err := s.grants.DeviceOwner(ctx, deviceID)
	if err != nil {
		if errors.Is(err, ErrDeviceNotFound) {
			return Grant{}, ErrDeviceNotFound
		}
		return Grant{}, err
	}
	if owner != user {
		return Grant{}, ErrDeviceNotFound
	}
	if _, err := s.checkFolder(ctx, user, spaceID, folderID); err != nil {
		return Grant{}, err
	}

	now := time.Now().UTC()
	current, err := s.grants.ActiveGrant(ctx, deviceID)
	if errors.Is(err, ErrGrantNotFound) {
		id, err := newGrantID()
		if err != nil {
			return Grant{}, err
		}
		g := Grant{
			ID:        id,
			DeviceID:  deviceID,
			UserID:    user,
			SpaceID:   spaceID,
			FolderID:  folderID,
			Version:   1,
			CreatedAt: now,
			UpdatedAt: now,
		}
		if err := s.grants.InsertGrant(ctx, g); err != nil {
			return Grant{}, err
		}
		return g, nil
	}
	if err != nil {
		return Grant{}, err
	}
	if current.SpaceID == spaceID && current.FolderID == folderID {
		// Re-asserting the same source is not a change: a client that saves
		// the form twice must not expire its own cache.
		return current, nil
	}
	if err := s.grants.RepointGrant(ctx, current.ID, spaceID, folderID, now); err != nil {
		return Grant{}, err
	}
	current.SpaceID, current.FolderID, current.UpdatedAt = spaceID, folderID, now
	current.Version++
	return current, nil
}

// Revoke withdraws one grant. The device keeps syncing whatever it was
// already bound to — dropping the start-page source is not unbinding the
// Space (§5.3).
func (s *Service) Revoke(ctx context.Context, user canonical.UserID, grantID string) error {
	g, err := s.grants.GetGrant(ctx, grantID)
	if err != nil {
		if errors.Is(err, ErrGrantNotFound) {
			return ErrGrantNotFound
		}
		return err
	}
	if g.UserID != user || !g.RevokedAt.IsZero() {
		return ErrGrantNotFound
	}
	return s.grants.RevokeGrant(ctx, grantID, time.Now().UTC())
}

// ActiveGrant returns a device's current source, or ErrNotConfigured.
func (s *Service) ActiveGrant(ctx context.Context, deviceID string) (Grant, error) {
	g, err := s.grants.ActiveGrant(ctx, deviceID)
	if errors.Is(err, ErrGrantNotFound) {
		return Grant{}, ErrNotConfigured
	}
	return g, err
}

// Source loads the space and folder a grant points at, without reading
// anything below it. A client checking whether its cached source is still
// alive asks that question, and the answer should not cost a subtree.
func (s *Service) Source(ctx context.Context, g Grant) (canonical.SyncSpace, canonical.Node, error) {
	sp, err := s.tree.Space(ctx, g.SpaceID)
	if err != nil {
		if errors.Is(err, canonical.ErrSpaceNotFound) {
			return canonical.SyncSpace{}, canonical.Node{}, ErrSourceUnavailable
		}
		return canonical.SyncSpace{}, canonical.Node{}, err
	}
	// A space that has changed hands is not this grant's space any more: the
	// folder id may still resolve, but it resolves to somebody else's tree.
	if sp.OwnerUserID != g.UserID {
		return canonical.SyncSpace{}, canonical.Node{}, ErrSourceUnavailable
	}
	node, err := s.tree.Node(ctx, g.SpaceID, g.FolderID)
	if err != nil {
		if errors.Is(err, canonical.ErrNodeNotFound) {
			return canonical.SyncSpace{}, canonical.Node{}, ErrSourceUnavailable
		}
		return canonical.SyncSpace{}, canonical.Node{}, err
	}
	if node.Type != canonical.NodeTypeFolder {
		return canonical.SyncSpace{}, canonical.Node{}, ErrSourceUnavailable
	}
	return sp, node, nil
}

// ListGrants returns the account's live grants.
func (s *Service) ListGrants(ctx context.Context, user canonical.UserID) ([]Grant, error) {
	all, err := s.grants.ListGrants(ctx, user)
	if err != nil {
		return nil, err
	}
	out := all[:0]
	for _, g := range all {
		if g.RevokedAt.IsZero() {
			out = append(out, g)
		}
	}
	return out, nil
}

// GrantSnapshot reads the source subtree one grant points at. The grant is
// revalidated on every read: a folder deleted since it was approved, or a
// Space transferred to another account, must stop being served rather than
// resolve to whatever else shares its name (§5.2).
func (s *Service) GrantSnapshot(ctx context.Context, g Grant) (Subtree, error) {
	if _, _, err := s.Source(ctx, g); err != nil {
		return Subtree{}, err
	}
	return s.read(ctx, g.SpaceID, g.FolderID)
}

// SessionSnapshot reads a source for a signed-in account. The web start page
// may point at any folder of any space the user owns, so ownership, not a
// grant, is what bounds this read; a grant is what bounds the device one.
func (s *Service) SessionSnapshot(ctx context.Context, user canonical.UserID,
	spaceID canonical.SpaceID, folderID canonical.NodeID) (Subtree, error) {

	if _, err := s.checkFolder(ctx, user, spaceID, folderID); err != nil {
		return Subtree{}, err
	}
	return s.read(ctx, spaceID, folderID)
}

// checkFolder accepts only a real folder node in a space the user owns. A
// root slot or the space itself is out of scope for V1 (§5.1).
func (s *Service) checkFolder(ctx context.Context, user canonical.UserID,
	spaceID canonical.SpaceID, folderID canonical.NodeID) (canonical.Node, error) {

	sp, err := s.tree.Space(ctx, spaceID)
	if err != nil {
		if errors.Is(err, canonical.ErrSpaceNotFound) {
			return canonical.Node{}, ErrSpaceNotFound
		}
		return canonical.Node{}, err
	}
	if sp.OwnerUserID != user {
		return canonical.Node{}, ErrSpaceNotFound
	}
	node, err := s.tree.Node(ctx, spaceID, folderID)
	if err != nil {
		if errors.Is(err, canonical.ErrNodeNotFound) {
			return canonical.Node{}, ErrSourceUnavailable
		}
		return canonical.Node{}, err
	}
	if node.Type != canonical.NodeTypeFolder {
		return canonical.Node{}, ErrSourceUnavailable
	}
	return node, nil
}

func (s *Service) read(ctx context.Context, spaceID canonical.SpaceID, folderID canonical.NodeID) (Subtree, error) {
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

// newGrantID mints a grant identifier. UUIDv7 keeps grants ordered by
// creation, matching how the rest of the system names its resources.
func newGrantID() (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("startpage: new grant id: %w", err)
	}
	return id.String(), nil
}
