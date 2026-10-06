// Package library implements the web-facing bookmark REST operations
// (doc 08 §4): session-authenticated CRUD on a space's canonical tree
// plus a read-only activity feed derived from the journal. Every
// mutation goes through the canonical executor.
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

	// ListRecentJournal returns the newest journal entries of the
	// space's current epoch, newest first.
	ListRecentJournal(ctx context.Context, space canonical.SpaceID, limit int) ([]JournalRow, error)
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

// JournalRow is one journal entry with its origin columns resolved.
type JournalRow struct {
	Epoch          int64
	Revision       int64
	Type           string
	NodeID         string
	PayloadJSON    string
	OriginType     string
	OriginUserID   string
	OriginDeviceID string
	CreatedAt      time.Time
}

// ActivityEntry is one human-facing activity row (doc 15 preview). V1
// entries are read-only; undo arrives with ChangeSets.
type ActivityEntry struct {
	ID        string
	Timestamp time.Time
	Actor     string
	Action    string // create | update | move | delete
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

// Create inserts a node and returns the stored row.
func (s *Service) Create(ctx context.Context, space canonical.SpaceID, user canonical.UserID, p CreateParams) (canonical.Node, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return canonical.Node{}, err
	}
	nodeID := canonical.NodeID(id.String())
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	err = s.executor.Execute(ctx, s.store, origin, canonical.CreateNode{
		SpaceID:  space,
		NodeID:   nodeID,
		Type:     p.Type,
		Title:    p.Title,
		URL:      p.URL,
		Parent:   p.Parent,
		BeforeID: p.BeforeID,
	})
	if err != nil {
		return canonical.Node{}, err
	}
	return s.loadNode(ctx, space, nodeID)
}

// Update changes a node's title and/or URL and returns the stored row.
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
	if title != nil && *title != current.Title {
		cmds = append(cmds, canonical.UpdateNodeTitle{SpaceID: space, NodeID: node, Title: *title})
	}
	if url != nil && *url != current.URL {
		cmds = append(cmds, canonical.UpdateNodeURL{SpaceID: space, NodeID: node, URL: *url})
	}
	if len(cmds) == 0 {
		return current, nil
	}
	if err := s.executor.Execute(ctx, s.store, origin, cmds...); err != nil {
		return canonical.Node{}, err
	}
	return s.loadNode(ctx, space, node)
}

// Move reparents and/or reorders a node and returns the stored row.
func (s *Service) Move(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID, parent canonical.ParentRef, beforeID *canonical.NodeID) (canonical.Node, error) {
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	if err := s.executor.Execute(ctx, s.store, origin, canonical.MoveNode{
		SpaceID:  space,
		NodeID:   node,
		Parent:   parent,
		BeforeID: beforeID,
	}); err != nil {
		return canonical.Node{}, err
	}
	return s.loadNode(ctx, space, node)
}

// Delete removes a node and its subtree.
func (s *Service) Delete(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID) error {
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	return s.executor.Execute(ctx, s.store, origin, canonical.DeleteNode{
		SpaceID: space,
		NodeID:  node,
	})
}

// Activity renders the newest journal entries as human-facing rows.
func (s *Service) Activity(ctx context.Context, space canonical.SpaceID, limit int) ([]ActivityEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.store.ListRecentJournal(ctx, space, limit)
	if err != nil {
		return nil, err
	}
	out := make([]ActivityEntry, 0, len(rows))
	for _, row := range rows {
		actor, err := s.actorName(ctx, row)
		if err != nil {
			return nil, err
		}
		action, summary, err := summarize(row)
		if err != nil {
			return nil, err
		}
		out = append(out, ActivityEntry{
			ID:        fmt.Sprintf("act-%d-%d", row.Epoch, row.Revision),
			Timestamp: row.CreatedAt,
			Actor:     actor,
			Action:    action,
			Summary:   summary,
			Undoable:  false, // undo arrives with ChangeSets (doc 15)
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

func (s *Service) actorName(ctx context.Context, row JournalRow) (string, error) {
	switch row.OriginType {
	case string(canonical.OriginDevice):
		if row.OriginDeviceID != "" {
			if name, err := s.store.DeviceName(ctx, row.OriginDeviceID); err == nil && name != "" {
				return name, nil
			}
		}
		return "已同步设备", nil
	case string(canonical.OriginUser):
		if row.OriginUserID != "" {
			if name, err := s.store.Username(ctx, row.OriginUserID); err == nil && name != "" {
				return name, nil
			}
		}
		return "Web", nil
	default:
		return "系统", nil
	}
}
