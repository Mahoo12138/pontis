// Package library implements the web-facing bookmark REST operations
// (doc 08 §4): session-authenticated CRUD on a space's canonical tree
// plus the user-facing activity history and undo (doc 15). Every
// mutation goes through the canonical executor as one ChangeSet.
package library

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
)

// Store is the persistence contract required by the library service,
// defined on the consumer side.
type Store interface {
	BeginTx(ctx context.Context) (canonical.Tx, error)

	LoadSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error)
	ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error)

	DeviceName(ctx context.Context, deviceID string) (string, error)
	Username(ctx context.Context, userID string) (string, error)
}

// Errors.
var (
	// ErrNodeNotFound is returned for unknown node ids.
	ErrNodeNotFound = errors.New("library: node not found")
	// ErrNothingToUpdate is returned when an update carries no fields.
	ErrNothingToUpdate = errors.New("library: nothing to update")
)

// CreateParams are the parameters of a web-side node creation.
type CreateParams struct {
	Type     canonical.NodeType
	Title    string
	URL      string
	Parent   canonical.ParentRef
	BeforeID *canonical.NodeID
}

// ActivityEntry is one user-facing activity row backed by a ChangeSet
// (doc 15 §10).
type ActivityEntry struct {
	ID        string
	Timestamp time.Time
	Actor     string
	Action    string // create | update | move | delete | undo | reconciliation
	Summary   string
	Undoable  bool
}

// Service implements the web-facing library operations.
type Service struct {
	store    Store
	executor *canonical.Executor
}

// NewService returns a library service backed by store.
func NewService(store Store) *Service {
	return &Service{store: store, executor: canonical.NewExecutor()}
}

// ListNodes returns every node of the space ordered for tree building.
func (s *Service) ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	return s.store.ListNodes(ctx, space)
}

// RootSlots returns the space's root slots ordered by position.
func (s *Service) RootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error) {
	return s.store.ListRootSlots(ctx, space)
}

// Create inserts a node as one ChangeSet and returns the stored row.
func (s *Service) Create(ctx context.Context, space canonical.SpaceID, user canonical.UserID, p CreateParams) (canonical.Node, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return canonical.Node{}, err
	}
	nodeID := canonical.NodeID(id.String())
	kind := "书签"
	if p.Type == canonical.NodeTypeFolder {
		kind = "文件夹"
	}
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	if _, err := s.executor.ExecuteChangeSet(ctx, s.store, origin, space, canonical.ChangeSetInput{
		Kind:    "create",
		Summary: fmt.Sprintf("新建了「%s」%s", p.Title, kind),
	}, canonical.CreateNode{
		SpaceID:  space,
		NodeID:   nodeID,
		Type:     p.Type,
		Title:    p.Title,
		URL:      p.URL,
		Parent:   p.Parent,
		BeforeID: p.BeforeID,
	}); err != nil {
		return canonical.Node{}, err
	}
	return s.loadNode(ctx, space, nodeID)
}

// Update changes a node's title and/or URL as one ChangeSet.
func (s *Service) Update(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID, title, url *string) (canonical.Node, error) {
	if title == nil && url == nil {
		return canonical.Node{}, ErrNothingToUpdate
	}
	current, err := s.loadNode(ctx, space, node)
	if err != nil {
		return canonical.Node{}, err
	}
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	var cmds []canonical.Command
	var summary string
	if title != nil && *title != current.Title {
		cmds = append(cmds, canonical.UpdateNodeTitle{SpaceID: space, NodeID: node, Title: *title})
		summary = fmt.Sprintf("将「%s」重命名为「%s」", current.Title, *title)
	}
	if url != nil && *url != current.URL {
		cmds = append(cmds, canonical.UpdateNodeURL{SpaceID: space, NodeID: node, URL: *url})
		if summary == "" {
			summary = fmt.Sprintf("更新了「%s」的链接", current.Title)
		} else {
			summary = fmt.Sprintf("重命名并更新了「%s」的链接", current.Title)
		}
	}
	if len(cmds) == 0 {
		return current, nil
	}
	if _, err := s.executor.ExecuteChangeSet(ctx, s.store, origin, space, canonical.ChangeSetInput{
		Kind:    "update",
		Summary: summary,
	}, cmds...); err != nil {
		return canonical.Node{}, err
	}
	return s.loadNode(ctx, space, node)
}

// Move reparents and/or reorders a node as one ChangeSet.
func (s *Service) Move(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID, parent canonical.ParentRef, beforeID *canonical.NodeID) (canonical.Node, error) {
	current, err := s.loadNode(ctx, space, node)
	if err != nil {
		return canonical.Node{}, err
	}
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	if _, err := s.executor.ExecuteChangeSet(ctx, s.store, origin, space, canonical.ChangeSetInput{
		Kind:    "move",
		Summary: fmt.Sprintf("移动了「%s」", current.Title),
	}, canonical.MoveNode{
		SpaceID:  space,
		NodeID:   node,
		Parent:   parent,
		BeforeID: beforeID,
	}); err != nil {
		return canonical.Node{}, err
	}
	return s.loadNode(ctx, space, node)
}

// Delete removes a node and its subtree as one undoable ChangeSet: the
// full subtree before-image is captured atomically with the delete
// (doc 15 §7, §13).
func (s *Service) Delete(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID) error {
	current, err := s.loadNode(ctx, space, node)
	if err != nil {
		return err
	}
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	kind := "书签"
	if current.Type == canonical.NodeTypeFolder {
		kind = "文件夹"
	}
	_, err = s.executor.ExecuteChangeSet(ctx, s.store, origin, space, canonical.ChangeSetInput{
		Kind:    "delete",
		Summary: fmt.Sprintf("删除了%s「%s」", kind, current.Title),
	}, canonical.DeleteNode{
		SpaceID: space,
		NodeID:  node,
	})
	return err
}

// UndoChangeSet plans and, when clean, applies the inverse of a
// ChangeSet as a new ChangeSet (doc 15 §8). Review-required plans never
// partially apply.
func (s *Service) UndoChangeSet(ctx context.Context, space canonical.SpaceID, user canonical.UserID, changeSetID string) (canonical.UndoPlan, error) {
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	return s.executor.ExecuteUndo(ctx, s.store, origin, space, changeSetID)
}

// Activity renders the newest ChangeSets as human-facing rows. Entries
// carrying usable, unexpired before-images are undoable (doc 15 §12).
func (s *Service) Activity(ctx context.Context, space canonical.SpaceID, limit int) ([]ActivityEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	// Collect ChangeSets and undo-data flags inside one read transaction,
	// then resolve actor names outside of it: the single-connection pool
	// must never be asked for a second connection while a transaction
	// holds one.
	type row struct {
		cs       canonical.ChangeSet
		undoable bool
	}
	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return nil, err
	}
	changeSets, _, err := tx.ListChangeSets(ctx, space, limit)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	now := time.Now().UTC()
	rows := make([]row, 0, len(changeSets))
	for _, cs := range changeSets {
		undoable := false
		if data, found, err := tx.LoadUndoData(ctx, cs.ID); err == nil && found {
			undoable = data.ExpiresAt.IsZero() || now.Before(data.ExpiresAt)
		}
		rows = append(rows, row{cs: cs, undoable: undoable})
	}
	_ = tx.Rollback(ctx)

	out := make([]ActivityEntry, 0, len(rows))
	for _, r := range rows {
		actor, err := s.actorName(ctx, r.cs)
		if err != nil {
			return nil, err
		}
		out = append(out, ActivityEntry{
			ID:        r.cs.ID,
			Timestamp: r.cs.CreatedAt,
			Actor:     actor,
			Action:    r.cs.Kind,
			Summary:   r.cs.Summary,
			Undoable:  r.undoable,
		})
	}
	return out, nil
}

func (s *Service) loadNode(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) (canonical.Node, error) {
	tx, err := s.store.BeginTx(ctx)
	if err != nil {
		return canonical.Node{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	node, err := tx.LoadNode(ctx, space, id)
	if err != nil {
		if errors.Is(err, canonical.ErrNodeNotFound) {
			return canonical.Node{}, ErrNodeNotFound
		}
		return canonical.Node{}, err
	}
	return node, nil
}

func (s *Service) actorName(ctx context.Context, cs canonical.ChangeSet) (string, error) {
	switch cs.ActorType {
	case canonical.OriginDevice:
		if cs.ActorDeviceID != "" {
			if name, err := s.store.DeviceName(ctx, string(cs.ActorDeviceID)); err == nil && name != "" {
				return name, nil
			}
		}
		return "已同步设备", nil
	case canonical.OriginUser:
		if cs.ActorUserID != "" {
			if name, err := s.store.Username(ctx, string(cs.ActorUserID)); err == nil && name != "" {
				return name, nil
			}
		}
		return "Web", nil
	default:
		return "系统", nil
	}
}
