// Package library implements the web-side canonical tree access: reading
// the explorer tree and applying user-initiated CRUD through the canonical
// executor, plus the activity feed derived from ChangeSets (doc 15).
package library

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"pontis/internal/canonical"
	"pontis/internal/changeset"
)

// Store is the read-side persistence contract required by the service.
type Store interface {
	GetSpace(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error)
	GetNode(ctx context.Context, space canonical.SpaceID, id canonical.NodeID) (canonical.Node, error)
	ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error)
	ListRootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error)
	ListChangeSets(ctx context.Context, space canonical.SpaceID, limit int) ([]changeset.ChangeSet, error)
	DeviceName(ctx context.Context, id string) (string, error)
	UserName(ctx context.Context, id string) (string, error)
}

// Writer is the write-side contract: a canonical transaction factory.
type Writer interface {
	BeginTx(ctx context.Context) (canonical.Tx, error)
}

// Limits.
const (
	// MaxTitleLength is the V1 title bound shared with the sync protocol.
	MaxTitleLength = 255
	// MaxURLLength guards against abuse from web-originated writes.
	MaxURLLength = 2048
	// DefaultActivityLimit caps the activity feed response.
	DefaultActivityLimit = 100
)

// Service implements web-originated tree access.
type Service struct {
	store      Store
	writer     Writer
	changesets *changeset.Service
}

// NewService returns a library service.
func NewService(store Store, writer Writer, changesets *changeset.Service) *Service {
	return &Service{store: store, writer: writer, changesets: changesets}
}

// Node and root-slot reads.

// Space loads one space or canonical.ErrSpaceNotFound.
func (s *Service) Space(ctx context.Context, id canonical.SpaceID) (canonical.SyncSpace, error) {
	return s.store.GetSpace(ctx, id)
}

// Nodes returns the space's full node list; the client builds the tree.
func (s *Service) Nodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	if _, err := s.store.GetSpace(ctx, space); err != nil {
		return nil, err
	}
	return s.store.ListNodes(ctx, space)
}

// RootSlots returns the space's root slots.
func (s *Service) RootSlots(ctx context.Context, space canonical.SpaceID) ([]canonical.RootSlot, error) {
	if _, err := s.store.GetSpace(ctx, space); err != nil {
		return nil, err
	}
	return s.store.ListRootSlots(ctx, space)
}

// CreateParams carries a web-originated node creation.
type CreateParams struct {
	Type     canonical.NodeType
	Title    string
	URL      string
	Parent   canonical.ParentRef
	BeforeID *canonical.NodeID
}

// CreateNode validates and applies a user's node creation.
func (s *Service) CreateNode(ctx context.Context, space canonical.SpaceID, user canonical.UserID, p CreateParams) (canonical.Node, error) {
	if p.Title == "" {
		return canonical.Node{}, canonical.ErrTitleRequired
	}
	if len(p.Title) > MaxTitleLength {
		return canonical.Node{}, ErrTitleTooLong
	}
	if len(p.URL) > MaxURLLength {
		return canonical.Node{}, ErrURLTooLong
	}

	id, err := uuid.NewV7()
	if err != nil {
		return canonical.Node{}, err
	}
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}

	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return canonical.Node{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	cmd := canonical.CreateNode{
		SpaceID:  space,
		NodeID:   canonical.NodeID(id.String()),
		Type:     p.Type,
		Title:    p.Title,
		URL:      p.URL,
		Parent:   p.Parent,
		BeforeID: p.BeforeID,
	}
	if _, err := s.changesets.RecordNodeOp(ctx, tx, space, origin, cmd); err != nil {
		return canonical.Node{}, err
	}
	created, err := tx.LoadNode(ctx, space, cmd.NodeID)
	if err != nil {
		return canonical.Node{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.Node{}, err
	}
	committed = true
	return created, nil
}

// UpdateParams carries an optional title/url change; nil fields are no-ops.
type UpdateParams struct {
	Title *string
	URL   *string
}

// UpdateNode applies title and/or URL changes to one node.
func (s *Service) UpdateNode(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID, p UpdateParams) (canonical.Node, error) {
	if p.Title != nil {
		if *p.Title == "" {
			return canonical.Node{}, canonical.ErrTitleRequired
		}
		if len(*p.Title) > MaxTitleLength {
			return canonical.Node{}, ErrTitleTooLong
		}
	}
	if p.URL != nil && len(*p.URL) > MaxURLLength {
		return canonical.Node{}, ErrURLTooLong
	}

	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}

	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return canonical.Node{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	var cmds []canonical.Command
	if p.Title != nil {
		cmds = append(cmds, canonical.UpdateNodeTitle{SpaceID: space, NodeID: node, Title: *p.Title})
	}
	if p.URL != nil {
		cmds = append(cmds, canonical.UpdateNodeURL{SpaceID: space, NodeID: node, URL: *p.URL})
	}
	if len(cmds) > 0 {
		if _, err := s.changesets.RecordNodeOp(ctx, tx, space, origin, cmds...); err != nil {
			return canonical.Node{}, err
		}
	}
	updated, err := tx.LoadNode(ctx, space, node)
	if err != nil {
		return canonical.Node{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.Node{}, err
	}
	committed = true
	return updated, nil
}

// MoveParams carries a reparent/reorder request.
type MoveParams struct {
	Parent   canonical.ParentRef
	BeforeID *canonical.NodeID
}

// MoveNode applies a user's move command.
func (s *Service) MoveNode(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID, p MoveParams) (canonical.Node, error) {
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}

	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return canonical.Node{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()

	cmd := canonical.MoveNode{SpaceID: space, NodeID: node, Parent: p.Parent, BeforeID: p.BeforeID}
	if _, err := s.changesets.RecordNodeOp(ctx, tx, space, origin, cmd); err != nil {
		return canonical.Node{}, err
	}
	moved, err := tx.LoadNode(ctx, space, node)
	if err != nil {
		return canonical.Node{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return canonical.Node{}, err
	}
	committed = true
	return moved, nil
}

// DeleteNode removes a node and its subtree.
func (s *Service) DeleteNode(ctx context.Context, space canonical.SpaceID, user canonical.UserID, node canonical.NodeID) error {
	origin := canonical.Origin{Type: canonical.OriginUser, UserID: user}
	tx, err := s.writer.BeginTx(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	if _, err := s.changesets.RecordNodeOp(ctx, tx, space, origin, canonical.DeleteNode{SpaceID: space, NodeID: node}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}

// ActivityEntry is one human-readable item of the space's recent history.
type ActivityEntry struct {
	ID        string
	Timestamp string
	Actor     string
	Action    string // create | update | move | delete | import | publish | transfer | undo
	Summary   string
	Undoable  bool
	Undone    bool
	Expired   bool
}

// Activity derives the user-level history feed from ChangeSets (doc 15
// §1: Activity is business history, not machine journal). Entries whose
// undo window passed stay visible but are marked expired.
func (s *Service) Activity(ctx context.Context, space canonical.SpaceID, limit int) ([]ActivityEntry, error) {
	sp, err := s.store.GetSpace(ctx, space)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > DefaultActivityLimit {
		limit = DefaultActivityLimit
	}
	sets, err := s.store.ListChangeSets(ctx, space, limit)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	out := make([]ActivityEntry, 0, len(sets))
	for _, cs := range sets {
		undone := cs.UndoneByChangeSet != ""
		entry := ActivityEntry{
			ID:        cs.ID,
			Timestamp: cs.CreatedAt.Format(time.RFC3339Nano),
			Actor:     s.changesetActor(ctx, cs),
			Action:    mapKindAction(cs.Kind),
			Summary:   cs.Summary,
			Undone:    undone,
		}
		if cs.UndoDataJSON != "" && !undone && cs.Epoch == sp.Epoch {
			if now.Sub(cs.CreatedAt) > changeset.UndoWindow {
				entry.Expired = true
			} else {
				entry.Undoable = true
			}
		}
		out = append(out, entry)
	}
	return out, nil
}

func (s *Service) changesetActor(ctx context.Context, cs changeset.ChangeSet) string {
	switch cs.OriginType {
	case canonical.OriginDevice:
		name, _ := s.store.DeviceName(ctx, string(cs.ActorDeviceID))
		if name == "" {
			return "浏览器设备"
		}
		return name
	case canonical.OriginUser:
		name, _ := s.store.UserName(ctx, string(cs.ActorUserID))
		if name == "" {
			return "网页"
		}
		return name + " (网页)"
	case canonical.OriginImport:
		return "导入"
	case canonical.OriginTransfer:
		return "跨空间转移"
	case canonical.OriginSystem, canonical.OriginRecovery:
		return "系统"
	default:
		return "未知"
	}
}

func mapKindAction(kind changeset.Kind) string {
	switch kind {
	case changeset.KindNodeCreate:
		return "create"
	case changeset.KindNodeUpdate:
		return "update"
	case changeset.KindNodeMove:
		return "move"
	case changeset.KindNodeDelete:
		return "delete"
	case changeset.KindImport:
		return "import"
	case changeset.KindPublication:
		return "publish"
	case changeset.KindTransferIn, changeset.KindTransferOut:
		return "transfer"
	case changeset.KindUndo:
		return "undo"
	default:
		return "update"
	}
}

// Service-level errors carrying HTTP semantics.
var (
	ErrTitleTooLong = errors.New("library: title too long")
	ErrURLTooLong   = errors.New("library: url too long")
)

// ListNodes exposes the raw node list for detector-style consumers
// (organizer, backup capture).
func (s *Service) ListNodes(ctx context.Context, space canonical.SpaceID) ([]canonical.Node, error) {
	return s.store.ListNodes(ctx, space)
}
