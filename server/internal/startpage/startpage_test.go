package startpage

import (
	"context"
	"errors"
	"testing"
	"time"

	"pontis/internal/canonical"
)

// fakeGrants and fakeTree stand in for the SQLite store so the decisions the
// service makes — whose device, what kind of node, when the version moves —
// can be tested without a database.
type fakeGrants struct {
	byID    map[string]Grant
	active  map[string]Grant
	owners  map[string]canonical.UserID
	revoked []string
}

func newFakeGrants() *fakeGrants {
	return &fakeGrants{byID: map[string]Grant{}, active: map[string]Grant{}, owners: map[string]canonical.UserID{}}
}

func (f *fakeGrants) InsertGrant(_ context.Context, g Grant) error {
	f.byID[g.ID] = g
	f.active[g.DeviceID] = g
	return nil
}

func (f *fakeGrants) RepointGrant(_ context.Context, id string, space canonical.SpaceID, folder canonical.NodeID, at time.Time) error {
	g, ok := f.byID[id]
	if !ok || !g.RevokedAt.IsZero() {
		return ErrGrantNotFound
	}
	g.SpaceID, g.FolderID, g.UpdatedAt, g.Version = space, folder, at, g.Version+1
	f.byID[id] = g
	f.active[g.DeviceID] = g
	return nil
}

func (f *fakeGrants) RevokeGrant(_ context.Context, id string, at time.Time) error {
	g, ok := f.byID[id]
	if !ok {
		return nil
	}
	g.RevokedAt = at
	f.byID[id] = g
	delete(f.active, g.DeviceID)
	f.revoked = append(f.revoked, id)
	return nil
}

func (f *fakeGrants) GetGrant(_ context.Context, id string) (Grant, error) {
	g, ok := f.byID[id]
	if !ok {
		return Grant{}, ErrGrantNotFound
	}
	return g, nil
}

func (f *fakeGrants) ActiveGrant(_ context.Context, deviceID string) (Grant, error) {
	g, ok := f.active[deviceID]
	if !ok {
		return Grant{}, ErrGrantNotFound
	}
	return g, nil
}

func (f *fakeGrants) ListGrants(_ context.Context, user canonical.UserID) ([]Grant, error) {
	var out []Grant
	for _, g := range f.byID {
		if g.UserID == user {
			out = append(out, g)
		}
	}
	return out, nil
}

func (f *fakeGrants) DeviceOwner(_ context.Context, deviceID string) (canonical.UserID, error) {
	owner, ok := f.owners[deviceID]
	if !ok {
		return "", ErrDeviceNotFound
	}
	return owner, nil
}

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

func (f *fakeTree) Subtree(_ context.Context, space canonical.SpaceID, folder canonical.NodeID, budget int) (Subtree, error) {
	kids, ok := f.below[folder]
	if !ok {
		return Subtree{}, canonical.ErrNodeNotFound
	}
	// The real store reads budget+1 rows and hands them all back, so the
	// service is what turns "more than asked for" into a refusal.
	return Subtree{Space: f.spaces[space], Source: f.nodes[folder], Nodes: kids}, nil
}

func newTestService() (*Service, *fakeGrants, *fakeTree) {
	grants := newFakeGrants()
	grants.owners["dev-1"] = "user-1"
	tree := &fakeTree{
		spaces: map[canonical.SpaceID]canonical.SyncSpace{
			"space-1": {ID: "space-1", OwnerUserID: "user-1", Epoch: 3, CurrentRevision: 42},
		},
		nodes: map[canonical.NodeID]canonical.Node{
			"folder-1": {ID: "folder-1", SpaceID: "space-1", Type: canonical.NodeTypeFolder, Title: "Entries"},
			"folder-2": {ID: "folder-2", SpaceID: "space-1", Type: canonical.NodeTypeFolder, Title: "Reading"},
			"mark-1":   {ID: "mark-1", SpaceID: "space-1", Type: canonical.NodeTypeBookmark, Title: "GitHub", URL: "https://github.com/"},
			"child-1":  {ID: "child-1", SpaceID: "space-1", Type: canonical.NodeTypeBookmark, Title: "MDN", URL: "https://developer.mozilla.org"},
		},
		below: map[canonical.NodeID][]canonical.Node{
			"folder-1": {
				{ID: "child-1", SpaceID: "space-1", Type: canonical.NodeTypeBookmark, Title: "MDN", URL: "https://developer.mozilla.org"},
			},
			"folder-2": {},
		},
	}
	return NewService(grants, tree), grants, tree
}

func TestAuthorizeRefuseForeignResources(t *testing.T) {
	svc, grants, _ := newTestService()
	ctx := context.Background()
	grants.owners["dev-2"] = "user-2"

	for _, tc := range []struct {
		name   string
		user   canonical.UserID
		device string
		space  canonical.SpaceID
		folder canonical.NodeID
		want   error
	}{
		{"someone else's device", "user-1", "dev-2", "space-1", "folder-1", ErrDeviceNotFound},
		{"unknown device", "user-1", "dev-gone", "space-1", "folder-1", ErrDeviceNotFound},
		{"someone else's space", "user-1", "dev-1", "space-2", "folder-1", ErrSpaceNotFound},
		{"unknown folder", "user-1", "dev-1", "space-1", "node-gone", ErrSourceUnavailable},
		{"a bookmark as source", "user-1", "dev-1", "space-1", "mark-1", ErrSourceUnavailable},
	} {
		if _, err := svc.Authorize(ctx, tc.user, tc.device, tc.space, tc.folder); !errors.Is(err, tc.want) {
			t.Errorf("%s: err = %v, want %v", tc.name, err, tc.want)
		}
	}
	// None of those guesses may leave a grant behind: a half-authorized
	// device would read a source nobody approved.
	if _, err := grants.ActiveGrant(ctx, "dev-1"); !errors.Is(err, ErrGrantNotFound) {
		t.Fatalf("grants written by refused attempts: %v", err)
	}
}

func TestAuthorizeVersionMovesOnlyWhenTheSourceDoes(t *testing.T) {
	svc, _, _ := newTestService()
	ctx := context.Background()

	first, err := svc.Authorize(ctx, "user-1", "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if first.Version != 1 {
		t.Fatalf("version = %d, want 1", first.Version)
	}
	again, err := svc.Authorize(ctx, "user-1", "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("re-authorize: %v", err)
	}
	// Saving the same form twice must not expire the snapshot the client
	// already holds for this source.
	if again.Version != 1 || again.ID != first.ID {
		t.Fatalf("same source moved the grant: %+v", again)
	}

	moved, err := svc.Authorize(ctx, "user-1", "dev-1", "space-1", "folder-2")
	if err != nil {
		t.Fatalf("move source: %v", err)
	}
	// A different folder is a different source: the version has to move, or a
	// client would keep serving the old folder's cache under the new name.
	if moved.Version != 2 || moved.FolderID != "folder-2" {
		t.Fatalf("moved = %+v, want version 2 at folder-2", moved)
	}
}

func TestRevokeOnlyByOwnerAndOnce(t *testing.T) {
	svc, grants, _ := newTestService()
	ctx := context.Background()

	g, err := svc.Authorize(ctx, "user-1", "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if err := svc.Revoke(ctx, "user-2", g.ID); !errors.Is(err, ErrGrantNotFound) {
		t.Fatalf("foreign revoke = %v, want ErrGrantNotFound", err)
	}
	if _, err := grants.ActiveGrant(ctx, "dev-1"); err != nil {
		t.Fatalf("a stranger's revocation took effect: %v", err)
	}
	if err := svc.Revoke(ctx, "user-1", g.ID); err != nil {
		t.Fatalf("owner revoke: %v", err)
	}
	if err := svc.Revoke(ctx, "user-1", g.ID); !errors.Is(err, ErrGrantNotFound) {
		t.Fatalf("second revoke = %v, want ErrGrantNotFound", err)
	}
	if _, err := svc.ActiveGrant(ctx, "dev-1"); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("after revoke = %v, want ErrNotConfigured", err)
	}
}

func TestGrantSnapshotRevalidatesTheSource(t *testing.T) {
	svc, _, tree := newTestService()
	ctx := context.Background()

	g, err := svc.Authorize(ctx, "user-1", "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	sub, err := svc.GrantSnapshot(ctx, g)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(sub.Nodes) != 1 || sub.Space.CurrentRevision != 42 {
		t.Fatalf("subtree = %+v", sub)
	}

	// The folder was deleted in the workbench, or a same-named one was made
	// elsewhere: the grant's id still resolves, but not to a folder.
	delete(tree.nodes, "folder-1")
	if _, err := svc.GrantSnapshot(ctx, g); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("after deletion = %v, want ErrSourceUnavailable", err)
	}
}

func TestGrantSnapshotStopsWhenTheSpaceChangesHands(t *testing.T) {
	svc, _, tree := newTestService()
	ctx := context.Background()

	g, err := svc.Authorize(ctx, "user-1", "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	// A cross-space transfer gives the tree a new identity (§5.2).
	tree.spaces["space-1"] = canonical.SyncSpace{ID: "space-1", OwnerUserID: "user-2", Epoch: 3}
	if _, err := svc.GrantSnapshot(ctx, g); !errors.Is(err, ErrSourceUnavailable) {
		t.Fatalf("after transfer = %v, want ErrSourceUnavailable", err)
	}
}

func TestSourceOverTheBudgetIsRefused(t *testing.T) {
	svc, _, tree := newTestService()
	ctx := context.Background()

	var many []canonical.Node
	for i := 0; i < MaxDescendants+1; i++ {
		many = append(many, canonical.Node{
			ID: canonical.NodeID("n"), SpaceID: "space-1",
			Type: canonical.NodeTypeBookmark, Title: "t", URL: "https://e.example",
		})
	}
	tree.below["folder-1"] = many

	g, err := svc.Authorize(ctx, "user-1", "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	// Refused, not trimmed: a truncated list labelled complete would be
	// shown as the whole folder.
	if _, err := svc.GrantSnapshot(ctx, g); !errors.Is(err, ErrSourceTooLarge) {
		t.Fatalf("err = %v, want ErrSourceTooLarge", err)
	}
}

func TestSnapshotBytesRefusesAnOversizedSource(t *testing.T) {
	svc, _, tree := newTestService()
	ctx := context.Background()

	long := make([]byte, 4096)
	for i := range long {
		long[i] = 'a'
	}
	var many []canonical.Node
	for i := 0; i < 3000; i++ {
		many = append(many, canonical.Node{
			ID: canonical.NodeID("n"), SpaceID: "space-1",
			Type: canonical.NodeTypeBookmark, Title: string(long), URL: "https://e.example",
		})
	}
	tree.below["folder-1"] = many

	g, err := svc.Authorize(ctx, "user-1", "dev-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if _, err := svc.GrantSnapshot(ctx, g); !errors.Is(err, ErrSourceTooLarge) {
		t.Fatalf("err = %v, want ErrSourceTooLarge under the node cap but over the byte cap", err)
	}
}

func TestSessionSnapshotNeedsOwnership(t *testing.T) {
	svc, _, _ := newTestService()
	ctx := context.Background()

	if _, err := svc.SessionSnapshot(ctx, "user-2", "space-1", "folder-1"); !errors.Is(err, ErrSpaceNotFound) {
		t.Fatalf("stranger's space = %v, want ErrSpaceNotFound", err)
	}
	sub, err := svc.SessionSnapshot(ctx, "user-1", "space-1", "folder-1")
	if err != nil {
		t.Fatalf("owner snapshot: %v", err)
	}
	if len(sub.Nodes) != 1 {
		t.Fatalf("subtree = %+v", sub)
	}
}
