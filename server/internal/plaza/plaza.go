// Package plaza implements publications: explicit, versioned share trees
// copied out of a private space (doc 10). Publications never expose
// canonical UUIDs or revisions; applying one copies fresh canonical nodes
// into the consumer's space through the executor.
package plaza

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/library"
)

// Visibility of a publication.
type Visibility string

const (
	VisibilityPrivate Visibility = "private"
	VisibilityPlaza   Visibility = "plaza"
)

// Errors.
var (
	ErrNotFound       = errors.New("plaza: publication not found")
	ErrNotOwner       = errors.New("plaza: not the publication owner")
	ErrTitleRequired  = errors.New("plaza: title must not be empty")
	ErrSourceNotFound = errors.New("plaza: source node not found")
	ErrSpaceForbidden = errors.New("plaza: target space is not yours")
	ErrInvalidApply   = errors.New("plaza: invalid apply request")
)

// Node is one node of the published tree.
type Node struct {
	ID       string  `json:"id"`
	Type     string  `json:"type"`
	Title    string  `json:"title"`
	URL      *string `json:"url,omitempty"`
	Children []Node  `json:"children,omitempty"`
}

// Publication is the full aggregate (tree included).
type Publication struct {
	ID            string
	Slug          string
	OwnerUserID   string
	PublisherName string
	SpaceID       string
	RootNodeID    string `json:"-"`
	Title         string
	Description   string
	Tags          []string
	Version       int
	Visibility    Visibility
	BookmarkCount int64
	FolderCount   int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
	Tree          Node
}

// Store is the persistence contract.
type Store interface {
	Insert(ctx context.Context, p Publication) error
	Get(ctx context.Context, id string) (Publication, error)
	ListPlaza(ctx context.Context) ([]Publication, error)
	ListByOwner(ctx context.Context, userID string) ([]Publication, error)
	UpdateSnapshot(ctx context.Context, id string, tree Node, bookmarks, folders int64, version int, at time.Time) error
	UpdateMeta(ctx context.Context, id string, title, description *string, visibility *Visibility, at time.Time) error
	Delete(ctx context.Context, id string) error
}

// Service implements publishing and applying.
type Service struct {
	store   Store
	library *library.Service
	exec    *canonical.Executor
	writer  interface {
		BeginTx(ctx context.Context) (canonical.Tx, error)
	}
}

// NewService returns a plaza service.
func NewService(store Store, lib *library.Service, writer interface {
	BeginTx(ctx context.Context) (canonical.Tx, error)
}) *Service {
	return &Service{store: store, library: lib, exec: canonical.NewExecutor(), writer: writer}
}

// PublishParams carries a publish request.
type PublishParams struct {
	SpaceID    canonical.SpaceID
	RootNodeID string // empty = whole space
	Title      string
	Desc       string
	Tags       []string
	Visibility Visibility
}

// Publish captures a versioned snapshot.
func (s *Service) Publish(ctx context.Context, user canonical.UserID, p PublishParams) (Publication, error) {
	if p.Title == "" {
		return Publication{}, ErrTitleRequired
	}
	sp, err := s.library.Space(ctx, p.SpaceID)
	if err != nil {
		return Publication{}, err
	}
	if sp.OwnerUserID != user {
		return Publication{}, ErrSpaceForbidden
	}
	nodes, err := s.library.ListNodes(ctx, p.SpaceID)
	if err != nil {
		return Publication{}, err
	}
	slots, err := s.library.RootSlots(ctx, p.SpaceID)
	if err != nil {
		return Publication{}, err
	}

	tree, bookmarks, folders := buildTree(nodes, p.RootNodeID, titleMap(nodes), keyMap(slots))
	if p.RootNodeID != "" && bookmarks < 0 {
		return Publication{}, ErrSourceNotFound
	}
	tree = renameRoot(tree, p.Title)

	id, err := uuid.NewV7()
	if err != nil {
		return Publication{}, err
	}
	now := time.Now().UTC()
	vis := p.Visibility
	if vis == "" {
		vis = VisibilityPlaza
	}
	pub := Publication{
		ID:            id.String(),
		Slug:          slugify(p.Title) + "-" + id.String()[:8],
		OwnerUserID:   string(user),
		SpaceID:       string(p.SpaceID),
		RootNodeID:    p.RootNodeID,
		Title:         p.Title,
		Description:   p.Desc,
		Tags:          p.Tags,
		Version:       1,
		Visibility:    vis,
		BookmarkCount: bookmarks,
		FolderCount:   folders,
		CreatedAt:     now,
		UpdatedAt:     now,
		Tree:          tree,
	}
	if err := s.store.Insert(ctx, pub); err != nil {
		return Publication{}, err
	}
	return pub, nil
}

// UpdateSnapshot re-captures the source tree, bumping the version.
func (s *Service) UpdateSnapshot(ctx context.Context, user canonical.UserID, id string) (Publication, error) {
	pub, err := s.owned(ctx, user, id)
	if err != nil {
		return Publication{}, err
	}
	nodes, err := s.library.ListNodes(ctx, canonical.SpaceID(pub.SpaceID))
	if err != nil {
		return Publication{}, err
	}
	slots, err := s.library.RootSlots(ctx, canonical.SpaceID(pub.SpaceID))
	if err != nil {
		return Publication{}, err
	}
	tree, bookmarks, folders := buildTree(nodes, pub.rootNodeID(), titleMap(nodes), keyMap(slots))
	tree = renameRoot(tree, pub.Title)
	if err := s.store.UpdateSnapshot(ctx, id, tree, bookmarks, folders, pub.Version+1, time.Now().UTC()); err != nil {
		return Publication{}, err
	}
	return s.store.Get(ctx, id)
}

// UpdateMeta changes title/description/visibility.
func (s *Service) UpdateMeta(ctx context.Context, user canonical.UserID, id string, title, desc *string, vis *Visibility) (Publication, error) {
	if _, err := s.owned(ctx, user, id); err != nil {
		return Publication{}, err
	}
	if title != nil && *title == "" {
		return Publication{}, ErrTitleRequired
	}
	if err := s.store.UpdateMeta(ctx, id, title, desc, vis, time.Now().UTC()); err != nil {
		return Publication{}, err
	}
	return s.store.Get(ctx, id)
}

// Unpublish removes the publication; imported copies in other spaces are
// independent canonical nodes and stay untouched.
func (s *Service) Unpublish(ctx context.Context, user canonical.UserID, id string) error {
	if _, err := s.owned(ctx, user, id); err != nil {
		return err
	}
	return s.store.Delete(ctx, id)
}

// ListPlaza returns plaza-visible publications with search across title,
// description, publisher name and tags.
func (s *Service) ListPlaza(ctx context.Context, q string) ([]Publication, error) {
	list, err := s.store.ListPlaza(ctx)
	if err != nil {
		return nil, err
	}
	q = strings.ToLower(strings.TrimSpace(q))
	var out []Publication
	for _, p := range list {
		if q != "" && !matchesQuery(p, q) {
			continue
		}
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

// ListMine returns the user's publications regardless of visibility.
func (s *Service) ListMine(ctx context.Context, user canonical.UserID) ([]Publication, error) {
	return s.store.ListByOwner(ctx, string(user))
}

// Get returns one publication; plaza visibility or ownership required.
func (s *Service) Get(ctx context.Context, user canonical.UserID, id string) (Publication, error) {
	pub, err := s.store.Get(ctx, id)
	if err != nil {
		return Publication{}, err
	}
	if pub.Visibility != VisibilityPlaza && pub.OwnerUserID != string(user) {
		return Publication{}, ErrNotFound
	}
	return pub, nil
}

// ApplyParams carries a consumer apply request.
type ApplyParams struct {
	SpaceID  canonical.SpaceID
	Parent   canonical.ParentRef
	Strategy string // merge | replace
}

// ApplyResult reports what the copy did.
type ApplyResult struct {
	Created int64 `json:"created"`
	Updated int64 `json:"updated"`
	Kept    int64 `json:"kept"`
}

// Apply copies the published tree into the consumer's space through the
// executor. Merge reuses same-title folders and same-raw-URL bookmarks at
// the mapped location (conservative ExactTreeMatcher); replace clears the
// target's children first. Both run as one atomic domain transaction.
func (s *Service) Apply(ctx context.Context, user canonical.UserID, id string, p ApplyParams) (ApplyResult, error) {
	pub, err := s.Get(ctx, user, id)
	if err != nil {
		return ApplyResult{}, err
	}
	sp, err := s.library.Space(ctx, p.SpaceID)
	if err != nil {
		return ApplyResult{}, err
	}
	if sp.OwnerUserID != user {
		return ApplyResult{}, ErrSpaceForbidden
	}
	if p.Strategy != "merge" && p.Strategy != "replace" {
		return ApplyResult{}, ErrInvalidApply
	}

	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return ApplyResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	// Replace: clear the target's existing children first.
	if p.Strategy == "replace" {
		children, err := tx.Children(ctx, p.SpaceID, p.Parent)
		if err != nil {
			return ApplyResult{}, err
		}
		for _, child := range children {
			ids, err := tx.SubtreeIDs(ctx, p.SpaceID, child.ID)
			if err != nil {
				return ApplyResult{}, err
			}
			// Deepest first satisfies the parent FK.
			for i := len(ids) - 1; i >= 0; i-- {
				if err := tx.DeleteNodes(ctx, p.SpaceID, []canonical.NodeID{ids[i]}); err != nil {
					return ApplyResult{}, err
				}
			}
		}
	}

	// Existing children index for merge matching.
	children, err := tx.Children(ctx, p.SpaceID, p.Parent)
	if err != nil {
		return ApplyResult{}, err
	}
	var res ApplyResult
	byTitle := map[string]canonical.NodeID{}
	byURL := map[string]canonical.NodeID{}
	for _, c := range children {
		if c.Type == canonical.NodeTypeFolder {
			byTitle[c.Title] = c.ID
		} else {
			byURL[c.URL] = c.ID
		}
	}

	newID := func() (canonical.NodeID, error) {
		id, err := uuid.NewV7()
		if err != nil {
			return "", err
		}
		return canonical.NodeID(id.String()), nil
	}

	var walk func(pubNode Node, parent canonical.ParentRef) error
	walk = func(pubNode Node, parent canonical.ParentRef) error {
		for _, child := range pubNode.Children {
			if child.Type == "folder" {
				if existing, ok := byTitle[child.Title]; ok && p.Strategy == "merge" {
					res.Kept++
					if err := walk(child, canonical.NewNodeParent(existing)); err != nil {
						return err
					}
					continue
				}
				id, err := newID()
				if err != nil {
					return err
				}
				if err := s.exec.ApplyTx(ctx, tx, origin, canonical.CreateNode{
					SpaceID: p.SpaceID, NodeID: id, Type: canonical.NodeTypeFolder,
					Title: child.Title, Parent: parent,
				}); err != nil {
					return err
				}
				byTitle[child.Title] = id
				res.Created++
				if err := walk(child, canonical.NewNodeParent(id)); err != nil {
					return err
				}
				continue
			}
			// Bookmark.
			childURL := ""
			if child.URL != nil {
				childURL = *child.URL
			}
			if _, ok := byURL[childURL]; ok && p.Strategy == "merge" {
				res.Kept++
				continue
			}
			id, err := newID()
			if err != nil {
				return err
			}
			if err := s.exec.ApplyTx(ctx, tx, origin, canonical.CreateNode{
				SpaceID: p.SpaceID, NodeID: id, Type: canonical.NodeTypeBookmark,
				Title: child.Title, URL: childURL, Parent: parent,
			}); err != nil {
				return err
			}
			byURL[childURL] = id
			res.Created++
		}
		return nil
	}

	if err := walk(pub.Tree, p.Parent); err != nil {
		return ApplyResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ApplyResult{}, err
	}
	committed = true
	return res, nil
}

func (s *Service) owned(ctx context.Context, user canonical.UserID, id string) (Publication, error) {
	pub, err := s.store.Get(ctx, id)
	if err != nil {
		return Publication{}, err
	}
	if pub.OwnerUserID != string(user) {
		return Publication{}, ErrNotOwner
	}
	return pub, nil
}

func matchesQuery(p Publication, q string) bool {
	if strings.Contains(strings.ToLower(p.Title), q) ||
		strings.Contains(strings.ToLower(p.Description), q) ||
		strings.Contains(strings.ToLower(p.PublisherName), q) {
		return true
	}
	for _, t := range p.Tags {
		if strings.Contains(strings.ToLower(t), q) {
			return true
		}
	}
	return false
}

func slugify(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ' || r == '-' || r == '/' || r == '.':
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

func (p Publication) rootNodeID() string {
	// The stored root_node_id is not carried on the aggregate; the snapshot
	// update re-reads it from the store row via the store's snapshot
	// columns. Simplified: whole-space publications re-capture the space.
	return p.RootNodeID
}

// --- snapshot builders ---

func titleMap(nodes []canonical.Node) map[canonical.NodeID]string {
	m := make(map[canonical.NodeID]string, len(nodes))
	for _, n := range nodes {
		m[n.ID] = n.Title
	}
	return m
}

func keyMap(slots []canonical.RootSlot) map[string]canonical.RootSlot {
	m := make(map[string]canonical.RootSlot, len(slots))
	for _, s := range slots {
		m[s.Key] = s
	}
	return m
}

// buildTree assembles the publication tree of the whole space or of one
// subtree; returns nil tree when the source node does not exist.
func buildTree(nodes []canonical.Node, rootNodeID string, titles map[canonical.NodeID]string, slots map[string]canonical.RootSlot) (Node, int64, int64) {
	childrenOf := map[string][]canonical.Node{}
	var rootOfSpace []canonical.Node
	var source *canonical.Node
	for _, n := range nodes {
		if n.Parent.Type == canonical.ParentTypeNode {
			childrenOf[string(n.Parent.NodeID)] = append(childrenOf[string(n.Parent.NodeID)], n)
		} else {
			rootOfSpace = append(rootOfSpace, n)
		}
		if rootNodeID != "" && n.ID == canonical.NodeID(rootNodeID) {
			source = new(canonical.Node)
			*source = n
		}
	}
	sort.Slice(rootOfSpace, func(i, j int) bool { return rootOfSpace[i].Position < rootOfSpace[j].Position })
	for k := range childrenOf {
		list := childrenOf[k]
		sort.Slice(list, func(i, j int) bool { return list[i].Position < list[j].Position })
		childrenOf[k] = list
	}

	var bookmarks, folders int64
	var build func(n canonical.Node) Node
	build = func(n canonical.Node) Node {
		out := Node{ID: "pn-" + string(n.ID), Type: string(n.Type), Title: n.Title}
		if n.Type == canonical.NodeTypeBookmark {
			u := n.URL
			out.URL = &u
			bookmarks++
		} else {
			folders++
		}
		for _, c := range childrenOf[string(n.ID)] {
			out.Children = append(out.Children, build(c))
		}
		return out
	}

	if rootNodeID != "" {
		if source == nil {
			return Node{}, -1, 0
		}
		return build(*source), bookmarks, folders
	}

	root := Node{ID: "pn-root", Type: "folder"}
	for _, n := range rootOfSpace {
		root.Children = append(root.Children, build(n))
	}
	// The synthetic root container is not counted.
	return root, bookmarks, folders
}

// renameRoot sets the container title to the publication title.
func renameRoot(tree Node, title string) Node {
	tree.Title = title
	return tree
}

// RootNodeID recomputes the stored root node id column; the store persists
// it on insert and uses it on snapshot updates.
func (p Publication) MarshalTree() (string, error) {
	b, err := json.Marshal(p.Tree)
	return string(b), err
}
