package transfer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
)

// TreeSource reads the canonical tree.
type TreeSource interface {
	Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error)
	ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error)
}

// Writer supplies canonical transactions for import applies.
type Writer interface {
	BeginTx(ctx context.Context) (canonical.Tx, error)
}

// EntryAction classifies one planned change (doc 11 §8).
type EntryAction string

const (
	ActionCreate      EntryAction = "create"
	ActionUpdate      EntryAction = "update"
	ActionMove        EntryAction = "move"
	ActionDelete      EntryAction = "delete"
	ActionKeep        EntryAction = "keep"
	ActionAmbiguous   EntryAction = "ambiguous"
	ActionUnsupported EntryAction = "unsupported"
)

// Entry is one line of the plan preview.
type Entry struct {
	Title  string `json:"title"`
	URL    string `json:"url,omitempty"`
	Path   string `json:"path"`
	Action string `json:"action"`
	Reason string `json:"reason,omitempty"`
}

// Plan is the persisted-in-memory result of Parse → Validate → Plan.
type Plan struct {
	ID            string         `json:"plan_id"`
	SpaceID       string         `json:"space_id"`
	Format        Format         `json:"format"`
	Total         int            `json:"total"`
	Counts        map[string]int `json:"counts"`
	Warnings      []string       `json:"warnings"`
	Entries       []Entry        `json:"entries"`
	BoundRevision int64          `json:"bound_revision"`
	CreatedAt     time.Time      `json:"-"`
	Tree          *ImportNode    `json:"-"`
}

// ApplyResult reports real counters from the committed transaction.
type ApplyResult struct {
	Created int64 `json:"created"`
	Updated int64 `json:"updated"`
	Deleted int64 `json:"deleted"`
	Kept    int64 `json:"kept"`
}

// planTTL bounds how long a preview stays valid; plans are operational
// temporary data (doc 14 §7).
const planTTL = time.Hour

// Service implements export and import planning/application.
type Service struct {
	trees      TreeSource
	writer     Writer
	changesets *changeset.Service

	mu    sync.Mutex
	plans map[string]Plan
}

// NewService returns a transfer service.
func NewService(trees TreeSource, writer Writer, changesets *changeset.Service) *Service {
	return &Service{trees: trees, writer: writer, changesets: changesets, plans: map[string]Plan{}}
}

// --- export (side-effect free) ---

// Export renders the space (or one root slot) in the requested format.
func (s *Service) Export(ctx context.Context, space canonical.SpaceID, format Format, rootKey string) (filename, contentType, content string, err error) {
	sp, err := s.trees.Space(ctx, space)
	if err != nil {
		return "", "", "", err
	}
	nodes, err := s.trees.ListNodes(ctx, space)
	if err != nil {
		return "", "", "", err
	}
	slots, err := s.trees.ListRootSlots(ctx, space)
	if err != nil {
		return "", "", "", err
	}
	if rootKey != "" {
		var scoped []canonical.Node
		for _, n := range nodes {
			if n.Parent.Type == canonical.ParentTypeRoot && n.Parent.RootKey == rootKey {
				scoped = append(scoped, n)
			}
		}
		nodes = scoped
	}

	switch format {
	case FormatNetscapeHTML:
		return fmt.Sprintf("%s-bookmarks.html", sp.Name), "text/html", renderHTML(nodes, slots), nil
	case FormatNativeJSON:
		raw, err := renderJSON(sp, nodes, slots)
		if err != nil {
			return "", "", "", err
		}
		return fmt.Sprintf("%s-export.json", sp.Name), "application/json", raw, nil
	default:
		return "", "", "", ErrInvalidFormat
	}
}

func renderHTML(nodes []canonical.Node, slots []canonical.RootSlot) string {
	childrenOf := map[string][]canonical.Node{}
	var roots []canonical.Node
	for _, n := range nodes {
		if n.Parent.Type == canonical.ParentTypeNode {
			key := string(n.Parent.NodeID)
			childrenOf[key] = append(childrenOf[key], n)
		} else {
			roots = append(roots, n)
		}
	}
	for k := range childrenOf {
		list := childrenOf[k]
		sort.Slice(list, func(i, j int) bool { return list[i].Position < list[j].Position })
		childrenOf[k] = list
	}
	sort.Slice(roots, func(i, j int) bool { return roots[i].Position < roots[i].Position })

	esc := func(s string) string {
		r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
		return r.Replace(s)
	}
	var b strings.Builder
	b.WriteString("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n")
	b.WriteString("<!-- This is an automatically generated file. DO NOT EDIT! -->\n")
	b.WriteString(`<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">` + "\n")
	b.WriteString("<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n")

	var writeLevel func(list []canonical.Node, depth int)
	writeLevel = func(list []canonical.Node, depth int) {
		pad := strings.Repeat("    ", depth)
		for _, n := range list {
			if n.Type == canonical.NodeTypeFolder {
				b.WriteString(pad + "<DT><H3>" + esc(n.Title) + "</H3>\n")
				kids := childrenOf[string(n.ID)]
				if len(kids) > 0 {
					b.WriteString(pad + "<DL><p>\n")
					writeLevel(kids, depth+1)
					b.WriteString(pad + "</DL><p>\n")
				}
			} else {
				b.WriteString(pad + "<DT><A HREF=\"" + esc(n.URL) + "\">" + esc(n.Title) + "</A>\n")
			}
		}
	}
	writeLevel(roots, 1)
	b.WriteString("</DL><p>\n")
	return b.String()
}

func renderJSON(sp canonical.SyncSpace, nodes []canonical.Node, slots []canonical.RootSlot) (string, error) {
	file := portableFile{Format: "pontis-portable-bookmarks", Version: 1}
	for _, s := range slots {
		file.RootSlots = append(file.RootSlots, portableSlot{Key: s.Key, DisplayName: s.DisplayName, Position: s.Position})
	}
	for _, n := range nodes {
		pn := portableNode{
			ID:       string(n.ID),
			Type:     string(n.Type),
			Title:    n.Title,
			Position: n.Position,
		}
		if n.URL != "" {
			u := n.URL
			pn.URL = &u
		}
		if n.Parent.Type == canonical.ParentTypeNode {
			p := string(n.Parent.NodeID)
			pn.ParentID = &p
		} else {
			k := n.Parent.RootKey
			pn.RootKey = &k
		}
		file.Nodes = append(file.Nodes, pn)
	}
	raw, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// --- import planning ---

// Preview parses the content and plans against the space's whole tree:
// bookmarks are matched by exact raw URL anywhere in the space, folders by
// full path. The apply call re-plans against the concrete target parent
// and reports real counters.
func (s *Service) Preview(ctx context.Context, space canonical.SpaceID, format Format, content string) (*Plan, error) {
	tree, warnings, err := ParseImport(format, content)
	if err != nil {
		return nil, err
	}
	sp, err := s.trees.Space(ctx, space)
	if err != nil {
		return nil, err
	}
	nodes, err := s.trees.ListNodes(ctx, space)
	if err != nil {
		return nil, err
	}
	urlSet := map[string]bool{}
	pathSet := map[string]bool{}
	var pathOf func(n canonical.Node) string
	byID := map[canonical.NodeID]canonical.Node{}
	for _, n := range nodes {
		byID[n.ID] = n
		if n.Type == canonical.NodeTypeBookmark {
			urlSet[n.URL] = true
		}
	}
	pathOf = func(n canonical.Node) string {
		parts := []string{n.Title}
		cur := n
		for cur.Parent.Type == canonical.ParentTypeNode {
			p, ok := byID[cur.Parent.NodeID]
			if !ok {
				break
			}
			parts = append([]string{p.Title}, parts...)
			cur = p
		}
		return "/" + strings.Join(parts, "/")
	}
	for _, n := range nodes {
		if n.Type == canonical.NodeTypeFolder {
			pathSet[strings.ToLower(pathOf(n))] = true
		}
	}

	plan := &Plan{
		SpaceID:       string(space),
		Format:        format,
		Counts:        map[string]int{},
		Warnings:      warnings,
		BoundRevision: sp.CurrentRevision,
		CreatedAt:     time.Now().UTC(),
		Tree:          tree,
	}

	var walk func(n ImportNode, path string)
	walk = func(n ImportNode, path string) {
		for _, c := range n.Children {
			p := path + "/" + strings.ToLower(c.Title)
			if c.URL != "" {
				plan.Total++
				switch {
				case urlSet[c.URL]:
					plan.Counts[string(ActionKeep)]++
					plan.Entries = append(plan.Entries, Entry{Title: c.Title, URL: c.URL, Path: path, Action: string(ActionKeep)})
				default:
					plan.Counts[string(ActionCreate)]++
					plan.Entries = append(plan.Entries, Entry{Title: c.Title, URL: c.URL, Path: path, Action: string(ActionCreate)})
				}
			} else {
				plan.Total++
				if pathSet[p] {
					plan.Counts[string(ActionKeep)]++
					plan.Entries = append(plan.Entries, Entry{Title: c.Title, Path: path, Action: string(ActionKeep)})
				} else {
					plan.Counts[string(ActionCreate)]++
					plan.Entries = append(plan.Entries, Entry{Title: c.Title, Path: path, Action: string(ActionCreate)})
				}
				walk(c, p)
			}
		}
	}
	walk(*tree, "")

	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	plan.ID = id.String()

	// Prune stale plans while we hold the lock.
	s.mu.Lock()
	now := time.Now().UTC()
	for k, v := range s.plans {
		if now.Sub(v.CreatedAt) > planTTL {
			delete(s.plans, k)
		}
	}
	s.plans[plan.ID] = *plan
	s.mu.Unlock()

	// Cap the preview entries to keep responses bounded.
	if len(plan.Entries) > 50 {
		plan.Entries = plan.Entries[:50]
	}
	return plan, nil
}

// Apply re-plans against the concrete target parent with the chosen
// strategy and commits the result through the canonical executor. The
// whole apply — replace deletes plus every merge create — is ONE ChangeSet
// with an atomic Before Image, so it can be undone as a whole (doc 15 §8).
func (s *Service) Apply(ctx context.Context, user canonical.UserID, space canonical.SpaceID, planID string, parent canonical.ParentRef, strategy string) (ApplyResult, error) {
	s.mu.Lock()
	plan, ok := s.plans[planID]
	s.mu.Unlock()
	if !ok || plan.SpaceID != string(space) {
		return ApplyResult{}, ErrPlanNotFound
	}
	if strategy != "merge" && strategy != "replace" {
		return ApplyResult{}, ErrInvalidStrategy
	}
	// Stale plan: the space moved on since the preview (doc 11 §8).
	sp, err := s.trees.Space(ctx, space)
	if err != nil {
		return ApplyResult{}, err
	}
	if sp.CurrentRevision != plan.BoundRevision {
		return ApplyResult{}, ErrPlanStale
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

	rec := s.changesets.BeginBatch(space, changeset.KindImport, origin, true)

	var res ApplyResult
	if strategy == "replace" {
		// Replace clears the target's children first — as journaled,
		// tombstoned DeleteNode commands so sync clients observe the
		// removal and the undo has a full Before Image.
		children, err := tx.Children(ctx, space, parent)
		if err != nil {
			return ApplyResult{}, err
		}
		for _, child := range children {
			ids, err := tx.SubtreeIDs(ctx, space, child.ID)
			if err != nil {
				return ApplyResult{}, err
			}
			if err := rec.Apply(ctx, tx, canonical.DeleteNode{SpaceID: space, NodeID: child.ID}); err != nil {
				return ApplyResult{}, err
			}
			res.Deleted += int64(len(ids))
		}
	}

	// Merge matcher built per level: each reused folder re-indexes its own
	// children so deep merges match on the real target contents.
	newID := func() (canonical.NodeID, error) {
		id, err := uuid.NewV7()
		if err != nil {
			return "", err
		}
		return canonical.NodeID(id.String()), nil
	}
	indexChildren := func(parent canonical.ParentRef) (byTitle map[string]canonical.NodeID, byURL map[string]canonical.NodeID, err error) {
		children, err := tx.Children(ctx, space, parent)
		if err != nil {
			return nil, nil, err
		}
		byTitle = map[string]canonical.NodeID{}
		byURL = map[string]canonical.NodeID{}
		for _, c := range children {
			if c.Type == canonical.NodeTypeFolder {
				byTitle[c.Title] = c.ID
			} else {
				byURL[c.URL] = c.ID
			}
		}
		return byTitle, byURL, nil
	}
	byTitle, byURL, err := indexChildren(parent)
	if err != nil {
		return ApplyResult{}, err
	}
	var walk func(n ImportNode, parent canonical.ParentRef, byTitle, byURL map[string]canonical.NodeID) error
	walk = func(n ImportNode, parent canonical.ParentRef, byTitle, byURL map[string]canonical.NodeID) error {
		for _, c := range n.Children {
			if c.URL == "" {
				if existing, ok := byTitle[c.Title]; ok {
					res.Kept++
					// Recurse into the existing folder with a fresh index
					// of its actual children.
					subTitle, subURL, err := indexChildren(canonical.NewNodeParent(existing))
					if err != nil {
						return err
					}
					if err := walk(c, canonical.NewNodeParent(existing), subTitle, subURL); err != nil {
						return err
					}
					continue
				}
				id, err := newID()
				if err != nil {
					return err
				}
				if err := rec.Apply(ctx, tx, canonical.CreateNode{
					SpaceID: space, NodeID: id, Type: canonical.NodeTypeFolder,
					Title: c.Title, Parent: parent,
				}); err != nil {
					return err
				}
				byTitle[c.Title] = id
				res.Created++
				empty := map[string]canonical.NodeID{}
				if err := walk(c, canonical.NewNodeParent(id), empty, empty); err != nil {
					return err
				}
				continue
			}
			if _, ok := byURL[c.URL]; ok {
				res.Kept++
				continue
			}
			id, err := newID()
			if err != nil {
				return err
			}
			if err := rec.Apply(ctx, tx, canonical.CreateNode{
				SpaceID: space, NodeID: id, Type: canonical.NodeTypeBookmark,
				Title: c.Title, URL: c.URL, Parent: parent,
			}); err != nil {
				return err
			}
			byURL[c.URL] = id
			res.Created++
		}
		return nil
	}
	if err := walk(*plan.Tree, parent, byTitle, byURL); err != nil {
		return ApplyResult{}, err
	}

	summary := fmt.Sprintf("导入合并：新增 %d 项", res.Created)
	if strategy == "replace" {
		summary = fmt.Sprintf("导入替换：删除 %d 项，新增 %d 项", res.Deleted, res.Created)
	}
	if _, err := rec.Finish(ctx, tx, summary); err != nil {
		return ApplyResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ApplyResult{}, err
	}
	committed = true

	s.mu.Lock()
	delete(s.plans, planID)
	s.mu.Unlock()
	return res, nil
}

// Service-level errors mapped by the HTTP layer.
var (
	ErrPlanNotFound    = errors.New("transfer: plan not found or expired")
	ErrPlanStale       = errors.New("transfer: plan is stale, re-run the preview")
	ErrInvalidStrategy = errors.New("transfer: strategy must be merge or replace")
)
