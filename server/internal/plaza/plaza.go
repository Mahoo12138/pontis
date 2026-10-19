// Package plaza implements publications: explicit, versioned share trees
// copied out of a private space (doc 10). Publications never expose
// canonical UUIDs or revisions; applying one copies fresh canonical nodes
// into the consumer's space through the executor.
package plaza

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
	"pontis/internal/library"
)

// Visibility of a publication.
type Visibility string

const (
	VisibilityPrivate Visibility = "private"
	VisibilityPlaza   Visibility = "plaza"
)

// Published node ids are opaque to consumers: a short prefix plus a keyed
// digest, never a canonical UUID.
const (
	nodeIDPrefix  = "pn-"
	nodeIDHexLen  = 24
	syntheticRoot = "root"
)

// Errors.
var (
	ErrNotFound          = errors.New("plaza: publication not found")
	ErrNotOwner          = errors.New("plaza: not the publication owner")
	ErrTitleRequired     = errors.New("plaza: title must not be empty")
	ErrSourceNotFound    = errors.New("plaza: source node not found")
	ErrSpaceForbidden    = errors.New("plaza: target space is not yours")
	ErrInvalidApply      = errors.New("plaza: invalid apply request")
	ErrInvalidVisibility = errors.New("plaza: visibility must be private or plaza")
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
	NodeKey       string `json:"-"`
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

// normalizeNodeIDs rewrites legacy snapshot ids. Before per-publication keys
// existed, published node ids were the canonical UUID with a prefix, which
// leaked private identity (doc 10 §5); stored trees may still carry them.
func (p *Publication) normalizeNodeIDs() {
	if p.NodeKey == "" {
		return
	}
	p.Tree = mapNodeIDs(p.Tree, func(id string) string {
		raw := strings.TrimPrefix(id, nodeIDPrefix)
		if canonicalID, ok := parseCanonicalID(raw); ok {
			return opaqueNodeID(p.NodeKey, canonicalID)
		}
		return id
	})
}

func mapNodeIDs(n Node, mapID func(string) string) Node {
	out := Node{
		ID:    mapID(n.ID),
		Type:  n.Type,
		Title: n.Title,
		URL:   n.URL,
	}
	if n.Children != nil {
		out.Children = make([]Node, 0, len(n.Children))
		for _, c := range n.Children {
			out.Children = append(out.Children, mapNodeIDs(c, mapID))
		}
	}
	return out
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
	store      Store
	library    *library.Service
	changesets *changeset.Service
	writer     interface {
		BeginTx(ctx context.Context) (canonical.Tx, error)
	}
}

// NewService returns a plaza service.
func NewService(store Store, lib *library.Service, changesets *changeset.Service, writer interface {
	BeginTx(ctx context.Context) (canonical.Tx, error)
}) *Service {
	return &Service{store: store, library: lib, changesets: changesets, writer: writer}
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
	if err := validateVisibility(p.Visibility); err != nil {
		return Publication{}, err
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

	key, err := newNodeKey()
	if err != nil {
		return Publication{}, err
	}
	tree, bookmarks, folders := buildTree(nodes, p.RootNodeID, key)
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
		NodeKey:       key,
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

func validateVisibility(v Visibility) error {
	switch v {
	case "", VisibilityPrivate, VisibilityPlaza:
		return nil
	}
	return ErrInvalidVisibility
}

// newNodeKey returns the per-publication secret used to derive published node
// ids. Keeping it per publication means two publishers never share an id space.
func newNodeKey() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// opaqueNodeID is stable for one canonical node within one publication, so
// snapshot updates keep identity without publishing the canonical UUID.
func opaqueNodeID(key, canonicalID string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(canonicalID))
	return nodeIDPrefix + hex.EncodeToString(mac.Sum(nil))[:nodeIDHexLen]
}

func parseCanonicalID(s string) (string, bool) {
	u, err := uuid.Parse(s)
	if err != nil || u.String() != strings.ToLower(s) {
		return "", false
	}
	return u.String(), true
}

// UpdateSnapshot re-captures the source tree, bumping the version. A source
// that no longer exists is refused: writing an empty tree would silently
// destroy a published collection.
func (s *Service) UpdateSnapshot(ctx context.Context, user canonical.UserID, id string) (Publication, error) {
	pub, err := s.owned(ctx, user, id)
	if err != nil {
		return Publication{}, err
	}
	nodes, err := s.library.ListNodes(ctx, canonical.SpaceID(pub.SpaceID))
	if err != nil {
		return Publication{}, err
	}
	tree, bookmarks, folders := buildTree(nodes, pub.RootNodeID, pub.NodeKey)
	if bookmarks < 0 {
		return Publication{}, ErrSourceNotFound
	}
	tree = renameRoot(tree, pub.Title)
	if err := s.store.UpdateSnapshot(ctx, id, tree, bookmarks, folders, pub.Version+1, time.Now().UTC()); err != nil {
		return Publication{}, err
	}
	return s.load(ctx, id)
}

// UpdateMeta changes title/description/visibility.
func (s *Service) UpdateMeta(ctx context.Context, user canonical.UserID, id string, title, desc *string, vis *Visibility) (Publication, error) {
	if _, err := s.owned(ctx, user, id); err != nil {
		return Publication{}, err
	}
	if title != nil && *title == "" {
		return Publication{}, ErrTitleRequired
	}
	if vis != nil {
		if err := validateVisibility(*vis); err != nil {
			return Publication{}, err
		}
	}
	if err := s.store.UpdateMeta(ctx, id, title, desc, vis, time.Now().UTC()); err != nil {
		return Publication{}, err
	}
	return s.load(ctx, id)
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
	out := filterQuery(list, q)
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

// ListMine returns the user's publications regardless of visibility. The same
// query applies: a private publication is not a hit for an unrelated term.
func (s *Service) ListMine(ctx context.Context, user canonical.UserID, q string) ([]Publication, error) {
	list, err := s.store.ListByOwner(ctx, string(user))
	if err != nil {
		return nil, err
	}
	return filterQuery(list, q), nil
}

func filterQuery(list []Publication, q string) []Publication {
	needle := strings.ToLower(strings.TrimSpace(q))
	out := make([]Publication, 0, len(list))
	for _, p := range list {
		if needle != "" && !matchesQuery(p, needle) {
			continue
		}
		out = append(out, p)
	}
	return out
}

// load reads one publication and rewrites any legacy published node id.
func (s *Service) load(ctx context.Context, id string) (Publication, error) {
	pub, err := s.store.Get(ctx, id)
	if err != nil {
		return Publication{}, err
	}
	pub.normalizeNodeIDs()
	return pub, nil
}

// Get returns one publication; plaza visibility or ownership required.
func (s *Service) Get(ctx context.Context, user canonical.UserID, id string) (Publication, error) {
	pub, err := s.load(ctx, id)
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
// executor. Merge reuses equivalent nodes at the matching location; replace
// clears the target's children first. Both run as one atomic domain
// transaction and one undoable ChangeSet.
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

	// One ChangeSet for the whole apply (doc 15 §8): undoable as a whole.
	rec := s.changesets.BeginBatch(p.SpaceID, changeset.KindPublication, origin, true)

	// Replace: clear the target's existing children first — as journaled,
	// tombstoned DeleteNode commands so sync clients observe the removal
	// and the undo keeps a full Before Image.
	if p.Strategy == "replace" {
		children, err := tx.Children(ctx, p.SpaceID, p.Parent)
		if err != nil {
			return ApplyResult{}, err
		}
		for _, child := range children {
			if err := rec.Apply(ctx, tx, canonical.DeleteNode{SpaceID: p.SpaceID, NodeID: child.ID}); err != nil {
				return ApplyResult{}, err
			}
		}
	}

	// Existing children index for merge matching.
	m := &merger{
		ctx:     ctx,
		tx:      tx,
		space:   p.SpaceID,
		rec:     rec,
		replace: p.Strategy == "replace",
		indexes: map[string]*childIndex{},
	}

	// A whole-space publication stores a synthetic container as its root, so
	// its children land directly at the target. A subtree publication has the
	// source folder (or bookmark) as its root, and that node is copied too.
	if pub.RootNodeID == "" {
		if err := m.placeChildren(pub.Tree, p.Parent); err != nil {
			return ApplyResult{}, err
		}
	} else if err := m.place(pub.Tree, p.Parent); err != nil {
		return ApplyResult{}, err
	}
	res := ApplyResult{Created: m.created, Kept: m.kept}

	summary := fmt.Sprintf("应用发布「%s」：新增 %d 项", pub.Title, res.Created)
	if _, err := rec.Finish(ctx, tx, summary); err != nil {
		return ApplyResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ApplyResult{}, err
	}
	committed = true
	return res, nil
}

// merger copies published nodes into the consumer's tree. Matching is
// location-aware: every target parent is indexed once when the walk reaches
// it, so re-applying a publication converges instead of duplicating nested
// content, and two same-named folders inside one publication stay two folders.
type merger struct {
	ctx     context.Context
	tx      canonical.Tx
	space   canonical.SpaceID
	rec     *changeset.Batch
	replace bool
	indexes map[string]*childIndex
	created int64
	kept    int64
}

type childIndex struct {
	byTitle map[string]canonical.NodeID
	byURL   map[string]canonical.NodeID
}

func parentKey(parent canonical.ParentRef) string {
	if parent.Type == canonical.ParentTypeNode {
		return "node:" + string(parent.NodeID)
	}
	return "root:" + parent.RootKey
}

func (m *merger) index(parent canonical.ParentRef) (*childIndex, error) {
	key := parentKey(parent)
	if ix, ok := m.indexes[key]; ok {
		return ix, nil
	}
	children, err := m.tx.Children(m.ctx, m.space, parent)
	if err != nil {
		return nil, err
	}
	ix := &childIndex{byTitle: map[string]canonical.NodeID{}, byURL: map[string]canonical.NodeID{}}
	for _, c := range children {
		if c.Type == canonical.NodeTypeFolder {
			ix.byTitle[c.Title] = c.ID
		} else {
			ix.byURL[c.URL] = c.ID
		}
	}
	m.indexes[key] = ix
	return ix, nil
}

// placeChildren copies the contents of a published container under parent.
func (m *merger) placeChildren(container Node, parent canonical.ParentRef) error {
	for _, child := range container.Children {
		if err := m.place(child, parent); err != nil {
			return err
		}
	}
	return nil
}

// place copies one published node under parent, reusing an equivalent node
// that already lives at that location when merging.
func (m *merger) place(node Node, parent canonical.ParentRef) error {
	isFolder := node.Type == string(canonical.NodeTypeFolder)
	url := ""
	if node.URL != nil {
		url = *node.URL
	}

	if !m.replace {
		ix, err := m.index(parent)
		if err != nil {
			return err
		}
		var existing canonical.NodeID
		var found bool
		if isFolder {
			existing, found = ix.byTitle[node.Title]
		} else {
			existing, found = ix.byURL[url]
		}
		if found {
			m.kept++
			if isFolder {
				return m.placeChildren(node, canonical.NewNodeParent(existing))
			}
			return nil
		}
	}

	id, err := newCanonicalID()
	if err != nil {
		return err
	}
	cmd := canonical.CreateNode{
		SpaceID: m.space, NodeID: id, Parent: parent, Title: node.Title,
		Type: canonical.NodeTypeFolder,
	}
	if !isFolder {
		cmd.Type = canonical.NodeTypeBookmark
		cmd.URL = url
	}
	if err := m.rec.Apply(m.ctx, m.tx, cmd); err != nil {
		return err
	}
	m.created++
	if isFolder {
		return m.placeChildren(node, canonical.NewNodeParent(id))
	}
	return nil
}

func newCanonicalID() (canonical.NodeID, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	return canonical.NodeID(id.String()), nil
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

// --- snapshot builders ---

// buildTree assembles the publication tree of the whole space or of one
// subtree; returns a negative bookmark count when the source node does not
// exist. Published ids are derived from the publication key, never from the
// canonical UUID.
func buildTree(nodes []canonical.Node, rootNodeID, key string) (Node, int64, int64) {
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
		out := Node{ID: opaqueNodeID(key, string(n.ID)), Type: string(n.Type), Title: n.Title}
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

	root := Node{ID: nodeIDPrefix + syntheticRoot, Type: "folder"}
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

// MarshalTree serializes the snapshot for storage.
func (p Publication) MarshalTree() (string, error) {
	b, err := json.Marshal(p.Tree)
	return string(b), err
}
